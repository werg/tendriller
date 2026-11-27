/**
 * Bounded Chronolog v2 control-only sync participant on the Tendril Durable Object.
 * Encrypted application envelopes and private CAS chunks are never accepted here.
 */
import { decodeRecord, encodeRecord, verifyRecord, type Signed } from '@chronolog/authority';
import { authorityRecord, authorityRecordBytes } from '../../contract/authority.mjs';
import { participantIdentity, requireAgentScope, type Principal } from './access';
import {
  authorityAccount, authorityError, decodeRequestAuthorityRecord, freshAuthorityAccess,
  readControlState, syncControlState, withAuthorityMutation,
} from './authority';
import { HttpError, json, readJson } from './http';
import type { Tendril } from './tendril';

export const PARTICIPANT_REQUEST_DOMAIN = 'chronolog/participant-sync/v2';

export interface ParticipantSyncPayload {
  readonly applicationId: string;
  readonly requestId: string;
  readonly action: 'control.sync';
  readonly publicOps?: unknown[];
  readonly casNodes?: unknown[];
  readonly checkpoints?: unknown[];
  readonly knownOpIds?: string[];
  readonly knownCasHashes?: string[];
}

const pending = new WeakMap<Tendril, Map<string, number>>();

export async function handlePeerParticipant(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const budget = participantIdentity(t, principal).budget;
  const active = pending.get(t) ?? new Map<string, number>();
  pending.set(t, active);
  if ([...active.values()].reduce((sum, n) => sum + n, 0) >= 4 || (active.get(budget) ?? 0) >= 2) {
    throw new HttpError(429, 'participant_busy');
  }
  active.set(budget, (active.get(budget) ?? 0) + 1);
  try {
    const request = decodeRequestAuthorityRecord<Signed<ParticipantSyncPayload>>(await readJson(req, 4 * 1024 * 1024));
    if (!request || typeof request !== 'object' || Array.isArray(request) || !request.payload || typeof request.payload !== 'object' ||
      Object.keys(request).some(key => !['payload', 'signer', 'signature'].includes(key)) ||
      request.payload.action !== 'control.sync') {
      throw new HttpError(400, 'participant_fields_invalid');
    }
    await verifyRecord(PARTICIPANT_REQUEST_DOMAIN, request);
    await freshAuthorityAccess(t, principal);
    if (principal.kind === 'agent') requireAgentScope(principal, 'participants:connect');
    authorityAccount(t, principal);

    const state = await readControlState(t);
    if (!state) throw new HttpError(409, 'application_uninitialized');
    if (request.payload.applicationId !== state.chainId) throw new HttpError(400, 'participant_application_mismatch');
    if (!state.permissions.openReaders && !state.permissions.readers.has(request.signer)) {
      throw new HttpError(403, 'participant_member_required');
    }

    const synced = await withAuthorityMutation(t, () => syncControlState(t, principal, {
      publicOps: request.payload.publicOps,
      casNodes: request.payload.casNodes,
      checkpoints: request.payload.checkpoints,
      knownOpIds: request.payload.knownOpIds,
      knownCasHashes: request.payload.knownCasHashes,
    }));
    await freshAuthorityAccess(t, principal);
    return json(authorityRecord(encodeRecord({
      requestId: request.payload.requestId,
      applicationId: state.chainId,
      ...synced,
    })));
  } catch (error) {
    return authorityError(error);
  } finally {
    const n = (active.get(budget) ?? 1) - 1;
    if (n) active.set(budget, n); else active.delete(budget);
    if (!active.size) pending.delete(t);
  }
}
