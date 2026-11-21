// Test-only witness around the real participant supervisor's existing callbacks.
// No requests, retry timers or polling are created by this observer.
export function observeSetupReadiness(owned) {
  let state = 'opening', revision = 0, notices = 0, noticeRevision = -1, reconciled = 0, pending = 0;
  const listeners = new Set();
  const snapshot = () => ({ state, revision, notices, reconciled, pending,
    ready: state === 'connected' && noticeRevision === revision && reconciled >= notices && pending === 0 });
  const changed = () => { for (const listener of listeners) listener(); };
  return {
    snapshot,
    watch(callbacks) {
      return owned.watchSetup({ ...callbacks,
        onStatus(value) {
          state = value.state;
          if (state === 'connected') { revision++; noticeRevision = -1; }
          callbacks.onStatus?.(value); changed();
        },
        onChange(value) {
          notices++; noticeRevision = revision;
          callbacks.onChange(value); changed();
        },
      });
    },
    async processPairings(options) {
      const through = notices;
      pending++; changed();
      try {
        const result = await owned.processPairings?.(options) ?? [];
        reconciled = Math.max(reconciled, through);
        return result;
      } finally { pending--; changed(); }
    },
    wait({ signal, timeoutMs = 55000 } = {}) {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        let timer;
        const finish = (error, value) => {
          clearTimeout(timer); listeners.delete(check); signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve(value);
        };
        const abort = () => finish(signal.reason);
        const check = () => {
          const value = snapshot();
          if (signal?.aborted) return abort();
          if (['closed', 'access_revoked'].includes(value.state)) return finish(Error('SETUP_CONTROL_CLOSED'));
          if (value.ready) finish(null, value);
        };
        timer = setTimeout(() => finish(Error('SETUP_CONTROL_READY_TIMEOUT')), timeoutMs);
        listeners.add(check); signal?.addEventListener('abort', abort, { once: true }); check();
      });
    },
  };
}
