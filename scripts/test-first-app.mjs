// Exercise the downloaded first-app source as an independent public-package consumer.
// The local host has synthetic account sessions; no OAuth provider or live service is used.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { parseArgs, promisify } from 'node:util';
import { Agent, setGlobalDispatcher } from 'undici';
import { chromium, expect } from '@playwright/test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from 'wrangler';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { values } = parseArgs({ options: {
  'session-archive': { type: 'string' }, report: { type: 'string' }, keep: { type: 'boolean' },
  'native-only': { type: 'boolean' },
} });
if (!values['session-archive']) throw Error('Usage: node scripts/test-first-app.mjs --session-archive /absolute/chronolog-peer-session-COMMIT.tgz [--native-only] [--report FILE] [--keep]');
const sessionArchive = resolve(values['session-archive']);
const reportPath = resolve(values.report ?? join(root, '.results/first-app.json'));
const directory = await mkdtemp(join(tmpdir(), 'tendriller-first-app-'));
const app = join(directory, 'application');
const SERVICE = 'https://service.localhost:8790';
const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));
const report = { status: 'running', qualification: 'isolated-local-tutorial',
  native_checks: 'running', browser_checks: 'not-run',
  limits: ['Synthetic local owner session; no OAuth provider tested.',
    'Local Chromium and encrypted WebSocket relay; no Internet, native RTC or mobile qualification.',
    'Scripted tutorial execution; not an unassisted fresh-agent usability result.'], steps: [] };
let host, peer, browser, stage = 'preflight';

// Every request, including a followed redirect or literal IP, is restricted to
// loopback hosts. TLS relaxation never enters the tutorial, packages or page.
// The same test-only factory is copied into the child-process preload below.
function createLocalDispatcher() {
  class LocalAgent extends Agent {
    dispatch(options, handler) {
      const hostname = new URL(options.origin).hostname;
      if (!hostname.endsWith('.localhost') && hostname !== 'localhost' && hostname !== '127.0.0.1')
        throw Error('The first-app fixture refuses non-loopback network access.');
      return super.dispatch(options, handler);
    }
  }
  return new LocalAgent({ connect: { rejectUnauthorized: false,
    lookup(_hostname, options, callback) {
      if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    },
  } });
}
const dispatcher = createLocalDispatcher();
setGlobalDispatcher(dispatcher);

async function run(command, args, options = {}) {
  const result = await execute(command, args, { cwd: app, timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024, ...options });
  return result.stdout;
}
function checkpoint(name) { stage = name; console.log(`First app: ${name}`); }
function passed(name) { report.steps.push(name); }
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function packDependency(name) {
  const path = dirname(require.resolve(`${name}/package.json`));
  const result = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--offline', '--json',
    '--cache', join(directory, 'npm-cache'), '--pack-destination', directory, path]));
  return join(directory, result[0].filename);
}

try {
  await mkdir(app);
  await mkdir(dirname(reportPath), { recursive: true });
  const { version } = await jsonFile(join(root, 'package.json'));
  const proof = await jsonFile(join(root, 'dist/provenance.json'));
  const toolsProof = await jsonFile(join(root, 'dist/tools-manifest.json'));
  const archives = Object.fromEntries(['sdk', 'tools', 'engine'].map(name =>
    [name, join(root, 'dist', `tendriller-${name}-${version}.tgz`)]));
  for (const artifact of [...proof.artifacts, ...toolsProof.artifacts]) {
    assert.equal(sha256(await readFile(join(root, 'dist', artifact.file))), artifact.sha256, `Archive changed: ${artifact.file}`);
  }
  report.core = { source: proof.source, dirty: proof.dirty, version,
    artifacts: Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, sha256(await readFile(path))]))) };
  const engine = join(directory, 'engine'); await mkdir(engine);
  await run('tar', ['-xzf', archives.engine, '-C', engine]);
  const engineProof = await jsonFile(join(engine, 'package/provenance.json'));
  for (const [path, hash] of Object.entries(engineProof.files))
    assert.equal(sha256(await readFile(join(engine, 'package', path))), hash, `Packed engine changed: ${path}`);

  checkpoint('start isolated packed host');
  let existing;
  try { existing = await fetch(`${SERVICE}/health`, { signal: AbortSignal.timeout(1_000) }); } catch {}
  if (existing) { await existing.body?.cancel(); throw Error('Port 8790 already serves a host. Stop it before this isolated test.'); }
  // Use the public runtime API directly: address-printing in the dev CLI needs
  // network-interface inspection that restricted execution hosts may disallow.
  const { workerOptions: sourceOptions } = unstable_getMiniflareWorkerOptions(join(root, 'server/wrangler.jsonc'));
  // The engine archive is already one bundled module; source-loader rules do
  // not apply to it (and are intentionally unsupported by the v5 converter).
  const { modulesRules: _sourceRules, ...workerOptions } = sourceOptions;
  host = new Miniflare({ ...convertV4MiniflareOptions({ ...workerOptions,
    scriptPath: join(engine, 'package/worker.mjs'), modulesRoot: join(engine, 'package'), modules: true,
    bindings: { ...workerOptions.bindings, PUBLIC_BASE: SERVICE, PAGE_BASE_DOMAIN: 'pages.localhost' },
    host: '127.0.0.1', port: 8790, https: true, cf: false,
  }), resourcePersistencePath: join(directory, 'host-state'), resourceTmpPath: join(directory, 'host-tmp'),
  enableDevRegistry: false, logRequests: false });
  await host.ready;
  const accounts = await host.getD1Database('ACCOUNTS');
  for (const query of unstable_splitSqlQuery(await readFile(join(engine, 'package/migrations/0001_accounts.sql'), 'utf8')))
    await accounts.prepare(query).run();
  const now = Date.now(), ownerToken = 'tendriller-local-e2e-session';
  await accounts.batch([
    accounts.prepare("UPDATE service_state SET mode = 'open' WHERE id = 1"),
    accounts.prepare('INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)').bind('e2e-owner', now, 'owner@example.test'),
    accounts.prepare('INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('github', 'e2e-subject', 'e2e-owner', 'e2e-owner', 'owner@example.test', now),
    accounts.prepare('INSERT INTO identity_emails (provider, subject, email) VALUES (?, ?, ?)').bind('github', 'e2e-subject', 'owner@example.test'),
    accounts.prepare('INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(sha256(ownerToken), 'e2e-owner', now, now + 86_400_000),
  ]);
  passed('packed host with isolated storage');

  checkpoint('download first-app source and install exact public packages');
  const source = await fetch(`${SERVICE}/downloads/tendriller-first-app.tgz`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(source.status, 200, 'The domain must serve the first-app archive.');
  const sourceBytes = new Uint8Array(await source.arrayBuffer());
  report.tutorial_sha256 = sha256(sourceBytes);
  const sourceArchive = join(directory, 'first-app.tgz'); await writeFile(sourceArchive, sourceBytes);
  await run('tar', ['-xzf', sourceArchive, '-C', app]);
  const esbuild = await packDependency('esbuild');
  const esbuildPlatform = await packDependency(`@esbuild/${process.platform}-${process.arch}`);
  await run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund',
    '--cache', join(directory, 'npm-cache'), archives.sdk, archives.tools, sessionArchive, esbuild, esbuildPlatform]);
  const sessionProof = await jsonFile(join(app, 'node_modules/@chronolog/peer-session/provenance.json'));
  assert.equal(sessionProof.dirty, false, 'Use a clean, explicitly selected public Chronolog archive.');
  report.chronolog = { source: sessionProof.source, dirty: sessionProof.dirty, sha256: sha256(await readFile(sessionArchive)) };

  const preload = join(directory, 'local-network.mjs');
  await writeFile(preload, `import { Agent, setGlobalDispatcher, WebSocket } from ${JSON.stringify(pathToFileURL(require.resolve('undici')).href)};
${createLocalDispatcher.toString()}
const dispatcher = createLocalDispatcher();
setGlobalDispatcher(dispatcher);
globalThis.WebSocket = class extends WebSocket { constructor(url, protocols = []) { super(url, { protocols, dispatcher }); } };
`);
  const node = async args => run(process.execPath, ['--import', preload, ...args]);
  const cli = join(app, 'node_modules/@tendriller/tools/bin/tendril.mjs');
  const cliJson = async args => JSON.parse(await node([cli, '--session', join(app, 'session.mjs'), ...args]));
  passed('domain-served tutorial and independently installed public packages');

  checkpoint('create, claim and initialize');
  await node(['setup.mjs', 'create', SERVICE, 'owner@example.test', 'First-app qualification']);
  const handle = await jsonFile(join(app, '.tendriller/handle.json'));
  const localPage = new URL(handle.page_url); localPage.port = '8790';
  const initialClaim = await fetch(localPage, { redirect: 'manual' });
  assert.equal(initialClaim.status, 302); await initialClaim.body?.cancel();
  const claim = await fetch(initialClaim.headers.get('Location'), { redirect: 'manual',
    headers: { Cookie: `__Host-tendriller=${ownerToken}` } });
  assert.equal(claim.status, 303, 'Synthetic owner must traverse the actual claim flow.'); await claim.body?.cancel();
  const redeemUrl = new URL(claim.headers.get('Location')); redeemUrl.port = '8790';
  const redeem = await fetch(redeemUrl, { redirect: 'manual' });
  assert.equal(redeem.status, 303); await redeem.body?.cancel();
  const initialized = JSON.parse(await node(['setup.mjs', 'init']));
  assert.equal(initialized.initialized, true);
  assert.deepEqual((await cliJson(['query', 'notes', 'null'])).value, []);
  const device = await jsonFile(join(app, '.tendriller/initialized.json'));
  await node(['setup.mjs', 'init']);
  assert.deepEqual(await jsonFile(join(app, '.tendriller/initialized.json')), device, 'Initialization retry preserves identity.');
  assert.equal((await cliJson(['command', 'addNote', JSON.stringify({ text: 'Native setup and durable reopen' }),
    '--operation', 'native-setup-1'])).outcome, 'accepted');
  const retained = await cliJson(['query', 'notes', 'null']);
  assert.equal(retained.value.length, 1); assert.equal(retained.value[0].operationId, 'native-setup-1');
  passed('real native command and coherent query after process reopen');
  report.application_id = handle.application.id; report.native_device_id = device.deviceId;
  passed('owner claim, exact initialization retry, selected genesis and native reopen');

  checkpoint('build and sign the complete authored graph');
  await node(['build.mjs']);
  const initial = await jsonFile(join(app, '.tendriller/initial-input.json'));
  for (const path of await files(join(app, 'page'))) {
    const bytes = await readFile(path);
    assert.equal(bytes.includes(Buffer.from(handle.token)), false, 'Agent token leaked into authored output.');
    assert.equal(bytes.includes(Buffer.from(initial.epochKey)), false, 'Bootstrap epoch key leaked into authored output.');
    assert.doesNotMatch(path, /\.tendriller|device\.sqlite/);
  }
  const publication = await cliJson(['publish', join(app, 'page'), '--operation', 'first-app-publication-1']);
  const retry = await cliJson(['publish', join(app, 'page'), '--operation', 'first-app-publication-1']);
  assert.deepEqual(retry, publication, 'Exact publication retry must recover its original receipt.');
  report.publication_id = publication.publication.id;
  passed('public-only authored graph, signed publication and exact publication retry');
  report.native_checks = 'passed';

  if (values['native-only']) {
    report.status = 'partial';
    report.limits.push('Browser and cross-device behavior omitted by --native-only.');
    console.log('First-app native/package/host checks passed; browser qualification remains untested.');
  } else {
    report.browser_checks = 'running';
    checkpoint('launch browser');
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--host-resolver-rules=MAP *.localhost:443 127.0.0.1:8790, MAP *.localhost 127.0.0.1'] });
    report.browser = await browser.version();
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(SERVICE); await page.screenshot({ path: join(dirname(reportPath), 'first-app-homepage-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(dirname(reportPath), 'first-app-homepage-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 960 });
    await context.addCookies([{ name: '__Host-tendriller', value: ownerToken,
      domain: 'service.localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    checkpoint('create and enroll the actual browser device');
    await page.goto(handle.page_url);
    await page.locator('#create-device').click();
    await expect(page.locator('#device-key')).toHaveValue(/^[a-f0-9]{64}$/, { timeout: 30_000 });
    const browserDevice = await page.locator('#device-key').inputValue();
    await node(['setup.mjs', 'enroll', browserDevice]);
    await node(['setup.mjs', 'enroll', browserDevice]);
    report.browser_device_id = browserDevice;
    passed('independent browser signer and exact authorized enrollment retry');

    // Drive the same real native bootstrap without a second store owner. This is
    // the agent side of the test; it adds no protocol, backend or fixture data.
    await writeFile(join(app, 'test-peer.mjs'), `import {createInterface} from 'node:readline';
  import {openSession} from './session.mjs';
  const {session} = await openSession();
  console.log(JSON.stringify({ready:true,deviceId:session.deviceId}));
  for await (const line of createInterface({input:process.stdin})) {
    const request=JSON.parse(line);
    try {
      let result;
      if(request.action==='query') result=await session.query('notes',null);
      else if(request.action==='command') {
        const before=await session.query('notes',null);
        const operation=await session.command('addNote',{text:request.text},{operationId:request.operationId,basedOn:before.revision});
        result=await operation.applied({signal:AbortSignal.timeout(30000)});
      } else if(request.action==='close') {await session.close(); console.log(JSON.stringify({id:request.id,closed:true})); break;}
      else throw Error('Unknown test action');
      console.log(JSON.stringify({id:request.id,result}));
    } catch(error) {console.log(JSON.stringify({id:request.id,error:error.message}));}
  }
  await session.close();
  `);
    async function startPeer() {
      const child = spawn(process.execPath, ['--import', preload, join(app, 'test-peer.mjs')], { cwd: app, stdio: ['pipe', 'pipe', 'pipe'] });
      const waiting = new Map(); let sequence = 0, readyResolve, readyReject, stderr = '';
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-6_000); });
      createInterface({ input: child.stdout }).on('line', line => {
        const value = JSON.parse(line);
        if (value.ready) { readyResolve(value); return; }
        const held = waiting.get(value.id); if (!held) return;
        waiting.delete(value.id); clearTimeout(held.timer);
        if (value.error) held.reject(Error(value.error)); else held.resolve(value.result ?? value);
      });
      child.once('exit', code => {
        const error = Error(`Native peer exited (${code}): ${stderr}`); readyReject(error);
        for (const held of waiting.values()) { clearTimeout(held.timer); held.reject(error); } waiting.clear();
      });
      const client = { child, async request(action, input = {}) {
        if (child.exitCode !== null || child.signalCode !== null) throw Error(`Native peer is closed: ${stderr}`);
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waiting.delete(id); reject(Error(`Native ${action} timed out: ${stderr}`)); }, 40_000);
          waiting.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, action, ...input }) + '\n');
        });
      } };
      peer = client;
      let timer;
      const metadata = await Promise.race([ready, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Error(`Native peer did not open: ${stderr}`)), 40_000);
      })]).finally(() => clearTimeout(timer));
      assert.equal(metadata.deviceId, device.deviceId);
      return client;
    }
    await startPeer();
    checkpoint('connect browser and exchange retained commands');
    await page.locator('#connect').click();
    await expect(page.locator('#data-status')).toContainText('Data: ready; application: ready', { timeout: 60_000 });
    await page.locator('#note').fill('Created in the browser'); await page.locator('#submit').click();
    await expect(page.locator('#result')).toContainText('Applied: accepted', { timeout: 30_000 });
    assert.deepEqual((await peer.request('query')).value.map(note => note.text),
      ['Native setup and durable reopen', 'Created in the browser']);
    passed('browser command observed by the real native session through relay');

    checkpoint('cancel an applied waiter, reload and retry its original operation');
    await page.evaluate(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = milliseconds => milliseconds === 15_000
        ? AbortSignal.abort(Error('TEST_APPLIED_WAITER_CANCELLED')) : timeout(milliseconds);
    });
    await page.locator('#note').fill('Preserve this uncertain operation'); await page.locator('#submit').click();
    await expect(page.locator('#result')).toContainText('TEST_APPLIED_WAITER_CANCELLED', { timeout: 30_000 });
    const operation = await page.locator('#operation-id').inputValue();
    await expect(page.locator('#submit')).toBeDisabled();
    await page.reload(); await page.locator('#connect').click();
    await expect(page.locator('#device-key')).toHaveValue(browserDevice, { timeout: 30_000 });
    await expect(page.locator('#data-status')).toContainText('Data: ready; application: ready', { timeout: 60_000 });
    await expect(page.locator('#operation-id')).toHaveValue(operation);
    await expect(page.locator('#submit')).toBeDisabled();
    await page.locator('#retry').click();
    await expect(page.locator('#submit')).toBeEnabled({ timeout: 30_000 });
    const afterRetry = (await peer.request('query')).value;
    assert.equal(afterRetry.filter(note => note.operationId === operation).length, 1);
    assert.equal(afterRetry.length, 3);
    report.retried_operation_id = operation;
    passed('cancelled waiter, pending identity across reload and exact retry without duplication');

    const applied = await peer.request('command', { text: 'Created by the native agent', operationId: 'native-note-1' });
    assert.equal(applied.outcome, 'accepted');
    await expect(page.locator('#notes')).toContainText('Created by the native agent', { timeout: 30_000 });
    await expect(page.locator('#notes li')).toHaveCount(4);
    passed('native command observed by the browser without state injection');

    checkpoint('close and reopen both original devices');
    await page.locator('#close').click();
    await expect(page.locator('#connection')).toContainText('Connection closed');
    await peer.request('close'); await stop(peer.child); peer = undefined;
    await startPeer(); assert.equal((await peer.request('query')).value.length, 4);
    await page.reload(); await page.locator('#connect').click();
    await expect(page.locator('#device-key')).toHaveValue(browserDevice, { timeout: 30_000 });
    await expect(page.locator('#notes li')).toHaveCount(4, { timeout: 60_000 });
    passed('same native/browser identities and retained notes after both reopen');
    report.status = 'passed'; report.browser_checks = 'passed'; report.note_count = 4;
    console.log('First-app native/browser integration passed. Synthetic local claim and relay limits are recorded in the report.');
  }
} catch (error) {
  report.status = 'failed'; report.failed_stage = stage; report.error = error.message;
  if (report.native_checks === 'running') report.native_checks = 'failed';
  if (report.browser_checks === 'running') report.browser_checks = 'failed';
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  if (peer) { await peer.request('close').catch(() => {}); await stop(peer.child); }
  await browser?.close().catch(() => {}); await host?.dispose().catch(() => {}); await dispatcher.close().catch(() => {});
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (values.keep) console.log(`Private test directory retained: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
}
