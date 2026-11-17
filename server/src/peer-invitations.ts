import { PEER_INVITATION_LIMITS as LIMITS, PEER_INVITATION_PROTOCOL, validatePeerInvitation,
  type PeerInvitation } from '../../contract/invitations.mjs';
import { validatePeerId } from '../../contract/discovery.mjs';
import { accountActive, currentPrincipal, pageAccessAllowed, type Principal } from './access';
import { selectedApplication } from './application';
import { HttpError, json, readJson } from './http';
import type { Tendril } from './tendril';

interface PendingInvitation extends PeerInvitation { fingerprint: string }
interface Attachment {
  kind: 'peer-invitations'; peerId: string; owner: string; principal: Principal;
  window: number; seen: PendingInvitation[]; pending: PendingInvitation[];
}
const attachment = (ws: WebSocket): Attachment | null => {
  const value = ws.deserializeAttachment() as Attachment | null;
  return value?.kind === 'peer-invitations' ? value : null;
};
export const isInvitationSocket = (ws: WebSocket): boolean => attachment(ws) !== null;
function identity(t: Tendril, principal: Principal): string {
  const current = currentPrincipal(t, principal);
  if (!current || current.kind === 'producer' || current.kind === 'page' && (current.role === 'display' || !current.accountId))
    throw new HttpError(403, 'forbidden', 'Peer invitations require an authenticated participant');
  if (selectedApplication(t).kind !== 'peer') throw new HttpError(409, 'application_backend', 'Invitations belong to a peer application');
  return current.kind === 'agent' ? `agent:${current.credentialHash}` : `account:${current.accountId}`;
}
async function fresh(t: Tendril, principal: Principal): Promise<void> {
  identity(t, principal);
  if (!await pageAccessAllowed(t) || principal.kind === 'page' && principal.accountId && !await accountActive(t, principal.accountId))
    throw new HttpError(403, 'forbidden', 'Peer invitation access is no longer active');
  identity(t, principal);
}
function active(t: Tendril): WebSocket[] {
  return t.ctx.getWebSockets('peer-invitations').filter(ws => {
    const value = attachment(ws);
    if (ws.readyState !== WebSocket.READY_STATE_OPEN || !value) return false;
    if (!currentPrincipal(t, value.principal)) { ws.close(4003, 'Peer host access revoked'); return false; }
    return true;
  });
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
    const listeners = active(t), previous = listeners.find(ws => attachment(ws)!.peerId === peerId);
    if (previous && attachment(previous)!.owner !== owner) throw new HttpError(409, 'peer_identity_conflict');
    if (!previous && (listeners.length >= LIMITS.listeners || listeners.filter(ws => attachment(ws)!.owner === owner).length >= LIMITS.listenersPerPrincipal))
      throw new HttpError(429, 'peer_listener_full', 'The bounded invitation directory is full');
    previous?.close(1000, 'Invitation listener replaced');
    const [client, server] = Object.values(new WebSocketPair());
    t.ctx.acceptWebSocket(server, ['peer-invitations']);
    server.serializeAttachment({ kind: 'peer-invitations', peerId, owner, principal, window: t.now(), seen: [], pending: [] } satisfies Attachment);
    server.send(JSON.stringify({ t: 'ready', version: 1, peerId }));
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': PEER_INVITATION_PROTOCOL } });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const input = await readJson(req, LIMITS.messageBytes);
  let peerId: string, invitation: PeerInvitation;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3) throw new Error('fields');
    peerId = validatePeerId(input.peerId);
    invitation = validatePeerInvitation({ channel: input.channel, requesterPeerId: input.requesterPeerId });
    if (peerId === invitation.requesterPeerId) throw new Error('self invitation');
  } catch { throw new HttpError(400, 'bad_request', 'Expected only a target peer and bounded invitation'); }
  const recipient = active(t).find(ws => attachment(ws)!.peerId === peerId);
  if (!recipient) throw new HttpError(404, 'peer_unavailable', 'The peer is not listening for invitations');
  const original = attachment(recipient)!;
  await fresh(t, principal);
  try { await fresh(t, original.principal); }
  catch (error) { recipient.close(4003, 'Peer host access revoked'); throw error; }
  const current = attachment(recipient)!;
  identity(t, principal); identity(t, current.principal);
  if (recipient.readyState !== WebSocket.READY_STATE_OPEN || current.peerId !== peerId || current.owner !== original.owner)
    throw new HttpError(409, 'peer_unavailable', 'The invitation listener changed');
  const fingerprint = JSON.stringify([owner, invitation.channel, invitation.requesterPeerId]);
  const seen = t.now() - current.window < 60_000 ? current.seen : [];
  if (seen.some(item => item.fingerprint === fingerprint)) return json({ invited: peerId, channel: invitation.channel });
  if (seen.some(item => item.channel === invitation.channel) || current.pending.some(item => item.channel === invitation.channel))
    throw new HttpError(409, 'peer_invitation_channel_reused', 'Use a fresh channel for a different invitation');
  if (seen.length >= LIMITS.invitationsPerMinute || current.pending.length >= LIMITS.pending)
    throw new HttpError(429, 'peer_invitation_busy', 'The peer has bounded pending invitation work');
  const pending = { ...invitation, fingerprint };
  recipient.serializeAttachment({ ...current, window: seen === current.seen ? current.window : t.now(),
    seen: [...seen, pending], pending: [...current.pending, pending] } satisfies Attachment);
  try { recipient.send(JSON.stringify({ t: 'invitation', ...invitation })); }
  catch { recipient.close(1011, 'Invitation delivery failed'); throw new HttpError(503, 'peer_unavailable'); }
  return json({ invited: peerId, channel: invitation.channel });
}

/** Consumption acknowledgements only release a bounded routing-hint slot. */
export function handleInvitationMessage(t: Tendril, ws: WebSocket, message: string | ArrayBuffer): void {
  const value = attachment(ws);
  if (!value || ws.readyState !== WebSocket.READY_STATE_OPEN) return;
  if (!currentPrincipal(t, value.principal)) { ws.close(4003, 'Peer host access revoked'); return; }
  if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > LIMITS.messageBytes) { ws.close(1009, 'Invitations accept bounded acknowledgements'); return; }
  try {
    const input = JSON.parse(message);
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 3 || input.t !== 'received') throw new Error('frame');
    const invitation = validatePeerInvitation({ channel: input.channel, requesterPeerId: input.requesterPeerId });
    const pending = value.pending.filter(item => item.channel !== invitation.channel || item.requesterPeerId !== invitation.requesterPeerId);
    if (pending.length === value.pending.length) throw new Error('unknown acknowledgement');
    ws.serializeAttachment({ ...value, pending });
  } catch { ws.close(1008, 'Invalid invitation acknowledgement'); }
}
