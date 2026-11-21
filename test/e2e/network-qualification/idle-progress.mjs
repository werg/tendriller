import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile, rename, chmod } from 'node:fs/promises';

// Progress is local observer liveness, never an application/network probe.
export async function observeIdleDuration(durationMs, { signal, onProgress, intervalMs = 60_000 } = {}) {
  const started = Date.now();
  const idleStartedAt = new Date(started).toISOString();
  const idlePlannedEndAt = new Date(started + durationMs).toISOString();
  let queue = Promise.resolve();
  let writeFailure;
  const publish = () => {
    const value = { state: 'idle-observation-open', at: new Date().toISOString(),
      idleStartedAt, idlePlannedEndAt, requestedMs: durationMs, elapsedMs: Date.now() - started,
      counterCoverage: 'start-only-until-segment-close', modelTurns: null,
      scope: 'local-application-and-host-traffic; not Cloudflare billing or physical OS sleep' };
    queue = queue.then(() => onProgress?.(value)).catch(error => { writeFailure ??= error; });
  };
  publish(); await queue;
  if (writeFailure) throw writeFailure;
  const heartbeat = setInterval(publish, intervalMs);
  try { await sleep(durationMs, undefined, { signal }); }
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
