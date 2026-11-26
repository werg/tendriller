import { createAuthorityProvider, createAuthorityParticipant, decodeRecord, encodeRecord, verifyFinalityProofs, equalRecord,
  type SignedParticipantRequest, type FinalityProof } from '@chronolog/authority';
import { authorityRecord, authorityRecordBytes } from '../../contract/authority.mjs';
import { participantIdentity, requireAgentScope, type Principal } from './access';
import { readAuthorityBundle, authorityAccount, freshAuthorityAccess, authorityError, withAuthorityMutation, decodeRequestAuthorityRecord } from './authority';
import { exchangePeerPublication } from './peer-publications';
import { HttpError, json, readJson } from './http';
import type { Tendril } from './tendril';
const pending = new WeakMap<Tendril, Map<string, number>>();
/** Bounded control-only participant. Application programs, ciphertext and epoch keys are not accepted. */
export async function handlePeerParticipant(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const budget = participantIdentity(t, principal).budget, active = pending.get(t) ?? new Map<string, number>();
  pending.set(t, active);
  if ([...active.values()].reduce((sum, n) => sum + n, 0) >= 4 || (active.get(budget) ?? 0) >= 2) throw new HttpError(429, 'participant_busy');
  active.set(budget, (active.get(budget) ?? 0) + 1);
  try {
    const request = decodeRequestAuthorityRecord<SignedParticipantRequest>(await readJson(req, 2 * 1024 * 1024));
    if (!request || typeof request !== 'object' || Array.isArray(request) || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload) || Object.keys(request).some(key => !['payload', 'signer', 'signature'].includes(key)) || Object.keys(request.payload).some(key => !['applicationId', 'requestId', 'action', 'publication', 'proof'].includes(key))) throw new HttpError(400, 'participant_fields_invalid');
    if (!['authority.read', 'publication.read', 'publication.publish', 'finality.read', 'finality.publish'].includes(request.payload.action)) throw new HttpError(403, 'participant_action_forbidden');
    await freshAuthorityAccess(t, principal);
    if (principal.kind === 'agent') requireAgentScope(principal, 'participants:connect');
    authorityAccount(t, principal);
    const bundle = await readAuthorityBundle(t);
    if (bundle === null) throw new HttpError(409, 'application_uninitialized');
    // Signed membership, not host bookkeeping, identifies participant keys.
    if (!bundle.memberships.at(-1)!.payload.members.some(member => member.publicKey === request.signer)) throw new HttpError(403, 'participant_member_required');
    const memory = new Map<string, Uint8Array>(), authority = await createAuthorityProvider({ bundle, store: { async get(key) { return memory.get(key) ?? null; }, async put(key, bytes) { memory.set(key, bytes); } } });
    const participant = createAuthorityParticipant({ authority, publications: {
      async read() { const receipt = await exchangePeerPublication(t, principal, 'read', {}) as {publication: any} | null; return receipt ? [receipt.publication] : []; },
      async publish(publication) { const receipt = await exchangePeerPublication(t, principal, 'publish', { publication, assets: [] }) as {publication: any}; return receipt.publication; },
    }, ...(authority.descriptor.finalityPolicy.kind === 'none' ? {} : { finality: {
      async read() {
        const value = t.db.get<unknown>('application_finality_proofs', null), proofs = value === null ? [] : decodeRecord<FinalityProof[]>(authorityRecordBytes(value));
        return (await verifyFinalityProofs(authority.descriptor, proofs, authority)).proofs;
      },
      async publish(proof: FinalityProof) { await withAuthorityMutation(t, async () => {
        const value = t.db.get<unknown>('application_finality_proofs', null), proofs = value === null ? [] : decodeRecord<FinalityProof[]>(authorityRecordBytes(value));
        const latest = await readAuthorityBundle(t);
        if (!latest) throw new HttpError(409, 'application_uninitialized');
        await authority.merge(latest);
        if (!authority.grant(request.signer)?.finalizer) throw new HttpError(403, 'participant_finalizer_required');
        const verified = await verifyFinalityProofs(authority.descriptor, [...proofs, proof], authority);
        await freshAuthorityAccess(t, principal);
        if (equalRecord(proofs, verified.proofs)) return;
        const bytes = encodeRecord(verified.proofs); if (bytes.length > 1024 * 1024) throw new HttpError(413, 'finality_history_full');
        t.db.set('application_finality_proofs', authorityRecord(bytes));
      }); },
    } }) });
    const response = await participant.handle(request);
    await freshAuthorityAccess(t, principal);
    return json(authorityRecord(encodeRecord(response)));
  } catch (error) { return authorityError(error); }
  finally { const n = (active.get(budget) ?? 1) - 1; if (n) active.set(budget, n); else active.delete(budget); if (!active.size) pending.delete(t); }
}
