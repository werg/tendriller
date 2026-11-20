import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// Real page/DOM and UI helpers; deterministic session boundary, no RTC claim.
// Run: node --test scripts/test/browser/starter-submission.test.mjs
test('starter readiness, retained retry/reload, rejection and reconnect in Chromium', {timeout:20000}, async t => {
  const bundle = await build({ entryPoints: ['docs/tutorial/page.mjs'], bundle: true, write: false, format: 'esm',
    plugins: [{ name: 'session-fixture', setup(build) {
      build.onResolve({ filter: /^(?:@tendriller\/core\/collaboration\/browser|@chronolog\/peer-session\/tendriller|\.\/pairing-browser\.mjs)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      build.onResolve({ filter: /^@tendriller\/core\/collaboration$/ }, () => ({ path: new URL('../../../collaboration/index.mjs', import.meta.url).pathname }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const createApplicationBackend = () => ({});
        export const createBrowserPairing = () => ({read: () => null});
        export async function openBrowserOwner({context}) {
          const statuses = [], recoveries = [], participation = [];
          const status = {phase:'ready',database:'ready',generation:'g'};
          const revision = {generation:'g'};
          let resolveRead, fail = false, hold = true, lose = true, beforeSave = false;
          const saved = JSON.parse(localStorage.getItem('fixture-saved') || '{}');
          const calls = [];
          const session = { applicationId:'app', historyId:'history', deviceId:'b'.repeat(64), endpoint:{context},
            signals: {}, signal: new AbortController().signal,
            onStatus(fn) {statuses.push(fn); fn(status); return () => {};},
            onRecovery(fn) {recoveries.push(fn); return () => {};},
            participation: {onStatus(fn) {participation.push(fn); fn({phase:'following'}); return () => {};}},
            changes() {return {async *[Symbol.asyncIterator]() {await new Promise(() => {});}};},
            async query() {if (hold) await new Promise(r => resolveRead = r); if(fail) throw Error('Read unavailable'); return {revision,value:[]};},
            async command(name,input,options) {
              calls.push({name,input,options});
              if(beforeSave) throw Error('Intent retained but no saved acknowledgment');
              saved[options.operationId] = {operationId:options.operationId,status:lose?'saved':'applied',outcome:lose?undefined:'accepted',attemptId:'a'.repeat(64),generation:'g',author:'b'.repeat(64),historyId:'history'};
              localStorage.setItem('fixture-saved',JSON.stringify(saved));
              if(lose) throw Error('Reply lost');
              return {operationId:options.operationId, applied: async () => saved[options.operationId], shared:async()=>[]};
            },
            async retry(id) {calls.push({retry:id}); saved[id] = {...saved[id],status:'applied',outcome:'rejected',rejectionCode:'STALE'};},
            operations: {get:async id=>saved[id] || null, inspect:async id=>({state:saved[id] || null}),wait:async id=>saved[id]},
          };
          window.fixture = {calls, release() {hold=false; resolveRead?.();}, fail(value) {fail=value;},
            connection(phase) {participation.forEach(fn=>fn({phase}));},
            recovery() {recoveries.forEach(fn=>fn({abandoned:[],unknownLoss:false}));},
            hold() {hold=true;}, beforeSave(value) {beforeSave=value;}, responseLoss(value) {lose=value;}, session};
          return {session,detach:async()=>{},suspend:async()=>{},resume:async()=>{}};
        }
      ` }));
    } }] });
  const html = await readFile(new URL('../../../docs/tutorial/index.html', import.meta.url));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/page.mjs' ? 'text/javascript' : req.url === '/configuration.json' ? 'application/json' : 'text/html');
    res.end(req.url === '/page.mjs' ? bundle.outputFiles[0].text : req.url === '/configuration.json'
      ? JSON.stringify({applicationId:'app',nativeDeviceId:'a'.repeat(64),page_url:`http://127.0.0.1:${server.address().port}/`}) : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined});
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({viewport:{width:390,height:844}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => window.tendril = {application:{install(){}},signals:{install(){}},on:()=>()=>{},sensors:{status:()=>({active:[],pending:[]}),on:()=>()=>{},stopAll(){}}});
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(url);
  const enabled = id => page.locator(id).isEnabled();
  await page.locator('#note').fill('Preserved draft');
  await page.locator('#note').press('Tab');
  assert.equal(await page.locator('#operation-id').evaluate(element => element === document.activeElement), true);
  await page.locator('#connect').click(); await page.waitForFunction(() => window.fixture);
  assert.equal(await enabled('#submit'), false);
  assert.equal(await enabled('#media-file'), false, await page.locator('#result').textContent());
  // Even synthetic/keyboard submission cannot bypass readiness.
  await page.locator('#form').dispatchEvent('submit');
  assert.match(await page.locator('#result').textContent(), /No new operation was submitted/);
  assert.equal(await page.locator('#operation-id').inputValue(), '');
  await page.evaluate(() => fixture.release());
  await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.equal(await enabled('#media-file'), true);
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
  await page.reload(); await page.locator('#connect').click(); await page.waitForFunction(() => window.fixture);
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
  await page.reload(); await page.locator('#connect').click(); await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => {fixture.responseLoss(false); fixture.release();});
  await page.waitForFunction(() => !document.querySelector('#retry').disabled);
  await page.locator('#retry').click(); await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.deepEqual(await page.evaluate(() => fixture.calls), [intentCommand]);
  assert.equal(await page.locator('#operation-id').inputValue(), intentId);
  assert.equal(await page.locator('#note').inputValue(), 'A newer editable draft');
  await page.locator('#submit').click(); await page.waitForFunction(() => document.querySelector('#note').value === '');
  assert.match(await page.locator('#result').textContent(), /accepted/);
  await page.evaluate(() => {fixture.hold(); fixture.connection('recovering');});
  assert.equal(await enabled('#submit'), false); assert.equal(await enabled('#media-file'), false);
  await page.evaluate(() => fixture.connection('following'));
  assert.equal(await enabled('#submit'), false);
  await page.evaluate(() => fixture.release()); await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  await page.evaluate(() => {fixture.hold(); fixture.recovery();}); assert.equal(await enabled('#submit'), false);
  await page.evaluate(() => fixture.release()); await page.waitForFunction(() => !document.querySelector('#submit').disabled);
  assert.equal(await page.locator('#note').getAttribute('aria-describedby'), 'draft-help submission-status');
  assert.equal(await page.locator('#submission-status').getAttribute('role'), 'status');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#close').click(); assert.equal(await enabled('#submit'), false);
  assert.equal(await enabled('#note'), true);
  assert.deepEqual(errors, []);
});
