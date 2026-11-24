import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { exportNativeCheckpoint, restoreNativeCheckpoint, loadCheckpointLibrary } from '../lib/handoff.mjs';

const projectDir = process.env.TENDRILLER_CHECKPOINT_TEST_PROJECT ?? process.cwd();
const { native: { openNativeDevice, NativeBytesStore } } = await loadCheckpointLibrary(projectDir);
const secret = 'a'.repeat(64);
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const devicePath = join(root, 'device.sqlite'), outputPath = join(root, 'move.clcp');
  const device = await openNativeDevice({ path: devicePath, create: true });
  const key = device.identity.publicKey;
  await device.store.put('test-retained-attempt', new Uint8Array([1, 2, 3]));
  await device.close();
  return { root, key, devicePath, outputPath, secret, projectDir };
}
test('canonical device handoff preserves signer and retained history and retires only the original store', async t => {
  const f = await fixture(t);
  const exported = await exportNativeCheckpoint(f);
  assert.equal(exported.retiredSource, true);
  assert.equal(exported.metadata.deviceId, f.key);
  await assert.rejects(openNativeDevice({ path: f.devicePath }), { code: 'DEVICE_RETIRED_BY_CHECKPOINT' });
  const target = join(f.root, 'restored'), devicePath = join(target, 'device.sqlite');
  const restored = await restoreNativeCheckpoint({ inputPath: f.outputPath, devicePath, secret, projectDir });
  assert.equal(restored.materialization, 'rebuild-on-open');
  assert.equal(exported.metadata.hasSqlDatabase, false);
  const device = await openNativeDevice({ path: devicePath });
  try {
    assert.equal(device.identity.publicKey, f.key);
    assert.deepEqual(await device.store.get('test-retained-attempt'), new Uint8Array([1, 2, 3]));
  } finally { await device.close(); }

});
test('a running device or an existing output cannot be retired by export', async t => {
  const f = await fixture(t), active = await openNativeDevice({ path: f.devicePath });
  try { await assert.rejects(exportNativeCheckpoint(f), { code: 'BYTES_STORE_IN_USE' }); }
  finally { await active.close(); }
  assert.equal(existsSync(f.outputPath), false);
  writeFileSync(f.outputPath, 'existing checkpoint');
  await assert.rejects(exportNativeCheckpoint(f), { code: 'CHECKPOINT_OUTPUT_EXISTS' });
  assert.equal(readFileSync(f.outputPath, 'utf8'), 'existing checkpoint');
  const resumed = await openNativeDevice({ path: f.devicePath }); await resumed.close();
});
test('restore failure leaves no partial target and existing state is never replaced', async t => {
  const f = await fixture(t); await exportNativeCheckpoint(f);
  const target = join(f.root, 'fresh'), devicePath = join(target, 'device.sqlite');
  await assert.rejects(restoreNativeCheckpoint({ inputPath: f.outputPath, devicePath, secret: 'wrong passphrase', projectDir }));
  assert.equal(existsSync(target), false);
  await assert.rejects(restoreNativeCheckpoint({ inputPath: f.outputPath, devicePath: join(f.root, 'other.sqlite'), secret, projectDir }), { code: 'CHECKPOINT_TARGET_NOT_EMPTY' });
  assert.equal(existsSync(join(f.root, 'other.sqlite')), false);
});
test('failed durable checkpoint publication leaves the source signer usable', async t => {
  const f = await fixture(t);
  await assert.rejects(exportNativeCheckpoint({ ...f, outputPath: join(f.root, 'x'.repeat(300) + '.clcp') }));
  const device = await openNativeDevice({ path: f.devicePath });
  try { assert.equal(device.identity.publicKey, f.key); }
  finally { await device.close(); }
});
test('an unrelated SQLite database is rejected without changing its bytes', async t => {
  const f = await fixture(t), source = join(f.root, 'unrelated.sqlite');
  const sql = new DatabaseSync(source); sql.exec('CREATE TABLE example(x)'); sql.close();
  const before = readFileSync(source);
  await assert.rejects(exportNativeCheckpoint({ ...f, devicePath: source }));
  assert.deepEqual(readFileSync(source), before);
  assert.equal(existsSync(f.outputPath), false);
});
test('entry limits reject oversized snapshots before enumeration and preserve the source', async t => {
  const f = await fixture(t), sql = new DatabaseSync(f.devicePath);
  sql.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4097) INSERT INTO stored_bytes SELECT 'extra-'||x, x'' FROM n");
  sql.close();
  await assert.rejects(exportNativeCheckpoint(f), { code: 'CHECKPOINT_LIMIT_EXCEEDED' });
  assert.equal(existsSync(f.outputPath), false);
  const resumed = await openNativeDevice({ path: f.devicePath });
  try { assert.equal(resumed.identity.publicKey, f.key); }
  finally { await resumed.close(); }
});


for (const method of ['checkpointWal', 'close']) test('restore awaits asynchronous ' + method + ' failure before publishing its destination', async t => {
  const f = await fixture(t); await exportNativeCheckpoint(f);
  const target = join(f.root, 'restored'), devicePath = join(target, 'device.sqlite');
  const failure = new Error('asynchronous ' + method + ' failure'), original = NativeBytesStore.prototype[method];
  t.mock.method(NativeBytesStore.prototype, method, async function (...args) {
    await new Promise(resolve => setImmediate(resolve));
    await original.apply(this, args);
    throw failure;
  });
  await assert.rejects(restoreNativeCheckpoint({ inputPath: f.outputPath, devicePath, secret, projectDir }), error => error === failure);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('.checkpoint-restore-')), []);
  assert.equal(existsSync(f.outputPath), true);
});
