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

/** The cursor advances only after the caller durably handles an entire batch. */
export async function consumeNativeEvents(session, {
  topics, loadCursor, commitBatch, signal, onReady,
}) {
  if (!Array.isArray(topics) || !topics.length || topics.some(topic => typeof topic !== 'string' || !topic)
    || typeof loadCursor !== 'function' || typeof commitBatch !== 'function') throw Error('AGENT_CONSUMER_OPTIONS_INVALID');
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([session.signal, stopped.signal, signal].filter(Boolean));
  const selectedTopics = [...topics];
  const review = evidence => Object.assign(Error('AGENT_CONSUMER_REVIEW_RECOVERY: reconcile handled work before resuming.'), evidence);
  const offRecovery = session.onRecovery(recovery => stopped.abort(review({ recovery })));
  let ready = false;
  try {
    let cursor = await loadCursor();
    lifetime.throwIfAborted();
    for await (const change of session.changes({ signal: lifetime })) {
      lifetime.throwIfAborted();
      if (change.kind === 'recovery') throw review({ revision: change.revision, recovery: change.recovery });
      for (;;) {
        lifetime.throwIfAborted();
        const view = await session.readView();
        let batch;
        try {
          lifetime.throwIfAborted();
          batch = await view.readEvents({ topics: selectedTopics, limit: 64,
            ...(cursor === undefined ? {} : { cursor }) });
        } finally { await view.release(); }
        // A handler may wait on a model or an external service. Never pin a
        // captured view across that work; recovery still cancels the batch.
        lifetime.throwIfAborted();
        if (batch.hasMore && batch.cursor === cursor) throw Error('AGENT_CONSUMER_CURSOR_STALLED');
        if (!ready) { await onReady?.({ signal: lifetime }); ready = true; lifetime.throwIfAborted(); }
        await commitBatch(batch, { signal: lifetime });
        lifetime.throwIfAborted();
        cursor = batch.cursor;
        if (!batch.hasMore) break;
      }
    }
    lifetime.throwIfAborted();
    throw Error('AGENT_CONSUMER_STREAM_ENDED: inspect the owner before restarting.');
  } finally { offRecovery(); }
}
