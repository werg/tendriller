import { canonicalJson, CollaborationError, identifier, operationReference } from './protocol.mjs';

/** Ordinary operations and journals remain owned by the supplied session. */
export function createCollaborationClient({ session, endpoint = session?.endpoint, runId, store } = {}) {
  if (!session || typeof session.command !== 'function' || typeof session.query !== 'function') throw new CollaborationError('SESSION_REQUIRED');
  const context = endpoint?.context ?? {};
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
    // Reference persistence is before the first uncertain submission boundary.
    store?.retainOperation(reference, { command: name, input, ...(options.basedOn ? { basedOn: options.basedOn } : {}), source });
    try {
      const operation = await session.command(name, input, { ...options, operationId });
      const saved = await operation.get().catch(() => null);
      // Avoid mutating a frozen public handle or manufacturing an applied outcome.
      return Object.freeze({ operationId, reference: operationReference(session, operationId, saved),
        get: (...args) => operation.get(...args), applied: (...args) => operation.applied(...args),
        shared: (...args) => operation.shared(...args),
      });
    } catch (error) { error.operationReference = reference; throw error; }
  }
  const fence = input => ({ ...input, runId: input.runId ?? currentRun,
    endpointIncarnation: input.endpointIncarnation ?? incarnation });
  const inspect = async taskId => { active(); return session.query('collab.task', { taskId: identifier(taskId) }); };
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
    async inspectOperation(reference) {
      active(); if(reference.applicationId !== session.applicationId) throw new CollaborationError('OPERATION_SCOPE_MISMATCH');
      return session.operations.inspect(reference.operationId, { author: reference.author });
    },
    async retry(reference) {
      active(); if(reference.applicationId!==session.applicationId || reference.author!==session.deviceId)
        throw new CollaborationError('ORIGINAL_SIGNER_REQUIRED', 'Exact retry must use the original owning journal');
      return session.retry(reference.operationId);
    },
    async detach() { if(detached)return; detached=true; if(typeof session.detach==='function')await session.detach(); },
  });
}
