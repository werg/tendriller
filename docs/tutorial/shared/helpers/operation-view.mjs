// Observe the owned session's journal. This module creates no delivery queue.
export function createOperationView(session, {
  operationId, operation, onChange, onError, signal,
} = {}) {
  if (typeof operationId !== 'string' || !operationId) throw TypeError('An operation ID is required.');
  if (operation && operation.operationId !== operationId) throw TypeError('Operation handle identity does not match.');
  const lifetime = new AbortController();
  const owned = AbortSignal.any([lifetime.signal, ...[session.signal, signal].filter(Boolean)]);
  let closed = false, running = false, dirty = false, requested = 0, iterator, sharedTask;
  let stopStatus = () => {}, stopRecovery = () => {};
  let snapshot = Object.freeze({ operationId, state: null, inspection: null,
    coverage: null, waitingForShared: false, recovery: null });
  const waiting = new Set();
  const notify = (listener, value) => {
    if (closed || !listener) return;
    try { listener(value); } catch (error) { if (listener !== onError) notify(onError, error); }
  };
  const update = value => { if (!closed) { snapshot = Object.freeze({ ...snapshot, ...value }); notify(onChange, snapshot); } };
  const settle = (error, value, failed = false) => {
    for (const held of waiting) failed ? held.reject(error) : held.resolve(value);
    waiting.clear();
  };
  const invalidate = () => { if (!closed) { requested++; dirty = true; queueMicrotask(pump); } };
  async function pump() {
    if (closed || running) return;
    running = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        const request = requested;
        try {
          const inspection = await session.operations.inspect(operationId);
          if (closed || request !== requested) continue;
          snapshot = Object.freeze({ ...snapshot, inspection, state: inspection?.state ?? null });
          settle(null, snapshot); notify(onChange, snapshot);
        } catch (error) {
          if (closed || request !== requested) continue;
          settle(error, undefined, true); notify(onError, error);
        }
      }
    } finally { running = false; }
  }
  function refresh() {
    if (closed) return Promise.reject(owned.reason ?? Error('Operation view is closed.'));
    const task = new Promise((resolve, reject) => waiting.add({ resolve, reject }));
    invalidate(); return task;
  }
  async function retry() {
    const current = await refresh();
    if (!current.state) throw Error('No saved attempt is visible. Keep the original input and ID; inspect the initial submission before retrying.');
    if (['abandoned', 'needsReapply'].includes(current.state.status))
      throw Error('Review the current application state before explicitly reapplying this operation with a new ID.');
    owned.throwIfAborted(); await session.retry(operationId); return refresh();
  }
  async function reapply({ name, input, operationId: nextId, basedOn } = {}) {
    if (typeof name !== 'string' || !name || typeof nextId !== 'string' || !nextId || nextId === operationId || !basedOn)
      throw TypeError('Reviewed reapplication needs a command, new operation ID and coherent current revision.');
    const request = structuredClone({ name, input, operationId: nextId, basedOn });
    const current = await refresh();
    if (!['abandoned', 'needsReapply'].includes(current.state?.status))
      throw Error('Only an abandoned or needsReapply operation can be explicitly reapplied.');
    owned.throwIfAborted();
    // Only the caller can present and approve the domain values. This helper's
    // guard is not an authorization decision, and it never invents a new ID.
    return session.reapply(operationId, request.name, request.input,
      { operationId: request.operationId, basedOn: request.basedOn });
  }
  function waitForShared({ signal: external } = {}) {
    if (closed) return Promise.reject(owned.reason);
    if (!operation) return Promise.reject(Error('Retained coverage needs the original operation handle; an ID-only reopened view reports coverage as unknown.'));
    if (sharedTask) return sharedTask;
    const observed = AbortSignal.any([owned, ...[external].filter(Boolean)]);
    update({ waitingForShared: true });
    sharedTask = (async () => {
      try {
        const coverage = await operation.shared({ signal: observed });
        observed.throwIfAborted(); update({ coverage }); return coverage;
      } finally { update({ waitingForShared: false }); sharedTask = undefined; }
    })();
    return sharedTask;
  }
  function close() {
    if (closed) return;
    closed = true; owned.removeEventListener('abort', close);
    lifetime.abort(Error('Operation view is closed.'));
    stopStatus(); stopRecovery(); settle(owned.reason, undefined, true);
    void Promise.resolve().then(() => iterator?.return?.()).catch(() => {});
  }
  owned.addEventListener('abort', close, { once: true });
  if (owned.aborted) close();
  else {
    try {
      stopStatus = session.onStatus(status => {
        if (status.phase === 'closed' || status.database === 'closed') close();
        else if (status.database === 'ready' && status.phase === 'ready') invalidate();
      });
      if (closed) stopStatus();
      else {
        stopRecovery = session.onRecovery(recovery => { update({ recovery }); invalidate(); });
        iterator = session.changes({ signal: owned })[Symbol.asyncIterator]();
        void (async () => {
          try {
            while (!closed) {
              const change = await iterator.next();
              if (change.done) break;
              invalidate();
            }
          } catch (error) { if (!closed) notify(onError, error); }
        })();
        invalidate();
      }
    } catch (error) { close(); throw error; }
  }
  return Object.freeze({ refresh, retry, reapply, waitForShared, close, get snapshot() { return snapshot; } });
}
