// Application-owned Node helpers. These use only public session APIs and never
// close the native owner, change its signer, or start a host conversation.
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});

/** One private writer, atomic checkpoints, no automatic stale-lock takeover. */
export async function openConsumerCheckpoint(path, { scope } = {}) {
  if (typeof path !== 'string' || !path || scope === undefined) throw Error('AGENT_CONSUMER_CHECKPOINT_OPTIONS_INVALID');
  const file = resolve(path), directory = dirname(file), lock = file + '.lock';
  const token = randomUUID(), expectedScope = canonical(scope), savedScope = JSON.parse(expectedScope);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw Object.assign(Error('AGENT_CONSUMER_LOCKED: verify the previous worker has stopped before removing its stale .lock directory.'),
      { code: 'AGENT_CONSUMER_LOCKED', checkpointPath: file });
  }
  let current = null, closed = false, tail = Promise.resolve();
  try {
    await writeFile(resolve(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }), { mode: 0o600 });
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
