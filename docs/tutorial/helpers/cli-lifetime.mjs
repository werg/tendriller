// Standalone CLI bookkeeping only. Importing this module does not acquire a
// process lifetime, and this helper never exits a process. The guarded entry
// point chooses disposal after finish() verifies cleanup and flushes output.
export function createCliLifetime({ runtime = process, flushTimeoutMs = 1000 } = {}) {
  const stopped = new AbortController(), stop = () => stopped.abort();
  let opened = false, closed = false, failed = false, failure;
  runtime.once('SIGINT', stop); runtime.once('SIGTERM', stop);
  const flush = stream => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('CLI_OUTPUT_FLUSH_DEADLINE')), flushTimeoutMs);
    const error = cause => { clearTimeout(timer); reject(cause); };
    stream.once('error', error);
    stream.write('', cause => {
      clearTimeout(timer);
      if (cause) reject(cause);
      else { stream.removeListener('error', error); resolve(); }
    });
  });
  return {
    signal: stopped.signal,
    opened() { opened = true; },
    closed() { closed = true; },
    fail(error) { failed = true; failure = error; },
    async finish() {
      runtime.removeListener('SIGINT', stop); runtime.removeListener('SIGTERM', stop);
      const interrupted = failed && stopped.signal.aborted && failure === stopped.signal.reason;
      let code = Number.isInteger(runtime.exitCode) && runtime.exitCode !== 0 ? runtime.exitCode : 0;
      if (failed && !interrupted || opened && !closed) code ||= 1;
      if (failed && (!interrupted || opened && !closed)) {
        try { runtime.stderr.write(`${failure?.code ?? failure?.name ?? 'Error'}: ${failure?.message ?? String(failure)}\n`); }
        catch { code = 1; }
      }
      if (opened && !closed) {
        try { runtime.stderr.write('CLI owned cleanup is unverified. Preserve the original device, inputs and operation IDs.\n'); }
        catch { /* Nonzero even when the diagnostic pipe has closed. */ }
      }
      try { await flush(runtime.stdout); }
      catch {
        code = 1;
        try { runtime.stderr.write('CLI output was not fully flushed. Inspect the retained original operation before retrying.\n'); }
        catch { /* Preserve the nonzero result. */ }
      }
      try { await flush(runtime.stderr); } catch { code = 1; }
      return code;
    },
  };
}
