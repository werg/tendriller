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
