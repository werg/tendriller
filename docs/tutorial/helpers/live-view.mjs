// Application-owned UI adapter over public native/Worker session APIs.
// It owns no session, state store, replication loop or domain projection.
export function createLiveView(session, {
  query, input = null, onSnapshot, onStatus, onRecovery, onError, signal,
} = {}) {
  if (typeof query !== 'string' || !query) throw TypeError('A declared query name is required.');
  const capturedInput = structuredClone(input), lifetime = new AbortController();
  const owned = AbortSignal.any([lifetime.signal, ...[session.signal, signal].filter(Boolean)]);
  let closed = false, running = false, dirty = false, requested = 0, snapshot = null;
  let status = null, error = null, hasError = false;
  let statusKey, stopStatus = () => {}, stopRecovery = () => {}, iterator;
  const waiting = new Set(), initial = new Set(), listeners = new Set();
  const recovering = failure => (failure?.code ?? failure?.message) === 'PEER_RECOVERING';
  const settleInitial = (failed, value) => {
    for (const finish of [...initial]) finish(failed, value);
  };
  const notify = (listener, value) => {
    if (closed || !listener) return;
    try { listener(value); } catch (error) { if (listener !== onError) notify(onError, error); }
  };
  const settle = (error, value, failed = false) => {
    for (const held of waiting) failed ? held.reject(error) : held.resolve(value);
    waiting.clear();
  };
  const invalidate = () => {
    if (closed) return;
    requested++; dirty = true; queueMicrotask(pump);
  };
  async function pump() {
    if (running || closed) return;
    running = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        const request = requested;
        try {
          const result = await session.query(query, capturedInput);
          // A later invalidation may describe another selected generation.
          // Never order revisions by sequence or merge independently read values.
          if (closed || request !== requested) continue;
          snapshot = Object.freeze({ revision: result.revision, value: result.value }); error = null; hasError = false;
          settle(null, snapshot); settleInitial(false, snapshot); notify(onSnapshot, snapshot);
          for (const listener of listeners) notify(listener, snapshot);
        } catch (failure) {
          if (closed || request !== requested) continue;
          const quietRecovery = recovering(failure) && snapshot === null && initial.size > 0 && waiting.size === 0;
          error = failure; hasError = true; settle(failure, undefined, true);
          if (!recovering(failure)) settleInitial(true, failure);
          if (!quietRecovery) notify(onError, failure);
        }
      }
    } finally { running = false; }
  }
  function refresh() {
    if (closed) return Promise.reject(owned.reason);
    const task = new Promise((resolve, reject) => waiting.add({ resolve, reject }));
    invalidate(); return task;
  }
  // Unlike an explicit refresh, first-read readiness survives ordinary replica
  // recovery. The same view/session retries only on invalidation events, within
  // one fixed caller deadline; there is no timer-driven read or reconnect loop.
  function ready({ signal, timeoutMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      return Promise.reject(TypeError('Initial read timeout must be 1..120000 milliseconds.'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (closed) return Promise.reject(owned.reason);
    if (snapshot !== null) return Promise.resolve(snapshot);
    if (hasError && !recovering(error)) return Promise.reject(error);
    return new Promise((resolve, reject) => {
      const finish = (failed, value) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); initial.delete(finish);
        failed ? reject(value) : resolve(value);
      };
      const abort = () => finish(true, signal.reason);
      const timer = setTimeout(() => finish(true, Object.assign(Error('INITIAL_READ_TIMEOUT'), { code: 'INITIAL_READ_TIMEOUT' })), timeoutMs);
      initial.add(finish); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  function subscribe(listener) {
    if (typeof listener !== 'function') throw TypeError('A snapshot listener is required.');
    if (closed) throw Error('Live view is closed.');
    listeners.add(listener);
    if (snapshot !== null) notify(listener, snapshot);
    return () => { listeners.delete(listener); };
  }
  function close() {
    if (closed) return;
    closed = true; owned.removeEventListener('abort', close);
    lifetime.abort(Error('Live view is closed.'));
    stopStatus(); stopRecovery(); listeners.clear(); settle(owned.reason, undefined, true); settleInitial(true, owned.reason);
    // Query has no cancellation parameter. Late results are ignored; closing an
    // observer must not close the shared session or wait for an uncancellable read.
    void Promise.resolve().then(() => iterator?.return?.()).catch(() => {});
  }
  owned.addEventListener('abort', close, { once: true });
  if (owned.aborted) close();
  else {
    try {
      stopStatus = session.onStatus(value => {
        const generationChanged = status !== null && status.generation !== value.generation;
        const becameReady = status?.phase !== 'ready' && value.phase === 'ready';
        status = value; notify(onStatus, value);
        const next = `${value.generation}/${value.database}/${value.phase}`;
        if (generationChanged || becameReady || next !== statusKey && value.database === 'ready' && value.phase === 'ready') invalidate();
        statusKey = next;
        if (value.phase === 'closed' || value.database === 'closed') close();
      });
      if (closed) stopStatus();
      else {
        stopRecovery = session.onRecovery(notice => { notify(onRecovery, notice); invalidate(); });
        iterator = session.changes({ signal: owned })[Symbol.asyncIterator]();
        // Begin observing before requesting the first read. Changes are
        // invalidations, including recovery, rather than an event replay log.
        void (async () => {
          try {
            while (!closed) {
              const change = await iterator.next();
              if (change.done) break;
              invalidate();
            }
          } catch (failure) { if (!closed) { error = failure; hasError = true; if (!recovering(failure)) settleInitial(true, failure); notify(onError, failure); } }
        })();
        invalidate();
      }
    } catch (error) { close(); throw error; }
  }
  // Subscribers receive only coherent {revision,value} snapshots. Connection
  // status and read/observation errors have separate fields and callbacks.
  return Object.freeze({ refresh, ready, subscribe, close, get snapshot() { return snapshot; },
    get status() { return status; }, get error() { return error; } });
}
