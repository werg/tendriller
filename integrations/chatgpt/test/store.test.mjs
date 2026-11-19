import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDeliveryStore, createMemoryStore } from '../store.mjs';

test('cursor and jobs survive reopen together, secrets are encrypted, failed transactions roll back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tendriller-delivery-'));
  const path = join(dir, 'state.sqlite'), key = randomBytes(32);
  let store = openDeliveryStore({ path, key });
  try {
    await store.transaction(state => {
      state.cursor = 'selected-cursor'; state.jobs = [{ secret: 'whsec_private-secret-value', state: 'queued' }];
    });
    await assert.rejects(store.transaction(state => { state.cursor = 'wrong'; throw Error('crash'); }), /crash/);
    await assert.rejects(store.transaction(state => { state.cursor = 'uncloneable'; return () => {}; }), /could not be cloned/);
    await store.close();
    assert.equal((await readFile(path)).includes(Buffer.from('whsec_private-secret-value')), false);
    store = openDeliveryStore({ path, key });
    assert.deepEqual(await store.read(), { cursor: 'selected-cursor', jobs: [{ secret: 'whsec_private-secret-value', state: 'queued' }] });
    await assert.rejects(store.transaction(async state => { state.cursor = 'async'; }), /synchronous/);
    assert.equal((await store.read()).cursor, 'selected-cursor');
    await store.close();
    store = openDeliveryStore({ path, key: randomBytes(32) });
    await assert.rejects(store.read(), /cannot be authenticated/);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('uncloneable transaction return values cannot commit memory state', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.transaction(state => { state.changed = true; return () => {}; }), /could not be cloned/);
  assert.deepEqual(await store.read(), {});
});

test('multiple store connections preserve updates and no encryption key is generated silently', async () => {
  assert.throws(() => openDeliveryStore({ path: 'unused' }), /encryption key/);
  const dir = await mkdtemp(join(tmpdir(), 'tendriller-delivery-'));
  const options = { path: join(dir, 'state.sqlite'), key: randomBytes(32) };
  const a = openDeliveryStore(options), b = openDeliveryStore(options);
  try {
    await a.transaction(state => { state.a = 1; });
    await b.transaction(state => { state.b = 2; });
    assert.deepEqual(await a.read(), { a: 1, b: 2 });
  } finally { await a.close(); await b.close(); await rm(dir, { recursive: true, force: true }); }
});

test('private assets stay outside the metadata record and share atomic admission and a byte budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tendriller-blobs-'));
  const path = join(dir, 'state.sqlite'), key = randomBytes(32), bytes = Buffer.from('private-reviewed-asset');
  for (const persistent of [false, true]) {
    let store = persistent ? openDeliveryStore({ path, key, maxBlobBytes: bytes.length }) : createMemoryStore({}, { maxBlobBytes: bytes.length });
    try {
      await assert.rejects(store.transaction((state, blobs) => { blobs.put('asset:1', bytes); state.review = 'wrong'; throw Error('rollback'); }), /rollback/);
      assert.equal(await store.readBlob('asset:1'), null); assert.deepEqual(await store.read(), {});
      await store.transaction((state, blobs) => { blobs.put('asset:1', bytes); state.review = { asset: 'asset:1' }; });
      await store.transaction((_state, blobs) => blobs.put('asset:1', bytes));
      await assert.rejects(store.transaction((state, blobs) => { blobs.put('asset:2', bytes); state.review = 'wrong'; }), { code: 'STORE_BLOB_CAPACITY' });
      await assert.rejects(store.transaction((_state, blobs) => blobs.put('asset:1', Buffer.from('changed'))), { code: 'STORE_BLOB_CONFLICT' });
      assert.deepEqual(await store.read(), { review: { asset: 'asset:1' } });
      assert.deepEqual(await store.readBlob('asset:1'), bytes);
      if (persistent) {
        await store.close(); assert.equal((await readFile(path)).includes(bytes), false);
        store = openDeliveryStore({ path, key, maxBlobBytes: bytes.length });
        assert.deepEqual(await store.readBlob('asset:1'), bytes);
        await store.transaction(state => { state.cursor = 'advanced'; });
        assert.equal(JSON.stringify(await store.read()).includes(bytes.toString()), false);
      }
    } finally { await store.close(); }
  }
  await rm(dir, { recursive: true, force: true });
});
