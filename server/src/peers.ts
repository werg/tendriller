import { PEER_RENDEZVOUS_LIMITS as LIMITS, PEER_RENDEZVOUS_PROTOCOL, validatePeerBootstrap, validatePeerDescription, validatePeerIceCandidate } from '../../contract/peers.mjs';
import { participantIdentity, requireAgentScope, pageAccessAllowed, accountActive, freshPrincipal } from './access';
import type { Principal } from './access';
import { HttpError, json, readJson } from './http';
import {
  closeHubSubscriber, deleteHubSubscriber, deliverHubData, getHubSubscriber, listHubSubscribers, putHubSubscriber,
  type HubStreamDataResult, type HubStreamOpenResult, type HubStreamRef, type HubSubscriber,
} from './hub-streams';
import type { Tendril } from './tendril';
import { handlePeerParticipant } from './peer-participant';
import { handleDiscoveryWatch, exchangeDiscovery } from './discovery';
import { handleInvitations, sendPeerInvitation } from './peer-invitations';
import { handleRelay } from './peer-relay';
import { handleEnrollment, handleSnapshot } from './authority';
import { exchangePeerPublication } from './peer-publications';
import { handleRealtimeIce, handleRealtimeSfu } from './realtime';

export const PEER_ROUTE = /^peers\/(?:bootstrap|rendezvous|invitations|participant|relay|enrollment|publication|snapshot|invite|discovery|discovery\/watch|ice|sfu\/(?:sessions|tracks|renegotiate|close|usage|room))$/;
/** Public connection configuration is read while serving the page, without a second discovery request. */
export function peerBootstrap(t: Tendril) {
  return validatePeerBootstrap(t.db.get('peer_bootstrap', { version: 2, endpoints: [] }));
}
export interface PeerState {
  channel: string; session: string; peerId: string; principal: Principal;
  role: 'offerer' | 'answerer'; expiresAt: number; ready: boolean; sent: boolean; candidates: number; complete: boolean;
}
interface PeerAttachment extends PeerState { kind: 'rendezvous' }
type PeerEndpoint =
  | { kind: 'ws'; ws: WebSocket; value: PeerAttachment }
  | { kind: 'hub'; sub: HubSubscriber<PeerState>; value: PeerState };

function sameEndpoint(a: PeerEndpoint, b: PeerEndpoint): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'ws' ? a.ws === (b as { kind: 'ws'; ws: WebSocket }).ws : a.sub.key === (b as { kind: 'hub'; sub: HubSubscriber<PeerState> }).sub.key;
}
function attachment(ws: WebSocket): PeerAttachment | null {
  const value = ws.deserializeAttachment() as PeerAttachment | null;
  return value?.kind === 'rendezvous' ? value : null;
}
export const isPeerSocket = (ws: WebSocket): boolean => attachment(ws) !== null;
function authorized(t: Tendril, principal: Principal): boolean {
  try { participantIdentity(t, principal); return true; }
  catch { return false; }
}
const identifier = (value: string | null): string => {
  if (!value || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new HttpError(400, 'bad_request', 'A bounded channel and peerId are required');
  return value;
};
function peers(t: Tendril, channel?: string): PeerEndpoint[] {
  const result: PeerEndpoint[] = [];
  for (const ws of t.ctx.getWebSockets('rendezvous')) {
    const value = attachment(ws);
    if (ws.readyState !== WebSocket.READY_STATE_OPEN || !value || value.complete) continue;
    if (value.expiresAt <= t.now()) { ws.close(1008, 'Rendezvous expired'); continue; }
    if (!authorized(t, value.principal)) { ws.close(4003, 'Peer host access revoked'); continue; }
    if (channel === undefined || value.channel === channel) result.push({ kind: 'ws', ws, value });
  }
  for (const sub of listHubSubscribers<PeerState>(t, 'rendezvous')) {
    const value = sub.state;
    if (!value || value.complete) { deleteHubSubscriber(t, sub.key); continue; }
    if (value.expiresAt <= t.now()) { closeHubSubscriber(t, sub, 1008, 'Rendezvous expired'); continue; }
    if (!authorized(t, value.principal)) { closeHubSubscriber(t, sub, 4003, 'Peer host access revoked'); continue; }
    if (channel === undefined || value.channel === channel) result.push({ kind: 'hub', sub, value });
  }
  return result;
}
export function nextPeerDeadline(t: Tendril): number | null {
  const times: number[] = [];
  for (const ws of t.ctx.getWebSockets('rendezvous')) {
    const value = attachment(ws);
    if (value && !value.complete && ws.readyState === WebSocket.READY_STATE_OPEN) times.push(value.expiresAt);
  }
  for (const sub of listHubSubscribers<PeerState>(t, 'rendezvous')) {
    if (sub.state && !sub.state.complete) times.push(sub.state.expiresAt);
  }
  return times.length ? Math.min(...times) : null;
}
export function expirePeers(t: Tendril): void { peers(t); }

function saveEndpoint(t: Tendril, ep: PeerEndpoint, next: PeerState): void {
  if (ep.kind === 'ws') ep.ws.serializeAttachment({ kind: 'rendezvous', ...next } satisfies PeerAttachment);
  else putHubSubscriber<PeerState>(t, { ...ep.sub, state: next });
}
function refreshEndpoint(t: Tendril, ep: PeerEndpoint): PeerEndpoint | null {
  if (ep.kind === 'ws') {
    const value = ep.ws.readyState === WebSocket.READY_STATE_OPEN ? attachment(ep.ws) : null;
    return value ? { kind: 'ws', ws: ep.ws, value } : null;
  }
  const sub = getHubSubscriber<PeerState>(t, ep.sub.key);
  return sub ? { kind: 'hub', sub, value: sub.state } : null;
}
async function sendToEndpoint(t: Tendril, ep: PeerEndpoint, text: string): Promise<boolean> {
  if (ep.kind === 'ws') {
    if (ep.ws.readyState !== WebSocket.READY_STATE_OPEN) return false;
    try { ep.ws.send(text); return true; } catch { return false; }
  }
  return (await deliverHubData(t, ep.sub, text)) === 'delivered';
}
function closeEndpoint(t: Tendril, ep: PeerEndpoint, code: number, reason: string, { notify = true } = {}): void {
  if (ep.kind === 'ws') {
    if (ep.ws.readyState === WebSocket.READY_STATE_OPEN) {
      try { ep.ws.close(code, reason); } catch {}
    }
  } else {
    closeHubSubscriber(t, ep.sub, code, reason, { notify });
  }
}

export async function handlePeers(t: Tendril, req: Request, url: URL, path: string, principal: Principal): Promise<Response> {
  if (!authorized(t, principal) || !await freshPrincipal(t, principal)) throw new HttpError(403, 'forbidden', 'Rendezvous requires an authorized page or agent identity');
  if (path === 'peers/discovery/watch') return handleDiscoveryWatch(t, req, url, principal);
  if (path === 'peers/enrollment') return handleEnrollment(t, req, principal);
  if (path === 'peers/snapshot') return handleSnapshot(t, req, principal);
  if (path === 'peers/publication') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const input = await readJson(req, 12 * 1024 * 1024) as Record<string, unknown>;
    if (!input || !['read', 'publish'].includes(String(input.action))) throw new HttpError(400, 'publication_action_invalid');
    const { action, ...payload } = input;
    return json(await exchangePeerPublication(t, principal, action as 'read' | 'publish', payload));
  }
  if (path === 'peers/discovery' || path === 'peers/invite') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const input = await readJson(req, 256 * 1024) as Record<string, unknown>;
    if (path === 'peers/invite') return json(await sendPeerInvitation(t, principal, input));
    const { action, ...payload } = input;
    if (!['read', 'advertise', 'withdraw'].includes(String(action))) throw new HttpError(400, 'discovery_action_invalid');
    return json(await exchangeDiscovery(t, principal, action as 'read' | 'advertise' | 'withdraw', payload));
  }
  if (path === 'peers/participant') return handlePeerParticipant(t, req, principal);
  if (path === 'peers/invitations') return handleInvitations(t, req, url, principal);
  if (path === 'peers/relay') return handleRelay(t, req, url, principal);
  if (path === 'peers/ice') return handleRealtimeIce(t, req, principal);
  if (path.startsWith('peers/sfu/')) return handleRealtimeSfu(t, req, url, path.slice('peers/sfu/'.length), principal);
  if (path === 'peers/bootstrap') {
    if (req.method === 'GET') return json(peerBootstrap(t));
    if (req.method === 'PUT') {
      if (principal.kind !== 'agent' && !(principal.kind === 'page' && principal.role === 'owner')) throw new HttpError(403, 'forbidden');
      if (principal.kind === 'agent') requireAgentScope(principal, 'host:manage');
      let value;
      try { value = validatePeerBootstrap(await readJson(req, 20_000)); }
      catch (error) { throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : 'Invalid bootstrap hints'); }
      if (!authorized(t, principal)) throw new HttpError(403, 'forbidden');
      if (JSON.stringify(t.db.get('peer_bootstrap', null)) !== JSON.stringify(value)) t.db.set('peer_bootstrap', value);
      return json(value);
    }
    throw new HttpError(405, 'method_not_allowed');
  }
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
  if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).includes(PEER_RENDEZVOUS_PROTOCOL))
    throw new HttpError(400, 'bad_request', `Rendezvous requires ${PEER_RENDEZVOUS_PROTOCOL}`);
  const channel = identifier(url.searchParams.get('channel')), peerId = identifier(url.searchParams.get('peerId'));
  const existing = peers(t, channel);
  if (existing.length >= 2 || existing.some(p => p.value.ready || p.value.peerId === peerId))
    throw new HttpError(409, 'peer_channel_full', 'A rendezvous has exactly two distinct endpoints');
  const pendingPeers = peers(t), budget = participantIdentity(t, principal).budget;
  if (pendingPeers.length >= LIMITS.sessions * 2 || pendingPeers.filter(p => participantIdentity(t, p.value.principal).budget === budget).length >= LIMITS.sessions)
    throw new HttpError(429, 'peer_quota', 'Too many pending rendezvous for this account or application');
  const [client, server] = Object.values(new WebSocketPair());
  const first = existing.length ? existing[0] : null;
  const value: PeerAttachment = {
    kind: 'rendezvous', channel, session: first?.value.session ?? crypto.randomUUID(), peerId, principal,
    role: first ? 'answerer' : 'offerer', expiresAt: first?.value.expiresAt ?? t.now() + LIMITS.lifetimeMs,
    ready: !!first, sent: false, candidates: 0, complete: false,
  };
  t.ctx.acceptWebSocket(server, ['rendezvous']);
  server.serializeAttachment(value);
  if (first) {
    saveEndpoint(t, first, { ...first.value, ready: true });
    const readyFirst = JSON.stringify({ t: 'ready', version: 2, session: value.session, role: first.value.role });
    const delivered = await sendToEndpoint(t, first, readyFirst);
    if (!delivered) {
      closeEndpoint(t, first, 1013, 'Rendezvous peer disconnected', { notify: false });
      server.close(1013, 'Rendezvous peer disconnected');
    } else if (server.readyState === WebSocket.READY_STATE_OPEN) {
      server.send(JSON.stringify({ t: 'ready', version: 2, session: value.session, role: value.role }));
    }
  }
  t.scheduleAlarm();
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PEER_RENDEZVOUS_PROTOCOL } });
}

/** Stateless hub-backed rendezvous subscription. */
export async function openRendezvousHubStream(
  t: Tendril,
  url: URL,
  protocols: string[],
  principal: Principal,
  ref: HubStreamRef,
): Promise<HubStreamOpenResult> {
  if (!authorized(t, principal) || !await freshPrincipal(t, principal))
    throw new HttpError(403, 'forbidden', 'Rendezvous requires an authorized page or agent identity');
  if (!protocols.includes(PEER_RENDEZVOUS_PROTOCOL))
    throw new HttpError(400, 'bad_request', `Rendezvous requires ${PEER_RENDEZVOUS_PROTOCOL}`);
  const channel = identifier(url.searchParams.get('channel')), peerId = identifier(url.searchParams.get('peerId'));
  const existing = peers(t, channel);
  if (existing.length >= 2 || existing.some(p => p.value.ready || p.value.peerId === peerId))
    throw new HttpError(409, 'peer_channel_full', 'A rendezvous has exactly two distinct endpoints');
  const pendingPeers = peers(t), budget = participantIdentity(t, principal).budget;
  if (pendingPeers.length >= LIMITS.sessions * 2 || pendingPeers.filter(p => participantIdentity(t, p.value.principal).budget === budget).length >= LIMITS.sessions)
    throw new HttpError(429, 'peer_quota', 'Too many pending rendezvous for this account or application');
  const first = existing.length ? existing[0] : null;
  let state: PeerState = {
    channel, session: first?.value.session ?? crypto.randomUUID(), peerId, principal,
    role: first ? 'answerer' : 'offerer', expiresAt: first?.value.expiresAt ?? t.now() + LIMITS.lifetimeMs,
    ready: !!first, sent: false, candidates: 0, complete: false,
  };
  putHubSubscriber<PeerState>(t, { ...ref, kind: 'rendezvous', state, createdAt: t.now() });
  const initial: string[] = [];
  if (first) {
    saveEndpoint(t, first, { ...first.value, ready: true });
    const delivered = await sendToEndpoint(t, first, JSON.stringify({ t: 'ready', version: 2, session: state.session, role: first.value.role }));
    if (!delivered) {
      closeEndpoint(t, first, 1013, 'Rendezvous peer disconnected', { notify: false });
      state = {
        channel, session: crypto.randomUUID(), peerId, principal,
        role: 'offerer', expiresAt: t.now() + LIMITS.lifetimeMs,
        ready: false, sent: false, candidates: 0, complete: false,
      };
      putHubSubscriber<PeerState>(t, { ...ref, kind: 'rendezvous', state, createdAt: t.now() });
    } else {
      initial.push(JSON.stringify({ t: 'ready', version: 2, session: state.session, role: state.role }));
    }
  }
  t.scheduleAlarm();
  return { protocol: PEER_RENDEZVOUS_PROTOCOL, initial };
}

// Serialize per-socket authorization checks with a bounded in-memory queue for trickle ICE bursts.
const queues = new WeakMap<WebSocket, { pending: string[]; running: boolean; sawDescription: boolean }>();
export async function handlePeerMessage(t: Tendril, ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
  if (ws.readyState !== WebSocket.READY_STATE_OPEN) return;
  if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > LIMITS.messageBytes) {
    ws.close(1009, 'Rendezvous accepts bounded SDP/ICE signaling only'); return;
  }
  let state = queues.get(ws);
  if (!state) queues.set(ws, state = { pending: [], running: false, sawDescription: attachment(ws)?.sent === true });
  try {
    const peek = JSON.parse(message);
    if (peek && typeof peek === 'object' && peek.t === 'description') {
      if (state.sawDescription) {
        state.pending.length = 0;
        ws.close(1008, 'Only one description is allowed');
        return;
      }
      state.sawDescription = true;
    }
  } catch { /* Handled below. */ }
  if (state.pending.length >= LIMITS.maxCandidates + 2) {
    ws.close(1008, 'Too many queued rendezvous messages'); return;
  }
  state.pending.push(message);
  if (state.running) return;
  state.running = true;
  try {
    while (state.pending.length && ws.readyState === WebSocket.READY_STATE_OPEN) {
      const next = state.pending.shift()!;
      const value = attachment(ws);
      if (!value) break;
      await forwardSignaling(t, { kind: 'ws', ws, value }, next);
    }
  } catch {
    closePeer(t, ws);
    if (ws.readyState === WebSocket.READY_STATE_OPEN) ws.close(1011, 'Rendezvous failed');
  } finally {
    state.running = false;
    if (!state.pending.length) queues.delete(ws);
  }
}

/** Stateless hub-backed signaling frame handler. */
export async function handlePeerHubData(
  t: Tendril,
  sub: HubSubscriber<PeerState>,
  message: string,
): Promise<HubStreamDataResult> {
  if (new TextEncoder().encode(message).byteLength > LIMITS.messageBytes) {
    deleteHubSubscriber(t, sub.key);
    closePeerHubStream(t, sub);
    return { close: { code: 1009, reason: 'Rendezvous accepts bounded SDP/ICE signaling only' } };
  }
  try {
    return await forwardSignaling(t, { kind: 'hub', sub, value: sub.state }, message);
  } catch {
    deleteHubSubscriber(t, sub.key);
    closePeerHubStream(t, sub);
    return { close: { code: 1011, reason: 'Rendezvous failed' } };
  }
}

async function forwardSignaling(t: Tendril, sender: PeerEndpoint, message: string): Promise<HubStreamDataResult> {
  const closeSender = (code: number, reason: string, frames?: string[]): HubStreamDataResult => {
    if (sender.kind === 'ws') {
      for (const frame of frames ?? []) {
        if (sender.ws.readyState === WebSocket.READY_STATE_OPEN) try { sender.ws.send(frame); } catch {}
      }
      if (sender.ws.readyState === WebSocket.READY_STATE_OPEN) try { sender.ws.close(code, reason); } catch {}
      return {};
    }
    deleteHubSubscriber(t, sender.sub.key);
    return { ...(frames ? { frames } : {}), close: { code, reason } };
  };

  let currentSender = refreshEndpoint(t, sender);
  if (!currentSender || currentSender.value.complete) return {};
  let value = currentSender.value;
  if (!value.ready || value.expiresAt <= t.now()) return closeSender(1008, 'Invalid rendezvous state');
  let parsed: { kind: 'description'; description: { type: 'offer' | 'answer'; sdp: string } }
    | { kind: 'candidate'; candidate: ReturnType<typeof validatePeerIceCandidate> }
    | { kind: 'connected' };
  try {
    const input = JSON.parse(message);
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.session !== value.session) throw new Error('session');
    if (input.t === 'description' && Object.keys(input).length === 3 && !value.sent) {
      const description = validatePeerDescription(input.description);
      if (description.type !== (value.role === 'offerer' ? 'offer' : 'answer')) throw new Error('role');
      parsed = { kind: 'description', description };
    } else if (input.t === 'candidate' && Object.keys(input).length === 3 && value.sent && value.candidates < LIMITS.maxCandidates) {
      parsed = { kind: 'candidate', candidate: validatePeerIceCandidate(input.candidate) };
    } else if (input.t === 'connected' && Object.keys(input).length === 2 && value.sent) {
      parsed = { kind: 'connected' };
    } else {
      throw new Error('frame');
    }
  } catch { return closeSender(1008, 'Invalid or repeated WebRTC signaling'); }

  if (!authorized(t, value.principal)) return closeSender(4003, 'Peer host access revoked');
  const other = peers(t, value.channel).find(peer => !sameEndpoint(peer, currentSender!) && peer.value.session === value.session);
  if (!other) return closeSender(1013, 'Rendezvous peer disconnected');
  const ownerAccount = t.db.get<string | null>('owner_account', null);
  const senderAcc = value.principal.kind === 'page' && value.principal.accountId && value.principal.accountId !== ownerAccount ? value.principal.accountId : null;
  const otherAcc = other.value.principal.kind === 'page' && other.value.principal.accountId && other.value.principal.accountId !== ownerAccount ? other.value.principal.accountId : null;
  const [pageOk, senderAccOk, otherAccOk, senderFresh, otherFresh] = await Promise.all([
    pageAccessAllowed(t),
    senderAcc ? accountActive(t, senderAcc) : Promise.resolve(true),
    otherAcc ? (otherAcc === senderAcc ? Promise.resolve(true) : accountActive(t, otherAcc)) : Promise.resolve(true),
    freshPrincipal(t, value.principal),
    freshPrincipal(t, other.value.principal),
  ]);
  if (!pageOk || !senderAccOk || !senderFresh) return closeSender(4003, 'Peer host access revoked');
  if (!(otherAcc === senderAcc ? senderAccOk : otherAccOk) || !otherFresh) {
    closeEndpoint(t, other, 4003, 'Peer host access revoked');
    return closeSender(1013, 'Rendezvous peer disconnected');
  }
  currentSender = refreshEndpoint(t, currentSender);
  const currentOther = refreshEndpoint(t, other);
  if (!currentSender || !currentOther || currentSender.value.complete || currentOther.value.complete ||
      currentOther.value.session !== currentSender.value.session || currentSender.value.expiresAt <= t.now() ||
      !authorized(t, currentSender.value.principal) || !authorized(t, currentOther.value.principal)) {
    return closeSender(4003, 'Rendezvous is no longer authorized');
  }
  value = currentSender.value;
  const recipient = currentOther.value;

  if (parsed.kind === 'description') {
    if (value.sent || (value.role === 'answerer' && !recipient.sent)) {
      return closeSender(1008, 'An answer requires a delivered offer');
    }
    saveEndpoint(t, currentSender, { ...value, sent: true });
    const delivered = await sendToEndpoint(t, currentOther, JSON.stringify({ t: 'description', session: value.session, description: parsed.description }));
    if (!delivered) {
      closeEndpoint(t, currentOther, 1013, 'Rendezvous peer disconnected', { notify: false });
      return closeSender(1013, 'Rendezvous peer disconnected');
    }
    return {};
  }
  if (parsed.kind === 'candidate') {
    if (!value.sent || value.candidates >= LIMITS.maxCandidates) {
      return closeSender(1008, 'ICE candidate limit exceeded');
    }
    saveEndpoint(t, currentSender, { ...value, candidates: value.candidates + 1 });
    const delivered = await sendToEndpoint(t, currentOther, JSON.stringify({ t: 'candidate', session: value.session, candidate: parsed.candidate }));
    if (!delivered) {
      closeEndpoint(t, currentOther, 1013, 'Rendezvous peer disconnected', { notify: false });
      return closeSender(1013, 'Rendezvous peer disconnected');
    }
    return {};
  }
  // `connected`: both descriptions must be exchanged before closing as complete.
  if (!value.sent || !recipient.sent) {
    return closeSender(1008, 'Connected requires exchanged descriptions');
  }
  saveEndpoint(t, currentSender, { ...value, complete: true });
  saveEndpoint(t, currentOther, { ...recipient, complete: true });
  const done = JSON.stringify({ t: 'complete', session: value.session });
  try {
    await sendToEndpoint(t, currentOther, done);
  } finally {
    closeEndpoint(t, currentOther, 1000, 'Rendezvous complete');
    t.scheduleAlarm();
  }
  return closeSender(1000, 'Rendezvous complete', [done]);
}

function notifyPartnerDisconnected(t: Tendril, ep: PeerEndpoint): void {
  const value = ep.value;
  if (!value || value.complete) return;
  for (const other of peers(t, value.channel)) {
    if (!sameEndpoint(other, ep) && other.value.session === value.session) {
      closeEndpoint(t, other, 1013, 'Rendezvous peer disconnected');
    }
  }
  t.scheduleAlarm();
}

export function closePeer(t: Tendril, ws: WebSocket): void {
  const value = attachment(ws);
  if (!value) return;
  notifyPartnerDisconnected(t, { kind: 'ws', ws, value });
}

export function closePeerHubStream(t: Tendril, sub: HubSubscriber<PeerState>): void {
  if (!sub.state) return;
  notifyPartnerDisconnected(t, { kind: 'hub', sub, value: sub.state });
}
