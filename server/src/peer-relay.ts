import { PEER_RELAY_LIMITS as LIMITS, PEER_RELAY_PROTOCOL } from '../../contract/relay.mjs';
import { accountActive, pageAccessAllowed, participantIdentity, freshPrincipal, type Principal } from './access';
import { acquireRelayLease, getAccountEntitlements, quotaError, recordAccountUsage, releaseRelayLease } from './billing/entitlements';
import { HttpError } from './http';
import type { Tendril } from './tendril';

type Lane = 'reliable' | 'live';
type Pending = [sequence: number, receipt: string, bytes: number];
interface Attachment {
  kind: 'peer-relay'; channel: string; session: string; peerId: string; remotePeerId: string; lane: Lane;
  owner: string; principal: Principal; ready: boolean; expiresAt: number; authorizedUntil: number;
  received: number; pending: Pending[]; progressAt: number; window: number; packets: number;
  /** Live packets this endpoint may have in flight; echoed in ready and retained through hibernation. */
  liveWindow: number;
}
type QueuedMessage = { socket: WebSocket; message: ArrayBuffer } | { socket: WebSocket; credit: string };
interface Route { value: Attachment; other: WebSocket; recipient: Attachment }
interface Refresh {
  sockets: WebSocket[]; ownerAccount: string | null; startedAt: number; queue: QueuedMessage[]; bytes: number;
  done: Promise<void>; finish: () => void; timer: ReturnType<typeof setTimeout>;
}
// The existing two peers' reliable/live credit plus all corresponding receipts.
// Only an active policy check retains these bytes; nothing enters storage or an attachment.
const refreshMessages = 4 * (LIMITS.pendingPackets + LIMITS.livePendingPackets);
const refreshBytes = 2 * (LIMITS.pendingBytes + LIMITS.livePendingPackets * LIMITS.packetBytes) + refreshMessages * 256;
const refreshTimeoutMs = 5_000;
const RELAY_FLUSH_BYTES = 5 * 1024 * 1024;
const RELAY_FLUSH_INTERVAL_MS = 5 * 60_000;
const RELAY_ACTIVE_WINDOW_MS = 30_000;
interface RelayUsage {
  accountId: string;
  lastFlushAt: number;
  lastPacketAt: number;
  pendingBytes: number;
  pendingMs: number;
}
const refreshing = new WeakMap<Tendril, Map<string, Refresh>>();
const usageTrack = new WeakMap<Tendril, Map<string, RelayUsage>>();

function flushRelayUsage(t: Tendril, session: string, closing: boolean): void {
  const map = usageTrack.get(t);
  const entry = map?.get(session);
  if (closing) {
    map?.delete(session);
    if (map && !map.size) usageTrack.delete(t);
  }
  if (!entry) {
    if (closing) t.ctx.waitUntil(releaseRelayLease(t.env, session));
    return;
  }
  const now = t.now();
  const bytes = entry.pendingBytes;
  const ms = entry.pendingMs;
  entry.pendingBytes = 0;
  entry.pendingMs = 0;
  entry.lastFlushAt = now;
  const work: Promise<void>[] = [];
  if (bytes > 0 || ms > 0) work.push(recordAccountUsage(t.env, entry.accountId, { relayBytes: bytes, relayMs: ms }, now));
  if (closing) work.push(releaseRelayLease(t.env, session));
  if (work.length) t.ctx.waitUntil(Promise.all(work).then(() => undefined));
}

function recordRelayPacketInMemory(t: Tendril, session: string, bytes: number, now: number): void {
  const entry = usageTrack.get(t)?.get(session);
  if (!entry) return;
  entry.pendingBytes += bytes;
  const elapsed = Math.max(0, now - entry.lastPacketAt);
  entry.pendingMs += Math.min(RELAY_ACTIVE_WINDOW_MS, elapsed || 1);
  entry.lastPacketAt = now;
  if (entry.pendingBytes >= RELAY_FLUSH_BYTES || now - entry.lastFlushAt >= RELAY_FLUSH_INTERVAL_MS) {
    flushRelayUsage(t, session, false);
  }
}
const attachment = (ws: WebSocket): Attachment | null => {
  const value = ws.deserializeAttachment() as (Omit<Attachment, 'pending'> & { pending: ArrayBuffer }) | null;
  if (value?.kind !== 'peer-relay') return null;
  const bytes = new Uint8Array(value.pending), view = new DataView(value.pending), pending: Pending[] = [];
  for (let offset = 0; offset < bytes.length; offset += 24) pending.push([view.getUint32(offset),
    Array.from(bytes.subarray(offset + 4, offset + 20), byte => byte.toString(16).padStart(2, '0')).join(''), view.getUint32(offset + 20)]);
  return { ...value, pending };
};
/** Compact metadata stays within the hibernation attachment limit even at full credit. */
function write(ws: WebSocket, value: Attachment): void {
  const bytes = new Uint8Array(value.pending.length * 24), view = new DataView(bytes.buffer);
  for (const [index, [sequence, token, length]] of value.pending.entries()) {
    const offset = index * 24;
    view.setUint32(offset, sequence); view.setUint32(offset + 20, length);
    for (let i = 0; i < 16; i++) bytes[offset + 4 + i] = Number.parseInt(token.slice(i * 2, i * 2 + 2), 16);
  }
  ws.serializeAttachment({ ...value, pending: bytes.buffer });
}
export const isRelaySocket = (ws: WebSocket): boolean => attachment(ws) !== null;
const all = (t: Tendril) => t.ctx.getWebSockets('peer-relay');
function owner(t: Tendril, principal: Principal): string {
  return participantIdentity(t, principal).route;
}
async function authorize(t: Tendril, principal: Principal): Promise<number> {
  const until = t.now() + LIMITS.authorizationMs;
  owner(t, principal);
  const allowed = await pageAccessAllowed(t) && await freshPrincipal(t, principal);
  owner(t, principal);
  if (!allowed || t.now() >= until)
    throw new HttpError(403, 'forbidden', 'Peer relay access is no longer active');
  if (principal.kind === 'page' && principal.accountId) {
    const allowed = await accountActive(t, principal.accountId);
    owner(t, principal);
    if (!allowed || t.now() >= until) throw new HttpError(403, 'forbidden', 'Peer relay access is no longer active');
  }
  return until;
}
function members(t: Tendril, session: string): WebSocket[] {
  return all(t).filter(ws => ws.readyState === WebSocket.READY_STATE_OPEN && attachment(ws)?.session === session);
}
function closeSession(t: Tendril, session: string, code: number, reason: string): void {
  finishRefresh(t, session);
  flushRelayUsage(t, session, true);
  for (const ws of members(t, session)) ws.close(code, reason);
  t.scheduleAlarm();
}
function deadline(value: Attachment): number {
  return Math.min(value.expiresAt,
    value.pending.length ? value.progressAt + LIMITS.progressMs : Infinity);
}
function active(t: Tendril): WebSocket[] {
  return all(t).filter(ws => {
    const value = attachment(ws);
    if (!value || ws.readyState !== WebSocket.READY_STATE_OPEN) return false;
    try { owner(t, value.principal); }
    catch { closeSession(t, value.session, 4003, 'Peer host access revoked'); return false; }
    if (value.expiresAt <= t.now() || value.pending.length && value.progressAt + LIMITS.progressMs <= t.now()) {
      closeSession(t, value.session, 1008, 'Peer relay expired'); return false;
    }
    return true;
  });
}
/** End only the bounded bridge invocation's relay, including its remote half. */
export function closePeerRelayRoutes(t: Tendril, peerId: string): void {
  const sessions = new Set(all(t).flatMap(socket => {
    const value = attachment(socket);
    return value && (value.peerId === peerId || value.remotePeerId === peerId) ? [value.session] : [];
  }));
  for (const session of sessions) closeSession(t, session, 1000, 'Assistant call complete');
}

export function nextRelayDeadline(t: Tendril): number | null {
  const times = all(t).flatMap(ws => {
    const value = attachment(ws);
    return value && ws.readyState === WebSocket.READY_STATE_OPEN ? [deadline(value)] : [];
  });
  return times.length ? Math.min(...times) : null;
}
/** Quiet connections need only pairing, lifetime and outstanding-receipt deadlines. */
export function expireRelays(t: Tendril): void { active(t); }

function finishRefresh(t: Tendril, session: string): void {
  const sessions = refreshing.get(t), state = sessions?.get(session);
  if (!state) return;
  sessions!.delete(session);
  if (!sessions!.size) refreshing.delete(t);
  clearTimeout(state.timer);
  state.queue.length = 0; state.sockets.length = 0; state.bytes = 0;
  state.finish();
}
/** Recheck the exact admitted session after every yield, including local mutations and time passing. */
function refreshMembers(t: Tendril, session: string, state: Refresh): Attachment[] {
  const current = members(t, session), now = t.now();
  if (refreshing.get(t)?.get(session) !== state || t.db.get<string | null>('owner_account', null) !== state.ownerAccount || current.length !== 4 ||
      current.some(ws => !state.sockets.includes(ws)) || now >= state.startedAt + refreshTimeoutMs)
    throw new Error('Relay authorization expired');
  return current.map(ws => {
    const value = attachment(ws)!;
    if (!value.ready || owner(t, value.principal) !== value.owner || value.expiresAt <= now ||
        value.pending.length && value.progressAt + LIMITS.progressMs <= now) throw new Error('Relay expired');
    return value;
  });
}
/** A timeout/close releases the event handlers even if the underlying D1 request has not settled. */
function policyCheck<T>(state: Refresh, work: () => Promise<T>): Promise<T> {
  return Promise.race([work(), state.done.then(() => { throw new Error('Relay authorization cancelled'); })]);
}
async function refreshSession(t: Tendril, session: string, state: Refresh): Promise<void> {
  try {
    const values = refreshMembers(t, session, state);
    const allowed = await policyCheck(state, () => pageAccessAllowed(t));
    refreshMembers(t, session, state);
    if (!allowed) throw new Error('Peer host access revoked');
    // The page-policy join already checks its owner account. Other participants
    // need their own policy read, shared across that account's two lanes.
    const accounts = new Set(values.flatMap(value => value.principal.kind === 'page' && value.principal.accountId &&
      value.principal.accountId !== state.ownerAccount ? [value.principal.accountId] : []));
    for (const account of accounts) {
      const allowed = await policyCheck(state, () => accountActive(t, account));
      refreshMembers(t, session, state);
      if (!allowed) throw new Error('Peer account access revoked');
    }
    // Start the lease before the first policy read, so slow reads cannot extend its bound.
    for (const ws of state.sockets) write(ws, { ...attachment(ws)!, authorizedUntil: state.startedAt + LIMITS.authorizationMs });
    while (refreshing.get(t)?.get(session) === state && state.queue.length) {
      const next = state.queue.shift()!;
      if ('credit' in next) next.socket.send(next.credit);
      else forward(t, next.socket, next.message);
    }
    finishRefresh(t, session);
  } catch {
    // A late result belongs only to its original refresh, never a replacement session.
    if (refreshing.get(t)?.get(session) === state) closeSession(t, session, 4003, 'Peer host access revoked');
  }
}
function startRefresh(t: Tendril, session: string): Refresh {
  let sessions = refreshing.get(t);
  if (!sessions) refreshing.set(t, sessions = new Map());
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const state: Refresh = { sockets: members(t, session), ownerAccount: t.db.get<string | null>('owner_account', null),
    startedAt: t.now(), queue: [], bytes: 0, done, finish,
    timer: setTimeout(() => {
      if (refreshing.get(t)?.get(session) === state) closeSession(t, session, 4003, 'Peer authorization timed out');
    }, refreshTimeoutMs) };
  sessions.set(session, state);
  return state;
}

export async function handleRelay(t: Tendril, req: Request, url: URL, principal: Principal): Promise<Response> {
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).includes(PEER_RELAY_PROTOCOL))
    throw new HttpError(400, 'bad_request', `Relay requires ${PEER_RELAY_PROTOCOL}`);
  const channel = url.searchParams.get('channel'), peerId = url.searchParams.get('peerId'), remotePeerId = url.searchParams.get('remotePeerId'), lane = url.searchParams.get('lane');
  if (!channel || !/^[A-Za-z0-9_.:-]{1,160}$/.test(channel) || !peerId || !remotePeerId ||
      !/^[0-9a-f]{64}$/.test(peerId) || !/^[0-9a-f]{64}$/.test(remotePeerId) || peerId === remotePeerId || !['reliable', 'live'].includes(lane ?? ''))
    throw new HttpError(400, 'bad_request', 'Relay needs a bounded channel, reciprocal signing identities and lane');
  const requestedWindow = url.searchParams.get('liveWindow');
  const liveWindow = requestedWindow === null ? LIMITS.livePendingPackets : Number(requestedWindow);
  if (requestedWindow !== null && (!/^[1-9][0-9]?$/.test(requestedWindow) || liveWindow > LIMITS.livePendingPackets))
    throw new HttpError(400, 'bad_request', `liveWindow must be 1-${LIMITS.livePendingPackets}`);
  const authorizedUntil = await authorize(t, principal);
  const owned = owner(t, principal), sockets = active(t), existing = sockets.filter(ws => attachment(ws)!.channel === channel);
  if (existing.some(ws => {
    const value = attachment(ws)!;
    return value.ready || value.peerId === peerId && (value.owner !== owned || value.lane === lane) ||
      !(value.peerId === peerId && value.remotePeerId === remotePeerId || value.peerId === remotePeerId && value.remotePeerId === peerId);
  })) throw new HttpError(409, 'peer_channel_full', 'A relay pairs exactly two endpoints with two distinct lanes');
  const sessionIds = new Set(sockets.map(ws => attachment(ws)!.session));
  const budget = participantIdentity(t, principal).budget;
  const ownedSessions = new Set(sockets.filter(ws => participantIdentity(t, attachment(ws)!.principal).budget === budget).map(ws => attachment(ws)!.session));
  const first = existing.length ? attachment(existing[0])! : null;
  if (!first && sessionIds.size >= LIMITS.sessions || (!first || !ownedSessions.has(first.session)) && ownedSessions.size >= LIMITS.sessionsPerPrincipal)
    throw new HttpError(429, 'peer_quota', 'The bounded relay directory is full');
  const now = t.now();
  const sessionId = first?.session ?? crypto.randomUUID();
  let sessionLifetimeMs = LIMITS.lifetimeMs;
  const pageOwner = t.db.get<string | null>('owner_account', null);
  if (existing.length === 3 && pageOwner) {
    const ent = await getAccountEntitlements(t.env, pageOwner, now);
    sessionLifetimeMs = ent.quotas.relayLifetimeMs;
    if (ent.quotas.relayMsPerMonth !== null && ent.usage.relayMs >= ent.quotas.relayMsPerMonth) {
      throw quotaError({
        env: t.env,
        quota: 'relay_duration',
        plan: ent.plan,
        used: Math.round(ent.usage.relayMs / 60_000),
        limit: Math.round(ent.quotas.relayMsPerMonth / 60_000),
        resetsAt: ent.usage.resetsAt,
        message: `Monthly host relay allowance reached (${Math.round(ent.quotas.relayMsPerMonth / 3_600_000)} active hrs on ${ent.plan}). Direct peer-to-peer sync stays unlimited.`,
        localAlternative: 'Check docs/TRANSPORT_DIAGNOSTICS.md to enable direct UDP WebRTC, upgrade for priority relay + TURN, or self-host on Cloudflare.',
      });
    }
    const lease = await acquireRelayLease(t.env, pageOwner, t.tid, sessionId, now + sessionLifetimeMs, ent.quotas.relayConcurrentSessions, now);
    if (!lease.allowed && ent.quotas.relayConcurrentSessions !== null) {
      throw quotaError({
        env: t.env,
        quota: 'relay_concurrent',
        plan: ent.plan,
        used: lease.active,
        limit: ent.quotas.relayConcurrentSessions,
        resetsAt: null,
        message: `Your ${ent.plan} plan allows up to ${ent.quotas.relayConcurrentSessions} concurrent host relay sessions across your account.`,
        localAlternative: 'Direct WebRTC connections have no relay session limit. Close an idle relayed tab, upgrade for more relay slots, or self-host.',
      });
    }
  }
  const [client, server] = Object.values(new WebSocketPair());
  const value: Attachment = { kind: 'peer-relay', channel, session: sessionId, peerId, remotePeerId, lane: lane as Lane,
    owner: owned, principal, ready: false, expiresAt: first?.expiresAt ?? now + LIMITS.pairingMs,
    authorizedUntil, received: 0, pending: [], progressAt: now, window: now, packets: 0, liveWindow };
  t.ctx.acceptWebSocket(server, ['peer-relay']); write(server, value);
  const group = [...existing, server];
  if (group.length === 4) {
    if (pageOwner) {
      let map = usageTrack.get(t);
      if (!map) usageTrack.set(t, map = new Map());
      map.set(sessionId, { accountId: pageOwner, lastFlushAt: now, lastPacketAt: now, pendingBytes: 0, pendingMs: 0 });
    }
    for (const socket of group) {
      const current = attachment(socket)!;
      write(socket, { ...current, ready: true, expiresAt: now + sessionLifetimeMs });
    }
    for (const socket of group) {
      const current = attachment(socket)!;
      socket.send(JSON.stringify({ t: 'ready', version: 1, session: current.session, lane: current.lane, peerId: current.peerId, remotePeerId: current.remotePeerId,
        liveWindow: current.liveWindow }));
    }
  }
  t.scheduleAlarm();
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PEER_RELAY_PROTOCOL } });
}

function endpoints(t: Tendril, value: Attachment): Route {
  owner(t, value.principal);
  const now = t.now();
  if (!value.ready || value.expiresAt <= now || value.pending.length && value.progressAt + LIMITS.progressMs <= now) throw new Error('Relay expired');
  const other = members(t, value.session).find(socket => {
    const recipient = attachment(socket)!;
    return recipient.peerId === value.remotePeerId && recipient.remotePeerId === value.peerId && recipient.lane === value.lane;
  });
  if (!other) throw new Error('Relay peer disconnected');
  const recipient = attachment(other)!; owner(t, recipient.principal);
  if (!recipient.ready || recipient.expiresAt <= now || recipient.pending.length && recipient.progressAt + LIMITS.progressMs <= now)
    throw new Error('Relay expired');
  return { value, other, recipient };
}
/** Warm traffic is synchronous. Only expired admission temporarily buffers a bounded burst. */
export function handleRelayMessage(t: Tendril, ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
  const value = attachment(ws);
  if (!value || ws.readyState !== WebSocket.READY_STATE_OPEN) return;
  try {
    const route = endpoints(t, value), existing = refreshing.get(t)?.get(value.session);
    if (!existing && Math.min(value.authorizedUntil, route.recipient.authorizedUntil) > t.now()) return forward(t, ws, message, route);
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message).length : message.byteLength;
    if (typeof message === 'string' ? bytes > 256 : bytes <= 4 || bytes > LIMITS.packetBytes + 4) throw new Error('Relay packet too large');
    const state = existing ?? startRefresh(t, value.session);
    if (state.queue.length >= refreshMessages || state.bytes + bytes > refreshBytes) throw new Error('Relay authorization queue exhausted');
    const queued = typeof message === 'string'
      ? { socket: route.other, credit: receiveReceipt(t, message, route) }
      : { socket: ws, message };
    state.queue.push(queued); state.bytes += bytes;
    if (!existing) void refreshSession(t, value.session, state);
    return state.done;
  } catch { closeSession(t, value.session, 1008, 'Invalid or unauthorized peer relay'); }
}

/** Accept progress when a receipt arrives; its credit can wait for policy. */
function receiveReceipt(t: Tendril, message: string, { value, other, recipient }: Route): string {
  if (new TextEncoder().encode(message).length > 256) throw new Error('Relay control too large');
  const input = JSON.parse(message), pending = recipient.pending[0];
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 4 || input.t !== 'received' || input.session !== value.session ||
      !pending || input.sequence !== pending[0] || input.receipt !== pending[1]) throw new Error('Invalid relay receipt');
  write(other, { ...recipient, pending: recipient.pending.slice(1), progressAt: t.now() });
  return JSON.stringify({ t: 'credit', session: value.session, sequence: input.sequence });
}

/** No ciphertext survives forwarding in attachments or storage. */
function forward(t: Tendril, ws: WebSocket, message: string | ArrayBuffer, checked?: Route): void {
  const value = checked?.value ?? attachment(ws);
  if (!value || ws.readyState !== WebSocket.READY_STATE_OPEN) return;
  try {
    const route = checked ?? endpoints(t, value), { other, recipient } = route;
    if (Math.min(value.authorizedUntil, recipient.authorizedUntil) <= t.now()) throw new Error('Relay authorization expired');
    if (typeof message === 'string') {
      other.send(receiveReceipt(t, message, route));
      return;
    }
    if (message.byteLength <= 4 || message.byteLength > LIMITS.packetBytes + 4) throw new Error('Relay packet too large');
    const sequence = new DataView(message).getUint32(0), bytes = message.byteLength - 4;
    if (sequence !== value.received + 1) throw new Error('Invalid relay packet sequence');
    const now = t.now(), packets = now - value.window < 1000 ? value.packets + 1 : 1;
    if (packets > (value.lane === 'live' ? LIMITS.livePacketsPerSecond : LIMITS.reliablePacketsPerSecond)) throw new Error('Relay packet rate exceeded');
    const next = { ...value, received: sequence, packets, window: now - value.window < 1000 ? value.window : now };
    if (value.pending.length >= (value.lane === 'live' ? value.liveWindow : LIMITS.pendingPackets) || value.pending.reduce((sum, item) => sum + item[2], 0) + bytes > LIMITS.pendingBytes) {
      if (value.lane !== 'live') throw new Error('Relay send credit exhausted');
      write(ws, next); ws.send(JSON.stringify({ t: 'credit', session: value.session, sequence })); return;
    }
    const token = crypto.getRandomValues(new Uint8Array(16)), receipt = Array.from(token, byte => byte.toString(16).padStart(2, '0')).join('');
    const packet = new Uint8Array(20 + bytes); new DataView(packet.buffer).setUint32(0, sequence);
    packet.set(token, 4); packet.set(new Uint8Array(message, 4), 20);
    write(ws, { ...next, pending: [...value.pending, [sequence, receipt, bytes]], progressAt: value.pending.length ? value.progressAt : now });
    other.send(packet.buffer);
    recordRelayPacketInMemory(t, value.session, bytes, now);
    if (!value.pending.length) t.scheduleAlarm();
  } catch { closeSession(t, value.session, 1008, 'Invalid or unauthorized peer relay'); }
}
export function closeRelay(t: Tendril, ws: WebSocket): void {
  const value = attachment(ws);
  if (value) closeSession(t, value.session, 1013, 'Peer relay disconnected');
}
