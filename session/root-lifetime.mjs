// A document lifetime witness, separate from the session owner's Web Lock.
// Only the document requests this unique name. Workers QUERY it; requesting a
// cached document's lock causes contention. Current Chromium can also evict
// BFCache entries on query(); normal reload restores the retained application.
// Hidden/frozen documents retain their witness without running JavaScript.
export function rootLifetimeLockName(profileId, rootId) {
  if (typeof profileId !== 'string' || typeof rootId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(profileId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(rootId)) throw Error('OWNER_HANDSHAKE_INVALID');
  return `tendriller:root-lifetime:${profileId}:${rootId}`;
}

export async function acquireRootLifetime(profileId, rootId, { signal, locks = globalThis.navigator?.locks } = {}) {
  const name = rootLifetimeLockName(profileId, rootId);
  signal?.throwIfAborted();
  if (typeof locks?.request !== 'function' || typeof locks.query !== 'function') throw Error('OWNER_CAPABILITY_UNAVAILABLE');
  let acquired, failed, unlock, released;
  const ready = new Promise((resolve, reject) => { acquired = resolve; failed = reject; });
  const retained = new Promise(resolve => { unlock = resolve; });
  let holding;
  const release = () => {
    if (!released) {
      signal?.removeEventListener('abort', abort);
      unlock();
      released = Promise.resolve(holding).then(() => undefined);
    }
    return released;
  };
  const abort = () => { failed(signal.reason); void release().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    holding = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw Error('OWNER_ROOT_LIFETIME_BUSY');
        signal?.throwIfAborted();
        acquired();
        await retained;
      });
    });
    void holding.catch(failed);
    await ready;
    signal?.throwIfAborted();
    return Object.freeze({ name, release });
  } catch (error) {
    // Cancellation must not await a native grant; its callback fences late grants.
    void release().catch(() => {});
    throw error;
  }
}

export function rootLifetimeWitness(snapshot, profileId, rootId) {
  if (!Array.isArray(snapshot?.held) || !snapshot.held.every(lock => lock && typeof lock.name === 'string' &&
      ['exclusive', 'shared'].includes(lock.mode) && typeof lock.clientId === 'string' && lock.clientId.length > 0)) throw Error('OWNER_LIFETIME_QUERY_INVALID');
  const name = rootLifetimeLockName(profileId, rootId);
  const found = snapshot.held.find(lock => lock?.name === name && lock.mode === 'exclusive' &&
    typeof lock.clientId === 'string' && lock.clientId.length > 0);
  return found ? { name, clientId: found.clientId } : undefined;
}

/** One browser-local observer for shared roots and elected routes. Never requests a witness. */
export function createDocumentLifetimeObserver({ profileId, locks = globalThis.navigator?.locks,
  sweepMs = 60000, timeoutMs = 30000, signal } = {}) {
  rootLifetimeLockName(profileId, 'validation');
  const entries = new Set(), lifetime = new AbortController();
  let timer, querying, nativeQuery, sweeping, closed = false;
  const abort = () => close();
  signal?.addEventListener('abort', abort, { once: true });
  function schedule() {
    if (closed || ![...entries].some(entry => entry.parked)) { clearTimeout(timer); timer = undefined; return; }
    if (timer || sweeping) return;
    timer = setTimeout(() => { timer = undefined; void sweep(); }, sweepMs); timer.unref?.();
  }
  function query() {
    if (querying) return querying;
    querying = (async () => {
      let timeout, onAbort;
      try {
        lifetime.signal.throwIfAborted();
        if (typeof locks?.query !== 'function') throw Error('OWNER_CAPABILITY_UNAVAILABLE');
        // The browser API has no cancellation. After a timeout, do not pile up
        // native queries; ignore its eventual old result and retry on a later scan.
        if (nativeQuery) throw Error('OWNER_LIFETIME_QUERY_PENDING');
        const pending = nativeQuery = Promise.resolve().then(() => locks.query());
        void pending.finally(() => { if (nativeQuery === pending) nativeQuery = undefined; }).catch(() => {});
        const snapshot = await Promise.race([
          pending,
          new Promise((_, reject) => { onAbort = () => reject(lifetime.signal.reason); lifetime.signal.addEventListener('abort', onAbort, { once: true }); }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('OWNER_LIFETIME_QUERY_TIMEOUT')), timeoutMs); }),
        ]);
        rootLifetimeWitness(snapshot, profileId, 'validation');
        return snapshot;
      } finally { clearTimeout(timeout); lifetime.signal.removeEventListener('abort', onAbort); }
    })().finally(() => { querying = undefined; });
    return querying;
  }
  async function freshQuery() {
    // A snapshot begun before this arrival cannot prove its witness absent.
    const previous = querying;
    if (previous) await previous.catch(() => {});
    return query();
  }
  function sweep() {
    if (sweeping) return sweeping;
    const candidates = [...entries];
    sweeping = (async () => {
      const snapshot = await freshQuery();
      if (closed) return;
      for (const entry of candidates) {
        if (!entries.has(entry)) continue;
        const live = rootLifetimeWitness(snapshot, profileId, entry.rootId);
        if (!live || live.clientId !== entry.witness.clientId) {
          entries.delete(entry);
          try { entry.retire(); } catch { /* One disposed attachment cannot prevent reclamation of others. */ }
        }
      }
    })().catch(() => { /* Failed, timed out or malformed evidence never establishes document death. */ })
      .finally(() => { sweeping = undefined; schedule(); });
    return sweeping;
  }
  function close() {
    if (closed) return;
    closed = true; clearTimeout(timer); entries.clear(); signal?.removeEventListener('abort', abort);
    lifetime.abort(Error('OWNER_UNREACHABLE'));
  }
  if (signal?.aborted) close();
  return Object.freeze({
    get hasParked() { return [...entries].some(entry => entry.parked); },
    async prove(rootId) {
      const witness = rootLifetimeWitness(await freshQuery(), profileId, rootId);
      lifetime.signal.throwIfAborted();
      if (!witness) throw Error('OWNER_ROOT_LIFETIME_MISSING');
      return witness;
    },
    register(rootId, witness, retire) {
      lifetime.signal.throwIfAborted();
      const entry = { rootId, witness, retire, parked: false }; entries.add(entry);
      return Object.freeze({ setParked(value) { if (entries.has(entry)) entry.parked = value; schedule(); },
        close() { entries.delete(entry); schedule(); } });
    },
    async reapFresh() {
      const previous = sweeping;
      if (previous) await previous;
      if (!closed) await sweep();
    },
    close,
  });
}
