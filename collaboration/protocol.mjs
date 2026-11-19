/** Optional collaboration contracts. Routing is never a grant or a privacy boundary. */
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
  CURSOR_RESET_REQUIRED: 'Review the new generation or filter and explicitly reset this consumer.',
  RECOVERY_REVIEW_REQUIRED: 'Inspect the original operation and deliberately rebind or reapply.',
  EFFECT_OUTCOME_UNKNOWN: 'Reconcile the original effect identity before dispatching again.',
};
export class CollaborationError extends Error {
  constructor(code, message = code, scope = {}) {
    super(message); this.name = 'CollaborationError'; this.code = code; this.scope = scope;
    this.retrySafe = ['OWNER_BUSY', 'RECIPIENT_UNAVAILABLE'].includes(code);
    this.nextAction = actions[code] ?? 'Inspect the supplied scope and correct the request.';
  }
}
export function identifier(value, name = 'identity') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u.test(value))
    throw new CollaborationError('INVALID_IDENTITY', `Invalid ${name}`);
  return value;
}
export function signerId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    throw new CollaborationError('INVALID_SIGNER', 'A verified signing public key is required');
  return value;
}
export function canonicalJson(value, maxBytes = COLLABORATION_LIMITS.payloadBytes) {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 4096 || depth > 24) throw new CollaborationError('PAYLOAD_TOO_COMPLEX');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new CollaborationError('INVALID_PAYLOAD');
      return `[${item.map(child => visit(child, depth + 1)).join(',')}]`;
    }
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new CollaborationError('INVALID_PAYLOAD');
    if (Reflect.ownKeys(item).length !== Object.keys(item).length) throw new CollaborationError('INVALID_PAYLOAD');
    return `{${Object.keys(item).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor)) throw new CollaborationError('INVALID_PAYLOAD');
      return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
    }).join(',')}}`;
  }
  const encoded = visit(value, 0);
  if (new TextEncoder().encode(encoded).length > maxBytes) throw new CollaborationError('PAYLOAD_TOO_LARGE');
  return encoded;
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
export function operationReference(session, operationId, state) {
  // These public session getters come from the owner's verified descriptor,
  // including through its attachment metadata. Input/state labels cannot choose
  // the history, and a pre-descriptor partial reference is never safe to retry.
  const applicationId = session.applicationId ?? session.id, historyId = session.historyId;
  if (typeof applicationId !== 'string' || !applicationId || typeof historyId !== 'string' || !historyId)
    throw new CollaborationError('OPERATION_SCOPE_MISMATCH', 'An attached application and verified history are required');
  if (state?.operationId !== undefined && state.operationId !== operationId)
    throw new CollaborationError('OPERATION_REFERENCE_CONFLICT', 'The saved state belongs to a different operation');
  return Object.freeze({ applicationId, historyId, author: signerId(state?.author ?? session.deviceId),
    operationId: identifier(operationId, 'operation'), ...(state?.attemptId ? { attemptId: state.attemptId } : {}),
    ...(state?.generation ? { generation: state.generation } : {}) });
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
  if (['collab.claim', 'collab.rebind'].includes(name))
    return { ...input, endpointIncarnation: endpoint.endpointIncarnation,
      ...(context.runId ? { runId: context.runId } : {}) };
  return input;
}
export function consumerCursor(scope, sequence) {
  for (const name of ['applicationId', 'consumerId', 'generation', 'filterVersion']) identifier(scope[name], name);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new CollaborationError('INVALID_CURSOR');
  return Object.freeze({ protocol: COLLABORATION_PROTOCOL, ...scope, sequence });
}
export function validateConsumerCursor(cursor, scope, { retainedFrom = 0 } = {}) {
  if (!cursor || cursor.protocol !== COLLABORATION_PROTOCOL ||
    ['applicationId', 'consumerId', 'generation', 'filterVersion'].some(key => cursor[key] !== scope[key]) ||
    !Number.isSafeInteger(cursor.sequence) || cursor.sequence < retainedFrom)
    throw new CollaborationError('CURSOR_RESET_REQUIRED', 'The consumer scope or retained history changed', { ...scope, retainedFrom });
  return cursor;
}
