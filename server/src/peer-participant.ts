import {
  validateParticipantRequest, createParticipantResponse, PARTICIPANT_LIMITS,
} from '@chronolog/peer-generation/participant';
import type { Principal } from './access';
import { requireAgentScope, participantIdentity, freshPrincipal } from './access';
import type { Tendril } from './tendril';
import { selectedApplication } from './application';
import { HttpError, json, readJson } from './http';
import { exchangePeerControl, peerControlError } from './peer-generations';
import { exchangePeerPublication } from './peer-publications';
import { exchangeDiscovery } from './discovery';
import { sendPeerInvitation } from './peer-invitations';

const pending = new WeakMap<Tendril, Map<string, number>>();
/** The host is a filtered control participant over authenticated HTTP. */
export async function handlePeerParticipant(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const selection = selectedApplication(t);
  const budget = participantIdentity(t, principal).budget;
  let active = pending.get(t);
  if (!active) pending.set(t, active = new Map());
  const admitted = [...active.values()].reduce((sum, count) => sum + count, 0), principalAdmitted = active.get(budget) ?? 0;
  if (admitted >= PARTICIPANT_LIMITS.pending) throw new HttpError(429, 'peer_participant_busy');
  if (principalAdmitted >= Math.max(1, Math.floor(PARTICIPANT_LIMITS.pending / 2)))
    throw new HttpError(429, 'peer_principal_busy', 'This account has bounded pending participant work; other accounts retain capacity.');
  active.set(budget, principalAdmitted + 1);
  try {
    const message = validateParticipantRequest(await readJson(req, Math.max(PARTICIPANT_LIMITS.bytes.control, PARTICIPANT_LIMITS.bytes.publication)));
    if (!await freshPrincipal(t, principal)) throw new HttpError(403, 'forbidden', 'Participant access is no longer active');
    if (message.applicationId !== selection.id) throw new HttpError(409, 'peer_participant_scope_mismatch');
    if (principal.kind === 'agent') {
      requireAgentScope(principal, 'participants:connect');
      if (message.facet === 'control' && message.action !== 'read') requireAgentScope(principal, 'control:write');
      if (message.facet === 'publication' && message.action === 'publish') requireAgentScope(principal, 'publication:write');
    }
    if ((message.action === 'definition' || message.action === 'read' && message.facet !== 'publication') &&
        (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload) || Object.keys(message.payload).length))
      throw new HttpError(400, 'peer_participant_payload_invalid', 'Read requests carry no application data');
    let payload: unknown;
    switch (message.facet) {
      case 'control':
        payload = await exchangePeerControl(t, principal, message.action as 'read' | 'configure' | 'select' | 'administer', message.payload);
        break;
      case 'publication':
        payload = message.action === 'definition' ? await exchangePeerControl(t, principal, 'definition', message.payload)
          : await exchangePeerPublication(t, principal, message.action as 'read' | 'publish', message.payload);
        break;
      case 'discovery':
        payload = await exchangeDiscovery(t, principal, message.action as 'read' | 'advertise' | 'withdraw', message.payload);
        break;
      case 'ephemeral':
        payload = await sendPeerInvitation(t, principal, message.payload);
        break;
      default: throw new HttpError(403, 'peer_participant_facet_forbidden');
    }
    return json(createParticipantResponse(message, payload));
  } catch (error) { return peerControlError(error); }
  finally {
    const remaining = (active.get(budget) ?? 1) - 1;
    if (remaining) active.set(budget, remaining); else active.delete(budget);
    if (!active.size) pending.delete(t);
  }
}
