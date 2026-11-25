import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// The actual docs/tutorial page, helpers and DOM in Chromium. Deterministic session boundary: the browser owner is a
// fixture implementing the current public session surface (identity, status/onStatus, readView/onChange,
// command, operations.get/retry/subscribe). No RTC, host, finality provider or native participant is claimed.
// Run: node --test scripts/test/browser/starter-submission.test.mjs
const root = fileURLToPath(new URL('../../../', import.meta.url));
const session = root + 'node_modules/@chronolog/peer-session/index.mjs';

async function bundles() {
  // The real runtime registration binding over the built public transport observer, so additions to the page
  // contract cannot disappear into a stub.
  const transport = await build({ entryPoints: [root + 'runtime/src/transport.ts'], bundle: true, write: false, format: 'iife', globalName: 'FixtureTransport',
    plugins: [{ name: 'public-transport', setup(builder) {
      builder.onResolve({ filter: /session\/transport-diagnostics\.mjs$/ }, () => ({ path: root + 'dist/sdk/session/transport-diagnostics.mjs' }));
    } }] });
  const page = await build({ entryPoints: [root + 'docs/tutorial/page.mjs'], bundle: true, write: false, format: 'esm', platform: 'browser',
    plugins: [{ name: 'current-contract-fixture', setup(builder) {
      builder.onResolve({ filter: /^@tendriller\/core\/browser-owner$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onResolve({ filter: /^@tendriller\/core\/authority$/ }, () => ({ path: root + 'contract/authority.mjs' }));
      // The real peer-session view store, live view and domain definitions; only the backend registration is a no-op.
      builder.onResolve({ filter: /^@chronolog\/peer-session$/ }, args => ({ path: args.path, namespace: 'fixture-session' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-session' }, () => ({ resolveDir: root, contents:
        `export * from ${JSON.stringify(session)}; export const createApplicationBackend = () => ({});` }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export async function openBrowserOwner({ context }) {
          window.ownerAttachments = (window.ownerAttachments ?? 0) + 1;
          if (sessionStorage.getItem('fixture-fail-open')) throw Object.assign(Error('Owner unreachable'), { code: 'OWNER_UNREACHABLE' });
          const author = 'b'.repeat(64), other = 'd'.repeat(64), applicationId = 'c'.repeat(64);
          // Durable local store across reloads: operations and materialized events survive like the retained owner profile.
          const store = JSON.parse(localStorage.getItem('fixture-store') || '{"ops":[],"events":[],"version":0}');
          const persist = () => localStorage.setItem('fixture-store', JSON.stringify(store));
          const status = { canAuthor: true, phase: 'ready', database: 'ready', connectedPeers: 0, pendingOperations: 0, materializationError: null };
          const statusListeners = new Set(), changeListeners = new Set(), factListeners = new Set(), calls = [];
          const mode = { hold: false, failRead: false, loseReply: false, beforeSave: false, rejectOnRetry: false };
          let readGate, releaseRead; const gate = () => { readGate = new Promise(resolve => { releaseRead = resolve; }); }; gate();
          const emitStatus = () => { for (const fn of [...statusListeners]) fn({ ...status }); };
          const changed = () => { for (const fn of [...changeListeners]) fn({ kind: 'materialized', revision: revision(), revisedProposalIds: [] }); for (const fn of [...factListeners]) fn(); };
          const revision = () => ({ digest: 'revision-' + store.version, view: 'local', executionManifestDigest: 'e'.repeat(64), policyDigest: 'f'.repeat(64) });
          const find = id => store.ops.find(op => op.operationId === id || op.proposalId === id);
          const inspection = op => ({ applicationId, author, authorTimestampMs: '1000', proposalId: op.proposalId, operationId: op.operationId,
            stored: true, pending: null, materialized: op.materialized ? { proposalId: op.proposalId, revision: revision(), failingStatementIndex: null, ...op.materialized } : null,
            retained: (op.retained ?? []).map(signer => ({ signer })), finalized: op.finalized === true, excluded: op.excluded === true });
          const handle = op => ({ id: op.proposalId, operationId: op.operationId, stored: true, inspect: () => inspection(op) });
          const apply = op => {
            store.events = store.events.filter(event => event.operationId !== op.operationId);
            if (op.materialized?.outcome === 'accepted') store.events.push({ id: 'event-' + op.proposalId, proposalId: op.proposalId, operationId: op.operationId, author, authorTimestampMs: '1000', topic: op.topic, payload: op.input });
            store.version++; persist(); changed();
          };
          const owner = { applicationId, historyId: 'history', identity: { publicKey: author }, endpoint: { context }, signals: {}, signal: new AbortController().signal,
            get status() { return { ...status }; },
            onStatus(fn) { statusListeners.add(fn); fn({ ...status }); return () => statusListeners.delete(fn); },
            onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },
            // The transport observer is sampled only when a user asks for diagnostics.
            async diagnostics() { window.transportReads++; return []; },
            async readView() {
              if (mode.hold) await readGate;
              if (mode.failRead) throw Error('Read unavailable');
              return { applicationId, revision: revision(), release() {}, query() { return { columns: [], rows: [] }; },
                readEvents(options = {}) { const topics = options.topics; return { revision: revision(), events: structuredClone(store.events.filter(event => !topics || topics.includes(event.topic))), cursor: '', hasMore: false }; } };
            },
            async command(name, input, options) {
              calls.push({ name, input, options });
              if (mode.beforeSave) throw Error('Intent retained but no saved acknowledgment');
              const op = { operationId: options.operationId, proposalId: 'p'.repeat(60) + String(store.ops.length).padStart(4, '0'), name, input,
                topic: name === 'putNote' ? 'note.put' : 'note.deleted', materialized: { outcome: 'accepted', rejectionCode: null }, retained: [], finalized: false, excluded: false };
              store.ops.push(op); apply(op);
              if (mode.loseReply) throw Error('Reply lost');
              return handle(op);
            },
            operations: {
              get: async id => { const op = find(id); return op ? handle(op) : null; },
              async retry(id) {
                calls.push({ retry: id }); const op = find(id);
                if (mode.rejectOnRetry) { op.materialized = { outcome: 'rejected', rejectionCode: 'STALE' }; apply(op); }
                else changed();
                return handle(op);
              },
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
            canAuthor(value) { status.canAuthor = value; emitStatus(); }, phase(value) { status.phase = value; emitStatus(); }, database(value) { status.database = value; emitStatus(); },
            peers(count) { status.connectedPeers = count; emitStatus(); },
            holdRead(value) { mode.hold = value; if (value) gate(); else releaseRead(); }, failRead(value) { mode.failRead = value; changed(); },
            loseReply(value) { mode.loseReply = value; }, beforeSave(value) { mode.beforeSave = value; }, rejectOnRetry(value) { mode.rejectOnRetry = value; },
            fact(operationId, patch) { Object.assign(find(operationId), patch); store.version++; persist(); changed(); },
            peerNote(noteId, text) { store.events.push({ id: 'peer-' + noteId, proposalId: 'q'.repeat(64), operationId: 'peer-op-' + noteId, author: other, authorTimestampMs: '2000', topic: 'note.put', payload: { noteId, text } }); store.version++; persist(); changed(); },
            removeNote(noteId) { store.events = store.events.filter(event => event.payload.noteId !== noteId); store.version++; persist(); changed(); },
          };
          return { session: owner, detach: async () => {}, suspend: async () => {}, resume: async () => {} };
        }
      ` }));
    } }] });
  return { transport: transport.outputFiles[0].text, page: page.outputFiles[0].text, html: await readFile(root + 'docs/tutorial/index.html') };
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

async function open(t, { failOpen = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  const runtimeFixture = () => {
    window.transportReads = 0;
    window.tendril = { transport: FixtureTransport.createTransportBinding().api, application: { install() {} }, signals: { install() {} }, on: () => () => {},
      host: { peers: { application: async () => ({ authority: null }), challenge: async () => { throw Error('not used'); } } },
      publication: { saveOffline: async () => ({ id: 'fixture-publication' }) }, ready() { window.tendrilReady = true; },
      sensors: { status: () => ({ active: [], pending: [] }), on: () => () => {}, stopAll() {} } };
  };
  await page.addInitScript({ content: built.transport + ';(' + runtimeFixture.toString() + ')();' });
  if (failOpen) await page.addInitScript(() => sessionStorage.setItem('fixture-fail-open', '1'));
  await page.goto(url);
  return { page, errors, context };
}
const settled = page => page.waitForFunction(() => window.fixture);
const enabled = (page, id) => page.locator(id).isEnabled();
const facts = page => page.locator('#operation-status').textContent();

test('Save depends only on local signer/storage: it works offline with a held or failed read and no peers', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t);
  await settled(page);
  await page.evaluate(() => fixture.holdRead(true));
  // No successful query, no connected peers, no finalizer or agent: the draft can still be stored locally.
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.equal(await page.evaluate(() => fixture.session.status.connectedPeers), 0);
  assert.match(await page.locator('#submission-status').textContent(), /Save is available, including offline/);
  await page.locator('#note').fill('Offline draft');
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#note').value === '');
  const [call] = await page.evaluate(() => fixture.calls);
  assert.equal(call.name, 'putNote'); assert.equal(call.input.text, 'Offline draft');
  assert.equal(call.options.operationId, await page.locator('#operation-id').inputValue());
  assert.match(await facts(page), /Stored locally: yes/);
  assert.match(await facts(page), /Materialized locally: accepted/);
  assert.match(await facts(page), /Retained by peers: no authenticated evidence/);
  assert.match(await facts(page), /Finalized: no/);
  // A failing read neither disables Save nor claims the list is current.
  await page.evaluate(() => { fixture.holdRead(false); fixture.failRead(true); });
  await page.waitForFunction(() => document.querySelector('#view-error').textContent.includes('Read unavailable'));
  assert.match(await page.locator('#view-error').textContent(), /Local Save remains independent/);
  assert.equal(await enabled(page, '#submit'), true);
  assert.equal(await page.evaluate(() => window.transportReads), 0, 'registration and Save never sample or probe the participant');
  assert.equal(await page.evaluate(() => window.tendril.transport.status().state), 'available');
  assert.deepEqual(errors, []);
});

test('Save follows signing and storage prerequisites, never peers, database state or finality', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t);
  await settled(page);
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  await page.evaluate(() => { fixture.peers(3); fixture.database('opening'); fixture.peers(0); });
  assert.equal(await enabled(page, '#submit'), true);
  await page.evaluate(() => fixture.database('failed'));
  assert.equal(await enabled(page, '#submit'), true);
  await page.locator('#note').fill('Preserved draft');
  // Keys missing: honest explanation, and even a synthetic/keyboard submission cannot bypass it.
  await page.evaluate(() => fixture.canAuthor(false));
  assert.equal(await enabled(page, '#submit'), false);
  assert.match(await page.locator('#submission-status').textContent(), /explicit key provisioning/);
  await page.locator('#form').dispatchEvent('submit');
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('explicit key provisioning'));
  assert.equal(await page.locator('#operation-id').inputValue(), '');
  assert.deepEqual(await page.evaluate(() => fixture.calls), []);
  assert.equal(await page.locator('#note').inputValue(), 'Preserved draft');
  // The owner closing removes the storage prerequisite; the draft stays editable.
  await page.evaluate(() => { fixture.canAuthor(true); fixture.phase('closed'); });
  assert.equal(await enabled(page, '#submit'), false);
  assert.match(await page.locator('#submission-status').textContent(), /Local storage is unavailable/);
  assert.equal(await enabled(page, '#note'), true);
  await page.evaluate(() => fixture.phase('ready'));
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.equal(await page.locator('#note').getAttribute('aria-describedby'), 'draft-help submission-status');
  assert.equal(await page.locator('#submission-status').getAttribute('role'), 'status');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
});

test('an uncertain reply retains the exact original operation ID and retries that same stored operation across reload', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t);
  await settled(page);
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  await page.evaluate(() => fixture.loseReply(true));
  await page.locator('#note').fill('Preserved draft');
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('Reply lost'));
  const id = await page.locator('#operation-id').inputValue(); assert.ok(id);
  assert.match(await facts(page), new RegExp('Inspect or retry the retained operation ' + id));
  // The signed operation is already stored locally even though the reply was lost.
  await page.locator('#inspect').click();
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('Stored locally: yes'));
  assert.equal(await page.locator('#note').inputValue(), 'Preserved draft', 'only a durable acknowledgment clears the exact sent draft');
  assert.equal(await enabled(page, '#retry'), true);
  await page.reload(); await settled(page);
  assert.equal(await page.locator('#operation-id').inputValue(), id);
  assert.equal(await page.locator('#note').inputValue(), 'Preserved draft');
  await page.waitForFunction(() => !document.querySelector('#retry').disabled);
  await page.evaluate(() => fixture.loseReply(false));
  await page.locator('#retry').click();
  await page.waitForFunction(() => document.querySelector('#note').value === '');
  // Retry re-offers the original stored operation: no second command, no new ID, no retimestamp.
  assert.deepEqual(await page.evaluate(() => fixture.calls), [{ retry: id }]);
  assert.equal(await page.locator('#operation-id').inputValue(), id);
  assert.equal(await page.evaluate(() => fixture.store.ops.length), 1);
  assert.equal(await page.evaluate(() => fixture.store.events.length), 1, 'exactly one event for the one original operation');
  assert.deepEqual(errors, []);
});

test('a lost first call with only a retained intent retries the exact original input and ID while the draft stays editable', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t);
  await settled(page);
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  await page.evaluate(() => fixture.beforeSave(true));
  await page.locator('#note').fill('Original reviewed text');
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('no saved acknowledgment'));
  const id = await page.locator('#operation-id').inputValue(), first = await page.evaluate(() => fixture.calls.at(-1));
  assert.equal(await page.evaluate(() => fixture.store.ops.length), 0, 'nothing was stored');
  await page.locator('#note').fill('A newer editable draft');
  await page.reload(); await settled(page);
  assert.equal(await page.locator('#operation-id').inputValue(), id);
  assert.equal(await page.locator('#note').inputValue(), 'A newer editable draft');
  await page.waitForFunction(() => !document.querySelector('#retry').disabled);
  await page.evaluate(() => fixture.beforeSave(false));
  await page.locator('#retry').click();
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('Stored locally: yes'));
  const calls = await page.evaluate(() => fixture.calls);
  assert.deepEqual(calls.at(-1), first, 'the retry uses the original input and operation ID, not the newer draft');
  assert.equal(calls.at(-1).input.text, 'Original reviewed text');
  assert.match(await facts(page), /Original reviewed text: Original reviewed text/);
  assert.equal(await page.locator('#note').inputValue(), 'A newer editable draft', 'a different draft is never cleared by the original acknowledgment');
  assert.deepEqual(errors, []);
});

test('a materialized rejection of the original operation stays visible, retryable by ID and never silently re-signed', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t);
  await settled(page);
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  await page.locator('#note').fill('Concurrent edit');
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('Materialized locally: accepted'));
  const id = await page.locator('#operation-id').inputValue();
  assert.equal(await page.evaluate(() => fixture.store.events.length), 1);
  // Earlier work arriving later revises the outcome; the original intent remains inspectable.
  await page.evaluate(() => fixture.rejectOnRetry(true));
  await page.locator('#retry').click();
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('(STALE)'));
  assert.match(await facts(page), /Materialized locally: rejected \(STALE\)/);
  assert.match(await facts(page), /Stored locally: yes/);
  assert.equal(await page.evaluate(() => fixture.store.events.length), 0, 'the rejected operation no longer contributes a note');
  assert.equal(await page.locator('#count').textContent().then(text => text.startsWith('0 notes')), true);
  assert.equal(await page.locator('#operation-id').inputValue(), id);
  assert.deepEqual((await page.evaluate(() => fixture.calls)).map(call => call.retry ?? call.name), ['putNote', id]);
  assert.equal(await page.evaluate(() => fixture.store.ops.length), 1, 'no replacement operation was signed');
  assert.deepEqual(errors, []);
});

test('stored, materialized, retained and finalized observations update independently without another click', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t);
  await settled(page);
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  await page.locator('#note').fill('Observed note'); await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('Stored locally: yes'));
  const id = await page.locator('#operation-id').inputValue();
  const peer = 'd'.repeat(64);
  await page.evaluate(([id, peer]) => fixture.fact(id, { retained: [peer] }), [id, peer]);
  await page.waitForFunction(peer => document.querySelector('#operation-status').textContent.includes('Retained by peers: ' + peer), peer);
  assert.match(await facts(page), /Materialized locally: accepted/, 'retention does not change execution');
  assert.match(await facts(page), /Finalized: no/);
  await page.evaluate(id => fixture.fact(id, { finalized: true }), id);
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('Finalized: yes'));
  assert.match(await facts(page), new RegExp('Retained by peers: ' + peer), 'finality does not erase or imply retention');
  await page.evaluate(id => fixture.fact(id, { finalized: false, excluded: true, materialized: null }), id);
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('excluded by verified author-time evidence'));
  assert.match(await facts(page), /original signed intent remains inspectable/);
  // An ID that was never stored locally is reported honestly and cannot be retried as if it existed.
  await page.locator('#operation-id').fill('never-stored');
  await page.waitForFunction(() => document.querySelector('#operation-status').textContent.includes('No local signed proposal was found'));
  assert.equal(await enabled(page, '#retry'), false);
  assert.deepEqual(errors, []);
});

test('incoming earlier work rederives the list while the focused draft, unsent text and selection stay put', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t);
  await settled(page);
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  await page.evaluate(() => fixture.peerNote('shared', 'Peer note'));
  await page.waitForFunction(() => document.querySelector('#count').textContent.startsWith('1 note'));
  await page.locator('#notes a').click();
  await page.waitForFunction(() => document.querySelector('#detail-text').textContent.includes('Peer note'));
  await page.locator('#note').fill('Unsent local text'); await page.locator('#note').focus();
  await page.evaluate(() => fixture.peerNote('second', 'Second peer note'));
  await page.waitForFunction(() => document.querySelector('#count').textContent.startsWith('2 notes'));
  assert.equal(await page.locator('#note').evaluate(element => element === document.activeElement), true, 'incoming data never steals focus');
  assert.equal(await page.locator('#note').inputValue(), 'Unsent local text');
  assert.equal(new URL(page.url()).hash, '#note=shared', 'selection is by stable ID in the deep link');
  assert.match(await page.locator('#detail-text').textContent(), /Peer note/);
  // The selected record disappearing is explained; the unsent draft still survives and the link stays shareable.
  await page.evaluate(() => fixture.removeNote('shared'));
  await page.waitForFunction(() => document.querySelector('#count').textContent.startsWith('1 note'));
  assert.match(await page.locator('#detail-text').textContent(), /absent from the/);
  assert.equal(await page.locator('#note').inputValue(), 'Unsent local text');
  await page.reload(); await settled(page);
  assert.equal(await page.locator('#note').inputValue(), 'Unsent local text', 'the draft survives reload separately from shared state');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
});

test('an unreachable local owner keeps the draft editable, explains itself and reattaches on explicit retry', { timeout: 30000 }, async t => {
  const { page, errors } = await open(t, { failOpen: true });
  await page.waitForFunction(() => document.querySelector('#connection-status').textContent.includes('Local session could not open'));
  assert.equal(await enabled(page, '#submit'), false);
  assert.equal(await enabled(page, '#note'), true);
  assert.match(await page.locator('#submission-status').textContent(), /Opening this device’s retained local session/);
  await page.locator('#note').fill('Typed while unavailable');
  assert.equal(await page.locator('#reconnect').isVisible(), true);
  await page.evaluate(() => sessionStorage.removeItem('fixture-fail-open'));
  await page.locator('#reconnect').click();
  await settled(page);
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.equal(await page.locator('#note').inputValue(), 'Typed while unavailable');
  assert.equal(await page.evaluate(() => window.ownerAttachments), 2);
  assert.equal(await page.locator('#reconnect').isHidden(), true);
  assert.deepEqual(errors, []);
});
