import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { transferIntent, retryIntent, checkIntentSession } from '../../docs/tutorial/templates/inventory/ui-state.mjs';
import { buildPage } from '../../docs/tutorial/templates/inventory/build.mjs';
import { registerLifecycleFlush } from '../../docs/tutorial/shared/helpers/diagnostics-panel.mjs';

const snapshot = () => ({ revision: { digest: 'reviewed', view: 'local', executionManifestDigest: 'engine', policyDigest: 'none' }, value: { stock: [{ id: 'source', units: 10 }, { id: 'destination', units: 0 }] } });
const reference = { applicationId: 'app', author: 'device', operationId: 'op', proposalId: 'proposal' };
function retained() { return { ...transferIntent(snapshot(), { from: 'source', to: 'destination', units: 2 }, 'op'), reference }; }
function session(stored = false) {
  const calls = [], inspection = { stored, operationId: 'op', proposalId: 'proposal', materialized: null, retained: [], finalized: false, excluded: false }, operation = { inspect: async () => inspection };
  return { applicationId: 'app', identity: { publicKey: 'device' }, calls, operations: { get: async id => { calls.push(['get', id]); return stored ? operation : null; }, retry: async id => { calls.push(['retry', id]); return operation; } }, command: async (...args) => { calls.push(['command', ...args]); return operation; } };
}
test('transfer clones reviewed guard values as local context, not an ordering barrier', () => {
  const before = snapshot(), intent = transferIntent(before, { from: 'source', to: 'destination', units: 2 }, 'op');
  before.revision.digest = 'changed'; before.value.stock[0].units = 3;
  assert.equal(intent.reviewedRevision.digest, 'reviewed'); assert.equal(intent.input.expectedSource, 10); assert.equal(intent.operationId, 'op'); assert.equal('basedOn' in intent, false);
  const offline = transferIntent(null, { from: 'source', to: 'destination', units: 2, expectedSource: 10, expectedDestination: 0 }, 'offline'); assert.equal(offline.reviewedRevision, null);
});
test('uncertain pre-storage retry retains original inputs/ID, while stored retry uses only signed journal', async () => {
  const pending = retained(), fresh = session(); await retryIntent(fresh, pending);
  assert.deepEqual(fresh.calls, [['get', 'op'], ['command', 'transfer', pending.input, { operationId: 'op' }]]);
  const stored = session(true); await retryIntent(stored, JSON.parse(JSON.stringify(pending))); assert.deepEqual(stored.calls, [['get', 'op'], ['retry', 'op']]);
  const wrong = session(); wrong.identity.publicKey = 'other'; assert.throws(() => checkIntentSession(wrong, pending), /another application or signer/); assert.deepEqual(wrong.calls, []);
});

test('build requires setup and exact engine graph, removes stale or partial output', async t => {
  const directory = await mkdtemp(tmpdir() + '/sql-ui-build-'), root = pathToFileURL(directory + '/');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = new URL('dist/', root), engine = new URL('engine/', root);
  await mkdir(engine); await writeFile(new URL('index.html', root), '<html>SQL</html>');
  const wasm = Buffer.from('fixture-engine'), manifest = { wasmBytes: wasm.length, wasmSha256: createHash('sha256').update(wasm).digest('hex'), loaderSha256: createHash('sha256').update('module').digest('hex') };
  for (const [name, bytes] of Object.entries({ 'manifest.json': JSON.stringify(manifest), 'sqlite3.wasm': wasm, 'sqlite3.mjs': 'module', 'sqlite3-opfs-async-proxy.js': 'proxy' })) await writeFile(new URL(name, engine), bytes);
  const records = { 'handle.json': { application: { id: 'app' }, page_url: 'https://page.example/', privateCredential: 'never publish' },
    'host-configuration.json': { executionManifestDigest: 'engine-digest' },
    'prepared.json': { applicationId: 'app', publisherKey: 'independent-publisher', executionManifestDigest: 'engine-digest' } };
  const build = options => buildPage({ readPrivate: options.readPrivate, signer: { publicKey: 'independent-publisher' },
    page: { applicationId: 'app', pageUrl: 'https://page.example/', slug: 'stock' } }, options);
  const opts = { root, readPrivate: async name => records[name], verifyWasmBuild: (bytes, meta) => { assert.deepEqual(bytes, wasm); assert.deepEqual(meta, manifest); }, bundle: async () => {} };
  const retained = structuredClone(records);
  await build(opts);
  assert.deepEqual(records, retained, 'a build never rewrites retained host configuration or preparation');
  assert.equal((await readFile(new URL('engine/sqlite3.wasm', output))).toString(), wasm.toString());
  const config = JSON.parse(await readFile(new URL('configuration.json', output)));
  assert.deepEqual(Object.keys(config).sort(), ['applicationId', 'executionManifestDigest', 'page_url']);
  assert.equal(config.executionManifestDigest, 'engine-digest');
  // Building needs host configuration and preparation only: no initialization marker, schema or native device.
  assert.equal(Object.hasOwn(records, 'initialized.json'), false);
  for (const failure of [
    { readPrivate: async () => { throw Error('missing setup'); } },
    { readPrivate: async name => name === 'prepared.json' ? { ...records[name], applicationId: 'other' } : records[name] },
    { readPrivate: async name => name === 'prepared.json' ? { ...records[name], publisherKey: 'another-signer' } : records[name] },
    { verifyWasmBuild: () => { throw Error('unsupported profile'); } },
    { bundle: async () => { throw Error('bundle failed'); } },
  ]) {
    await mkdir(output, { recursive: true }); await writeFile(new URL('stale', output), 'stale');
    await assert.rejects(build({ ...opts, ...failure }), /no publishable dist/);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }
  await writeFile(new URL('sqlite3.mjs', engine), 'mismatched loader');
  await assert.rejects(build(opts), /loader does not match/);
  await assert.rejects(access(output), { code: 'ENOENT' });
  await writeFile(new URL('sqlite3.mjs', engine), 'module');
  await writeFile(new URL('sqlite3.wasm', engine), 'wrong');
  await assert.rejects(build(opts), /does not match/);
  await assert.rejects(access(output), { code: 'ENOENT' });
  await rm(new URL('manifest.json', engine));
  await assert.rejects(build(opts), /no publishable dist/);
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

test('local signing/storage readiness permits Save without peers, SQL readiness or a successful current view', async () => {
  const { createSubmissionState } = await import('../../docs/tutorial/shared/helpers/submission-state.mjs');
  const state = createSubmissionState(); state.update({ attached: true });
  state.application({ canAuthor: true, phase: 'ready', database: 'opening', connectedPeers: 0, materializationError: 'query table missing' });
  assert.equal(state.snapshot.canSubmit, true);
  const finish = state.begin(); assert.equal(state.snapshot.canSubmit, false); finish(); assert.equal(state.snapshot.canSubmit, true);
  state.application({ canAuthor: false, phase: 'ready', database: 'ready', connectedPeers: 8 }); assert.equal(state.snapshot.canSubmit, false);
});
test('SQL schema and column grants are ordinary programs, never immutable definition schema', async () => {
  const { definition, deriveInventory } = await import('../../docs/tutorial/templates/inventory/domain.mjs');
  assert.equal(Object.hasOwn(definition, 'schema'), false);
  const initial = definition.commands.initialize.prepare(null); assert.ok(initial.steps.some(step => typeof step.sql === 'string' && step.sql.startsWith('CREATE TABLE')));
  const grant = definition.commands.grantBinWrites.prepare({ publicKey: '11'.repeat(32) });
  assert.deepEqual(grant.steps[0].columns, ['units']); assert.equal(grant.steps[0].op, 'grant');
  let label = false;
  const view = { async query(sql) { if (sql.includes('sqlite_master')) return { rows: [['inventory', 'table'], ['transfers', 'table']] }; if (sql.startsWith('PRAGMA')) return { rows: label ? [[0,'id'],[1,'units'],[2,'label']] : [[0,'id'],[1,'units']] }; if (sql.includes('FROM transfers')) return { rows: [] }; return { rows: label ? [['source',10,'new field']] : [['source',10]] }; } };
  assert.equal((await deriveInventory(view)).hasLabel, false); label = true; const after = await deriveInventory(view); assert.equal(after.hasLabel, true); assert.equal(after.stock[0].label, 'new field');
});
