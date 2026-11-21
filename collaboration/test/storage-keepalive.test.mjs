import assert from 'node:assert/strict';
import test from 'node:test';
import { keepStorageInUse } from '../../session/browser.mjs';

// Chromium's in-memory OPFS (private windows, automation contexts) drops record files
// nothing has touched for ~10 minutes; listing the directory resets that. The keep-alive
// must cost nothing where storage is persisted and never wake a hidden page.
function environment() {
  const listed = [], listeners = new Map();
  const on = (target, type, fn) => { (listeners.get(target + type) ?? listeners.set(target + type, new Set()).get(target + type)).add(fn); };
  const off = (target, type, fn) => listeners.get(target + type)?.delete(fn);
  const fire = (target, type) => { for (const fn of listeners.get(target + type) ?? []) fn({}); };
  const directory = { kind: 'directory', async *keys() { throw Error('records must not be listed'); } };
  const root = { async *entries() { yield ['chronolog-app', directory]; yield ['other', directory]; yield ['chronolog-file', { kind: 'file' }]; },
    async getDirectoryHandle(name) { listed.push(name); return directory; } };
  const document = { visibilityState: 'visible', addEventListener: (t, f) => on('doc', t, f), removeEventListener: (t, f) => off('doc', t, f) };
  const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), document: globalThis.document,
    add: globalThis.addEventListener, remove: globalThis.removeEventListener };
  Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => root } }, configurable: true });
  globalThis.document = document; globalThis.addEventListener = (t, f) => on('win', t, f); globalThis.removeEventListener = (t, f) => off('win', t, f);
  return { listed, document, fire, restore() {
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator); else delete globalThis.navigator;
    globalThis.document = saved.document; globalThis.addEventListener = saved.add; globalThis.removeEventListener = saved.remove;
  } };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('ticks only while visible, touches once on hide and on resume, and opens only record directories', async () => {
  const env = environment();
  let stop;
  try {
    const ticks = []; stop = keepStorageInUse({ intervalMs: 20, storagePersisted: false, onTick: tick => ticks.push(tick) });
    await wait(70);
    const visible = env.listed.length;
    assert.ok(visible >= 2, 'periodic ticks while visible');
    assert.deepEqual([...new Set(env.listed)], ['chronolog-app']);
    assert.deepEqual(ticks[0], { ms: ticks[0].ms, directories: 1 });
    env.document.visibilityState = 'hidden'; env.fire('doc', 'visibilitychange'); await wait(5);
    const hidden = env.listed.length;
    assert.equal(hidden, visible + 1, 'one touch when the page is hidden');
    await wait(80);
    assert.equal(env.listed.length, hidden, 'no wake-ups while hidden');
    env.document.visibilityState = 'visible'; env.fire('doc', 'visibilitychange'); await wait(5);
    assert.equal(env.listed.length, hidden + 1, 'one touch on resume');
    await wait(50);
    assert.ok(env.listed.length > hidden + 1, 'ticks resume while visible');
    stop(); const stopped = env.listed.length; await wait(60);
    assert.equal(env.listed.length, stopped, 'stops with the attachment');
  } finally { stop?.(); env.restore(); }
});

test('does nothing when storage is persisted or the interval is 0', async () => {
  const env = environment();
  let stopPersisted, stopDisabled;
  try {
    stopPersisted = keepStorageInUse({ intervalMs: 10, storagePersisted: Promise.resolve(true) });
    stopDisabled = keepStorageInUse({ intervalMs: 0, storagePersisted: false });
    await wait(50);
    env.document.visibilityState = 'hidden'; env.fire('doc', 'visibilitychange');
    await wait(10);
    assert.equal(env.listed.length, 0);
    stopPersisted(); stopDisabled();
  } finally { stopPersisted?.(); stopDisabled?.(); env.restore(); }
});

test('visible nonpersistent attachment touches records before the first long interval', { timeout: 3000 }, async () => {
  const env = environment(); let stop, deadline;
  try {
    let touched;
    const firstTouch = new Promise(resolve => { touched = resolve; });
    stop = keepStorageInUse({ intervalMs: 60000, storagePersisted: false, onTick: touched });
    await Promise.race([firstTouch, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Error('INITIAL_STORAGE_TOUCH_TIMEOUT')), 1000);
    })]);
    assert.deepEqual(env.listed, ['chronolog-app']);
  } finally { clearTimeout(deadline); stop?.(); env.restore(); }
});

test('hidden startup and a stopped pending persistence check do not touch records', async () => {
  const env = environment(); let stopHidden, stopPending;
  try {
    env.document.visibilityState = 'hidden';
    stopHidden = keepStorageInUse({ intervalMs: 60000, storagePersisted: false });
    let resolvePersisted;
    const persisted = new Promise(resolve => { resolvePersisted = resolve; });
    env.document.visibilityState = 'visible';
    stopPending = keepStorageInUse({ intervalMs: 60000, storagePersisted: persisted });
    stopPending(); resolvePersisted(false);
    // The hidden attachment's deferred persistence continuation still sees the
    // actual document visibility when it starts, so keep it hidden until settled.
    env.document.visibilityState = 'hidden';
    await new Promise(setImmediate);
    assert.deepEqual(env.listed, []);
  } finally { stopHidden?.(); stopPending?.(); env.restore(); }
});
