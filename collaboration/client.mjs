import { canonicalJson, CollaborationError, identifier, operationReference, signerId } from './protocol.mjs';
import { captureCollaborationReader } from './paging.mjs';

function immutableJson(value) {
  const copy = JSON.parse(canonicalJson(value, 65536));
  function freeze(item) {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
    return item;
  }
  return freeze(copy);
}
function submissionFailure(cause, reference, submission) {
  const metadata = { operationReference: reference, operationIdentities: submission.identities, operationSubmission: submission };
  // Preserve normal transport error identity/codes. Nonextensible errors and
  // primitive rejections still retain their cause and the original identities.
  const reusable = cause instanceof Error && Object.isExtensible(cause) &&
    Object.keys(metadata).every(key => Object.getOwnPropertyDescriptor(cause, key)?.configurable !== false);
  const error = reusable ? cause : new Error(typeof cause?.message === 'string' ? cause.message : String(cause), { cause });
  if (!reusable) for (const key of ['name', 'code', 'scope', 'retrySafe', 'nextAction'])
    if (cause?.[key] !== undefined) Object.defineProperty(error, key, { value: cause[key], enumerable: key !== 'name' });
  Object.defineProperties(error, Object.fromEntries(Object.entries(metadata).map(([key, value]) =>
    [key, { value, enumerable: true, writable: false, configurable: false }])));
  return error;
}

/** Ordinary operations and journals remain owned by the supplied session. */
export function createCollaborationClient({ session, endpoint = session?.endpoint, runId, store } = {}) {
  if (!session || typeof session.command !== 'function' || typeof session.query !== 'function') throw new CollaborationError('SESSION_REQUIRED');
  const context = endpoint?.context ?? {};
  if (runId && context.runId && runId !== context.runId)
    throw new CollaborationError('RUN_SCOPE_MISMATCH', 'Attach with the intended run identity before claiming work');
  const incarnation = endpoint?.endpointIncarnation ?? `native-${crypto.randomUUID()}`;
  const currentRun = runId ?? context.runId ?? `run-${crypto.randomUUID()}`;
  let detached = false;
  const source = { deviceId: session.deviceId, endpointId: endpoint?.endpointId ?? null,
    endpointIncarnation: incarnation, ownerInstanceId: endpoint?.ownerInstanceId ?? null, runId: currentRun,
    ...context, evidence: endpoint ? 'owner-bound' : 'signer-context', contextEvidence: 'caller-asserted' };
  function active() { if (detached) throw new CollaborationError('ENDPOINT_STALE'); }
  async function submit(name, input, options = {}) {
    active(); const localOperationId = identifier(options.operationId ?? crypto.randomUUID(), 'operation');
    let reference = operationReference(session, localOperationId);
    const operationId = reference.operationId;
    const identities = { operationId, localOperationId, ...Object.fromEntries([
      'interactionId', 'taskId', 'slotId', 'claimId', 'resultId', 'actionId', 'threadId', 'messageId',
    ].filter(key => input[key] !== undefined).map(key => [key, identifier(input[key], key)])),
    ...(name === 'collab.request' ? { taskId: input.interactionId } : {}) };
    const submission = immutableJson({ command: name, input, identities,
      ...(options.basedOn ? { basedOn: options.basedOn } : {}), source });
    try {
      // Persist the generated identities and original immutable input before the
      // first uncertain boundary. The owner receives that exact input snapshot.
      store?.retainOperation(reference, submission);
      const operation = await session.command(name, submission.input, { ...options, operationId,
        ...(submission.basedOn ? { basedOn: submission.basedOn } : {}) });
      const saved = await operation.get().catch(() => null);
      reference = operationReference(session, operationId, saved);
      store?.retainOperation(reference, submission);
      // Avoid mutating a frozen public handle or manufacturing an applied outcome.
      return Object.freeze({ operationId, reference, identities: submission.identities, submission,
        get: (...args) => operation.get(...args), applied: (...args) => operation.applied(...args),
        shared: (...args) => operation.shared(...args),
      });
    } catch (error) { throw submissionFailure(error, reference, submission); }
  }
  const fence = input => ({ ...input, runId: input.runId ?? currentRun,
    endpointIncarnation: input.endpointIncarnation ?? incarnation });
  const inspect = async taskId => { active(); return session.query('collab.task', { taskId: identifier(taskId) }); };
  function operationScope(reference) {
    active();
    if (!reference || reference.applicationId !== session.applicationId ||
        typeof reference.historyId !== 'string' || !reference.historyId || reference.historyId !== session.historyId)
      throw new CollaborationError('OPERATION_SCOPE_MISMATCH', 'Select the original application and verified history before inspecting or retrying');
    identifier(reference.operationId, 'operation'); signerId(reference.author);
  }
  async function inspectOperation(reference) {
    operationScope(reference);
    const inspected = await session.operations.inspect(reference.operationId, { author: reference.author });
    if (!inspected) return null;
    const { state, attempt } = inspected, header = attempt?.payload?.header;
    // The saved/abandoned state need not contain an author. Use the inspected
    // signed attempt, never the current signer or a caller's provenance label.
    if (!header || header.applicationId !== reference.applicationId || header.author !== reference.author ||
        header.operationId !== reference.operationId || state?.operationId !== reference.operationId ||
        typeof attempt.id !== 'string' || !attempt.id || state.attemptId !== attempt.id ||
        typeof header.generation !== 'string' || !header.generation || state.generation !== header.generation ||
        (state.author !== undefined && state.author !== header.author) ||
        (reference.attemptId !== undefined && reference.attemptId !== attempt.id) ||
        (reference.generation !== undefined && reference.generation !== header.generation))
      throw new CollaborationError('OPERATION_REFERENCE_CONFLICT', 'The retained reference does not match the original signed attempt');
    return inspected;
  }
  return Object.freeze({ session, endpoint, runId: currentRun, source: Object.freeze(source),
    request(input, options) {
      return submit('collab.request', { ...input, interactionId: input.interactionId ?? crypto.randomUUID(),
        input: canonicalJson(input.input ?? null), target: canonicalJson(input.target, 2048),
        context: canonicalJson(input.context ?? {}, 2048), source: canonicalJson(source, 2048),
        responsePolicy: input.responsePolicy ?? 'one' }, options);
    },
    claim(input, options) { return submit('collab.claim', fence({ ...input, claimId: input.claimId ?? crypto.randomUUID(), taskVersion: input.taskVersion ?? 1, expectedEpoch: input.expectedEpoch ?? 0 }), options); },
    rebind(input, options) { return submit('collab.rebind', fence({ ...input, claimId: input.claimId ?? crypto.randomUUID(), taskVersion: input.taskVersion ?? 1 }), options); },
    handoff(input, options) { return submit('collab.handoff', { ...input, actionId: input.actionId ?? crypto.randomUUID() }, options); },
    result(input, options) { return submit('collab.result', fence({ ...input, resultId: input.resultId ?? crypto.randomUUID(),
      taskVersion: input.taskVersion ?? 1, outcome: input.outcome ?? 'succeeded', content: canonicalJson(input.content) }), options); },
    cancel(input, options) { return submit('collab.cancel', { ...input, actionId: input.actionId ?? crypto.randomUUID() }, options); },
    acknowledgeCancel(input, options) { return submit('collab.acknowledgeCancel', fence({ ...input, actionId: input.actionId ?? crypto.randomUUID() }), options); },
    finalize(input, options) { return submit('collab.finalize', { ...input, actionId: input.actionId ?? crypto.randomUUID(),
      allowPartial: input.allowPartial ?? false, content: canonicalJson(input.content) }, options); },
    message(input, options) { return submit('collab.message', { ...input, messageId: input.messageId ?? crypto.randomUUID(), source: canonicalJson(source, 2048) }, options); },
    inspect,
    snapshot() { active(); return session.query('collab.snapshot', null); },
    tasks(options = {}) { active(); return session.query('collab.tasks', options); },
    results(options = {}) { active(); return session.query('collab.results', options); },
    messages(options = {}) { active(); return session.query('collab.messages', options); },
    thread(options) { active(); return session.query('collab.thread', options); },
    capture(options = {}) { active(); return captureCollaborationReader(session, options); },
    async waitForOutcome(taskId, { signal } = {}) {
      active(); signal?.throwIfAborted();
      const lifetime = new AbortController();
      const observed = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const changes = session.changes({ signal: observed })[Symbol.asyncIterator]();
      let next = changes.next(); void next.catch(() => {});
      try {
        for (;;) {
          const snapshot = await inspect(taskId), task = snapshot.value.task;
          if (!task) throw new CollaborationError('INTERACTION_UNAVAILABLE', 'The selected history does not contain this request', { taskId });
          if (['completed','cancelled','needsReview'].includes(task.status)) return { ...snapshot.value, revision: snapshot.revision };
          const change = await next;
          if (change.done) throw new CollaborationError('OWNER_UNREACHABLE');
          next = changes.next(); void next.catch(() => {});
        }
      } finally { lifetime.abort(); await changes.return?.(); }
    },
    inspectOperation,
    async retry(reference) {
      operationScope(reference);
      if(reference.author!==session.deviceId)
        throw new CollaborationError('ORIGINAL_SIGNER_REQUIRED', 'Exact retry must use the original owning journal');
      if (!await inspectOperation(reference))
        throw new CollaborationError('OPERATION_UNAVAILABLE', 'The original owning journal does not retain this operation; do not create a replacement');
      return session.retry(reference.operationId);
    },
    async detach() { if(detached)return; detached=true; if(typeof session.detach==='function')await session.detach(); },
  });
}
