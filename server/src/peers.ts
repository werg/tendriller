import { PEER_RENDEZVOUS_LIMITS as LIMITS, PEER_RENDEZVOUS_PROTOCOL, validatePeerBootstrap, validatePeerDescription } from '../../contract/peers.mjs';
import { currentPrincipal, pageAccessAllowed, accountActive } from './access';
import type { Principal } from './access';
import { HttpError, json, readJson } from './http';
import type { Tendril } from './tendril';
import { handleDiscovery } from './discovery';
import { handlePeerGenerations } from './peer-generations';
import { handleInvitations } from './peer-invitations';

export const PEER_ROUTE = /^peers\/(?:bootstrap|rendezvous|invitations|directory|application|definition|generations|administration)$/;
/** Public connection configuration is read while serving the page, without a second discovery request. */
export function peerBootstrap(t: Tendril) {
  return validatePeerBootstrap(t.db.get('peer_bootstrap', { version: 2, endpoints: [] }));
}
interface PeerAttachment {
  kind: 'rendezvous'; channel: string; session: string; peerId: string; principal: Principal;
  role: 'offerer' | 'answerer'; expiresAt: number; ready: boolean; sent: boolean; complete: boolean;
}
function attachment(ws: WebSocket): PeerAttachment | null {
  const value = ws.deserializeAttachment() as PeerAttachment | null;
  return value?.kind === 'rendezvous' ? value : null;
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
  return t.ctx.getWebSockets('rendezvous').filter(ws => {
    const value = attachment(ws);
    if (ws.readyState !== WebSocket.READY_STATE_OPEN || !value || value.complete) return false;
    if (value.expiresAt <= t.now()) { ws.close(1008, 'Rendezvous expired'); return false; }
    if (!authorized(t, value.principal)) { ws.close(4003, 'Peer host access revoked'); return false; }
    return channel === undefined || value.channel === channel;
  });
}
export function nextPeerDeadline(t: Tendril): number | null {
  const times = t.ctx.getWebSockets('rendezvous').flatMap(ws => {
    const value = attachment(ws);
    return value && !value.complete && ws.readyState === WebSocket.READY_STATE_OPEN ? [value.expiresAt] : [];
  });
  return times.length ? Math.min(...times) : null;
}
export function expirePeers(t: Tendril): void { peers(t); }

export async function handlePeers(t: Tendril, req: Request, url: URL, path: string, principal: Principal): Promise<Response> {
  if (!authorized(t, principal)) throw new HttpError(403, 'forbidden', 'Rendezvous requires an authorized page or agent identity');
  if (path === 'peers/application' || path === 'peers/definition' || path === 'peers/generations' || path === 'peers/administration') return handlePeerGenerations(t, req, path, principal);
  if (path === 'peers/directory') return handleDiscovery(t, req, principal);
  if (path === 'peers/invitations') return handleInvitations(t, req, url, principal);
  if (path === 'peers/bootstrap') {
    if (req.method === 'GET') return json(peerBootstrap(t));
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
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).includes(PEER_RENDEZVOUS_PROTOCOL))
    throw new HttpError(400, 'bad_request', `Rendezvous requires ${PEER_RENDEZVOUS_PROTOCOL}`);
  const channel = identifier(url.searchParams.get('channel')), peerId = identifier(url.searchParams.get('peerId'));
  const existing = peers(t, channel);
  if (existing.length >= 2 || existing.some(ws => attachment(ws)?.ready || attachment(ws)?.peerId === peerId))
    throw new HttpError(409, 'peer_channel_full', 'A rendezvous has exactly two distinct endpoints');
  if (peers(t).length >= LIMITS.sessions * 2) throw new HttpError(429, 'peer_quota', 'Too many pending rendezvous');
  const [client, server] = Object.values(new WebSocketPair());
  const first = existing.length ? attachment(existing[0])! : null;
  const value: PeerAttachment = { kind: 'rendezvous', channel, session: first?.session ?? crypto.randomUUID(), peerId, principal,
    role: first ? 'answerer' : 'offerer', expiresAt: first?.expiresAt ?? t.now() + LIMITS.lifetimeMs,
    ready: !!first, sent: false, complete: false };
  t.ctx.acceptWebSocket(server, ['rendezvous']);
  server.serializeAttachment(value);
  if (first) {
    existing[0].serializeAttachment({ ...first, ready: true });
    existing[0].send(JSON.stringify({ t: 'ready', version: 1, session: value.session, role: first.role }));
    server.send(JSON.stringify({ t: 'ready', version: 1, session: value.session, role: value.role }));
  }
  t.scheduleAlarm();
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PEER_RENDEZVOUS_PROTOCOL } });
}

// Only one message may be waiting for authorization. There is no data-plane
// queue or application-frame parsing, and a second send retires this session.
const pending = new WeakSet<WebSocket>();
export async function handlePeerMessage(t: Tendril, ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
  if (ws.readyState !== WebSocket.READY_STATE_OPEN) return;
  if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > LIMITS.messageBytes) {
    ws.close(1009, 'Rendezvous accepts bounded SDP only'); return;
  }
  if (pending.has(ws)) { ws.close(1008, 'Only one description is allowed'); return; }
  pending.add(ws);
  try { await forwardDescription(t, ws, message); }
  catch {
    // An authorization/storage/send failure must not leave a half-used session
    // resident. Both peers retry with a new session and original application IDs.
    closePeer(t, ws);
    if (ws.readyState === WebSocket.READY_STATE_OPEN) ws.close(1011, 'Rendezvous failed');
  }
  finally { pending.delete(ws); }
}
async function forwardDescription(t: Tendril, ws: WebSocket, message: string): Promise<void> {
  let value = attachment(ws);
  if (!value || value.complete || ws.readyState !== WebSocket.READY_STATE_OPEN) return;
  if (!value.ready || value.sent || value.expiresAt <= t.now()) { ws.close(1008, 'Invalid rendezvous state'); return; }
  let description;
  try {
    const input = JSON.parse(message);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 ||
        input.t !== 'description' || input.session !== value.session) throw new Error('session');
    description = validatePeerDescription(input.description);
    if (description.type !== (value.role === 'offerer' ? 'offer' : 'answer')) throw new Error('role');
  } catch { ws.close(1008, 'Invalid or repeated WebRTC description'); return; }
  if (!authorized(t, value.principal) || !await pageAccessAllowed(t) ||
      value.principal.kind === 'page' && value.principal.accountId && !await accountActive(t, value.principal.accountId)) {
    ws.close(4003, 'Peer host access revoked'); return;
  }
  const other = peers(t, value.channel).find(peer => peer !== ws && attachment(peer)?.session === value!.session);
  if (!other) { ws.close(1013, 'Rendezvous peer disconnected'); return; }
  const candidate = attachment(other)!;
  if (candidate.principal.kind === 'page' && candidate.principal.accountId && !await accountActive(t, candidate.principal.accountId)) {
    other.close(4003, 'Peer host access revoked'); ws.close(1013, 'Rendezvous peer disconnected'); return;
  }
  // Account lookups can yield to a revocation, expiry or replacement session.
  value = attachment(ws)!;
  const recipient = attachment(other)!;
  if (ws.readyState !== WebSocket.READY_STATE_OPEN || other.readyState !== WebSocket.READY_STATE_OPEN ||
      value.complete || value.sent || recipient.complete || recipient.session !== value.session || value.expiresAt <= t.now() ||
      !authorized(t, value.principal) || !authorized(t, recipient.principal)) {
    ws.close(4003, 'Rendezvous is no longer authorized'); return;
  }
  if (value.role === 'answerer' && !recipient.sent) { ws.close(1008, 'An answer requires a delivered offer'); return; }
  ws.serializeAttachment({ ...value, sent: true });
  other.send(JSON.stringify({ t: 'description', session: value.session, description }));
  if (recipient.sent) {
    // Mark both attachments before close events can run. A completed session
    // never closes a new pair that happens to use the same channel name.
    ws.serializeAttachment({ ...value, sent: true, complete: true });
    other.serializeAttachment({ ...recipient, complete: true });
    const done = JSON.stringify({ t: 'complete', session: value.session });
    try { ws.send(done); other.send(done); }
    finally {
      if (ws.readyState === WebSocket.READY_STATE_OPEN) ws.close(1000, 'Rendezvous complete');
      if (other.readyState === WebSocket.READY_STATE_OPEN) other.close(1000, 'Rendezvous complete');
      t.scheduleAlarm();
    }
  }
}
export function closePeer(t: Tendril, ws: WebSocket): void {
  const value = attachment(ws);
  if (!value || value.complete) return;
  for (const other of peers(t, value.channel)) if (other !== ws && attachment(other)?.session === value.session)
    other.close(1013, 'Rendezvous peer disconnected');
  t.scheduleAlarm();
}
