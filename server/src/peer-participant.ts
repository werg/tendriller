import { validateParticipantRequest, createParticipantResponse, PARTICIPANT_LIMITS } from '../../contract/participant.mjs';
import { selectedApplication } from './application';
import { admitPeerParticipant, dispatchPeerControl, freshPeerAccess } from './peer-generations';
import { dispatchDiscovery } from './discovery';
import { invitePeer } from './peer-invitations';
import { HttpError, json, readJson } from './http';
import type { Principal } from './access';
import type { Tendril } from './tendril';

/** One bounded control-plane request boundary. Peer data interests never dispatch here. */
export async function handleParticipant(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  return admitPeerParticipant(t, principal, async () => {
    try {
      const request = validateParticipantRequest(await readJson(req, PARTICIPANT_LIMITS.bytes.control));
      if (request.applicationId !== selectedApplication(t).id) throw new HttpError(409, 'peer_participant_scope_mismatch');
      req.signal.throwIfAborted();
      if (request.facet === 'discovery' || request.facet === 'ephemeral') await freshPeerAccess(t, principal);
      const payload = request.facet === 'discovery' ? await dispatchDiscovery(t, request.action, request.payload, principal)
        : request.facet === 'ephemeral' ? await invitePeer(t, request.payload, principal)
        : await dispatchPeerControl(t, request, principal);
      if (request.facet === 'discovery' || request.facet === 'ephemeral') await freshPeerAccess(t, principal);
      return json(createParticipantResponse(request, payload));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code.startsWith('PEER_PARTICIPANT_')) throw new HttpError(/FORBIDDEN/.test(code) ? 403 : /LIMIT/.test(code) ? 413 : 400, code.toLowerCase(), code);
      throw error;
    }
  });
}
