import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// The actual docs/tutorial inventory page, helpers and DOM in Chromium. The deterministic boundary is the browser owner:
// a fixture implementing the current public session surface (identity, status/onStatus, readView/onChange, command,
// operations.get/retry/subscribe) over a tiny in-page inventory table. No SQL engine, RTC, host, finality provider or
// native participant is claimed; this proves the page itself starts, installs its live view and retries stored work.
// The page's startup runs as real module code, so an unbound identifier in it surfaces here as "Local opening failed".
// Run: node --test scripts/test/browser/inventory-submission.test.mjs
const root = fileURLToPath(new URL('../../../', import.meta.url));
const session = root + 'node_modules/@chronolog/peer-session/index.mjs';

async function bundles() {
  const transport = await build({ entryPoints: [root + 'runtime/src/transport.ts'], bundle: true, write: false, format: 'iife', globalName: 'FixtureTransport',
    plugins: [{ name: 'public-transport', setup(builder) {
      builder.onResolve({ filter: /session\/transport-diagnostics\.mjs$/ }, () => ({ path: root + 'dist/sdk/session/transport-diagnostics.mjs' }));
    } }] });
  const page = await build({ entryPoints: [root + 'docs/tutorial/templates/inventory/page.mjs'], bundle: true, write: false, format: 'esm', platform: 'browser',
    plugins: [{ name: 'current-contract-fixture', setup(builder) {
      builder.onResolve({ filter: /^@tendriller\/core\/browser-owner$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onResolve({ filter: /^@tendriller\/core\/authority$/ }, () => ({ path: root + 'contract/authority.mjs' }));
      // The real peer-session view store and live view; only the backend registration is a no-op.
      builder.onResolve({ filter: /^@chronolog\/peer-session$/ }, args => ({ path: args.path, namespace: 'fixture-session' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-session' }, () => ({ resolveDir: root, contents:
        `export * from ${JSON.stringify(session)}; export const createApplicationBackend = () => ({});` }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export async function openBrowserOwner({ context }) {
          const author = 'b'.repeat(64), applicationId = 'c'.repeat(64);
          // Durable across reloads like the retained owner profile: operations and the derived inventory.
          const store = JSON.parse(localStorage.getItem('fixture-store') || '{"ops":[],"version":0,"initialized":false,"stock":{},"transfers":[]}');
          const persist = () => localStorage.setItem('fixture-store', JSON.stringify(store));
          const status = { canAuthor: true, phase: 'ready', database: 'ready', connectedPeers: 0, pendingOperations: 0, materializationError: null };
          const statusListeners = new Set(), changeListeners = new Set(), factListeners = new Set(), calls = [];
          const mode = { beforeSave: false };
          const emitStatus = () => { for (const fn of [...statusListeners]) fn({ ...status }); };
          const revision = () => ({ digest: 'revision-' + store.version, view: 'local', executionManifestDigest: 'e'.repeat(64), policyDigest: 'f'.repeat(64) });
          const changed = () => { for (const fn of [...changeListeners]) fn({ kind: 'materialized', revision: revision(), revisedProposalIds: [] }); for (const fn of [...factListeners]) fn(); };
          const find = id => store.ops.find(op => op.operationId === id || op.proposalId === id);
          const inspection = op => ({ applicationId, author, authorTimestampMs: '1000', proposalId: op.proposalId, operationId: op.operationId,
            stored: true, pending: null, materialized: op.materialized ? { proposalId: op.proposalId, revision: revision(), failingStatementIndex: null, ...op.materialized } : null,
            retained: [], finalized: false, excluded: false });
          const handle = op => ({ id: op.proposalId, operationId: op.operationId, stored: true, inspect: () => inspection(op) });
          // A tiny deterministic domain: only the commands the page issues in these scenarios.
          const run = op => {
            if (op.name === 'initialize') { store.initialized = true; store.stock = { destination: 0, source: 10 }; op.materialized = { outcome: 'accepted', rejectionCode: null }; }
            else if (op.name === 'transfer') {
              const { from, to, units, expectedSource, expectedDestination, transferId } = op.input;
              const ok = store.initialized && store.stock[from] === expectedSource && store.stock[to] === expectedDestination && store.stock[from] >= units;
              op.materialized = ok ? { outcome: 'accepted', rejectionCode: null } : { outcome: 'rejected', rejectionCode: 'balance_changed' };
              if (ok) { store.stock[from] -= units; store.stock[to] += units; store.transfers.push({ id: transferId, source: from, destination: to, units }); }
            } else op.materialized = { outcome: 'rejected', rejectionCode: 'unsupported_fixture_command' };
          };
          const owner = { applicationId, historyId: 'history', identity: { publicKey: author }, endpoint: { context },
            signals: { async send() {}, subscribe() { return { async *[Symbol.asyncIterator]() {} }; } }, signal: new AbortController().signal,
            get status() { return { ...status }; },
            onStatus(fn) { statusListeners.add(fn); fn({ ...status }); return () => statusListeners.delete(fn); },
            onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },
            async diagnostics() { return []; },
            async readView() {
              return { applicationId, revision: revision(), release() {},
                async query(sql) {
                  if (!store.initialized) throw Error('no such table: inventory');
                  if (sql.includes('sqlite_master')) return { rows: [['inventory', 'table'], ['transfers', 'table']] };
                  if (sql.startsWith('PRAGMA table_info')) return { rows: [[0, 'id'], [1, 'units']] };
                  if (sql.includes('FROM transfers')) return { rows: store.transfers.map(row => [row.id, row.source, row.destination, row.units]) };
                  if (sql.includes('FROM inventory')) return { rows: Object.entries(store.stock).map(([id, units]) => [id, units]) };
                  throw Error('unsupported fixture query');
                },
                readEvents() { return { revision: revision(), events: [], cursor: '', hasMore: false }; } };
            },
            async command(name, input, options) {
              calls.push({ name, input, options });
              if (mode.beforeSave) throw Error('Intent retained but no stored acknowledgment');
              if (find(options.operationId)) throw Error('Duplicate operation ID: the original must be retried, not resubmitted');
              const op = { operationId: options.operationId, proposalId: 'p'.repeat(60) + String(store.ops.length).padStart(4, '0'), name, input };
              store.ops.push(op); run(op); store.version++; persist(); changed();
              return handle(op);
            },
            operations: {
              get: async id => { const op = find(id); return op ? handle(op) : null; },
              async retry(id) { calls.push({ retry: id }); const op = find(id); if (!op) throw Error('No such stored operation'); changed(); return handle(op); },
              subscribe({ operationId, signal }) {
                return { async *[Symbol.asyncIterator]() {
                  let dirty = true, wake; const listener = () => { dirty = true; wake?.(); }; factListeners.add(listener); signal?.addEventListener('abort', listener);
                  try { while (!signal?.aborted) { if (!dirty) await new Promise(resolve => { wake = resolve; }); if (signal?.aborted) break; dirty = false; const op = find(operationId); if (op) yield inspection(op); } }
                  finally { factListeners.delete(listener); signal?.removeEventListener('abort', listener); }
                } };
              },
            },
          };
          window.fixture = { calls, session: owner, store,
            canAuthor(value) { status.canAuthor = value; emitStatus(); }, peers(count) { status.connectedPeers = count; emitStatus(); },
            beforeSave(value) { mode.beforeSave = value; },
            // A stored operation this browser has no local intent for, for example authored by another view or profile.
            seed(operationId, input) { const op = { operationId, proposalId: 'a'.repeat(60) + '0001', name: 'transfer', input }; store.ops.push(op); run(op); store.version++; persist(); changed(); },
          };
          return { session: owner, detach: async () => {}, suspend: async () => {}, resume: async () => {} };
        }
      ` }));
    } }] });
  return { transport: transport.outputFiles[0].text, page: page.outputFiles[0].text, html: await readFile(root + 'docs/tutorial/templates/inventory/index.html') };
}

const built = await bundles();
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname;
  res.setHeader('Content-Type', path === '/page.mjs' ? 'text/javascript' : path === '/configuration.json' ? 'application/json' : 'text/html');
  res.end(path === '/page.mjs' ? built.page : path === '/configuration.json'
    ? JSON.stringify({ applicationId: 'c'.repeat(64), page_url: `http://127.0.0.1:${server.address().port}/` }) : built.html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
test.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const url = `http://127.0.0.1:${server.address().port}/`;

async function open(t, context) {
  context ??= await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  const runtimeFixture = () => {
    window.tendril = { transport: FixtureTransport.createTransportBinding().api, application: { install() {} }, signals: { install() {} }, on: () => () => {},
      host: { peers: { application: async () => ({ authority: null }), challenge: async () => { throw Error('not used'); } } },
      publication: { saveOffline: async () => ({ id: 'fixture-publication' }) }, ready() { window.tendrilReady = true; },
      sensors: { status: () => ({ active: [], pending: [] }), on: () => () => {}, stopAll() {} } };
  };
  await page.addInitScript({ content: built.transport + ';(' + runtimeFixture.toString() + ')();' });
  await page.goto(url);
  return { page, errors, context };
}
// The page is ready only when its whole startup ran: the owner attached, diagnostics mounted, the live view installed and the
// runtime told it is ready. An enabled Save button alone proves none of that (a throwing startup can leave it enabled).
async function ready(page) {
  await page.waitForFunction(() => window.tendrilReady === true && window.fixture);
  await page.waitForFunction(() => document.querySelector('#session-status').textContent.includes('Local signing/storage ready'));
}
const enabled = (page, selector) => page.locator(selector).isEnabled();
const diagnostics = page => page.evaluate(() => JSON.parse(document.getElementById('tendriller-diagnostics').textContent));

test('the whole page startup runs: owner attached, diagnostics mounted, live view installed and no opening failure', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t);
  await ready(page);
  const status = await page.locator('#session-status').textContent();
  assert.doesNotMatch(status, /Local opening failed/);
  assert.match(status, /Local signing\/storage ready · 0 peers/);
  assert.equal(await page.locator('#tendriller-diagnostics-panel').count(), 1, 'the diagnostics panel is mounted by the page, not a bare identifier');
  const state = await diagnostics(page);
  assert.equal(state.localOwnerStatus, 'open');
  assert.deepEqual(state.sessionStatus, { phase: 'ready', canAuthor: true, connectedPeers: 0 });
  assert.equal(await page.locator('#public-key').inputValue(), 'b'.repeat(64));
  // Before the ordinary initialize transaction there is no table: an honest, retained view error, and Save stays available.
  await page.waitForFunction(() => !document.querySelector('#view-error').hidden);
  assert.match(await page.locator('#view-error').textContent(), /no such table: inventory/);
  assert.equal(await enabled(page, '#initialize'), true);
  // The live view is installed, not just Save enabled: the stored DDL/DML transaction renders its rows.
  await page.locator('#initialize').click();
  await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('2 bins · 10 total units'));
  assert.match(await page.locator('#result').textContent(), /Stored locally: true/);
  assert.equal(await page.locator('#stock tr').count(), 2);
  assert.equal(await page.locator('#view-error').isHidden(), true);
  assert.deepEqual(errors, []);
});

test('a status callback after canAuthor toggles cannot abort startup, and the live view keeps rendering new work', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t);
  await ready(page);
  await page.locator('#initialize').click();
  await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('2 bins'));
  // Keys leave and return: every status callback updates the page, the diagnostics and the Save gate without throwing.
  await page.evaluate(() => fixture.canAuthor(false));
  await page.waitForFunction(() => document.querySelector('#session-status').textContent.includes('Explicit key provisioning required'));
  assert.equal(await enabled(page, '#initialize'), false);
  assert.equal((await diagnostics(page)).sessionStatus.canAuthor, false);
  await page.evaluate(() => { fixture.canAuthor(true); fixture.peers(2); });
  await page.waitForFunction(() => document.querySelector('#session-status').textContent.includes('2 peers'));
  assert.equal(await enabled(page, '#initialize'), true);
  await page.locator('#from').fill('source'); await page.locator('#to').fill('destination'); await page.locator('#units').fill('2');
  await page.locator('#review-balances').click();
  await page.getByRole('button', { name: 'Store transfer locally' }).click();
  await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('2 bins · 10 total units') && document.querySelector('#stock tr:nth-child(2) td:nth-child(2)')?.textContent === '8');
  assert.match(await page.locator('#result').textContent(), /Materialized locally: accepted/);
  assert.equal(await page.locator('#receipts li').count(), 1);
  assert.deepEqual(errors, []);
});

test('retrying an inspected stored operation with no local intent re-offers the original and never throws or resubmits', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t);
  await ready(page);
  await page.locator('#initialize').click();
  await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('2 bins'));
  // Another view or profile stored this operation; this page has no draft or intent for it.
  const operationId = 'stored-elsewhere';
  await page.evaluate(id => fixture.seed(id, { transferId: 'receipt-elsewhere', from: 'source', to: 'destination', units: 1, expectedSource: 10, expectedDestination: 0 }), operationId);
  assert.equal(await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.endsWith(':draft:intents') && key.includes('stored-elsewhere')) return true; return false; }), false);
  await page.locator('#op-id').fill(operationId);
  await page.waitForFunction(() => !document.querySelector('#retry').disabled);
  const before = await page.evaluate(() => fixture.calls.length);
  await page.locator('#retry').click();
  await page.waitForFunction(id => document.querySelector('#result').textContent.includes('Operation ' + id), operationId);
  const result = await page.locator('#result').textContent();
  assert.match(result, /Stored locally: true/);
  assert.match(result, /Proposal a{60}0001/);
  assert.doesNotMatch(result, /undefined|Cannot read|is not defined/);
  const calls = await page.evaluate(() => fixture.calls.slice(0));
  assert.deepEqual(calls.slice(before), [{ retry: operationId }], 'only the stored journal is asked to retry; no new command is submitted');
  assert.equal((await diagnostics(page)).lastStoredOperationId, operationId, 'diagnostics report the retried operation, not an undefined intent');
  assert.equal(await page.locator('#receipts li').count(), 1, 'the original receipt exists once');
  assert.deepEqual(errors, []);
});

test('an intent retained before any stored acknowledgment survives reload and retries with its exact ID and input once', { timeout: 30000 }, async t => {
  const { page, errors, context } = await open(t);
  await ready(page);
  await page.locator('#initialize').click();
  await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('2 bins'));
  await page.evaluate(() => fixture.beforeSave(true));
  await page.locator('#from').fill('source'); await page.locator('#to').fill('destination'); await page.locator('#units').fill('3');
  await page.locator('#review-balances').click();
  await page.getByRole('button', { name: 'Store transfer locally' }).click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('Intent retained but no stored acknowledgment'));
  const first = (await page.evaluate(() => fixture.calls)).at(-1);
  const operationId = await page.locator('#op-id').inputValue();
  assert.equal(first.options.operationId, operationId);
  assert.match(await page.locator('#result').textContent(), new RegExp(operationId));
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('#op-id').inputValue(), operationId, 'the same original operation ID is selected after reload');
  await page.waitForFunction(() => !document.querySelector('#retry').disabled);
  assert.equal(await enabled(page, '#initialize'), true, 'independent Save is not blocked by the uncertain operation');
  await page.locator('#retry').click();
  await page.waitForFunction(id => document.querySelector('#result').textContent.includes('Operation ' + id) && document.querySelector('#result').textContent.includes('Stored locally: true'), operationId);
  const retried = (await page.evaluate(() => fixture.calls)).filter(call => call.name === 'transfer');
  assert.equal(retried.length, 1, 'one submission on this reload: the exact retained intent');
  assert.equal(retried[0].options.operationId, operationId);
  assert.deepEqual(retried[0].input, first.input, 'the exact original input, with the same transfer receipt ID');
  assert.match(await page.locator('#result').textContent(), /Materialized locally: accepted/);
  assert.equal(await page.locator('#receipts li').count(), 1);
  assert.deepEqual(errors, []);
});
