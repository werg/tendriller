import { PEER_RELAY_LIMITS as LIMITS, PEER_RELAY_PROTOCOL } from '../../contract/relay.mjs';
import { accountActive, currentPrincipal, pageAccessAllowed, type Principal } from './access';
import { HttpError } from './http';
import type { Tendril } from './tendril';

type Lane = 'reliable' | 'live';
type Pending = [sequence: number, receipt: string, bytes: number];
interface Attachment {
  kind: 'peer-relay'; channel: string; session: string; peerId: string; remotePeerId: string; lane: Lane;
  owner: string; principal: Principal; ready: boolean; expiresAt: number; authorizedUntil: number;
  received: number; pending: Pending[]; progressAt: number; window: number; packets: number;
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
  const current = currentPrincipal(t, principal);
  if (!current || current.kind === 'page' && (current.role === 'display' || !current.accountId))
    throw new HttpError(403, 'forbidden', 'Peer relay requires an authenticated participant');
  return current.kind === 'agent' ? `agent:${current.credentialHash}` : `account:${current.accountId}`;
}
async function authorize(t: Tendril, principal: Principal): Promise<void> {
  owner(t, principal);
  if (!await pageAccessAllowed(t) || principal.kind === 'page' && principal.accountId && !await accountActive(t, principal.accountId))
    throw new HttpError(403, 'forbidden', 'Peer relay access is no longer active');
  owner(t, principal);
}
function members(t: Tendril, session: string): WebSocket[] {
  return all(t).filter(ws => ws.readyState === WebSocket.READY_STATE_OPEN && attachment(ws)?.session === session);
}
function closeSession(t: Tendril, session: string, code: number, reason: string): void {
  for (const ws of members(t, session)) ws.close(code, reason);
  t.scheduleAlarm();
}
function deadline(value: Attachment): number {
  return Math.min(value.expiresAt, value.authorizedUntil,
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
export function nextRelayDeadline(t: Tendril): number | null {
  const times = all(t).flatMap(ws => {
    const value = attachment(ws);
    return value && ws.readyState === WebSocket.READY_STATE_OPEN ? [deadline(value)] : [];
  });
  return times.length ? Math.min(...times) : null;
}
/** Account policy is revalidated at most 30s apart; local credential revocation is checked on every packet. */
export async function expireRelays(t: Tendril): Promise<void> {
  const sessions = new Set(active(t).map(ws => attachment(ws)!.session));
  for (const session of sessions) {
    const selected = members(t, session);
    if (!selected.some(ws => attachment(ws)!.authorizedUntil <= t.now())) continue;
    try {
      const principals = new Map(selected.map(ws => { const value = attachment(ws)!; return [value.owner, value.principal] as const; }));
      await Promise.all([...principals.values()].map(principal => authorize(t, principal)));
      // Authorization can yield to replacement, expiry or local revocation.
      for (const ws of members(t, session)) {
        const value = attachment(ws)!;
        owner(t, value.principal);
        if (value.expiresAt <= t.now()) throw new Error('expired');
        write(ws, { ...value, authorizedUntil: t.now() + LIMITS.authorizationMs });
      }
    } catch { closeSession(t, session, 4003, 'Peer host access revoked'); }
  }
}

export async function handleRelay(t: Tendril, req: Request, url: URL, principal: Principal): Promise<Response> {
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).includes(PEER_RELAY_PROTOCOL))
    throw new HttpError(400, 'bad_request', `Relay requires ${PEER_RELAY_PROTOCOL}`);
  const channel = url.searchParams.get('channel'), peerId = url.searchParams.get('peerId'), remotePeerId = url.searchParams.get('remotePeerId'), lane = url.searchParams.get('lane');
  if (!channel || !/^[A-Za-z0-9_.:-]{1,160}$/.test(channel) || !peerId || !remotePeerId ||
      !/^[0-9a-f]{64}$/.test(peerId) || !/^[0-9a-f]{64}$/.test(remotePeerId) || peerId === remotePeerId || !['reliable', 'live'].includes(lane ?? ''))
    throw new HttpError(400, 'bad_request', 'Relay needs a bounded channel, reciprocal signing identities and lane');
  await authorize(t, principal);
  const owned = owner(t, principal), sockets = active(t), existing = sockets.filter(ws => attachment(ws)!.channel === channel);
  if (existing.some(ws => {
    const value = attachment(ws)!;
    return value.ready || value.peerId === peerId && (value.owner !== owned || value.lane === lane) ||
      !(value.peerId === peerId && value.remotePeerId === remotePeerId || value.peerId === remotePeerId && value.remotePeerId === peerId);
  })) throw new HttpError(409, 'peer_channel_full', 'A relay pairs exactly two endpoints with two distinct lanes');
  const sessionIds = new Set(sockets.map(ws => attachment(ws)!.session));
  const ownedSessions = new Set(sockets.filter(ws => attachment(ws)!.owner === owned).map(ws => attachment(ws)!.session));
  const first = existing.length ? attachment(existing[0])! : null;
  if (!first && sessionIds.size >= LIMITS.sessions || (!first || !ownedSessions.has(first.session)) && ownedSessions.size >= LIMITS.sessionsPerPrincipal)
    throw new HttpError(429, 'peer_quota', 'The bounded relay directory is full');
  const [client, server] = Object.values(new WebSocketPair()), now = t.now();
  const value: Attachment = { kind: 'peer-relay', channel, session: first?.session ?? crypto.randomUUID(), peerId, remotePeerId, lane: lane as Lane,
    owner: owned, principal, ready: false, expiresAt: first?.expiresAt ?? now + LIMITS.pairingMs,
    authorizedUntil: now + LIMITS.authorizationMs, received: 0, pending: [], progressAt: now, window: now, packets: 0 };
  t.ctx.acceptWebSocket(server, ['peer-relay']); write(server, value);
  const group = [...existing, server];
  if (group.length === 4) {
    for (const socket of group) {
      const current = attachment(socket)!;
      write(socket, { ...current, ready: true, expiresAt: now + LIMITS.lifetimeMs });
    }
    for (const socket of group) {
      const current = attachment(socket)!;
      socket.send(JSON.stringify({ t: 'ready', version: 1, session: current.session, lane: current.lane, peerId: current.peerId, remotePeerId: current.remotePeerId }));
    }
  }
  t.scheduleAlarm();
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PEER_RELAY_PROTOCOL } });
}

/** No ciphertext is retained in attachments, storage or a relay-owned payload queue. */
export function handleRelayMessage(t: Tendril, ws: WebSocket, message: string | ArrayBuffer): void {
  const value = attachment(ws);
  if (!value || ws.readyState !== WebSocket.READY_STATE_OPEN) return;
  try {
    owner(t, value.principal);
    if (!value.ready || value.expiresAt <= t.now() || value.authorizedUntil <= t.now() || value.pending.length && value.progressAt + LIMITS.progressMs <= t.now()) throw new Error('Relay expired');
    const other = members(t, value.session).find(socket => {
      const recipient = attachment(socket)!;
      return recipient.peerId === value.remotePeerId && recipient.remotePeerId === value.peerId && recipient.lane === value.lane;
    });
    if (!other) throw new Error('Relay peer disconnected');
    const recipient = attachment(other)!; owner(t, recipient.principal);
    if (recipient.authorizedUntil <= t.now()) throw new Error('Relay authorization expired');
    if (typeof message === 'string') {
      if (new TextEncoder().encode(message).length > 256) throw new Error('Relay control too large');
      const input = JSON.parse(message), pending = recipient.pending[0];
      if (!input || typeof input !== 'object' || Object.keys(input).length !== 4 || input.t !== 'received' || input.session !== value.session ||
          !pending || input.sequence !== pending[0] || input.receipt !== pending[1]) throw new Error('Invalid relay receipt');
      write(other, { ...recipient, pending: recipient.pending.slice(1), progressAt: t.now() });
      other.send(JSON.stringify({ t: 'credit', session: value.session, sequence: input.sequence }));
      return;
    }
    if (message.byteLength <= 4 || message.byteLength > LIMITS.packetBytes + 4) throw new Error('Relay packet too large');
    const sequence = new DataView(message).getUint32(0), bytes = message.byteLength - 4;
    if (sequence !== value.received + 1) throw new Error('Invalid relay packet sequence');
    const now = t.now(), packets = now - value.window < 1000 ? value.packets + 1 : 1;
    if (packets > (value.lane === 'live' ? LIMITS.livePacketsPerSecond : LIMITS.reliablePacketsPerSecond)) throw new Error('Relay packet rate exceeded');
    const next = { ...value, received: sequence, packets, window: now - value.window < 1000 ? value.window : now };
    if (value.pending.length >= (value.lane === 'live' ? 1 : LIMITS.pendingPackets) || value.pending.reduce((sum, item) => sum + item[2], 0) + bytes > LIMITS.pendingBytes) {
      if (value.lane !== 'live') throw new Error('Relay send credit exhausted');
      write(ws, next); ws.send(JSON.stringify({ t: 'credit', session: value.session, sequence })); return;
    }
    const token = crypto.getRandomValues(new Uint8Array(16)), receipt = Array.from(token, byte => byte.toString(16).padStart(2, '0')).join('');
    const packet = new Uint8Array(20 + bytes); new DataView(packet.buffer).setUint32(0, sequence);
    packet.set(token, 4); packet.set(new Uint8Array(message, 4), 20);
    write(ws, { ...next, pending: [...value.pending, [sequence, receipt, bytes]], progressAt: value.pending.length ? value.progressAt : now });
    other.send(packet.buffer);
    if (!value.pending.length) t.scheduleAlarm();
  } catch { closeSession(t, value.session, 1008, 'Invalid or unauthorized peer relay'); }
}
export function closeRelay(t: Tendril, ws: WebSocket): void {
  const value = attachment(ws);
  if (value) closeSession(t, value.session, 1013, 'Peer relay disconnected');
}
