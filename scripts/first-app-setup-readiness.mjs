// Test-only witness for the optional native participant's LOCAL prerequisites.
//
// Ready means this retained device can author and read from its own stored state:
// the session is open, its signing identity holds a writer grant with the current
// epoch key (`canAuthor`), and local materialization has not failed. Peer
// connectivity, host reachability, retention evidence and finality are never
// prerequisites: an offline or unfinalized participant is still ready, and a
// missing finalizer can only delay finality evidence, never local authoring.
//
// The observer reads `session.status` and `session.onStatus`, the public
// application-session surface. It creates no requests, timers (other than an
// explicit wait deadline) or polling.
export function describeLocalReadiness(status) {
  const closed = status?.phase === 'closed' || status?.database === 'closed';
  const failed = status?.database === 'failed' || (status?.materializationError ?? null) !== null;
  return {
    phase: status?.phase ?? 'unknown', database: status?.database ?? 'unknown',
    canAuthor: status?.canAuthor === true, materializationError: status?.materializationError ?? null,
    // Informational only. Unseen remote bodies/keys do not block local authoring.
    awaitingKeys: status?.phase === 'awaiting-keys', pendingOperations: status?.pendingOperations ?? 0,
    ready: !closed && !failed && status?.canAuthor === true,
  };
}

export function observeLocalReadiness(session) {
  const snapshot = () => describeLocalReadiness(session.status);
  return {
    snapshot,
    /** Resolves when local prerequisites hold; fails closed on closure, materialization failure, abort or deadline. */
    wait({ signal, timeoutMs = 55000 } = {}) {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        let timer, off, settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); off?.(); signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve(value);
        };
        const abort = () => finish(signal.reason);
        const check = () => {
          if (settled) return;
          const value = snapshot();
          if (signal?.aborted) return abort();
          if (value.phase === 'closed' || value.database === 'closed') return finish(Object.assign(Error('SESSION_CLOSED'), { code: 'SESSION_CLOSED' }));
          if (value.database === 'failed' || value.materializationError !== null)
            return finish(Object.assign(Error('LOCAL_MATERIALIZATION_FAILED'), { code: 'LOCAL_MATERIALIZATION_FAILED', cause: value.materializationError }));
          if (value.ready) finish(null, value);
        };
        timer = setTimeout(() => finish(Object.assign(Error('LOCAL_READY_TIMEOUT'), { code: 'LOCAL_READY_TIMEOUT' })), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          // onStatus may invoke the callback synchronously, before `off` exists.
          const unsubscribe = session.onStatus(check);
          if (settled) unsubscribe?.(); else off = unsubscribe;
          check();
        } catch (error) { finish(error); }
      });
    },
  };
}
