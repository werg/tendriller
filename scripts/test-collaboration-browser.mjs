// Actual browser/storage qualification of the single-active-tab dedicated Worker owner composition, without a hosted service.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const reportRoot = resolve(process.env.TENDRILLER_BROWSER_OUTPUT ?? join(root, '.results'));
const out = join(reportRoot, 'collaboration-browser-assets');
await mkdir(out, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { page: 'collaboration/test/browser/page.mjs', worker: 'collaboration/test/browser/worker.mjs' },
  bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', outdir: out, outExtension: { '.js': '.mjs' },
});
await build({
  absWorkingDir: root,
  stdin: { contents: "export {openBrowserOwner,createBrowserIdentity} from './session/browser.mjs';export {serveBrowserOwner} from './session/worker.mjs';", resolveDir: root, loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: join(out, 'passive.mjs'),
});

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/passive.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Passive public import</title><script type="module">
window.passiveReady=(async()=>{
  const calls={};
  for(const name of ['Worker','SharedWorker','BroadcastChannel','WebSocket','RTCPeerConnection'])if(typeof window[name]==='function')window[name]=class{constructor(){calls[name]=(calls[name]||0)+1;throw Error('EAGER_'+name);}};
  const forbid=(object,name)=>{if(typeof object?.[name]!=='function')return;object[name]=()=>{calls[name]=(calls[name]||0)+1;throw Error('EAGER_'+name);};};
  for(const name of ['getDirectory','persist','persisted','estimate'])forbid(navigator.storage,name);
  for(const name of ['request','query'])forbid(navigator.locks,name);
  forbid(indexedDB,'open');forbid(window,'fetch');
  await import('/passive.mjs');return calls;
})();
</script>`);
    return;
  }
  if (path === '/' || path === '/board.html' || path === '/discussion.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Owner conformance</title><script type="module" src="/page.mjs"></script>');
    return;
  }
  if (!/^\/[A-Za-z0-9_.-]+\.mjs$/.test(path)) { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(join(out, path.slice(1)))); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const evidence = {
  status: 'failed',
  stage: 'launch',
  scenarios: [],
  completedStages: [],
  diagnostics: [],
  scope: 'Actual Chromium; local origin, events backend, single-active-tab dedicated Worker lock',
};

async function stage(name, run, timeoutMs = 25000) {
  evidence.stage = name;
  console.log(`Browser qualification: ${name}`);
  let timer;
  try {
    const result = await Promise.race([
      run(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error(`Browser stage timed out: ${name}`)), timeoutMs); }),
    ]);
    evidence.completedStages.push(name);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function observe(page, label) {
  const record = message => { if (evidence.diagnostics.length < 64) evidence.diagnostics.push({ page: label, stage: evidence.stage, message }); };
  page.on('pageerror', error => record(error.message));
  page.on('console', message => { if (message.type() === 'error') record(message.text()); });
}

const deadline = setTimeout(() => { evidence.failure = `Browser qualification exceeded its 120 second deadline at ${evidence.stage}`; void browser?.close(); }, 120000);
try {
  const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {};
  browser = await chromium.launch({ headless: true, ...launchOptions });
  evidence.browser = browser.version();

  await stage('passive-public-import-does-not-open-storage-workers-or-peer-discovery', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(base + '/passive.html');
      assert.deepEqual(await page.evaluate(() => window.passiveReady), {});
      evidence.passivePublicImportLazy = true;
    } finally {
      await context.close();
    }
  });

  const context = await browser.newContext();
  const profile = 'qualification-single-tab';
  const one = await context.newPage();
  const two = await context.newPage();
  observe(one, 'one');
  observe(two, 'two');
  const url = (path, view = 'main-view', extra = '') => `${base}/${path}?profile=${profile}&view=${view}${extra}`;

  const a = await stage('identity-and-first-attachment', async () => {
    await one.goto(url('board.html', 'tab-one', '&identity=create'));
    return one.evaluate(() => window.ready);
  });
  assert.equal(a.mode, 'dedicated');
  assert.equal(a.status.canAuthor, true);

  await stage('participant-focus', () => one.evaluate(() => window.verifyParticipantPanel()));

  await stage('drafts-and-commands', async () => {
    await one.evaluate(() => window.viewStore.writeDraft({ text: 'board draft' }));
    assert.equal(await one.evaluate(() => window.viewStore.readDraft().text), 'board draft');
    await one.evaluate(async () => {
      const op = await window.session.command('say', 'first', { operationId: 'first' });
      await op.materialized();
    });
    assert.equal(await one.evaluate(async () => (await window.session.query('messages', null)).value.events.length), 1);
  });

  await stage('suspend-resume', async () => {
    const before = await one.evaluate(() => window.session.endpoint.endpointIncarnation);
    await one.evaluate(() => window.attachment.suspend());
    await one.evaluate(() => window.attachment.resume());
    assert.equal(await one.evaluate(() => window.session.endpoint.endpointIncarnation), before);
  });

  await stage('second-tab-reports-active-elsewhere-without-stealing', async () => {
    await two.goto(url('discussion.html', 'tab-two'));
    await two.waitForFunction(() => window.ownerStage === 'failed:attachment');
    const failure = await two.evaluate(() => window.ownerFailure);
    assert.equal(failure.code, 'TAB_ACTIVE_ELSEWHERE');
    assert.equal(await one.evaluate(() => window.ownerReplacedCount), 0);
    assert.equal(await one.evaluate(() => window.session.signal.aborted), false);
  });

  await stage('explicit-takeover-transfers-lock-and-preserves-local-state', async () => {
    await two.goto(url('discussion.html', 'tab-two', '&takeover=1'));
    const b = await two.evaluate(() => window.ready);
    assert.equal(b.publicKey, a.publicKey);
    assert.equal(b.status.canAuthor, true);
    await one.waitForFunction(() => window.ownerReplacedCount === 1);
    assert.equal(await two.evaluate(async () => (await (await window.session.operations.get('first')).materialized({ timeoutMs: 15000 })).outcome), 'accepted');
    await two.evaluate(async () => {
      const op = await window.session.command('say', 'second', { operationId: 'second' });
      await op.materialized();
    });
    assert.equal(await two.evaluate(async () => (await window.session.query('messages', null)).value.events.length), 2);
  });

  await stage('reload-retains-identity-and-stored-operations', async () => {
    await two.reload();
    const reloaded = await two.evaluate(() => window.ready);
    assert.equal(reloaded.publicKey, a.publicKey);
    assert.equal(await two.evaluate(async () => (await window.session.query('messages', null)).value.events.length), 2);
  });

  evidence.scenarios.push({
    mode: 'dedicated',
    oneSigner: true,
    localAuthoringAvailable: true,
    singleActiveTabLock: true,
    explicitTakeoverPreservesState: true,
    suspendResume: true,
    asyncIdentityBootstrap: true,
    participantFocus: true,
    reloadPreservesState: true,
  });
  await context.close();
  evidence.stage = 'complete';
  evidence.status = 'passed';
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.failure ??= error.stack ?? String(error);
  console.error(JSON.stringify(evidence, null, 2));
  throw error;
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await new Promise(done => server.close(done));
  await writeFile(join(reportRoot, 'collaboration-browser.json'), JSON.stringify(evidence, null, 2) + '\n');
}
