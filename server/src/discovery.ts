import { PEER_DIRECTORY_LIMITS as LIMITS, validatePeerAdvertisement, validatePeerId,
  type PeerAdvertisement } from '../../contract/discovery.mjs';
import { PEER_DISCOVERY_PROTOCOL as PROTOCOL } from '../../contract/discovery-watch.mjs';
import { accountActive, currentPrincipal, freshPrincipal, pageAccessAllowed, participantIdentity, type Principal } from './access';
import { selectedApplication } from './application';
import { HttpError } from './http';
import type { Tendril } from './tendril';

const TAG = 'peer-discovery', key = 'peer_directory';
interface Attachment { kind: typeof TAG; peerId: string; owner: string; connection: string; principal: Principal }
interface StoredAdvertisement { advertisement: PeerAdvertisement; owner: string; principal: Principal; connection: string }
const attachment = (ws: WebSocket): Attachment | null => {
  const value = ws.deserializeAttachment() as Attachment | null;
  return value?.kind === TAG ? value : null;
};
export const isDiscoverySocket = (ws: WebSocket) => attachment(ws) !== null;
function identity(t: Tendril, principal: Principal): string { return participantIdentity(t, principal).route; }
async function fresh(t: Tendril, principal: Principal) {
  identity(t, principal);
  if (!await pageAccessAllowed(t) || principal.kind === 'page' && principal.accountId && !await accountActive(t, principal.accountId) || !await freshPrincipal(t, principal))
    throw new HttpError(403, 'forbidden', 'Peer discovery access is no longer active');
  identity(t, principal);
}
function listeners(t: Tendril): WebSocket[] {
  return t.ctx.getWebSockets(TAG).filter(ws => {
    const value = attachment(ws);
    if (!value || ws.readyState !== WebSocket.READY_STATE_OPEN) return false;
    if (!currentPrincipal(t, value.principal)) { ws.close(4003, 'Peer host access revoked'); return false; }
    return true;
  });
}
function active(t: Tendril): StoredAdvertisement[] {
  const connected = new Set(listeners(t).map(ws => attachment(ws)!.connection));
  return t.db.get<StoredAdvertisement[]>(key, []).filter(row => connected.has(row.connection) && currentPrincipal(t, row.principal));
}
const presence = (row: StoredAdvertisement) => ({ advertisement: row.advertisement });
function notify(t: Tendril, except?: string) {
  t.afterCommit(async () => {
    for (const socket of listeners(t)) {
      const value = attachment(socket)!;
      if (value.connection === except) continue;
      try { await fresh(t, value.principal); if (socket.readyState === WebSocket.READY_STATE_OPEN) socket.send(JSON.stringify({ type: 'changed' })); }
      catch { try { socket.close(4003, 'Peer discovery access unavailable'); } catch {} }
    }
  });
}

/** Admission, key-wrap and membership changes wake every current discovery watcher to re-read host state. */
export function notifyDiscoveryWatchers(t: Tendril): void { notify(t); }

/** Presence is retained by an inbound hibernating socket, without TTL renewals. */
export async function handleDiscoveryWatch(t: Tendril, req: Request, url: URL, principal: Principal): Promise<Response> {
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(x => x.trim()).includes(PROTOCOL))
    throw new HttpError(400, 'bad_request', 'Peer discovery requires its versioned WebSocket protocol');
  let peerId: string;
  try { peerId = validatePeerId(url.searchParams.get('peerId')); } catch { throw new HttpError(400, 'bad_request'); }
  await fresh(t, principal);
  const owner = identity(t, principal), sockets = listeners(t), previous = sockets.find(ws => attachment(ws)!.peerId === peerId);
  if (previous && attachment(previous)!.owner !== owner) throw new HttpError(409, 'peer_identity_conflict');
  const budget = participantIdentity(t, principal).budget;
  if (!previous && (sockets.length >= LIMITS.peers || sockets.filter(ws => participantIdentity(t, attachment(ws)!.principal).budget === budget).length >= LIMITS.peersPerPrincipal))
    throw new HttpError(429, 'peer_directory_full');
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, [TAG]);
  server.serializeAttachment({ kind: TAG, peerId, owner, principal, connection: crypto.randomUUID() } satisfies Attachment);
  previous?.close(4000, 'Discovery listener replaced');
  server.send(JSON.stringify({ type: 'ready' }));
  // Replacing a presence withdraws its former hint until it re-advertises.
  if (previous) notify(t, attachment(server)!.connection);
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PROTOCOL } });
}
export function closeDiscoverySocket(t: Tendril, ws: WebSocket): void {
  const value = attachment(ws); if (!value) return;
  t.transaction(() => {
    const before = t.db.get<StoredAdvertisement[]>(key, []), after = before.filter(row => row.connection !== value.connection);
    if (before.length !== after.length) { t.db.set(key, after); notify(t); }
  });
}

/** Actual changes write bounded routing hints once. Reads never renew presence. */
export async function exchangeDiscovery(t: Tendril, principal: Principal, action: 'read' | 'advertise' | 'withdraw', input?: any): Promise<unknown> {
  await fresh(t, principal);
  if (action === 'read') {
    const before = active(t), principals = new Map(before.map(row => [row.owner, row.principal]));
    const permitted = new Map(await Promise.all([...principals].map(async ([owner, value]) => {
      try { await fresh(t, value); return [owner, true] as const; }
      catch { return [owner, false] as const; }
    })));
    identity(t, principal);
    return { applicationId: selectedApplication(t).id, peers: active(t).filter(row => permitted.get(row.owner)).map(presence) };
  }
  let advertisement: PeerAdvertisement | undefined, peerId: string;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Expected an advertisement request');
    if (action === 'advertise') {
      if (Object.keys(input).some(field => field !== 'advertisement')) throw Error('Unknown advertisement field');
      advertisement = validatePeerAdvertisement(input.advertisement); peerId = advertisement.peerId;
    } else {
      if (Object.keys(input).some(field => field !== 'peerId')) throw Error('Unknown withdrawal field');
      peerId = validatePeerId(input.peerId);
    }
  } catch (error) { throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : 'Invalid advertisement'); }
  const owner = identity(t, principal);
  return t.transaction(() => {
    const sockets = listeners(t), socket = sockets.find(ws => attachment(ws)!.peerId === peerId), bound = socket && attachment(socket)!;
    if (bound && bound.owner !== owner) throw new HttpError(409, 'peer_identity_conflict');
    const retained = t.db.get<StoredAdvertisement[]>(key, []), rows = active(t), previous = rows.find(row => row.advertisement.peerId === peerId);
    if (previous && previous.owner !== owner) throw new HttpError(409, 'peer_identity_conflict');
    if (action === 'withdraw') {
      if (previous || retained.length !== rows.length) { t.db.set(key, rows.filter(row => row.advertisement.peerId !== peerId)); if (previous) notify(t, bound?.connection); }
      return { withdrawn: peerId };
    }
    if (!bound) throw new HttpError(409, 'peer_discovery_watch_required', 'Open this participant discovery subscription before advertising');
    if (previous && previous.connection === bound.connection && JSON.stringify(previous.advertisement) === JSON.stringify(advertisement)) return presence(previous);
    const row: StoredAdvertisement = { advertisement: advertisement!, owner, principal, connection: bound.connection };
    t.db.set(key, [...rows.filter(row => row.advertisement.peerId !== peerId), row]); notify(t, bound.connection);
    return presence(row);
  });
}
