import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// Real page/DOM and UI helpers; deterministic session boundary, no RTC claim.
// Run: node --test scripts/test/browser/starter-submission.test.mjs
test('starter readiness, retained retry/reload, rejection and reconnect in Chromium', {timeout:20000}, async t => {
  // Use the actual runtime registration binding over the built public SDK
  // observer, so additions to the page contract cannot disappear into a stub.
  const transport = await build({ entryPoints: ['runtime/src/transport.ts'], bundle: true, write: false, format: 'iife', globalName: 'FixtureTransport',
    plugins: [{name: 'public-transport', setup(build) {
      build.onResolve({filter: /session\/transport-diagnostics\.mjs$/}, () => ({path: new URL('../../../dist/sdk/session/transport-diagnostics.mjs', import.meta.url).pathname}));
    }}],
  });
  const bundle = await build({ entryPoints: ['docs/tutorial/templates/notes/page.mjs'], bundle: true, write: false, format: 'esm',
    plugins: [{ name: 'session-fixture', setup(build) {
      build.onResolve({ filter: /^(?:@tendriller\/core\/browser-owner|@chronolog\/peer-session\/tendriller|(?:\.\.?\/)+(?:shared\/)?pairing-browser\.mjs)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const createApplicationBackend = () => ({});
        export const requestPersistentStorage = async () => null;
        export const createBrowserPairing = () => ({read: () => null});
        export async function openBrowserOwner({context}) {
          window.ownerAttachments = (window.ownerAttachments ?? 0) + 1;
          const statuses = [], recoveries = [], participation = [];
          const status = {phase:'ready',database:'ready',generation:'e'.repeat(64)};
          const participationStatus = {phase:'following',connectedPeers:[],connectionRevision:0};
          window.transportReads = 0;
          const revision = {generation:'e'.repeat(64)};
          let resolveRead, fail = false, hold = true, lose = true, beforeSave = false, cancelApplied = false;
          const saved = JSON.parse(localStorage.getItem('fixture-saved') || '{}');
          const calls = [];
          const session = { applicationId:'c'.repeat(64), historyId:'history', deviceId:'b'.repeat(64), endpoint:{context},
            signals: {}, signal: new AbortController().signal,
            onStatus(fn) {statuses.push(fn); fn(status); return () => {};},
            onRecovery(fn) {recoveries.push(fn); return () => {};},
            participation: {status:participationStatus,async diagnostics(){window.transportReads++;return [];},onStatus(fn) {participation.push(fn); fn({...participationStatus}); return () => {};}},
            changes() {return {async *[Symbol.asyncIterator]() {await new Promise(() => {});}};},
            async query() {if (hold) await new Promise(r => resolveRead = r); if(fail) throw Error('Read unavailable'); return {revision,value:[]};},
            async command(name,input,options) {
              calls.push({name,input,options});
              if(beforeSave) throw Error('Intent retained but no saved acknowledgment');
              saved[options.operationId] = {operationId:options.operationId,status:lose?'saved':'applied',outcome:lose?undefined:'accepted',attemptId:'a'.repeat(64),generation:'e'.repeat(64),author:'b'.repeat(64),historyId:'history'};
              localStorage.setItem('fixture-saved',JSON.stringify(saved));
              if(lose) throw Error('Reply lost');
              return {operationId:options.operationId, applied: async () => {if(cancelApplied) throw Error('TEST_APPLIED_WAITER_CANCELLED'); return saved[options.operationId];}, shared:async()=>[]};
            },
            async reapply(original,name,input,options) {calls.push({reapplies:original}); return this.command(name,input,options);},
            async retry(id) {calls.push({retry:id}); saved[id] = {...saved[id],status:'applied',outcome:'rejected',rejectionCode:'STALE'};},
            operations: {get:async id=>saved[id] || null, inspect:async id=>({state:saved[id] || null}),wait:async id=>saved[id]},
          };
          window.fixture = {calls, release() {hold=false; resolveRead?.();}, fail(value) {fail=value;},
            connection(phase) {participationStatus.phase=phase;participation.forEach(fn=>fn({...participationStatus}));},
            recovery() {recoveries.forEach(fn=>fn({abandoned:[],unknownLoss:false}));},
            abandon(id) {saved[id] = {...saved[id],status:'needsReapply'};}, hold() {hold=true;}, beforeSave(value) {beforeSave=value;}, responseLoss(value) {lose=value;}, cancelApplied(value) {cancelApplied=value;}, session};
          return {session,detach:async()=>{},suspend:async()=>{},resume:async()=>{}};
        }
      ` }));
    } }] });
  const html = await readFile(new URL('../../../docs/tutorial/templates/notes/index.html', import.meta.url));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/page.mjs' ? 'text/javascript' : req.url === '/configuration.json' ? 'application/json' : 'text/html');
    res.end(req.url === '/page.mjs' ? bundle.outputFiles[0].text : req.url === '/configuration.json'
      ? JSON.stringify({applicationId:'c'.repeat(64),nativeDeviceId:'a'.repeat(64),page_url:`http://127.0.0.1:${server.address().port}/`}) : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined});
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({viewport:{width:390,height:844}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const runtimeFixture = () => {
    window.tendril = {transport:FixtureTransport.createTransportBinding().api,application:{install(){}},signals:{install(){}},on:()=>()=>{},sensors:{status:()=>({active:[],pending:[]}),on:()=>()=>{},stopAll(){}}};
  };
  await page.addInitScript({content: transport.outputFiles[0].text + ';(' + runtimeFixture.toString() + ')();'});
  const url = `http://127.0.0.1:${server.address().port}/`;
  // The page attaches by itself (connection component); there is no connect button.
  await page.goto(url); await page.waitForFunction(() => window.fixture);
  const enabled = id => page.locator(id).isEnabled();
  await page.locator('#note').fill('Preserved draft');
  await page.locator('#note').press('Tab');
  assert.equal(await page.locator('#operation-id').evaluate(element => element === document.activeElement), true);
  assert.equal(await enabled('#submit'), false);
  assert.equal(await enabled('#media-file'), false, await page.locator('#result').textContent());
  // Even synthetic/keyboard submission cannot bypass readiness.
  await page.locator('#form').dispatchEvent('submit');
  assert.match(await page.locator('#result').textContent(), /No new operation was submitted/);
  assert.equal(await page.locator('#operation-id').inputValue(), '');
  await page.evaluate(() => fixture.release());
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.equal(await enabled('#media-file'), true);
  assert.equal(await page.evaluate(() => window.tendril.transport.status().state), 'available');
  assert.equal(await page.evaluate(() => window.transportReads), 0, 'registration must not sample or probe the participant');
  await page.evaluate(() => fixture.fail(true));
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('Read unavailable'));
  assert.doesNotMatch(await page.locator('#result').textContent(), /Inspect or retry/);
  assert.equal(await page.locator('#operation-id').inputValue(), '');
  assert.equal(await page.locator('#note').inputValue(), 'Preserved draft');
  await page.evaluate(() => fixture.fail(false)); await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('Reply lost'));
  const id = await page.locator('#operation-id').inputValue(); assert.ok(id);
  assert.equal(await enabled('#submit'), false); assert.equal(await enabled('#retry'), true);
  const retained = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes(':operation:')).map(([, value]) => JSON.parse(value)));
  assert.equal(retained.length, 1);
  assert.equal(retained[0].reference.operationId, id);
  const command = await page.evaluate(() => fixture.calls[0]);
  assert.deepEqual(command.input, {text:'Preserved draft'});
  await page.reload(); await page.waitForFunction(() => window.fixture);
  assert.equal(await page.locator('#note').inputValue(), 'Preserved draft');
  assert.equal(await page.locator('#operation-id').inputValue(), id);
  assert.equal(await enabled('#retry'), false);
  await page.evaluate(() => fixture.release()); await page.waitForFunction(() => !document.querySelector('#retry').disabled);
  await page.waitForFunction(() => Object.entries(localStorage).some(([key, value]) => key.includes(':operation:') && JSON.parse(value).reference.attemptId));
  await page.locator('#retry').click(); await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.deepEqual(await page.evaluate(() => fixture.calls), [{retry:id}]);
  assert.match(await page.locator('#result').textContent(), /rejected/);
  assert.equal(await page.locator('#note').inputValue(), 'Preserved draft');
  assert.equal(await enabled('#retry'), false);
  // A lost first RPC with only a retained intent retries exact input/revision/ID.
  await page.evaluate(() => fixture.beforeSave(true));
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('no saved acknowledgment'));
  const intentId = await page.locator('#operation-id').inputValue();
  const intentCommand = await page.evaluate(() => fixture.calls.at(-1));
  await page.locator('#note').fill('A newer editable draft');
  await page.reload(); await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => {fixture.responseLoss(false); fixture.release();});
  await page.waitForFunction(() => !document.querySelector('#retry').disabled);
  await page.locator('#retry').click(); await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.deepEqual(await page.evaluate(() => fixture.calls), [intentCommand]);
  assert.equal(await page.locator('#operation-id').inputValue(), intentId);
  assert.equal(await page.locator('#note').inputValue(), 'A newer editable draft');
  await page.locator('#submit').click(); await page.waitForFunction(() => document.querySelector('#note').value === '');
  assert.match(await page.locator('#result').textContent(), /accepted/);
  // A cancelled applied waiter does not revoke an independently observed
  // applied result. This is the fast-observer race on elected browser owners.
  await page.locator('#note').fill('Observed despite waiter cancellation');
  await page.evaluate(() => fixture.cancelApplied(true));
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('TEST_APPLIED_WAITER_CANCELLED'));
  const cancelledId = await page.locator('#operation-id').inputValue();
  await page.waitForFunction(id => document.querySelector('#operation-status').textContent.includes(id + ': Applied: accepted.'), cancelledId);
  assert.equal(await enabled('#submit'), true);
  assert.equal(await enabled('#retry'), false);
  const remaining = await page.evaluate(id => Object.entries(localStorage).filter(([key, value]) =>
    key.includes(':operation:') && JSON.parse(value).reference.operationId === id), cancelledId);
  assert.deepEqual(remaining, [], 'A verified applied result resolves the retained reference, even when its waiter was cancelled.');
  await page.evaluate(() => fixture.cancelApplied(false));
  // Losing the agent connection keeps local saving (AGENTS.md: Save never waits on the
  // network or agent); photo evidence, analyzed by the connected agent, waits.
  await page.evaluate(() => fixture.connection('recovering'));
  assert.equal(await enabled('#submit'), true); assert.equal(await enabled('#media-file'), false);
  await page.evaluate(() => fixture.connection('following'));
  await page.waitForFunction(() => !document.querySelector('#media-file').disabled);
  await page.evaluate(() => {fixture.hold(); fixture.recovery();}); assert.equal(await enabled('#submit'), false);
  await page.evaluate(() => fixture.release()); await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.equal(await page.locator('#note').getAttribute('aria-describedby'), 'draft-help submission-status');
  assert.equal(await page.locator('#submission-status').getAttribute('role'), 'status');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#note').fill('Explicit reapplication');
  await page.evaluate(() => fixture.responseLoss(true));
  await page.locator('#submit').click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('Reply lost'));
  const abandonedId = await page.locator('#operation-id').inputValue();
  await page.evaluate(id => fixture.abandon(id), abandonedId);
  await page.locator('#inspect').click(); await page.waitForFunction(() => !document.querySelector('#reapply').disabled);
  assert.equal(await enabled('#retry'), false);
  await page.locator('#reapply').click();
  await page.waitForFunction(() => !document.querySelector('#retry').disabled);
  const replacementId = await page.locator('#operation-id').inputValue();
  assert.notEqual(replacementId, abandonedId);
  const reapplied = await page.evaluate(() => fixture.calls.slice(-2));
  assert.deepEqual(reapplied[0], {reapplies:abandonedId});
  assert.equal(reapplied[1].options.operationId, replacementId);
  await page.locator('#retry').click(); await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.deepEqual(await page.evaluate(() => fixture.calls.at(-1)), {retry:replacementId});
  await page.locator('#close').click(); assert.equal(await enabled('#submit'), false);
  assert.equal(await enabled('#note'), true);
  // Close while the next initial read is still pending. Releasing that read must
  // not install a backend or start another owner attachment behind the closed UI.
  await page.reload(); await page.locator('#close:enabled').waitFor();
  await page.locator('#close').click(); await page.evaluate(() => fixture.release());
  await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connection closed');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1600)));
  assert.equal(await page.evaluate(() => window.ownerAttachments), 1);
  assert.equal(await enabled('#close'), false);
  assert.equal(await page.locator('#app-content').isHidden(), true);
  assert.deepEqual(errors, []);
});
