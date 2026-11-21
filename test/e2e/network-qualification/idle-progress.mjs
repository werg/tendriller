import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { writeFile, rename, chmod } from 'node:fs/promises';

// Node timers can return before a fractional monotonic deadline. Re-arm only
// for the remaining time; neither an early wake nor a UTC clock adjustment can
// shorten the idle measurement. The injected clock/wait are local unit seams.
export async function waitForIdleDeadline(deadline, { signal,
  now = () => performance.now(), wait = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
  for (;;) {
    signal?.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) return;
    await wait(Math.ceil(remaining), signal);
  }
}

// Progress is local observer liveness, never an application/network probe.
export async function observeIdleDuration(durationMs, { signal, onProgress, intervalMs = 60_000 } = {}) {
  signal?.throwIfAborted();
  const monotonicStarted = performance.now();
  const deadline = monotonicStarted + durationMs;
  const started = Date.now();
  const idleStartedAt = new Date(started).toISOString();
  const idlePlannedEndAt = new Date(started + durationMs).toISOString();
  let queue = Promise.resolve();
  let writeFailure;
  const publish = () => {
    const value = { state: 'idle-observation-open', at: new Date().toISOString(),
      idleStartedAt, idlePlannedEndAt, requestedMs: durationMs, elapsedMs: performance.now() - monotonicStarted,
      counterCoverage: 'start-only-until-segment-close', modelTurns: null,
      scope: 'local-application-and-host-traffic; not Cloudflare billing or physical OS sleep' };
    queue = queue.then(() => onProgress?.(value)).catch(error => { writeFailure ??= error; });
  };
  publish(); await queue;
  if (writeFailure) throw writeFailure;
  const heartbeat = setInterval(publish, intervalMs);
  try { await waitForIdleDeadline(deadline, { signal }); }
  finally { clearInterval(heartbeat); await queue; }
  if (writeFailure) throw writeFailure;
  return { idleStartedAt, idlePlannedEndAt };
}

export function progressWriter(path) {
  return async value => {
    if (!path) return;
    // This bounded, redacted report is CI evidence. Its enclosing output
    // directory stays private; the host uploader must read container-owned bytes.
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 });
    await chmod(temporary, 0o644);
    await rename(temporary, path);
  };
}
