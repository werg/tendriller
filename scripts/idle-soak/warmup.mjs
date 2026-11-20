/** Active startup barriers. No timer survives entry into a measured idle segment. */
export function nativeReady(child, { signal, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', exited);
      signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
    const message = value => { if (value?.idleSoakReady === 1) finish(); };
    const exited = () => finish(Error('NATIVE_NOT_READY'));
    const aborted = () => finish(Error('WARMUP_INTERRUPTED'));
    const timer = setTimeout(() => finish(Error('NATIVE_READY_DEADLINE')), timeoutMs);
    child.on('message', message); child.once('exit', exited); child.once('error', exited);
    signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
  });
}
export function quietBoundary({ signal, quietMs = 2000, timeoutMs = 30000, busy = () => false } = {}) {
  let activity = () => {};
  return { activity() { activity(); }, wait() {
    return new Promise((resolve, reject) => {
      let quiet;
      const finish = error => { clearTimeout(quiet); clearTimeout(deadline); activity = () => {};
        signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => finish(Error('WARMUP_INTERRUPTED'));
      const deadline = setTimeout(() => finish(Error('QUIET_BOUNDARY_DEADLINE')), timeoutMs);
      activity = () => { clearTimeout(quiet); quiet = setTimeout(() => { if (!busy()) finish(); }, quietMs); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else activity();
    });
  } };
}
