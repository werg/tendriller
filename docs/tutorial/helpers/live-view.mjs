// Application-owned UI adapter over public native/Worker session APIs.
// It owns no session, state store, replication loop or domain projection.
export function createLiveView(session, {
  query, input = null, onSnapshot, onStatus, onRecovery, onError, signal,
} = {}) {
  if (typeof query !== 'string' || !query) throw TypeError('A declared query name is required.');
  const capturedInput = structuredClone(input), lifetime = new AbortController();
  const owned = AbortSignal.any([lifetime.signal, ...[session.signal, signal].filter(Boolean)]);
  let closed = false, running = false, dirty = false, requested = 0, snapshot = null;
  let status = null, error = null;
  let statusKey, stopStatus = () => {}, stopRecovery = () => {}, iterator;
  const waiting = new Set(), listeners = new Set();
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
          snapshot = Object.freeze({ revision: result.revision, value: result.value }); error = null;
          settle(null, snapshot); notify(onSnapshot, snapshot);
          for (const listener of listeners) notify(listener, snapshot);
        } catch (failure) {
          if (closed || request !== requested) continue;
          error = failure; settle(failure, undefined, true); notify(onError, failure);
        }
      }
    } finally { running = false; }
  }
  function refresh() {
    if (closed) return Promise.reject(owned.reason ?? Error('Live view is closed.'));
    const task = new Promise((resolve, reject) => waiting.add({ resolve, reject }));
    invalidate(); return task;
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
    stopStatus(); stopRecovery(); listeners.clear(); settle(owned.reason, undefined, true);
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
        status = value; notify(onStatus, value);
        const next = `${value.generation}/${value.database}/${value.phase}`;
        if (generationChanged || next !== statusKey && value.database === 'ready' && value.phase === 'ready') invalidate();
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
          } catch (failure) { if (!closed) { error = failure; notify(onError, failure); } }
        })();
        invalidate();
      }
    } catch (error) { close(); throw error; }
  }
  // Subscribers receive only coherent {revision,value} snapshots. Connection
  // status and read/observation errors have separate fields and callbacks.
  return Object.freeze({ refresh, subscribe, close, get snapshot() { return snapshot; },
    get status() { return status; }, get error() { return error; } });
}
