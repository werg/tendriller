import assert from 'node:assert/strict';
import test from 'node:test';
import { keepStorageInUse } from '../worker.mjs';

// Chromium discards idle OPFS record files in off-the-record profiles after ~10 minutes
// (observed: all files gone after 11 idle minutes; kept when listed every minute).
// The owner lists its record directories while a session is open.
test('lists chronolog record directories periodically and stops with the session', async () => {
  const listed = [];
  const directory = name => ({ kind: 'directory', async *keys() { listed.push(name); yield 'value-1'; } });
  const root = { async *entries() { yield ['chronolog-app', directory('chronolog-app')]; yield ['other', directory('other')]; yield ['chronolog-file', { kind: 'file' }]; } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => root } }, configurable: true });
  try {
    const session = new AbortController();
    keepStorageInUse(session.signal, 20);
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.ok(listed.length >= 2, 'touched more than once');
    assert.deepEqual([...new Set(listed)], ['chronolog-app'], 'only record directories are listed');
    session.abort();
    const after = listed.length;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(listed.length, after, 'stops when the session ends');
    const disabled = new AbortController(); keepStorageInUse(disabled.signal, 0);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(listed.length, after, '0 disables the keep-alive');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator;
  }
});
