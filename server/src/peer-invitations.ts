import { PEER_INVITATION_LIMITS as LIMITS, PEER_INVITATION_PROTOCOL, validatePeerInvitation,
  type PeerInvitation } from '../../contract/invitations.mjs';
import { validatePeerId } from '../../contract/discovery.mjs';
import { accountActive, currentPrincipal, freshPrincipal, pageAccessAllowed, participantIdentity, type Principal } from './access';
import { HttpError } from './http';
import {
  closeHubSubscriber, deleteHubSubscriber, deliverHubData, getHubSubscriber, listHubSubscribers, putHubSubscriber,
  type HubStreamDataResult, type HubStreamOpenResult, type HubStreamRef, type HubSubscriber,
} from './hub-streams';
import type { Tendril } from './tendril';

interface PendingInvitation extends PeerInvitation { fingerprint: string }
export interface InvitationState {
  peerId: string; owner: string; principal: Principal;
  window: number; seen: PendingInvitation[]; pending: PendingInvitation[];
}
interface Attachment extends InvitationState { kind: 'peer-invitations' }
type InvitationListener =
  | { kind: 'ws'; ws: WebSocket; value: Attachment }
  | { kind: 'hub'; sub: HubSubscriber<InvitationState>; value: InvitationState };

const attachment = (ws: WebSocket): Attachment | null => {
  const value = ws.deserializeAttachment() as Attachment | null;
  return value?.kind === 'peer-invitations' ? value : null;
};
export const isInvitationSocket = (ws: WebSocket): boolean => attachment(ws) !== null;
function identity(t: Tendril, principal: Principal): string {
  return participantIdentity(t, principal).route;
}
async function fresh(t: Tendril, principal: Principal): Promise<void> {
  identity(t, principal);
  if (!await pageAccessAllowed(t) || principal.kind === 'page' && principal.accountId && !await accountActive(t, principal.accountId) || !await freshPrincipal(t, principal))
    throw new HttpError(403, 'forbidden', 'Peer invitation access is no longer active');
  identity(t, principal);
}
function retireWs(ws: WebSocket, code: number, reason: string): void {
  // Detach before closing so a half-open or hibernated socket can never be
  // matched ahead of its replacement listener.
  try { ws.serializeAttachment(null); } catch {}
  try { ws.close(code, reason); } catch {}
}
function retireListener(t: Tendril, listener: InvitationListener, code: number, reason: string): void {
  if (listener.kind === 'ws') retireWs(listener.ws, code, reason);
  else closeHubSubscriber(t, listener.sub, code, reason);
}
function active(t: Tendril): InvitationListener[] {
  const result: InvitationListener[] = [];
  for (const ws of t.ctx.getWebSockets('peer-invitations')) {
    const value = attachment(ws);
    if (ws.readyState !== WebSocket.READY_STATE_OPEN || !value) continue;
    if (!currentPrincipal(t, value.principal)) { retireWs(ws, 4003, 'Peer host access revoked'); continue; }
    result.push({ kind: 'ws', ws, value });
  }
  for (const sub of listHubSubscribers<InvitationState>(t, 'peer-invitations')) {
    if (!currentPrincipal(t, sub.state.principal)) {
      closeHubSubscriber(t, sub, 4003, 'Peer host access revoked');
      continue;
    }
    result.push({ kind: 'hub', sub, value: sub.state });
  }
  return result;
}

/** No timer, heartbeat or application data. A new join explicitly wakes the selected listener. */
export async function handleInvitations(t: Tendril, req: Request, url: URL, principal: Principal): Promise<Response> {
  const owner = identity(t, principal);
  if (req.method === 'GET') {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required');
    if (!(req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).includes(PEER_INVITATION_PROTOCOL))
      throw new HttpError(400, 'bad_request', `Invitations require ${PEER_INVITATION_PROTOCOL}`);
    let peerId: string;
    try { peerId = validatePeerId(url.searchParams.get('peerId')); }
    catch { throw new HttpError(400, 'bad_request', 'A bounded peer identity is required'); }
    await fresh(t, principal);
    const listeners = active(t), previous = listeners.filter(l => l.value.peerId === peerId);
    if (previous.some(l => l.value.owner !== owner)) throw new HttpError(409, 'peer_identity_conflict');
    const budget = participantIdentity(t, principal).budget;
    if (!previous.length && (listeners.length >= LIMITS.listeners || listeners.filter(l => participantIdentity(t, l.value.principal).budget === budget).length >= LIMITS.listenersPerPrincipal))
      throw new HttpError(429, 'peer_listener_full', 'The bounded invitation directory is full');
    for (const stale of previous) retireListener(t, stale, 1000, 'Invitation listener replaced');
    const [client, server] = Object.values(new WebSocketPair());
    t.ctx.acceptWebSocket(server, ['peer-invitations']);
    server.serializeAttachment({ kind: 'peer-invitations', peerId, owner, principal, window: t.now(), seen: [], pending: [] } satisfies Attachment);
    server.send(JSON.stringify({ t: 'ready', version: 1, peerId }));
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PEER_INVITATION_PROTOCOL } });
  }
  throw new HttpError(405, 'method_not_allowed');
}

/** Stateless hub-backed invitation listener subscription. */
export async function openInvitationHubStream(
  t: Tendril,
  url: URL,
  protocols: string[],
  principal: Principal,
  ref: HubStreamRef,
): Promise<HubStreamOpenResult> {
  const owner = identity(t, principal);
  if (!protocols.includes(PEER_INVITATION_PROTOCOL))
    throw new HttpError(400, 'bad_request', `Invitations require ${PEER_INVITATION_PROTOCOL}`);
  let peerId: string;
  try { peerId = validatePeerId(url.searchParams.get('peerId')); }
  catch { throw new HttpError(400, 'bad_request', 'A bounded peer identity is required'); }
  await fresh(t, principal);
  const listeners = active(t), previous = listeners.filter(l => l.value.peerId === peerId);
  if (previous.some(l => l.value.owner !== owner)) throw new HttpError(409, 'peer_identity_conflict');
  const budget = participantIdentity(t, principal).budget;
  if (!previous.length && (listeners.length >= LIMITS.listeners || listeners.filter(l => participantIdentity(t, l.value.principal).budget === budget).length >= LIMITS.listenersPerPrincipal))
    throw new HttpError(429, 'peer_listener_full', 'The bounded invitation directory is full');
  for (const stale of previous) retireListener(t, stale, 1000, 'Invitation listener replaced');
  putHubSubscriber<InvitationState>(t, {
    ...ref,
    kind: 'peer-invitations',
    state: { peerId, owner, principal, window: t.now(), seen: [], pending: [] },
    createdAt: t.now(),
  });
  return { protocol: PEER_INVITATION_PROTOCOL, initial: [JSON.stringify({ t: 'ready', version: 1, peerId })] };
}

export async function sendPeerInvitation(t: Tendril, principal: Principal, input: any): Promise<{ invited: string; channel: string }> {
  const owner = identity(t, principal);
  let peerId: string, invitation: PeerInvitation;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3) throw new Error('fields');
    peerId = validatePeerId(input.peerId);
    invitation = validatePeerInvitation({ channel: input.channel, requesterPeerId: input.requesterPeerId });
    if (peerId === invitation.requesterPeerId) throw new Error('self invitation');
  } catch { throw new HttpError(400, 'bad_request', 'Expected only a target peer and bounded invitation'); }
  const recipient = active(t).filter(l => l.value.peerId === peerId).at(-1);
  if (!recipient) throw new HttpError(404, 'peer_unavailable', 'The peer is not listening for invitations');
  const original = recipient.value;
  identity(t, original.principal);
  const ownerAccount = t.db.get<string | null>('owner_account', null);
  const senderAcc = principal.kind === 'page' && principal.accountId && principal.accountId !== ownerAccount ? principal.accountId : null;
  const recipientAcc = original.principal.kind === 'page' && original.principal.accountId && original.principal.accountId !== ownerAccount ? original.principal.accountId : null;
  const [pageOk, senderAccOk, recipientAccOk, senderFresh, recipientFresh] = await Promise.all([
    pageAccessAllowed(t),
    senderAcc ? accountActive(t, senderAcc) : Promise.resolve(true),
    recipientAcc ? (recipientAcc === senderAcc ? Promise.resolve(true) : accountActive(t, recipientAcc)) : Promise.resolve(true),
    freshPrincipal(t, principal),
    freshPrincipal(t, original.principal),
  ]);
  const senderOk = pageOk && senderAccOk && Boolean(senderFresh);
  const recipientOk = pageOk && (recipientAcc === senderAcc ? senderAccOk : recipientAccOk) && Boolean(recipientFresh);
  if (!senderOk) throw new HttpError(403, 'forbidden', 'Peer invitation access is no longer active');
  if (!recipientOk) {
    retireListener(t, recipient, 4003, 'Peer host access revoked');
    throw new HttpError(403, 'forbidden', 'Peer invitation access is no longer active');
  }
  let current: InvitationState | null = null;
  let latestHubSub: HubSubscriber<InvitationState> | null = null;
  if (recipient.kind === 'ws') {
    current = recipient.ws.readyState === WebSocket.READY_STATE_OPEN ? attachment(recipient.ws) : null;
  } else {
    latestHubSub = getHubSubscriber<InvitationState>(t, recipient.sub.key);
    current = latestHubSub?.state ?? null;
  }
  identity(t, principal); if (current) identity(t, current.principal);
  if (!current || current.peerId !== peerId || current.owner !== original.owner)
    throw new HttpError(409, 'peer_unavailable', 'The invitation listener changed');
  const fingerprint = JSON.stringify([owner, invitation.channel, invitation.requesterPeerId]);
  const seen = t.now() - current.window < 60_000 ? current.seen : [];
  if (seen.some(item => item.fingerprint === fingerprint)) return { invited: peerId, channel: invitation.channel };
  if (seen.some(item => item.channel === invitation.channel) || current.pending.some(item => item.channel === invitation.channel))
    throw new HttpError(409, 'peer_invitation_channel_reused', 'Use a fresh channel for a different invitation');
  if (seen.length >= LIMITS.invitationsPerMinute || current.pending.length >= LIMITS.pending)
    throw new HttpError(429, 'peer_invitation_busy', 'The peer has bounded pending invitation work');
  const pending = { ...invitation, fingerprint };
  const nextState: InvitationState = {
    ...current,
    window: seen === current.seen ? current.window : t.now(),
    seen: [...seen, pending],
    pending: [...current.pending, pending],
  };
  const payload = JSON.stringify({ t: 'invitation', ...invitation });
  if (recipient.kind === 'ws') {
    recipient.ws.serializeAttachment({ kind: 'peer-invitations', ...nextState } satisfies Attachment);
    try { recipient.ws.send(payload); }
    catch { retireWs(recipient.ws, 1011, 'Invitation delivery failed'); throw new HttpError(503, 'peer_unavailable'); }
  } else {
    putHubSubscriber<InvitationState>(t, { ...latestHubSub!, state: nextState });
    const delivered = await deliverHubData(t, latestHubSub!, payload);
    if (!delivered) {
      deleteHubSubscriber(t, latestHubSub!.key);
      throw new HttpError(503, 'peer_unavailable');
    }
  }
  return { invited: peerId, channel: invitation.channel };
}

/** Consumption acknowledgements only release a bounded routing-hint slot. */
export function handleInvitationMessage(t: Tendril, ws: WebSocket, message: string | ArrayBuffer): void {
  const value = attachment(ws);
  if (!value || ws.readyState !== WebSocket.READY_STATE_OPEN) return;
  if (!currentPrincipal(t, value.principal)) { retireWs(ws, 4003, 'Peer host access revoked'); return; }
  if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > LIMITS.messageBytes) { retireWs(ws, 1009, 'Invitations accept bounded acknowledgements'); return; }
  try {
    const input = JSON.parse(message);
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 3 || input.t !== 'received') throw new Error('frame');
    const invitation = validatePeerInvitation({ channel: input.channel, requesterPeerId: input.requesterPeerId });
    const pending = value.pending.filter(item => item.channel !== invitation.channel || item.requesterPeerId !== invitation.requesterPeerId);
    if (pending.length === value.pending.length) throw new Error('unknown acknowledgement');
    ws.serializeAttachment({ ...value, pending });
  } catch { retireWs(ws, 1008, 'Invalid invitation acknowledgement'); }
}

/** Stateless hub-backed invitation acknowledgement handler. */
export function handleInvitationHubData(
  t: Tendril,
  sub: HubSubscriber<InvitationState>,
  message: string,
): HubStreamDataResult {
  const value = sub.state;
  if (!currentPrincipal(t, value.principal)) {
    deleteHubSubscriber(t, sub.key);
    return { close: { code: 4003, reason: 'Peer host access revoked' } };
  }
  if (new TextEncoder().encode(message).byteLength > LIMITS.messageBytes) {
    deleteHubSubscriber(t, sub.key);
    return { close: { code: 1009, reason: 'Invitations accept bounded acknowledgements' } };
  }
  try {
    const input = JSON.parse(message);
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 3 || input.t !== 'received') throw new Error('frame');
    const invitation = validatePeerInvitation({ channel: input.channel, requesterPeerId: input.requesterPeerId });
    const pending = value.pending.filter(item => item.channel !== invitation.channel || item.requesterPeerId !== invitation.requesterPeerId);
    if (pending.length === value.pending.length) throw new Error('unknown acknowledgement');
    putHubSubscriber<InvitationState>(t, { ...sub, state: { ...value, pending } });
    return {};
  } catch {
    deleteHubSubscriber(t, sub.key);
    return { close: { code: 1008, reason: 'Invalid invitation acknowledgement' } };
  }
}
