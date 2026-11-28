import { PEER_DIRECTORY_LIMITS as LIMITS, validatePeerAdvertisement, validatePeerId,
  type PeerAdvertisement } from '../../contract/discovery.mjs';
import { PEER_DISCOVERY_PROTOCOL as PROTOCOL } from '../../contract/discovery-watch.mjs';
import { accountActive, currentPrincipal, freshPrincipal, pageAccessAllowed, participantIdentity, type Principal } from './access';
import { selectedApplication } from './application';
import { HttpError } from './http';
import {
  closeHubSubscriber, deliverHubData, listHubSubscribers, putHubSubscriber,
  type HubStreamOpenResult, type HubStreamRef, type HubSubscriber,
} from './hub-streams';
import type { Tendril } from './tendril';

const TAG = 'peer-discovery', key = 'peer_directory';
export interface DiscoveryState { peerId: string; owner: string; connection: string; principal: Principal }
interface Attachment extends DiscoveryState { kind: typeof TAG }
interface StoredAdvertisement { advertisement: PeerAdvertisement; owner: string; principal: Principal; connection: string }
type DiscoveryListener =
  | { kind: 'ws'; ws: WebSocket; value: Attachment }
  | { kind: 'hub'; sub: HubSubscriber<DiscoveryState>; value: DiscoveryState };

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
function retireWs(ws: WebSocket, code: number, reason: string): void {
  try { ws.serializeAttachment(null); } catch {}
  try { ws.close(code, reason); } catch {}
}
function retireListener(t: Tendril, listener: DiscoveryListener, code: number, reason: string): void {
  if (listener.kind === 'ws') retireWs(listener.ws, code, reason);
  else closeHubSubscriber(t, listener.sub, code, reason);
}
function listeners(t: Tendril): DiscoveryListener[] {
  const result: DiscoveryListener[] = [];
  for (const ws of t.ctx.getWebSockets(TAG)) {
    const value = attachment(ws);
    if (!value || ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
    if (!currentPrincipal(t, value.principal)) { retireWs(ws, 4003, 'Peer host access revoked'); continue; }
    result.push({ kind: 'ws', ws, value });
  }
  for (const sub of listHubSubscribers<DiscoveryState>(t, TAG)) {
    if (!currentPrincipal(t, sub.state.principal)) {
      closeHubSubscriber(t, sub, 4003, 'Peer host access revoked');
      continue;
    }
    result.push({ kind: 'hub', sub, value: sub.state });
  }
  return result;
}
function active(t: Tendril): StoredAdvertisement[] {
  const connected = new Set(listeners(t).map(l => l.value.connection));
  return t.db.get<StoredAdvertisement[]>(key, []).filter(row => connected.has(row.connection) && currentPrincipal(t, row.principal));
}
const presence = (row: StoredAdvertisement) => ({ advertisement: row.advertisement });
function removeDiscoveryConnection(t: Tendril, connection: string): void {
  t.transaction(() => {
    const before = t.db.get<StoredAdvertisement[]>(key, []), after = before.filter(row => row.connection !== connection);
    if (before.length !== after.length) { t.db.set(key, after); notify(t, 'd'); }
  });
}
/**
 * Host revision vector, one counter per invalidation scope:
 *   c: public control ops/checkpoints   a: pending admissions / join requests
 *   d: peer directory                   m: store-and-forward mailbox
 * Counters live in this object's memory with a random nonce, so an evicted or
 * restarted object makes every client treat every scope as stale. A counter is
 * bumped synchronously with the write that changes its scope; responses capture
 * their scope's counter before reading, so a client whose last response carries
 * a counter at least the notified one already observed that change.
 * Notifications are invalidations only: they carry no state and grant nothing.
 */
export type HostScope = 'c' | 'a' | 'd' | 'm';
interface Revisions { nonce: string; c: number; a: number; d: number; m: number; lastSent?: string }
const revisions = new WeakMap<Tendril, Revisions>();
function revisionsOf(t: Tendril): Revisions {
  let value = revisions.get(t);
  if (!value) revisions.set(t, value = { nonce: crypto.randomUUID().replace(/-/g, '').slice(0, 12), c: 0, a: 0, d: 0, m: 0 });
  return value;
}
/** The scope's current revision for a response that is about to read that scope. */
export function hostRevision(t: Tendril, scope: HostScope): string {
  const value = revisionsOf(t);
  return `${value.nonce}.${value[scope]}`;
}
function revisionVector(t: Tendril): string {
  const { nonce, c, a, d, m } = revisionsOf(t);
  return `${nonce}.${c}.${a}.${d}.${m}`;
}
function bump(t: Tendril, scope: HostScope): void {
  const value = revisionsOf(t);
  if (value[scope] >= 1e9) { revisions.delete(t); revisionsOf(t); return; }
  value[scope]++;
}
const readyFrame = (t: Tendril) => JSON.stringify({ type: 'ready', rev: revisionVector(t) });

function notify(t: Tendril, scope: HostScope, except?: string) {
  bump(t, scope);
  t.afterCommit(async () => {
    // Several writes in one commit coalesce into one frame carrying the latest vector.
    const state = revisionsOf(t), rev = revisionVector(t), sentKey = `${rev}|${except ?? ''}`;
    if (state.lastSent === sentKey) return;
    state.lastSent = sentKey;
    const frame = JSON.stringify({ type: 'changed', rev });
    for (const listener of listeners(t)) {
      if (listener.value.connection === except) continue;
      if (listener.kind === 'ws') {
        try { await fresh(t, listener.value.principal); if (listener.ws.readyState === WebSocket.READY_STATE_OPEN) listener.ws.send(frame); }
        catch (err) {
          const revoked = err instanceof HttpError && err.status === 403;
          try { listener.ws.close(revoked ? 4003 : 1013, revoked ? 'Peer discovery access unavailable' : 'Transient discovery error; reconnect'); } catch {}
        }
      } else {
        try {
          await fresh(t, listener.value.principal);
          const delivery = await deliverHubData(t, listener.sub, frame);
          if (delivery === 'gone') {
            closeHubSubscriber(t, listener.sub, 1001, 'Hub stream unavailable', { notify: false });
            removeDiscoveryConnection(t, listener.value.connection);
          }
          // On 'transient_error', preserve the hub subscriber row so future updates still deliver.
        } catch (err) {
          if (err instanceof HttpError && err.status === 403) {
            closeHubSubscriber(t, listener.sub, 4003, 'Peer discovery access unavailable');
            removeDiscoveryConnection(t, listener.value.connection);
          }
        }
      }
    }
  });
}

/** Admission, key-wrap, control, mailbox and membership changes wake current discovery watchers for that scope. */
export function notifyDiscoveryWatchers(t: Tendril, scope: HostScope): void { notify(t, scope); }

/** Presence is retained by an inbound hibernating socket, without TTL renewals. */
export async function handleDiscoveryWatch(t: Tendril, req: Request, url: URL, principal: Principal): Promise<Response> {
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(x => x.trim()).includes(PROTOCOL))
    throw new HttpError(400, 'bad_request', 'Peer discovery requires its versioned WebSocket protocol');
  let peerId: string;
  try { peerId = validatePeerId(url.searchParams.get('peerId')); } catch { throw new HttpError(400, 'bad_request'); }
  await fresh(t, principal);
  const owner = identity(t, principal), all = listeners(t), previous = all.filter(l => l.value.peerId === peerId);
  if (previous.some(l => l.value.owner !== owner)) throw new HttpError(409, 'peer_identity_conflict');
  const budget = participantIdentity(t, principal).budget;
  if (!previous.length && (all.length >= LIMITS.peers || all.filter(l => participantIdentity(t, l.value.principal).budget === budget).length >= LIMITS.peersPerPrincipal))
    throw new HttpError(429, 'peer_directory_full');
  const staleConnections = new Set(previous.map(l => l.value.connection));
  for (const stale of previous) retireListener(t, stale, 4000, 'Discovery listener replaced');
  const [client, server] = Object.values(new WebSocketPair());
  t.ctx.acceptWebSocket(server, [TAG]);
  const connection = crypto.randomUUID();
  server.serializeAttachment({ kind: TAG, peerId, owner, principal, connection } satisfies Attachment);
  server.send(readyFrame(t));
  // Replacing a presence withdraws its former hint synchronously until it re-advertises.
  if (staleConnections.size) {
    t.transaction(() => {
      const before = t.db.get<StoredAdvertisement[]>(key, []);
      const after = before.filter(row => !staleConnections.has(row.connection));
      if (before.length !== after.length) t.db.set(key, after);
      notify(t, 'd', connection);
    });
  }
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PROTOCOL } });
}

/** Stateless hub-backed discovery watch subscription. */
export async function openDiscoveryHubStream(
  t: Tendril,
  url: URL,
  protocols: string[],
  principal: Principal,
  ref: HubStreamRef,
): Promise<HubStreamOpenResult> {
  if (!protocols.includes(PROTOCOL))
    throw new HttpError(400, 'bad_request', 'Peer discovery requires its versioned WebSocket protocol');
  let peerId: string;
  try { peerId = validatePeerId(url.searchParams.get('peerId')); } catch { throw new HttpError(400, 'bad_request'); }
  await fresh(t, principal);
  const owner = identity(t, principal), all = listeners(t), previous = all.filter(l => l.value.peerId === peerId);
  if (previous.some(l => l.value.owner !== owner)) throw new HttpError(409, 'peer_identity_conflict');
  const budget = participantIdentity(t, principal).budget;
  if (!previous.length && (all.length >= LIMITS.peers || all.filter(l => participantIdentity(t, l.value.principal).budget === budget).length >= LIMITS.peersPerPrincipal))
    throw new HttpError(429, 'peer_directory_full');
  const staleConnections = new Set(previous.map(l => l.value.connection));
  for (const stale of previous) retireListener(t, stale, 4000, 'Discovery listener replaced');
  const connection = crypto.randomUUID();
  putHubSubscriber<DiscoveryState>(t, { ...ref, kind: TAG, state: { peerId, owner, principal, connection }, createdAt: t.now() });
  if (staleConnections.size) {
    t.transaction(() => {
      const before = t.db.get<StoredAdvertisement[]>(key, []);
      const after = before.filter(row => !staleConnections.has(row.connection));
      if (before.length !== after.length) t.db.set(key, after);
      notify(t, 'd', connection);
    });
  }
  return { protocol: PROTOCOL, initial: [readyFrame(t)] };
}

export function closeDiscoverySocket(t: Tendril, ws: WebSocket): void {
  const value = attachment(ws); if (!value) return;
  removeDiscoveryConnection(t, value.connection);
}

export function closeDiscoveryHubStream(t: Tendril, sub: HubSubscriber<DiscoveryState>): void {
  if (!sub.state?.connection) return;
  removeDiscoveryConnection(t, sub.state.connection);
}

/** Actual changes write bounded routing hints once. Reads never renew presence. */
export async function exchangeDiscovery(t: Tendril, principal: Principal, action: 'read' | 'advertise' | 'withdraw', input?: any): Promise<unknown> {
  await fresh(t, principal);
  if (action === 'read') {
    const revision = hostRevision(t, 'd');
    const before = active(t), principals = new Map(before.map(row => [row.owner, row.principal]));
    const ownerAccount = t.db.get<string | null>('owner_account', null);
    const permitted = new Map(await Promise.all([...principals].map(async ([owner, value]) => {
      try {
        identity(t, value);
        // `fresh(t, principal)` above already verified `pageAccessAllowed(t)` (which checks the page
        // and its owner account). Only distinct guest/visitor accounts need a D1 active check here.
        if (value.kind === 'page' && value.accountId && value.accountId !== ownerAccount && !await accountActive(t, value.accountId)) {
          return [owner, false] as const;
        }
        return [owner, Boolean(await freshPrincipal(t, value))] as const;
      } catch { return [owner, false] as const; }
    })));
    identity(t, principal);
    return { applicationId: selectedApplication(t).id, peers: active(t).filter(row => permitted.get(row.owner)).map(presence), revision };
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
    const all = listeners(t), match = all.filter(l => l.value.peerId === peerId).at(-1), bound = match?.value;
    if (bound && bound.owner !== owner) throw new HttpError(409, 'peer_identity_conflict');
    const retained = t.db.get<StoredAdvertisement[]>(key, []), rows = active(t), previous = rows.find(row => row.advertisement.peerId === peerId);
    if (previous && previous.owner !== owner) throw new HttpError(409, 'peer_identity_conflict');
    if (action === 'withdraw') {
      if (previous || retained.length !== rows.length) { t.db.set(key, rows.filter(row => row.advertisement.peerId !== peerId)); if (previous) notify(t, 'd', bound?.connection); }
      return { withdrawn: peerId };
    }
    if (!bound) throw new HttpError(409, 'peer_discovery_watch_required', 'Open this participant discovery subscription before advertising');
    if (previous && previous.connection === bound.connection && JSON.stringify(previous.advertisement) === JSON.stringify(advertisement)) return presence(previous);
    const row: StoredAdvertisement = { advertisement: advertisement!, owner, principal, connection: bound.connection };
    t.db.set(key, [...rows.filter(row => row.advertisement.peerId !== peerId), row]); notify(t, 'd', bound.connection);
    return presence(row);
  });
}
