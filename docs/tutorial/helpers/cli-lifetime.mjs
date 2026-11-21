// Standalone CLI bookkeeping only. Importing this module does not acquire a
// process lifetime, and this helper never exits a process. The guarded entry
// point chooses disposal after finish() verifies cleanup and flushes output.
export function createCliLifetime({ runtime = process, flushTimeoutMs = 1000 } = {}) {
  const stopped = new AbortController(), stop = () => stopped.abort();
  let opened = false, closed = false, failed = false, pipeFailed = false, failure;
  const outputError = cause => {
    failed = true; pipeFailed = true; failure = cause; stopped.abort(cause);
  };
  runtime.stdout.on('error', outputError); runtime.stderr.on('error', outputError);
  runtime.once('SIGINT', stop); runtime.once('SIGTERM', stop);
  const flush = stream => new Promise((resolve, reject) => {
    let settled = false;
    const finish = cause => {
      if (settled) return;
      settled = true; clearTimeout(timer); stream.removeListener('error', finish);
      cause ? reject(cause) : resolve();
    };
    const timer = setTimeout(() => finish(Error('CLI_OUTPUT_FLUSH_DEADLINE')), flushTimeoutMs);
    stream.once('error', finish);
    try {
      stream.write('', cause => {
        // Node Writable reports a failed write to its callback before emitting
        // error on the next-tick queue. Keep the listener through that emission.
        if (cause) queueMicrotask(() => finish(cause)); else finish();
      });
    } catch (cause) { finish(cause); }
  });
  return {
    signal: stopped.signal,
    opened() { opened = true; },
    closed() { closed = true; },
    fail(error) { failed = true; failure = error; },
    async finish() {
      runtime.removeListener('SIGINT', stop); runtime.removeListener('SIGTERM', stop);
      const interrupted = opened && closed && !pipeFailed && failed && stopped.signal.aborted && failure === stopped.signal.reason;
      let code = Number.isInteger(runtime.exitCode) && runtime.exitCode !== 0 ? runtime.exitCode : 0;
      if (failed && !interrupted || opened && !closed) code ||= 1;
      try {
        if (failed && (!interrupted || opened && !closed)) {
          try { runtime.stderr.write(`${failure?.code ?? failure?.name ?? 'Error'}: ${failure?.message ?? String(failure)}\n`); }
          catch { code ||= 1; }
        }
        if (opened && !closed) {
          try { runtime.stderr.write('CLI owned cleanup is unverified. Preserve the original device, inputs and operation IDs.\n'); }
          catch { /* Nonzero even when the diagnostic pipe has closed. */ }
        }
        try { await flush(runtime.stdout); }
        catch {
          code ||= 1;
          try { runtime.stderr.write('CLI output was not fully flushed. Inspect the retained original operation before retrying.\n'); }
          catch { /* Preserve the nonzero result. */ }
        }
        try { await flush(runtime.stderr); } catch { code ||= 1; }
        if (pipeFailed) code ||= 1;
        return code;
      } finally {
        runtime.stdout.removeListener('error', outputError); runtime.stderr.removeListener('error', outputError);
      }
    },
  };
}
