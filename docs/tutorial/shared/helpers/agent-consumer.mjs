// Application-owned Node helpers. These use only public session APIs and never
// close the native owner, change its signer, or start a host conversation.
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';

const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});

async function defaultReadBootId() {
  try {
    const raw = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    return raw || null;
  } catch { return null; }
}

/**
 * Read Linux /proc/<pid>/stat field 22 (starttime in clock ticks since boot).
 * Uniquely identifies a process instance within a boot even if the OS reuses a PID.
 */
async function defaultReadProcessStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const endComm = raw.lastIndexOf(')');
    if (endComm < 0) return null;
    // Fields after ') ' start at field 3 (state); field 22 (starttime) is index 19.
    const fields = raw.slice(endComm + 2).trim().split(/\s+/u);
    return fields[19] && /^\d+$/u.test(fields[19]) ? fields[19] : null;
  } catch { return null; }
}

function defaultIsPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM means the process exists under another user -> treat as alive!
    return true;
  }
}

async function readOwnerWithGrace(ownerPath, graceMs = 150) {
  const deadline = Date.now() + graceMs;
  for (;;) {
    try {
      const parsed = JSON.parse(await readFile(ownerPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && typeof parsed.token === 'string' && Number.isSafeInteger(parsed.pid)) {
        return parsed;
      }
      return null;
    } catch (error) {
      if ((error.code === 'ENOENT' || error instanceof SyntaxError) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 15));
        continue;
      }
      return null;
    }
  }
}

async function classifyStaleOwner(owner, env) {
  if (!owner || typeof owner.token !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    return { stale: false, reason: 'owner_unreadable' };
  }
  const currentHost = env.hostname();
  if (typeof owner.hostname === 'string' && owner.hostname && owner.hostname !== currentHost) {
    return { stale: false, reason: 'different_host' };
  }
  const currentBootId = await env.readBootId();
  if (typeof owner.bootId === 'string' && owner.bootId && currentBootId && owner.bootId !== currentBootId) {
    return { stale: true, reason: 'reboot' };
  }
  const currentPid = env.pid();
  if (owner.pid === currentPid) {
    const currentStart = await env.readProcessStart(currentPid);
    if (typeof owner.processStart === 'string' && owner.processStart && currentStart && owner.processStart !== currentStart) {
      return { stale: true, reason: 'pid_reused' };
    }
    return { stale: false, reason: 'same_process_live' };
  }
  if (!env.isPidAlive(owner.pid)) {
    return { stale: true, reason: 'process_dead' };
  }
  if (typeof owner.processStart === 'string' && owner.processStart) {
    const liveStart = await env.readProcessStart(owner.pid);
    if (liveStart === null) {
      if (!env.isPidAlive(owner.pid)) return { stale: true, reason: 'process_dead' };
      return { stale: false, reason: 'process_start_unverifiable' };
    }
    if (liveStart !== owner.processStart) {
      return { stale: true, reason: 'pid_reused' };
    }
  }
  return { stale: false, reason: 'owner_live' };
}

/**
 * One private writer with atomic checkpoints and safe boot/process-identity stale-lock recovery.
 * Recovers locks left behind by a reboot, crash, or reused PID without touching the checkpoint
 * file (preserving pending/uncertain admissions for explicit reconciliation), while failing closed
 * with AGENT_CONSUMER_LOCKED whenever a live owner or unverifiable lock is present.
 */
export async function openConsumerCheckpoint(path, { scope, onRecoveredStaleLock, _lockEnv } = {}) {
  if (typeof path !== 'string' || !path || scope === undefined) throw Error('AGENT_CONSUMER_CHECKPOINT_OPTIONS_INVALID');
  const env = {
    pid: () => process.pid,
    hostname: () => osHostname(),
    readBootId: defaultReadBootId,
    readProcessStart: defaultReadProcessStart,
    isPidAlive: defaultIsPidAlive,
    ...(_lockEnv ?? {}),
  };
  const file = resolve(path), directory = dirname(file), lock = file + '.lock';
  const token = randomUUID(), expectedScope = canonical(scope), savedScope = JSON.parse(expectedScope);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt >= 2) {
        throw Object.assign(Error('AGENT_CONSUMER_LOCKED: verify the previous worker has stopped before removing its stale .lock directory.'),
          { code: 'AGENT_CONSUMER_LOCKED', checkpointPath: file });
      }
      const existingOwner = await readOwnerWithGrace(resolve(lock, 'owner.json'));
      const verdict = await classifyStaleOwner(existingOwner, env);
      if (!verdict.stale) {
        throw Object.assign(
          Error(`AGENT_CONSUMER_LOCKED: checkpoint is held by an active or unverifiable owner (${verdict.reason}).`),
          { code: 'AGENT_CONSUMER_LOCKED', reason: verdict.reason, checkpointPath: file, ownerPid: existingOwner?.pid ?? null },
        );
      }
      // Race-free atomic takeover: only one contender can rename the stale lock directory.
      const graveyard = `${lock}.stale.${randomUUID()}`;
      try {
        await rename(lock, graveyard);
      } catch (renameErr) {
        if (renameErr.code === 'ENOENT') continue; // Another contender reclaimed it; retry mkdir once.
        throw Object.assign(
          Error('AGENT_CONSUMER_LOCKED: could not atomically reclaim stale lock directory.'),
          { code: 'AGENT_CONSUMER_LOCKED', checkpointPath: file, cause: renameErr },
        );
      }
      try {
        const movedOwner = JSON.parse(await readFile(resolve(graveyard, 'owner.json'), 'utf8'));
        if (movedOwner.token !== existingOwner.token) {
          // Unexpected swap: fail loudly rather than hiding a concurrent owner.
          await rename(graveyard, lock).catch(() => {});
          throw Object.assign(Error('AGENT_CONSUMER_LOCKED: lock owner changed during stale-lock recovery.'),
            { code: 'AGENT_CONSUMER_LOCKED', checkpointPath: file });
        }
      } finally {
        await rm(graveyard, { recursive: true, force: true }).catch(() => {});
      }
      try {
        onRecoveredStaleLock?.({ reason: verdict.reason, previousOwner: existingOwner, checkpointPath: file });
      } catch { /* diagnostic callback must not break recovery */ }
    }
  }

  let current = null, closed = false, tail = Promise.resolve();
  try {
    const myPid = env.pid();
    const [bootId, processStart] = await Promise.all([env.readBootId(), env.readProcessStart(myPid)]);
    const ownerPayload = JSON.stringify({
      pid: myPid,
      token,
      hostname: env.hostname(),
      bootId,
      processStart,
      startedAt: new Date().toISOString(),
    });
    const ownerTmp = resolve(lock, `owner.${randomUUID()}.tmp`);
    await writeFile(ownerTmp, ownerPayload, { mode: 0o600 });
    await rename(ownerTmp, resolve(lock, 'owner.json'));
    try {
      const envelope = JSON.parse(await readFile(file, 'utf8'));
      if (envelope.version !== 1 || canonical(envelope.scope) !== expectedScope || !Object.hasOwn(envelope, 'value')) {
        throw Error('AGENT_CONSUMER_CHECKPOINT_SCOPE_MISMATCH');
      }
      current = envelope.value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }

  return Object.freeze({
    read() { return structuredClone(current); },
    save(value) {
      if (closed) return Promise.reject(Error('AGENT_CONSUMER_CHECKPOINT_CLOSED'));
      // Capture the bytes before yielding; caller mutation cannot change a pending save.
      const bytes = JSON.stringify({ version: 1, scope: savedScope, value }) + '\n';
      const next = JSON.parse(bytes).value;
      const saved = tail.then(async () => {
        const temporary = file + '.' + randomUUID() + '.tmp';
        let handle;
        try {
          handle = await open(temporary, 'wx', 0o600);
          await handle.writeFile(bytes);
          await handle.sync();
          await handle.close(); handle = undefined;
          await rename(temporary, file);
          // Persist the rename as well as file contents on supported Unix filesystems.
          const parent = await open(directory, 'r');
          try { await parent.sync(); } finally { await parent.close(); }
          current = next;
        } finally { await handle?.close(); await rm(temporary, { force: true }); }
      });
      // Preserve write ordering and make a failed write stop further writes in this run.
      tail = saved;
      void tail.catch(() => {});
      return saved;
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await tail; }
      finally {
        const owner = JSON.parse(await readFile(resolve(lock, 'owner.json'), 'utf8'));
        if (owner.token !== token) throw Error('AGENT_CONSUMER_LOCK_REPLACED');
        await rm(lock, { recursive: true });
      }
    },
  });
}

const staleCursor = error => error?.code === 'EVENT_CURSOR_STALE' || /EVENT_CURSOR_STALE/u.test(error?.message ?? '');

/**
 * The saved cursor advances only after the caller durably handles an entire batch.
 * An event cursor binds to the materialized projection that produced it, so any
 * later revision (a peer's operation, a late earlier operation, or this
 * consumer's own receipt/answer) makes it fail with `EVENT_CURSOR_STALE`. That
 * is not an error to skip over: the consumer derives the events again from the
 * start of the current coherent snapshot and the adapter reconciles by stable
 * request references and its own durable records (`commitBatch` must be idempotent
 * for work it already handled). The old cursor is never translated, and
 * `onCursorReset` lets the adapter retain evidence of the reset.
 */
export async function consumeNativeEvents(session, {
  topics, loadCursor, commitBatch, signal, onReady, onCursorReset,
}) {
  if (!Array.isArray(topics) || !topics.length || topics.some(topic => typeof topic !== 'string' || !topic)
    || typeof loadCursor !== 'function' || typeof commitBatch !== 'function') throw Error('AGENT_CONSUMER_OPTIONS_INVALID');
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([session.signal, stopped.signal, signal].filter(Boolean));
  const selectedTopics = [...topics];
  // `changes()` sends no initial notification. Subscribe before the first
  // coherent read so a change during or after it wakes the next pass.
  const iterator = session.changes({ signal: lifetime })[Symbol.asyncIterator]();
  let pending = iterator.next(), ready = false;
  pending.catch(() => {});
  try {
    let cursor = await loadCursor();
    lifetime.throwIfAborted();
    for (;;) {
      for (;;) {
        lifetime.throwIfAborted();
        const view = await session.readView();
        let batch, reset = false;
        try {
          lifetime.throwIfAborted();
          batch = await view.readEvents({ topics: selectedTopics, limit: 64,
            ...(cursor === undefined ? {} : { cursor }) });
        } catch (error) {
          if (cursor === undefined || !staleCursor(error)) throw error;
          reset = true;
        } finally { await view.release(); }
        if (reset) {
          const previous = cursor;
          cursor = undefined;
          await onCursorReset?.({ previousCursor: previous, signal: lifetime });
          continue;
        }
        // A handler may wait on a model or an external service. Never pin a
        // captured view across that work.
        lifetime.throwIfAborted();
        if (batch.hasMore && batch.cursor === cursor) throw Error('AGENT_CONSUMER_CURSOR_STALLED');
        if (!ready) { await onReady?.({ signal: lifetime }); ready = true; lifetime.throwIfAborted(); }
        await commitBatch(batch, { signal: lifetime });
        lifetime.throwIfAborted();
        cursor = batch.cursor;
        if (!batch.hasMore) break;
      }
      const step = await pending;
      lifetime.throwIfAborted(); // Cancellation may end the stream instead of rejecting it.
      if (step.done) throw Error('AGENT_CONSUMER_STREAM_ENDED: inspect the owner before restarting.');
      pending = iterator.next();
      pending.catch(() => {});
    }
  } finally {
    stopped.abort();
    await iterator.return?.().catch(() => {});
  }
}
