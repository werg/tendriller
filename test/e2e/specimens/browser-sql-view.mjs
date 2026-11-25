// Fixture observer over public session APIs. Subscribe before the initial read;
// changes() supplies its initial snapshot. Revisions are compared only by identity
// (digest, view, execution manifest and policy), never ordered: an earlier operation
// arriving later can produce a revision that sorts anywhere, and the view rederives it.
const identity = revision => JSON.stringify([revision.digest, revision.view, revision.executionManifestDigest, revision.policyDigest]);

export function observeSqlFixture(session, { query, onSnapshot, onError = () => {}, signal }) {
  const lifetime = new AbortController(), owned = AbortSignal.any([session.signal, signal, lifetime.signal].filter(Boolean));
  let closed = false, running = false, dirty = false, latest, displayed, snapshot, reads = 0, unavailable = false, readiness = 0, stopStatus = () => {};
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Readiness owns a bounded initial coherent read, not a delay after Ready.
  const timer = setTimeout(() => fail(new Error('SQL_FIXTURE_VIEW_TIMEOUT')), 20_000);
  const iterator = session.changes({ signal: owned })[Symbol.asyncIterator]();
  function close(...reasons) {
    const reason = reasons.length ? reasons[0] : new Error('SQL_FIXTURE_VIEW_CLOSED');
    if (closed) return;
    closed = true; clearTimeout(timer); stopStatus(); owned.removeEventListener('abort', aborted);
    lifetime.abort(reason); rejectReady(reason);
    void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  }
  function fail(error) { if (!closed) { onError(error); close(error); } }
  function aborted() { close(owned.reason); }
  owned.addEventListener('abort', aborted, { once: true });
  async function pump() {
    if (closed || running) return;
    running = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        const requested = latest, readyBeforeRead = readiness;
        reads++;
        let result;
        try { result = await session.query(query, null); }
        catch (error) {
          if (!snapshot && (error?.code ?? error?.message) === 'MATERIALIZATION_UNAVAILABLE') {
            unavailable = true;
            if (readiness !== readyBeforeRead) dirty = true;
            continue;
          }
          throw error;
        }
        unavailable = false;
        const received = identity(result.revision);
        if (closed) return;
        // A read that already contains the latest invalidation is coherent.
        // Otherwise discard the old snapshot and read again before Ready/render.
        if (latest !== requested && received !== latest) { dirty = true; continue; }
        dirty = false; displayed = received; snapshot = result;
        onSnapshot(result); clearTimeout(timer); resolveReady(result);
      }
    } catch (error) { fail(error); }
    finally { running = false; }
  }
  if (owned.aborted) aborted();
  else {
    stopStatus = session.onStatus?.(status => {
      if (closed || status.phase !== 'ready') return;
      readiness++;
      if (unavailable) { dirty = true; void pump(); }
    }) ?? (() => {});
    void (async () => {
      try {
        for (;;) {
          const change = await iterator.next();
          if (closed) return;
          if (change.done) { close(); return; }
          const value = change.value, next = identity(value.revision);
          if ((next === latest || next === displayed) && !unavailable) continue;
          latest = next; dirty = true; void pump();
        }
      } catch (error) { fail(error); }
    })();
  }
  return { ready, close, get reads() { return reads; }, get snapshot() { return snapshot; } };
}
