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
  const source = { deviceId: session.identity.publicKey, endpointId: endpoint?.endpointId ?? null,
    endpointIncarnation: incarnation, ownerInstanceId: endpoint?.ownerInstanceId ?? null, runId: currentRun,
    ...context, evidence: endpoint ? 'owner-bound' : 'signer-context', contextEvidence: 'caller-asserted' };
  function active() { if (detached) throw new CollaborationError('ENDPOINT_STALE'); }
  async function submit(name, input, options = {}) {
    active(); const localOperationId = options.operationId ?? crypto.randomUUID();
    let reference = operationReference(session, localOperationId);
    const operationId = reference.operationId;
    const identities = { operationId, localOperationId, ...Object.fromEntries([
      'interactionId', 'taskId', 'slotId', 'claimId', 'resultId', 'actionId', 'threadId', 'messageId',
    ].filter(key => input[key] !== undefined).map(key => [key, identifier(input[key], key)])),
    ...(name === 'collab.request' ? { taskId: input.interactionId } : {}) };
    const submission = immutableJson({ command: name, input, identities,
      ...(options.authorTimestampMs !== undefined ? { authorTimestampMs: options.authorTimestampMs.toString() } : {}), source });
    try {
      // Persist the generated identities and original immutable input before the
      // first uncertain boundary. The owner receives that exact input snapshot.
      store?.writeDraft(submission, `submission:${operationId}`);
      const operation = await session.command(name, submission.input, { operationId, ...(submission.authorTimestampMs !== undefined ? { authorTimestampMs: BigInt(submission.authorTimestampMs) } : {}) });
      const saved = await operation.inspect();
      reference = operationReference(session, operationId, saved);
      store?.retainOperation(reference, submission);
      // Storage success never fabricates materialization, retention or finality.
      return Object.freeze({ operationId, reference, identities: submission.identities, submission,
        stored: operation.stored, proposalId: reference.proposalId,
        inspect: (...args) => operation.inspect(...args), materialized: (...args) => operation.materialized(...args),
        retained: (...args) => operation.retained(...args), finalized: (...args) => operation.finalized(...args),
      });
    } catch (error) { throw submissionFailure(error, reference, submission); }
  }
  const fence = input => ({ ...input, runId: input.runId ?? currentRun,
    endpointIncarnation: input.endpointIncarnation ?? incarnation });
  const inspect = async taskId => { active(); return session.query('collab.task', { taskId: identifier(taskId) }); };
  function operationScope(reference) {
    active();
    if (!reference || reference.applicationId !== session.applicationId) throw new CollaborationError('OPERATION_SCOPE_MISMATCH');
    if (typeof reference.operationId !== 'string' || !reference.operationId || reference.operationId.length > 512 || /[\u0000-\u001f\u007f]/u.test(reference.operationId)) throw new CollaborationError('OPERATION_SCOPE_MISMATCH');
    signerId(reference.author);
    if (reference.proposalId !== undefined) signerId(reference.proposalId);
  }
  async function inspectOperation(reference) {
    operationScope(reference);
    // Look up through the owning public journal, then compare authenticated provenance.
    const operation = await session.operations.get(reference.proposalId ?? reference.operationId);
    if (!operation) return null;
    const state = await operation.inspect();
    if (state.applicationId !== reference.applicationId || state.author !== reference.author || state.operationId !== reference.operationId ||
        !/^[a-f0-9]{64}$/u.test(state.proposalId) || reference.proposalId !== undefined && state.proposalId !== reference.proposalId)
      throw new CollaborationError('OPERATION_REFERENCE_CONFLICT', 'The retained reference does not match the authenticated authored proposal');
    return state;
  }
  return Object.freeze({ session, endpoint, runId: currentRun, source: Object.freeze(source),
    request(input, options) {
      return submit('collab.request', { ...input, interactionId: input.interactionId ?? crypto.randomUUID(),
        input: canonicalJson(input.input ?? null), target: canonicalJson(input.target, 2048),
        context: canonicalJson(input.context ?? {}, 2048), source: canonicalJson(source, 2048),
        responsePolicy: input.responsePolicy ?? 'one' }, options);
    },
    claim(input, options) { return submit('collab.claim', fence({ ...input, claimId: input.claimId ?? crypto.randomUUID(), taskVersion: input.taskVersion ?? 1, expectedEpoch: input.expectedEpoch ?? 0 }), options); },
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
          if (['completed','cancelled'].includes(task.status)) return { ...snapshot.value, revision: snapshot.revision, finality: snapshot.revision.view === 'final' ? 'finalized' : 'pending' };
          const change = await next;
          if (change.done) throw new CollaborationError('OWNER_UNREACHABLE');
          next = changes.next(); void next.catch(() => {});
        }
      } finally { lifetime.abort(); await changes.return?.(); }
    },
    inspectOperation,
    async retry(reference) {
      operationScope(reference);
      if(reference.author!==session.identity.publicKey)
        throw new CollaborationError('ORIGINAL_SIGNER_REQUIRED', 'Exact retry must use the original owning journal');
      if (!await inspectOperation(reference))
        throw new CollaborationError('OPERATION_UNAVAILABLE', 'The original owning journal does not retain this operation; do not create a replacement');
      return session.operations.retry(reference.proposalId ?? reference.operationId);
    },
    async detach() { if(detached)return; detached=true; if(typeof session.detach==='function')await session.detach(); },
  });
}
