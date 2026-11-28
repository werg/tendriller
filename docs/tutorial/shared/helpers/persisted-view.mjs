// Stale-while-revalidate first paint for `createLiveView(session, derive, { persistKey, storage })`.
//
// The live view writes every coherent snapshot it derives to `storage[persistKey]`.
// A page reads that copy synchronously at startup and paints it, marked stale, before
// its Worker, WASM and local database are open; the live view then replaces it with a
// current snapshot. Staleness window: from page start until the first current read
// (normally well under a second on a warm device). The copy is device-local derived
// data the browser already holds; it is keyed by profile and publication (a new
// release never renders an older release's value shape), and a page forgets it when
// this device is removed.

const PREFIX = 'tendril-live:';

/** The persist key for view `name`, scoped to this browser profile and the executing publication. */
export function liveViewKey(storage, profileId, name) {
  const publication = globalThis.window?.tendril?.identity?.publication ?? 'unpublished';
  const scope = `${PREFIX}${profileId}:${name}:`, key = `${scope}${publication}`;
  // Drop copies written by earlier publications of the same view.
  try {
    for (let index = storage.length - 1; index >= 0; index--) {
      const other = storage.key(index);
      if (other?.startsWith(scope) && other !== key) storage.removeItem(other);
    }
  } catch { /* Storage may be unavailable; the live view then paints only current reads. */ }
  return key;
}

/** The persisted snapshot `{ revision, value, stale: true }`, or null. Never throws. */
export function persistedSnapshot(key, storage) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.revision?.digest !== 'string') return null;
    return { revision: parsed.revision, value: parsed.value, stale: true };
  } catch { return null; }
}

/** Forget a persisted snapshot (for example after this device was removed). */
export function forgetSnapshot(key, storage) {
  try { storage.removeItem(key); } catch { /* Nothing retained. */ }
}
