/** Retain the operation reference before invoking a command. The session owns signed attempts. */
export function createAssistanceClient(session, { pendingStorage, now = Date.now,
  randomId = () => globalThis.crypto.randomUUID() } = {}) {
  if (!['load', 'reserve', 'clear', 'resolve'].every(name => typeof pendingStorage?.[name] === 'function')) throw Error('ASSISTANCE_PENDING_STORAGE_REQUIRED');
  const loadPending = () => pendingStorage.load();
  function text(value, maximum) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw Error('ASSISTANCE_INPUT_INVALID');
    return value.trim();
  }
  async function submit(command, input, operationId) {
    const pending = { command, input, operationId };
    await pendingStorage.reserve(pending);
    // Do not wait indefinitely for application/retention in the user gesture.
    const operation = await session.command(command, input, { operationId });
    return { operationId, operation };
  }
  return {
    selectStep({ stepId, text: description }) {
      return submit('setCookingStep', { stepId: text(stepId, 128), text: text(description, 1000) }, randomId());
    },
    cancel(requestId) { return submit('cancelAssistance', { requestId: text(requestId, 128) }, randomId()); },
    async request({ question, kind = 'recipe_help', cookingStepId, cookingStepEventId, contextRevision, ttlMs = 900000 }) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86400000) throw Error('ASSISTANCE_TTL_INVALID');
      question = text(question, 4000); cookingStepId = text(cookingStepId, 128); contextRevision = text(contextRevision, 16384);
      cookingStepEventId = text(cookingStepEventId, 256);
      if (!['recipe_help', 'inventory_review', 'general'].includes(kind)) throw Error('ASSISTANCE_INPUT_INVALID');
      const expiresAtMs = now() + ttlMs;
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 1 || expiresAtMs > 8640000000000000) throw Error('ASSISTANCE_TTL_INVALID');
      const requestId = randomId(), operationId = randomId();
      const input = { requestId, kind, question, cookingStepId, cookingStepEventId, contextRevision, expiresAtMs };
      return { requestId, ...await submit('requestAssistance', input, operationId) };
    },
    async inspect() {
      const pending = await loadPending();
      return pending ? { pending, state: await session.operations.get(pending.operationId) } : null;
    },
    async resume() {
      const pending = await loadPending();
      if (!pending) throw Error('ASSISTANCE_NO_PENDING_OPERATION');
      const state = await session.operations.get(pending.operationId);
      if (state?.status === 'abandoned' || state?.status === 'needsReapply') throw Error('ASSISTANCE_EXPLICIT_REAPPLICATION_REQUIRED');
      // If no signed attempt exists, the first call may have failed before it
      // was saved. Reuse the original inputs/ID, never manufacture a new try.
      if (!state) return submit(pending.command, pending.input, pending.operationId);
      if (state.status === 'applied') return { operationId: pending.operationId, state };
      const operation = await session.retry(pending.operationId);
      return { operationId: pending.operationId, operation };
    },
    async acknowledge(operationId) {
      const pending = await loadPending();
      if (!pending) return;
      if (operationId !== undefined && pending.operationId !== operationId) return;
      const state = await session.operations.get(pending.operationId);
      if (state?.status !== 'applied') throw Error('ASSISTANCE_OUTCOME_UNCERTAIN');
      await pendingStorage.clear(pending.operationId);
      return state;
    },
    async resolve({ operationId, confirmed } = {}) {
      if (confirmed !== true) throw Error('ASSISTANCE_RESOLUTION_CONFIRMATION_REQUIRED');
      const pending = await loadPending();
      if (!pending || pending.operationId !== operationId) throw Error('ASSISTANCE_PENDING_OPERATION_CHANGED');
      const state = await session.operations.get(operationId);
      if (!['abandoned', 'needsReapply'].includes(state?.status)) throw Error('ASSISTANCE_OUTCOME_UNCERTAIN');
      if (!await pendingStorage.resolve(operationId, state.status)) throw Error('ASSISTANCE_PENDING_OPERATION_CHANGED');
      return { operationId, state };
    },
  };
}
