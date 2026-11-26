import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { transferIntent, retryIntent, checkIntentSession } from '../../docs/tutorial/templates/inventory/ui-state.mjs';
import { buildPage } from '../../docs/tutorial/templates/inventory/build.mjs';
import { registerLifecycleFlush } from '../../docs/tutorial/shared/helpers/diagnostics-panel.mjs';

const snapshot = () => ({ revision: { digest: 'reviewed', view: 'local', stateRoot: 'engine', historyDigest: 'none' }, value: { stock: [{ id: 'source', units: 10 }, { id: 'destination', units: 0 }] } });
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

test('Chronolog v2 SQL page build requires preparation, emits zero legacy engine files, and cleans up on failure', async t => {
  const directory = await mkdtemp(tmpdir() + '/sql-ui-build-'), root = pathToFileURL(directory + '/');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = new URL('dist/', root);
  await writeFile(new URL('index.html', root), '<html>SQL</html>');
  const records = {
    'handle.json': { application: { id: 'app' }, page_url: 'https://page.example/', privateCredential: 'never publish' },
    'prepared.json': { applicationId: 'app', publisherKey: 'independent-publisher' },
  };
  const build = options => buildPage({
    readPrivate: options.readPrivate,
    signer: { publicKey: 'independent-publisher' },
    page: { applicationId: 'app', pageUrl: 'https://page.example/', slug: 'stock' },
  }, options);
  const opts = { root, readPrivate: async name => records[name], bundle: async () => {} };
  const retainedRecords = structuredClone(records);
  await build(opts);
  assert.deepEqual(records, retainedRecords, 'a build never rewrites retained preparation');
  const config = JSON.parse(await readFile(new URL('configuration.json', output), 'utf8'));
  assert.deepEqual(Object.keys(config).sort(), ['applicationId', 'page_url']);
  // Zero legacy DoltLite / sqlite3.wasm files are copied into dist/
  await assert.rejects(access(new URL('engine/sqlite3.wasm', output)), { code: 'ENOENT' });
  assert.equal(Object.hasOwn(records, 'initialized.json'), false);

  for (const failure of [
    { readPrivate: async () => { throw Error('missing setup'); } },
    { readPrivate: async name => name === 'prepared.json' ? { ...records[name], applicationId: 'other' } : records[name] },
    { readPrivate: async name => name === 'prepared.json' ? { ...records[name], publisherKey: 'another-signer' } : records[name] },
    { bundle: async () => { throw Error('bundle failed'); } },
  ]) {
    await mkdir(output, { recursive: true }); await writeFile(new URL('stale', output), 'stale');
    await assert.rejects(build({ ...opts, ...failure }), /no publishable dist/);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }
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

test('SQL schema, preconditions, and RLS policies use first-class chronolog/sql with zero custom reducer boilerplate', async () => {
  const { definition, deriveInventory, topics, imports } = await import('../../docs/tutorial/templates/inventory/domain.mjs');
  assert.equal(Object.hasOwn(definition, 'schema'), false);
  assert.deepEqual(imports, {});
  assert.deepEqual(topics, { inventory: { module: 'chronolog/sql' } });
  const initial = definition.commands.initialize.prepare(null);
  assert.equal(initial[0].topic, 'inventory');
  assert.equal(initial[0].input.action, 'migrate');
  assert.ok(initial[0].input.policies.inventory.insert.includes('actor()'));
  const grant = definition.commands.grantBinWrites.prepare({ publicKey: '11'.repeat(32) });
  assert.equal(grant[0].input.mode, 'admin');
  assert.ok(grant[0].input.statements[0].sql.includes('bin_grants'));
  let label = false;
  const view = {
    async query(topic, input) {
      assert.equal(topic, 'inventory');
      if (input?.kind === 'tables') return { tables: [{ name: 'inventory', type: 'table' }, { name: 'transfers', type: 'table' }] };
      if (input?.sql === 'SELECT * FROM inventory LIMIT 0') {
        return { columns: label ? ['id', 'units', 'owner', 'label'] : ['id', 'units', 'owner'], rows: [] };
      }
      if (input?.sql?.includes('FROM inventory')) {
        return { rows: label ? [['source', 10, 'new field']] : [['source', 10]] };
      }
      return { rows: [] };
    },
  };
  assert.equal((await deriveInventory(view)).hasLabel, false);
  label = true;
  const after = await deriveInventory(view);
  assert.equal(after.hasLabel, true);
  assert.equal(after.stock[0].label, 'new field');
});
