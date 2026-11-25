// Observation only: the owned session remains the sole signed journal and replication owner.
export function createOperationView(session, { operationId, onChange = () => {}, onError = () => {}, signal } = {}) {
  if (typeof operationId !== 'string' || !operationId) throw TypeError('A stable original operation ID is required');
  const stop = new AbortController(), lifetime = AbortSignal.any([stop.signal, ...[session.signal, signal].filter(Boolean)]);
  let closed = false, running, dirty = false, token = 0, iterator, waitingFor = null;
  let snapshot = Object.freeze({ operationId, inspection: null, waitingFor: null, error: null });
  const waiters = new Set();
  const emit = patch => { if (closed) return; snapshot = Object.freeze({ ...snapshot, ...patch }); try { onChange(snapshot); } catch (error) { try { onError(error); } catch {} } };
  async function refresh() {
    if (closed) throw lifetime.reason ?? Error('Operation view closed');
    dirty = true;
    const result = new Promise((resolve, reject) => waiters.add({ resolve, reject }));
    if (!running) running = (async () => {
      while (dirty && !closed) {
        dirty = false; const current = ++token;
        try {
          const operation = await session.operations.get(operationId), inspection = operation === null ? null : await operation.inspect();
          if (closed || current !== token || dirty) continue;
          if (inspection && (inspection.applicationId !== session.applicationId || inspection.operationId !== operationId)) throw Error('Authenticated operation scope mismatch');
          emit({ inspection, error: null }); for (const waiter of waiters) waiter.resolve(snapshot); waiters.clear();
        } catch (error) { emit({ error }); for (const waiter of waiters) waiter.reject(error); waiters.clear(); try { onError(error); } catch {} }
      }
    })().finally(() => { running = undefined; if (dirty && !closed) void refresh().catch(() => {}); });
    return result;
  }
  async function waitFor(fact, options = {}) {
    if (!['materialized', 'retained', 'finalized'].includes(fact)) throw TypeError('Choose one independent operation fact');
    if (waitingFor !== null) throw Error('An explicit observation is already pending');
    const operation = await session.operations.get(operationId); if (!operation) throw Error('Original signed operation is not locally visible');
    waitingFor = fact; emit({ waitingFor });
    try { const value = await operation[fact]({ ...options, signal: AbortSignal.any([lifetime, ...[options.signal].filter(Boolean)]) }); await refresh(); return value; }
    finally { waitingFor = null; emit({ waitingFor: null }); }
  }
  async function retry() { lifetime.throwIfAborted(); await session.operations.retry(operationId); return refresh(); }
  function close() {
    if (closed) return; closed = true; lifetime.removeEventListener('abort', close); stop.abort(Error('Operation observation closed'));
    for (const waiter of waiters) waiter.reject(lifetime.reason); waiters.clear();
    void iterator?.return?.().catch(() => {});
  }
  lifetime.addEventListener('abort', close, { once: true });
  if (lifetime.aborted) close();
  else {
    iterator = session.operations.subscribe({ operationId, signal: lifetime })[Symbol.asyncIterator]();
    void (async () => {
      try {
        while (!closed) {
          const next = await iterator.next(); if (closed || next.done) break;
          const inspection = next.value;
          if (inspection.applicationId !== session.applicationId || inspection.operationId !== operationId) throw Error('Authenticated operation scope mismatch');
          // A fact notification may arrive while an older explicit read is in
          // flight. Publish this authenticated inspection, never that older read.
          ++token; dirty = false; emit({ inspection, error: null });
          for (const waiter of waiters) waiter.resolve(snapshot); waiters.clear();
        }
      } catch (error) { if (!closed) try { onError(error); } catch {} }
    })();
    void refresh().catch(() => {});
  }
  return Object.freeze({ refresh, retry, waitFor, close, get snapshot() { return snapshot; } });
}
