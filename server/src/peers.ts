import { decodePeerFrame, PEER_LIMITS, validatePeerBootstrap } from '../../contract/peers.mjs';
import { currentPrincipal, pageAccessAllowed, accountActive } from './access';
import type { Principal } from './access';
import { HttpError, json, readJson } from './http';
import type { Tendril } from './tendril';

export const PEER_ROUTE = /^peers\/(?:bootstrap|socket)$/;
interface PeerAttachment {
  kind: 'peer'; channel: string; peerId: string; principal: Principal;
  credit: number; second: number; bytes: number; ready: boolean;
}
function attachment(ws: WebSocket): PeerAttachment | null {
  const value = ws.deserializeAttachment() as PeerAttachment | null;
  return value?.kind === 'peer' ? value : null;
}
export const isPeerSocket = (ws: WebSocket): boolean => attachment(ws) !== null;
function authorized(t: Tendril, principal: Principal): boolean {
  const current = currentPrincipal(t, principal);
  return !!current && (current.kind === 'agent' || current.kind === 'page' && current.role !== 'display');
}
const identifier = (value: string | null): string => {
  if (!value || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new HttpError(400, 'bad_request', 'A bounded channel and peerId are required');
  return value;
};
function peers(t: Tendril, channel?: string): WebSocket[] {
  return t.ctx.getWebSockets('peer').filter(ws => {
    const value = attachment(ws);
    if (ws.readyState !== WebSocket.READY_STATE_OPEN || !value) return false;
    if (!authorized(t, value.principal)) { ws.close(4003, 'Peer host access revoked'); return false; }
    return channel === undefined || value.channel === channel;
  });
}
export async function handlePeers(t: Tendril, req: Request, url: URL, path: string, principal: Principal): Promise<Response> {
  if (!authorized(t, principal)) throw new HttpError(403, 'forbidden', 'Peer hosting requires an authorized page or agent identity');
  if (path === 'peers/bootstrap') {
    if (req.method === 'GET') return json(t.db.get('peer_bootstrap', { version: 1, endpoints: [] }));
    if (req.method === 'PUT') {
      if (principal.kind !== 'agent' && !(principal.kind === 'page' && principal.role === 'owner')) throw new HttpError(403, 'forbidden');
      let value;
      try { value = validatePeerBootstrap(await readJson(req, 20_000)); }
      catch (error) { throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : 'Invalid bootstrap hints'); }
      if (!authorized(t, principal)) throw new HttpError(403, 'forbidden');
      t.db.set('peer_bootstrap', value);
      return json(value);
    }
    throw new HttpError(405, 'method_not_allowed');
  }
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).includes('tendriller.peer.v1'))
    throw new HttpError(400, 'bad_request', 'The peer socket requires tendriller.peer.v1');
  const channel = identifier(url.searchParams.get('channel')), peerId = identifier(url.searchParams.get('peerId'));
  const existing = peers(t, channel);
  if (existing.length >= 2 || existing.some(ws => attachment(ws)?.peerId === peerId)) throw new HttpError(409, 'peer_channel_full', 'A peer channel has exactly two distinct endpoints');
  if (peers(t).length >= PEER_LIMITS.relaySessions * 2) throw new HttpError(429, 'peer_quota', 'Too many relay connections');
  const pair = new WebSocketPair(), [client, server] = [pair[0], pair[1]];
  t.ctx.acceptWebSocket(server, ['peer']);
  server.serializeAttachment({ kind: 'peer', channel, peerId, principal, credit: PEER_LIMITS.queueBytes,
    second: Math.floor(t.now() / 1000), bytes: 0, ready: existing.length === 1 } satisfies PeerAttachment);
  if (existing.length === 1) {
    const other = existing[0], value = attachment(other)!;
    other.serializeAttachment({ ...value, ready: true });
    other.send('{"t":"peer_ready","version":1}'); server.send('{"t":"peer_ready","version":1}');
  }
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'tendriller.peer.v1' } });
}
export async function handlePeerMessage(t: Tendril, ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
  let value = attachment(ws);
  if (!value) return;
  if (!authorized(t, value.principal) || !await pageAccessAllowed(t) ||
      value.principal.kind === 'page' && value.principal.accountId && !await accountActive(t, value.principal.accountId)) {
    ws.close(4003, 'Peer host access revoked'); return;
  }
  value = attachment(ws)!;
  const other = peers(t, value.channel).find(peer => peer !== ws);
  if (!other || !value.ready) { ws.close(1013, 'Peer disconnected; resume from durable progress'); return; }
  const recipient = attachment(other)!;
  if (typeof message === 'string') {
    // Credit is replenished only as the receiver consumes frames. The relay
    // retains no queue and cannot accumulate unbounded bytes for a slow peer.
    let credit: { t?: string; bytes?: number };
    try { credit = JSON.parse(message); } catch { ws.close(1008, 'Invalid relay control'); return; }
    if (Object.keys(credit).length !== 2 || credit.t !== 'peer_credit' || !Number.isSafeInteger(credit.bytes) || credit.bytes! < 4 ||
        value.credit + credit.bytes! > PEER_LIMITS.queueBytes) { ws.close(1008, 'Invalid receive credit'); return; }
    ws.serializeAttachment({ ...value, credit: value.credit + credit.bytes! });
    other.send(JSON.stringify({ t: 'peer_credit', bytes: credit.bytes }));
    return;
  }
  try { decodePeerFrame(new Uint8Array(message)); }
  catch { ws.close(1009, 'Invalid or oversized peer frame'); return; }
  const second = Math.floor(t.now() / 1000), bytes = (value.second === second ? value.bytes : 0) + message.byteLength;
  if (bytes > PEER_LIMITS.relayBytesPerSecond) { ws.close(1008, 'Peer byte rate exceeded'); return; }
  if (recipient.credit < message.byteLength) { ws.close(1008, 'Peer receive credit exceeded'); return; }
  // Fresh authorization checks after any asynchronous account lookup.
  if (!authorized(t, value.principal) || !authorized(t, recipient.principal)) { ws.close(4003, 'Peer host access revoked'); return; }
  ws.serializeAttachment({ ...value, second, bytes });
  other.serializeAttachment({ ...recipient, credit: recipient.credit - message.byteLength });
  other.send(message);
}
export function closePeer(t: Tendril, ws: WebSocket): void {
  const value = attachment(ws);
  if (!value) return;
  for (const other of peers(t, value.channel)) if (other !== ws) other.close(1013, 'Peer disconnected; resume from durable progress');
}
