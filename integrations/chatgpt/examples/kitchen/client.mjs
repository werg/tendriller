/** Retain the operation reference before invoking a command. The session owns signed attempts. */
export function createAssistanceClient(session, { savePending, loadPending, now = Date.now,
  randomId = () => globalThis.crypto.randomUUID() } = {}) {
  if (typeof savePending !== 'function' || typeof loadPending !== 'function') throw Error('ASSISTANCE_PENDING_STORAGE_REQUIRED');
  async function submit(command, input, operationId) {
    const existing = await loadPending();
    const pending = { command, input, operationId };
    if (existing && JSON.stringify(existing) !== JSON.stringify(pending)) throw Error('ASSISTANCE_PENDING_OPERATION_UNRESOLVED');
    await savePending(pending);
    // Do not wait indefinitely for application/retention in the user gesture.
    const operation = await session.command(command, input, { operationId });
    return { operationId, operation };
  }
  return {
    selectStep({ stepId, text }) { return submit('setCookingStep', { stepId, text }, randomId()); },
    cancel(requestId) { return submit('cancelAssistance', { requestId }, randomId()); },
    async request({ question, kind = 'recipe_help', cookingStepId, contextRevision, ttlMs = 900000 }) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86400000) throw Error('ASSISTANCE_TTL_INVALID');
      if (await loadPending()) throw Error('ASSISTANCE_PENDING_OPERATION_UNRESOLVED');
      const requestId = randomId(), operationId = randomId();
      const input = { requestId, kind, question, cookingStepId, contextRevision, expiresAtMs: now() + ttlMs };
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
    async acknowledge() {
      const pending = await loadPending();
      if (!pending) return;
      const state = await session.operations.get(pending.operationId);
      if (state?.status !== 'applied') throw Error('ASSISTANCE_OUTCOME_UNCERTAIN');
      await savePending(null);
      return state;
    },
  };
}
