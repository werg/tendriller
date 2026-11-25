/** Optional collaboration contracts. Routing is never a grant or a privacy boundary. */
import { SessionError, canonicalJson } from '@chronolog/peer-session';
export { canonicalJson };
export function identifier(value, name = 'identity') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u.test(value)) throw new CollaborationError('INVALID_IDENTITY', `Invalid ${name}`);
  return value;
}
export function signerId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new CollaborationError('INVALID_SIGNER');
  return value;
}
/** Only an authenticated journal inspection may supply an authored proposal identity. */
export function operationReference(session, operationId, inspection) {
  const applicationId = signerId(session.applicationId), author = signerId(session.identity?.publicKey);
  if (typeof operationId !== 'string' || !operationId || operationId.length > 512 || /[\u0000-\u001f\u007f]/u.test(operationId)) throw new CollaborationError('INVALID_IDENTITY');
  operationId = typeof session.scopeOperationId === 'function' ? session.scopeOperationId(operationId) : operationId;
  if (inspection && (inspection.applicationId !== applicationId || inspection.author !== author || inspection.operationId !== operationId))
    throw new CollaborationError('OPERATION_REFERENCE_CONFLICT');
  return Object.freeze({ applicationId, author, operationId, ...(inspection ? { proposalId: signerId(inspection.proposalId) } : {}) });
}

export const COLLABORATION_PROTOCOL = 'tendriller.collaboration.v1';
export const COLLABORATION_LIMITS = Object.freeze({ slots: 32, activeClaimsPerSigner: 8,
  payloadBytes: 8192, resultsPerSlot: 64, requests: 4096, observers: 64 });

const actions = {
  OWNER_BUSY: 'Attach to the existing owner or deliberately enroll a separate profile.',
  ENDPOINT_STALE: 'Reattach and inspect the original operation before acting again.',
  RECIPIENT_AMBIGUOUS: 'Choose one named recipient or create explicit contribution slots.',
  RECIPIENT_UNAVAILABLE: 'Choose an authorized recipient or retain the request for later.',
  CLAIM_CONFLICT: 'Inspect the current claim and observe it or choose another task.',
  CLAIM_SUPERSEDED: 'Inspect the current claim; do not repeat the external action.',
  CURSOR_RESET_REQUIRED: 'Review the new projection revision or filter and explicitly reset this consumer.',
  EFFECT_OUTCOME_UNKNOWN: 'Reconcile the original effect identity before dispatching again.',
};
export class CollaborationError extends SessionError {
  constructor(code, message = code, scope = {}) {
    super(code, message);
    this.scope = Object.freeze({ ...scope });
    this.retrySafe = false;
    this.nextAction = actions[code] ?? 'Inspect the original operation and current projection before retrying.';
    this.name = 'CollaborationError';
  }
}
export function endpointReference(value) {
  if (!value || typeof value !== 'object') throw new CollaborationError('ENDPOINT_STALE');
  return Object.freeze({ deviceId: signerId(value.deviceId), endpointId: identifier(value.endpointId, 'endpoint'),
    endpointIncarnation: identifier(value.endpointIncarnation ?? value.incarnation, 'endpoint incarnation') });
}
export function sameEndpoint(left, right) {
  return !!left && !!right && left.deviceId === right.deviceId && left.endpointId === right.endpointId &&
    (left.endpointIncarnation ?? left.incarnation) === (right.endpointIncarnation ?? right.incarnation);
}
export function validateTarget(target) {
  if (!target || typeof target !== 'object') throw new CollaborationError('INVALID_TARGET');
  switch (target.kind) {
    case 'endpoint': return { kind: target.kind, endpoint: endpointReference(target.endpoint) };
    case 'signer': return { kind: target.kind, deviceId: signerId(target.deviceId) };
    case 'participant': return { kind: target.kind, principalId: identifier(target.principalId) };
    case 'agent': return { kind: target.kind, agentBindingId: identifier(target.agentBindingId) };
    case 'workerGroup': return { kind: target.kind, groupId: identifier(target.groupId), mode: 'claimOne' };
    case 'thread': return { kind: target.kind, threadId: identifier(target.threadId) };
    default: throw new CollaborationError('INVALID_TARGET');
  }
}
/** Entries must come from authenticated membership/delegation, never presence alone. */
export function resolveRecipient(target, entries, { capability } = {}) {
  target = validateTarget(target);
  if (target.kind === 'thread' || target.kind === 'workerGroup') throw new CollaborationError('RECIPIENT_AMBIGUOUS');
  const candidates = entries.filter(entry => entry.authorized === true && !entry.revoked &&
    (!capability || entry.capabilities?.includes(capability)) &&
    (target.kind === 'signer' ? entry.deviceId === target.deviceId : target.kind === 'agent'
      ? entry.agentBindingId === target.agentBindingId : target.kind === 'participant'
        ? entry.principalId === target.principalId : sameEndpoint(entry.endpoint, target.endpoint)));
  const signers = [...new Set(candidates.map(entry => signerId(entry.deviceId)))];
  if (signers.length !== 1) throw new CollaborationError(signers.length ? 'RECIPIENT_AMBIGUOUS' : 'RECIPIENT_UNAVAILABLE');
  return candidates.find(entry => entry.deviceId === signers[0]);
}
/** Owner hook: replace every caller-supplied source, never merge authority claims. */
export function prepareCollaborationCommand(endpoint, name, input, deviceId) {
  if (!name.startsWith('collab.')) return input;
  const context = endpoint.context ?? {};
  const source = { deviceId: signerId(deviceId), endpointId: endpoint.endpointId,
    endpointIncarnation: endpoint.endpointIncarnation, ownerInstanceId: endpoint.ownerInstanceId,
    evidence: 'owner-bound', contextEvidence: 'same-origin-assertion',
    ...Object.fromEntries(['viewId', 'documentPath', 'publicationId', 'runId'].filter(key => context[key] !== undefined)
      .map(key => [key, context[key]])) };
  if (name === 'collab.request' || name === 'collab.message') return { ...input, source: canonicalJson(source, 2048) };
  // Result/acknowledgement fences name the original claim, possibly delivered
  // later by another attachment of the same signer. They are checked in SQL.
  if (name === 'collab.claim')
    return { ...input, endpointIncarnation: endpoint.endpointIncarnation,
      ...(context.runId ? { runId: context.runId } : {}) };
  return input;
}
export function consumerCursor(scope, sequence) {
  for (const name of ['applicationId', 'consumerId', 'revisionDigest', 'filterVersion']) identifier(scope[name], name);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new CollaborationError('INVALID_CURSOR');
  return Object.freeze({ protocol: COLLABORATION_PROTOCOL, ...scope, sequence });
}
export function validateConsumerCursor(cursor, scope, { retainedFrom = 0 } = {}) {
  if (!cursor || cursor.protocol !== COLLABORATION_PROTOCOL ||
    ['applicationId', 'consumerId', 'revisionDigest', 'filterVersion'].some(key => cursor[key] !== scope[key]) ||
    !Number.isSafeInteger(cursor.sequence) || cursor.sequence < retainedFrom)
    throw new CollaborationError('CURSOR_RESET_REQUIRED', 'The consumer scope or retained history changed', { ...scope, retainedFrom });
  return cursor;
}
