import assert from 'node:assert/strict';
import test from 'node:test';
import { requestPersistentStorage } from '../browser.mjs';

// A browser device holds its only signing key and unsent signed work in origin
// storage. Best-effort storage can be evicted under pressure (observed as
// APPLICATION_DATA_STORAGE_MISSING on the next open), so the SDK asks to persist it.
function withNavigator(storage, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: storage === undefined ? {} : { storage }, configurable: true });
  return Promise.resolve().then(run).finally(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator;
  });
}

test('asks the browser to persist storage once it is not yet persisted', () => withNavigator({
  calls: [], async persisted() { this.calls.push('persisted'); return false; }, async persist() { this.calls.push('persist'); return true; },
}, async () => {
  assert.equal(await requestPersistentStorage(), true);
  assert.deepEqual(navigator.storage.calls, ['persisted', 'persist']);
}));

test('does not ask again when storage is already persisted', () => withNavigator({
  calls: [], async persisted() { this.calls.push('persisted'); return true; }, async persist() { this.calls.push('persist'); return true; },
}, async () => {
  assert.equal(await requestPersistentStorage(), true);
  assert.deepEqual(navigator.storage.calls, ['persisted']);
}));

test('reports unsupported or refused persistence without throwing', async () => {
  await withNavigator(undefined, async () => assert.equal(await requestPersistentStorage(), null));
  await withNavigator({ async persist() { throw new Error('denied'); } }, async () => assert.equal(await requestPersistentStorage(), false));
  await withNavigator({ async persisted() { return false; }, async persist() { return false; } }, async () => assert.equal(await requestPersistentStorage(), false));
});
