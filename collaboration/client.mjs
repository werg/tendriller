import { canonicalJson, CollaborationError, identifier, operationReference, signerId } from './protocol.mjs';

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
    active(); const operationId = identifier(options.operationId ?? crypto.randomUUID(), 'operation');
    const reference = operationReference(session, operationId);
    const retainedContext = JSON.parse(canonicalJson({ command: name, input,
      ...(options.basedOn ? { basedOn: options.basedOn } : {}), source }, 65536));
    // Reference persistence is before the first uncertain submission boundary.
    store?.retainOperation(reference, retainedContext);
    try {
      const operation = await session.command(name, input, { ...options, operationId });
      const saved = await operation.get().catch(() => null);
      const fullReference = operationReference(session, operationId, saved);
      store?.retainOperation(fullReference, retainedContext);
      // Avoid mutating a frozen public handle or manufacturing an applied outcome.
      return Object.freeze({ operationId, reference: fullReference,
        get: (...args) => operation.get(...args), applied: (...args) => operation.applied(...args),
        shared: (...args) => operation.shared(...args),
      });
    } catch (error) { error.operationReference = reference; throw error; }
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
