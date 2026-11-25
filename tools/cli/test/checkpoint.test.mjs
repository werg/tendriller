import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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

for (const method of ['checkpointWal', 'close']) test('export retains the completed checkpoint receipt after asynchronous ' + method + ' failure', async t => {
  const f = await fixture(t);
  const failure = new Error('asynchronous export ' + method + ' failure'), original = NativeBytesStore.prototype[method];
  t.mock.method(NativeBytesStore.prototype, method, async function (...args) {
    await new Promise(resolve => setImmediate(resolve));
    await original.apply(this, args);
    throw failure;
  });
  let receipt;
  await assert.rejects(exportNativeCheckpoint(f), error => {
    assert.equal(error, failure);
    receipt = error.checkpoint;
    assert.equal(receipt.output, f.outputPath);
    assert.equal(receipt.size, readFileSync(f.outputPath).byteLength);
    assert.equal(receipt.retiredSource, true);
    assert.equal(receipt.metadata.deviceId, f.key);
    assert.match(receipt.nextAction, /Restore the retained checkpoint/u);
    return true;
  });
  t.mock.restoreAll();
  await assert.rejects(openNativeDevice({ path: f.devicePath }), { code: 'DEVICE_RETIRED_BY_CHECKPOINT' });
  const devicePath = join(f.root, 'recovered', 'device.sqlite');
  await restoreNativeCheckpoint({ inputPath: receipt.output, devicePath, secret, projectDir });
  const recovered = await openNativeDevice({ path: devicePath });
  try {
    assert.equal(recovered.identity.publicKey, f.key);
    assert.deepEqual(await recovered.store.get('test-retained-attempt'), new Uint8Array([1, 2, 3]));
  } finally { await recovered.close(); }
});

test('restore preserves the primary WAL failure when close fails differently and still removes staging', async t => {
  const f = await fixture(t); await exportNativeCheckpoint(f);
  const target = join(f.root, 'restored'), devicePath = join(target, 'device.sqlite');
  const primary = Object.assign(new Error('restore WAL failure'), { code: 'WAL_FAILED' });
  const cleanup = Object.assign(new Error('restore close failure'), { code: 'CLOSE_FAILED' });
  for (const [method, failure] of [['checkpointWal', primary], ['close', cleanup]]) {
    const original = NativeBytesStore.prototype[method];
    t.mock.method(NativeBytesStore.prototype, method, async function (...args) {
      await new Promise(resolve => setImmediate(resolve));
      await original.apply(this, args);
      throw failure;
    });
  }
  await assert.rejects(restoreNativeCheckpoint({ inputPath: f.outputPath, devicePath, secret, projectDir }), error => {
    assert.equal(error, primary);
    assert.equal(error.cleanupError, cleanup);
    return true;
  });
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('.checkpoint-restore-')), []);
  assert.equal(existsSync(f.outputPath), true);
});

test('CLI reports the retained checkpoint receipt and secondary cleanup failure after an export WAL failure', async t => {
  const f = await fixture(t), preload = join(f.root, 'fail-wal.mjs');
  writeFileSync(preload, `
import { loadCheckpointLibrary } from ${JSON.stringify(new URL('../lib/handoff.mjs', import.meta.url).href)};
const { native: { NativeBytesStore } } = await loadCheckpointLibrary(${JSON.stringify(projectDir)});
const original = NativeBytesStore.prototype.checkpointWal;
NativeBytesStore.prototype.checkpointWal = async function (...args) {
  await original.apply(this, args);
  throw Object.assign(new Error('Injected WAL failure'), { code: 'WAL_FAILED' });
};
const originalClose = NativeBytesStore.prototype.close;
NativeBytesStore.prototype.close = async function (...args) {
  await originalClose.apply(this, args);
  throw Object.assign(new Error('Injected close failure'), { code: 'CLOSE_FAILED' });
};
`);
  const cli = process.env.TENDRILLER_TOOLS_TEST_CLI ?? fileURLToPath(new URL('../bin/tendril.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import', preload, cli, 'checkpoint', 'export', f.outputPath,
    '--device', f.devicePath, '--project', projectDir,
  ], { env: { ...process.env, TENDRILLER_CHECKPOINT_SECRET: secret, NODE_NO_WARNINGS: '1' }, timeout: 10000 }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    const report = JSON.parse(error.stderr);
    assert.equal(report.error.code, 'WAL_FAILED');
    assert.equal(report.cleanup.code, 'CLOSE_FAILED');
    assert.equal(report.checkpoint.output, f.outputPath);
    assert.equal(report.checkpoint.retiredSource, true);
    assert.equal(report.checkpoint.metadata.deviceId, f.key);
    assert.match(report.checkpoint.nextAction, /Restore the retained checkpoint/u);
    assert.equal(report.checkpoint.size, readFileSync(f.outputPath).byteLength);
    assert.equal(error.stderr.includes(secret), false);
    return true;
  });
  await assert.rejects(openNativeDevice({ path: f.devicePath }), { code: 'DEVICE_RETIRED_BY_CHECKPOINT' });
});
