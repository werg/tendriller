import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { transferIntent, retryIntent, checkIntentSession } from '../../docs/tutorial/sql/ui-state.mjs';
import { buildPage } from '../../docs/tutorial/sql/build.mjs';
import { registerLifecycleFlush } from '../../docs/tutorial/helpers/diagnostics-panel.mjs';

const snapshot = () => ({ revision: { generation: 'g1', sequence: 7 },
  value: { stock: [{ id: 'source', units: 10 }, { id: 'destination', units: 0 }] } });
const reference = { applicationId: 'app', historyId: 'history', author: 'device', operationId: 'op' };
function retained() { return { ...transferIntent(snapshot(), { from: 'source', to: 'destination', units: 2 }, 'op'), reference }; }
function session(state = null) {
  const calls = [];
  return { applicationId: 'app', historyId: 'history', deviceId: 'device', calls,
    operations: { get: async id => { calls.push(['get', id]); return state; },
      wait: async id => { calls.push(['wait', id]); return { operationId: id, status: 'applied', outcome: 'accepted' }; } },
    retry: async id => { calls.push(['retry', id]); },
    command: async (...args) => { calls.push(['command', ...args]); },
  };
}
test('transfer captures the actual domain fields and clones the reviewed revision', () => {
  const before = snapshot(), intent = transferIntent(before, { from: 'source', to: 'destination', units: 2 }, 'op');
  before.revision.sequence++; before.value.stock[0].units = 3;
  assert.deepEqual(intent, { id: 'op', command: 'transfer', basedOn: { generation: 'g1', sequence: 7 },
    input: { transferId: 'op', from: 'source', to: 'destination', units: 2, expectedSource: 10, expectedDestination: 0 } });
  for (const units of [0, -1, 1.2, NaN, 11, 1_000_001]) assert.throws(() => transferIntent(snapshot(), { from: 'source', to: 'destination', units }, 'op'));
  assert.throws(() => transferIntent(snapshot(), { from: 'pantry', to: 'counter', units: 1 }, 'op'));
  assert.throws(() => transferIntent({ ...snapshot(), value: { stock: [] } }, { from: 'source', to: 'destination', units: 1 }, 'op'), /Initialize/);
});
test('uncertain reply then reload resends only the retained identity, input and revision', async () => {
  const pending = retained(), first = session();
  first.command = async () => { throw Error('reply lost'); };
  await assert.rejects(retryIntent(first, pending), /reply lost/);
  // JSON roundtrip models the browser view-store context surviving reload.
  const reloaded = JSON.parse(JSON.stringify(pending)), next = session();
  await retryIntent(next, reloaded);
  assert.deepEqual(next.calls[1], ['command', 'transfer', pending.input, { operationId: 'op', basedOn: pending.basedOn }]);
  assert.deepEqual(pending, retained());
});
test('saved retry uses signed journal; applied rejection resolves; exclusions never submit', async () => {
  const saved = session({ status: 'saved' }); await retryIntent(saved, retained());
  assert.deepEqual(saved.calls.map(call => call[0]), ['get', 'retry', 'wait']);
  const result = { status: 'applied', operationId: 'op', outcome: 'rejected', rejectionCode: 'source_changed' };
  const rejected = session(result); assert.equal(await retryIntent(rejected, retained()), result);
  assert.deepEqual(rejected.calls, [['get', 'op']]);
  for (const status of ['abandoned', 'needsReapply']) {
    const excluded = session({ status }); await assert.rejects(retryIntent(excluded, retained()), /Recovery excluded/);
    assert.deepEqual(excluded.calls, [['get', 'op']]);
  }
  for (const field of ['applicationId', 'historyId', 'deviceId']) {
    const wrong = session(); wrong[field] = 'different';
    assert.throws(() => checkIntentSession(retained(), wrong), /another device or history/);
    await assert.rejects(retryIntent(wrong, retained())); assert.deepEqual(wrong.calls, []);
  }
});

test('build requires setup and exact engine graph, removes stale or partial output', async t => {
  const directory = await mkdtemp(tmpdir() + '/sql-ui-build-'), root = pathToFileURL(directory + '/');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = new URL('page/', root), engine = new URL('engine/', root);
  await mkdir(engine); await writeFile(new URL('index.html', root), '<html>SQL</html>');
  const wasm = Buffer.from('fixture-engine'), manifest = { wasmBytes: wasm.length, wasmSha256: createHash('sha256').update(wasm).digest('hex') };
  for (const [name, bytes] of Object.entries({ 'manifest.json': JSON.stringify(manifest), 'sqlite3.wasm': wasm, 'sqlite3.mjs': 'module', 'sqlite3-opfs-async-proxy.js': 'proxy' })) await writeFile(new URL(name, engine), bytes);
  const records = { 'handle.json': { application: { id: 'app' }, page_url: 'https://page.example/', privateCredential: 'never publish' },
    'descriptor.json': { payload: { applicationId: 'app' } }, 'initialized.json': { applicationId: 'app', deviceId: 'native' } };
  const opts = { root, readPrivate: async name => records[name], verifyWasmBuild: (bytes, meta) => { assert.deepEqual(bytes, wasm); assert.deepEqual(meta, manifest); }, bundle: async () => {} };
  await buildPage(opts);
  assert.equal((await readFile(new URL('engine/sqlite3.wasm', output))).toString(), wasm.toString());
  const config = JSON.parse(await readFile(new URL('configuration.json', output)));
  assert.deepEqual(Object.keys(config).sort(), ['applicationId', 'descriptor', 'page_url']);
  for (const failure of [
    { readPrivate: async () => { throw Error('missing setup'); } },
    { readPrivate: async name => name === 'initialized.json' ? { applicationId: 'other' } : records[name] },
    { verifyWasmBuild: () => { throw Error('unsupported profile'); } },
    { bundle: async () => { throw Error('bundle failed'); } },
  ]) {
    await mkdir(output, { recursive: true }); await writeFile(new URL('stale', output), 'stale');
    await assert.rejects(buildPage({ ...opts, ...failure }), /no publishable page/);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }
  await writeFile(new URL('sqlite3.wasm', engine), 'wrong');
  await assert.rejects(buildPage(opts), /does not match/);
  await assert.rejects(access(output), { code: 'ENOENT' });
  await rm(new URL('manifest.json', engine));
  await assert.rejects(buildPage(opts), /no publishable page/);
});

test('lifecycle notifications contain async flush and error-reporter rejections, and unregister', async t => {
  const previous = { document: globalThis.document, window: globalThis.window };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.document = new EventTarget(); document.visibilityState = 'hidden'; globalThis.window = new EventTarget();
  let failures = 0;
  const unregister = registerLifecycleFlush(async () => { throw Error('flush failed'); }, { onError: async () => { failures++; throw Error('report failed'); } });
  document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide')); document.dispatchEvent(new Event('freeze'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(failures, 3);
  unregister(); window.dispatchEvent(new Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(failures, 3);
});
