import {
  validateParticipantRequest, createParticipantResponse, PARTICIPANT_LIMITS,
} from '@chronolog/peer-generation/participant';
import type { Principal } from './access';
import type { Tendril } from './tendril';
import { selectedApplication } from './application';
import { HttpError, json, readJson } from './http';
import { exchangePeerControl, peerControlError } from './peer-generations';
import { exchangePeerPublication } from './peer-publications';
import { exchangeDiscovery } from './discovery';
import { sendPeerInvitation } from './peer-invitations';

const pending = new WeakMap<Tendril, number>();
/** The host is a filtered control participant over authenticated HTTP. */
export async function handlePeerParticipant(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const selection = selectedApplication(t);
  const admitted = pending.get(t) ?? 0;
  if (admitted >= PARTICIPANT_LIMITS.pending) throw new HttpError(429, 'peer_participant_busy');
  pending.set(t, admitted + 1);
  try {
    const message = validateParticipantRequest(await readJson(req, Math.max(PARTICIPANT_LIMITS.bytes.control, PARTICIPANT_LIMITS.bytes.publication)));
    if (message.applicationId !== selection.id) throw new HttpError(409, 'peer_participant_scope_mismatch');
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
  finally { pending.set(t, (pending.get(t) ?? 1) - 1); }
}
