// Exercise the downloaded first-app source as an independent public-package consumer.
// The local host has synthetic account sessions; no OAuth provider or live service is used.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { connect as connectTls } from 'node:tls';
import { parseArgs, promisify } from 'node:util';
import { Agent, setGlobalDispatcher } from 'undici';
import { chromium, expect } from '@playwright/test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from 'wrangler';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { values } = parseArgs({ options: {
  'session-archive': { type: 'string' }, report: { type: 'string' }, keep: { type: 'boolean' },
  'native-only': { type: 'boolean' }, 'sql-native-only': { type: 'boolean' },
} });
if (!values['session-archive']) throw Error('Usage: node scripts/test-first-app.mjs --session-archive /absolute/chronolog-peer-session-COMMIT.tgz [--native-only | --sql-native-only] [--report FILE] [--keep]');
if (values['native-only'] && values['sql-native-only']) throw Error('Choose --native-only for events or --sql-native-only for SQL.');
const sqlOnly = Boolean(values['sql-native-only']);
const sessionArchive = resolve(values['session-archive']);
const reportPath = resolve(values.report ?? join(root, `.results/${sqlOnly ? 'first-app-sql' : 'first-app'}.json`));
const directory = await mkdtemp(join(tmpdir(), 'tendriller-first-app-'));
const app = join(directory, 'application');
const SERVICE = 'https://service.localhost:8790';
const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));
const report = { status: 'running', qualification: sqlOnly ? 'isolated-local-sql-tutorial' : 'isolated-local-tutorial',
  native_checks: 'running', browser_checks: 'not-run',
  limits: ['Synthetic local owner session; no OAuth provider tested.',
    sqlOnly ? 'Native SQL only; no browser SQL, publication, cross-device transport, Internet or mobile qualification.'
      : 'Local Chromium and encrypted WebSocket relay; no Internet, native RTC or mobile qualification.',
    'Scripted tutorial execution; not an unassisted fresh-agent usability result.'], steps: [] };
let host, peer, browser, page, stage = 'preflight';

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

async function localCertificatePin() {
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host: '127.0.0.1', port: 8790,
      servername: 'service.localhost', rejectUnauthorized: false });
    const finish = (error, value) => {
      clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(Error('Local fixture certificate was unavailable')), 5_000);
    socket.once('error', error => finish(error));
    socket.once('secureConnect', () => {
      try {
        const certificate = new X509Certificate(socket.getPeerCertificate().raw);
        finish(null, createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'));
      } catch (error) { finish(error); }
    });
  });
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
  const buildDependencies = sqlOnly ? [] : [await packDependency('esbuild'),
    await packDependency(`@esbuild/${process.platform}-${process.arch}`)];
  await run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund',
    '--cache', join(directory, 'npm-cache'), archives.sdk, archives.tools, sessionArchive, ...buildDependencies]);
  const sessionProof = await jsonFile(join(app, 'node_modules/@chronolog/peer-session/provenance.json'));
  assert.equal(sessionProof.dirty, false, 'Use a clean, explicitly selected public Chronolog archive.');
  report.chronolog = { source: sessionProof.source, dirty: sessionProof.dirty, sha256: sha256(await readFile(sessionArchive)) };
  if (sqlOnly) {
    assert.ok(sessionProof.sqlEngines?.includes('native'), '--sql-native-only requires a public Chronolog archive built with --sql-native.');
    report.chronolog.native_engine = sessionProof.nativeEngine;
  }

  const preload = join(directory, 'local-network.mjs');
  await writeFile(preload, `import { Agent, setGlobalDispatcher, WebSocket } from ${JSON.stringify(pathToFileURL(require.resolve('undici')).href)};
${createLocalDispatcher.toString()}
const dispatcher = createLocalDispatcher();
setGlobalDispatcher(dispatcher);
globalThis.WebSocket = class extends WebSocket { constructor(url, protocols = []) { super(url, { protocols, dispatcher }); } };
`);
  const project = sqlOnly ? join(app, 'sql') : app;
  const node = async args => run(process.execPath, ['--import', preload, ...args], { cwd: project });
  const cli = join(app, 'node_modules/@tendriller/tools/bin/tendril.mjs');
  // These setup/reopen probes deliberately run without a resident owner.
  const cliJson = async args => JSON.parse(await node([cli, '--session', join(project, 'session.mjs'), '--mode', 'own', ...args]));
  passed('domain-served tutorial and independently installed public packages');
  if (sqlOnly) {
    checkpoint('load the exact native SQL engine');
    const engine = JSON.parse(await node(['engine.mjs']));
    assert.equal(engine.available, true); assert.match(engine.executionManifestDigest, /^[a-f0-9]{64}$/);
    report.sql_engine = engine;
    passed('explicit native SQL capability and execution manifest');
  }

  checkpoint('create, initialize and publish before owner claim');
  await node(['setup.mjs', 'create', SERVICE, 'owner@example.test', 'First-app qualification']);
  const handle = await jsonFile(join(project, '.tendriller/handle.json'));
  const localPage = new URL(handle.page_url); localPage.port = '8790';
  const beforeClaim = JSON.parse(await node(['setup.mjs', 'init']));
  assert.equal(beforeClaim.initialized, true);
  let preparedPublication;
  if (!sqlOnly) {
    await node(['build.mjs']);
    preparedPublication = await cliJson(['publish', join(app, 'page'), '--operation', 'first-app-publication-1']);
    assert.ok(preparedPublication.publication.id);
  }
  passed('native application initialized and first signed UI published before claim');
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
  if (!sqlOnly) assert.deepEqual((await cliJson(['query', 'notes', 'null'])).value, []);
  const device = await jsonFile(join(project, '.tendriller/initialized.json'));
  await node(['setup.mjs', 'init']);
  assert.deepEqual(await jsonFile(join(project, '.tendriller/initialized.json')), device, 'Initialization retry preserves identity.');
  report.application_id = handle.application.id; report.native_device_id = device.deviceId;
  passed('owner claim, exact initialization retry, selected genesis and native reopen');

  if (sqlOnly) {
    const empty = await cliJson(['query', 'inventory', 'null']);
    assert.deepEqual(empty.value.stock, []); assert.deepEqual(empty.value.transfers, []);
    checkpoint('exercise guarded SQL transactions and exact demo retry');
    const demo = JSON.parse(await node(['demo.mjs']));
    assert.equal(demo.status, 'passed'); assert.deepEqual(demo.stock, { source: 7, destination: 3 });
    assert.equal(demo.accepted, 'inventory-demo-transfer-v1'); assert.equal(demo.rejected, 'inventory-demo-rejected-v1');
    const saved = ['demo-transfer.json', 'demo-rejection.json', 'schema.json', 'descriptor.json', 'genesis-request.json'];
    const fingerprints = await Promise.all(saved.map(name => readFile(join(project, '.tendriller', name)).then(sha256)));
    const retry = JSON.parse(await node(['demo.mjs']));
    assert.deepEqual(retry, demo, 'SQL demo retry must use the retained original operation results.');
    for (let i = 0; i < saved.length; i++)
      assert.equal(sha256(await readFile(join(project, '.tendriller', saved[i]))), fingerprints[i], `SQL retry changed ${saved[i]}.`);
    const retained = await cliJson(['query', 'inventory', 'null']);
    assert.deepEqual(Object.fromEntries(retained.value.stock.map(row => [row.id, row.units])), { destination: 3, source: 7 });
    assert.equal(retained.value.transfers.length, 1, 'Exact retry must not create another transfer receipt.');
    assert.equal(retained.value.activity.filter(event => event.topic === 'inventory.transferred').length, 1);
    assert.equal((await cliJson(['operation', demo.accepted])).state.outcome, 'accepted');
    const rejected = (await cliJson(['operation', demo.rejected])).state;
    assert.equal(rejected.outcome, 'rejected'); assert.equal(rejected.rejectionCode, 'assert:insufficient_stock');
    assert.deepEqual(await jsonFile(join(project, '.tendriller/initialized.json')), device);
    report.sql_demo = demo;
    report.sql_retained = { stock: demo.stock, receipts: retained.value.transfers.length,
      transfer_events: retained.value.activity.filter(event => event.topic === 'inventory.transferred').length };
    passed('guarded SQL transfer accepted; rejected transfer leaves balances, receipts and effective events unchanged');
    passed('exact SQL demo retry and coherent queries/outcomes after separate-process reopen');
    report.status = 'partial'; report.native_checks = 'passed';
    report.limits.push('Browser and published UI behavior omitted by --sql-native-only.');
    console.log('First-app native SQL setup and transaction checks passed; browser SQL qualification remains untested.');
  } else {
  assert.equal((await cliJson(['command', 'addNote', JSON.stringify({ text: 'Native setup and durable reopen' }),
    '--operation', 'native-setup-1'])).outcome, 'accepted');
  const retained = await cliJson(['query', 'notes', 'null']);
  assert.equal(retained.value.length, 1); assert.equal(retained.value[0].operationId, 'native-setup-1');
  passed('real native command and coherent query after process reopen');

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
    // Context.ignoreHTTPSErrors does not cover subsequent SharedWorker fetches.
    // Trust only this loopback fixture certificate across Chromium targets;
    // never disable certificate verification globally or alter the public app.
    const certificatePin = await localCertificatePin();
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--host-resolver-rules=MAP *.localhost:443 127.0.0.1:8790, MAP *.localhost 127.0.0.1',
        `--ignore-certificate-errors-spki-list=${certificatePin}`] });
    report.browser = await browser.version();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.on('requestfailed', request => {
      report.browser_network_failures ??= [];
      if (report.browser_network_failures.length < 20) {
        const url = new URL(request.url());
        report.browser_network_failures.push({ endpoint: url.origin + url.pathname, error: request.failure()?.errorText });
      }
    });
    page = await context.newPage();
    page.on('pageerror', error => {
      report.browser_errors ??= [];
      if (report.browser_errors.length < 12) report.browser_errors.push(error.message);
    });
    report.screenshots = {};
    await page.goto(SERVICE); await page.screenshot({ path: join(dirname(reportPath), 'first-app-homepage-desktop.png'), fullPage: true });
    report.screenshots.homepage_desktop = 'first-app-homepage-desktop.png';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(dirname(reportPath), 'first-app-homepage-mobile.png'), fullPage: true });
    report.screenshots.homepage_narrow_viewport = 'first-app-homepage-mobile.png';
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
    // the agent side of the test; it adds no protocol, backend or fixture state.
    // Only the inference provider function is replaced, inside this private test
    // process. Signals, encrypted content and reviewed commands remain real.
    const evidencePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
    await writeFile(join(app, 'test-peer.mjs'), `import assert from 'node:assert/strict';
  import {createInterface} from 'node:readline';
  import {openSession} from './session.mjs';
  import {servePeerInference} from './media/inference-service.mjs';
  const {session,supervisor} = await openSession();
  const expectedEvidence = new Uint8Array(Buffer.from(${JSON.stringify(evidencePng.toString('base64'))}, 'base64'));
  let inferenceCalls = 0, inferenceSource = null;
  const inference = servePeerInference({session, allowedDevices: [${JSON.stringify(browserDevice)}], maxRequests: 2,
    async infer({bytes, mediaType, source, signal}) {
      signal.throwIfAborted(); assert.deepEqual(bytes, expectedEvidence); assert.equal(mediaType, 'image/png');
      inferenceCalls++; inferenceSource = source;
      return {text: 'Suggested fixture observation'};
    },
  });
  console.log(JSON.stringify({ready:true,deviceId:session.deviceId,ownerInstanceId:supervisor.ownerInstanceId}));
  for await (const line of createInterface({input:process.stdin})) {
    const request=JSON.parse(line);
    try {
      let result;
      if(request.action==='query') result=await session.query('notes',null);
      else if(request.action==='diagnostics') result={status:session.status,participation:session.participation.status};
      else if(request.action==='inference-status') result={...inference.snapshot(), calls:inferenceCalls, source:inferenceSource};
      else if(request.action==='command') {
        const before=await session.query('notes',null);
        const operation=await session.command('addNote',{text:request.text},{operationId:request.operationId,basedOn:before.revision});
        result=await operation.applied({signal:AbortSignal.timeout(30000)});
      } else if(request.action==='close') {await inference.close(); await session.close(); console.log(JSON.stringify({id:request.id,closed:true})); break;}
      else throw Error('Unknown test action');
      console.log(JSON.stringify({id:request.id,result}));
    } catch(error) {console.log(JSON.stringify({id:request.id,error:error.message}));}
  }
  await inference.close(); await session.close();
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
      const client = { child, async request(action, input = {}, timeoutMs = 40_000) {
        if (child.exitCode !== null || child.signalCode !== null) throw Error(`Native peer is closed: ${stderr}`);
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waiting.delete(id); reject(Error(`Native ${action} timed out: ${stderr}`)); }, timeoutMs);
          waiting.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, action, ...input }) + '\n');
        });
      } };
      peer = client;
      let timer;
      const metadata = await Promise.race([ready, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Error(`Native peer did not open: ${stderr}`)), 40_000);
      })]).finally(() => clearTimeout(timer));
      assert.equal(metadata.deviceId, device.deviceId);
      client.metadata = metadata;
      return client;
    }
    await startPeer();
    const attached = JSON.parse(await node([cli, '--session', join(project, 'session.mjs'), '--mode', 'attach', 'self']));
    assert.equal(attached.deviceId, device.deviceId);
    assert.equal(attached.endpoint.ownerInstanceId, peer.metadata.ownerInstanceId);
    const attachedNotes = JSON.parse(await node([cli, '--session', join(project, 'session.mjs'), '--mode', 'attach', 'query', 'notes', 'null']));
    assert.deepEqual(attachedNotes.value, (await peer.request('query')).value);
    passed('separate CLI processes attach to the resident native owner without another signer/store');
    checkpoint('connect browser and exchange retained commands');
    await page.locator('#connect').click();
    await expect(page.locator('#data-status')).toContainText('Data: ready; application: ready', { timeout: 60_000 });
    await page.locator('#note').fill('Created in the browser'); await page.locator('#submit').click();
    await expect(page.locator('#result')).toContainText('Applied: accepted', { timeout: 30_000 });
    await expect(page.locator('#operation-status')).toContainText('Applied: accepted', { timeout: 30_000 });
    await expect(page.locator('#operation-status')).toContainText('peer retention receipt(s) observed', { timeout: 30_000 });
    assert.deepEqual((await peer.request('query')).value.map(note => note.text),
      ['Native setup and durable reopen', 'Created in the browser']);
    passed('browser command observed by the real native session through relay');
    passed('public UI adapters expose actual operation outcome and separate retained coverage');

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
    await expect(page.locator('#operation-status')).toContainText('Applied: accepted', { timeout: 30_000 });
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

    checkpoint('analyze immutable evidence through the authorized native peer');
    // The reopened notes can be read from local storage before the new peer
    // link exists. Ephemeral signals have no reconnect outbox: wait for the
    // actual coordinator connection before this one deliberate request.
    await expect(page.locator('#connection')).toContainText('Connection: following', { timeout: 60_000 });
    const beforeMedia = (await peer.request('query')).value;
    assert.equal((await peer.request('inference-status')).calls, 0);
    await page.locator('#media-file').setInputFiles({ name: 'fixture-evidence.png', mimeType: 'image/png', buffer: evidencePng });
    await page.locator('#media-share').check();
    await page.locator('#media-analyze').click();
    await expect(page.locator('#media-suggestion')).toContainText('Suggested fixture observation', { timeout: 60_000 });
    assert.deepEqual((await peer.request('query')).value, beforeMedia, 'Analysis must not submit a domain note.');
    const inferred = await peer.request('inference-status');
    assert.equal(inferred.calls, 1); assert.equal(inferred.admitted, 1);
    assert.equal(inferred.source.sha256, sha256(evidencePng));
    passed('authenticated inference signals and encrypted immutable content without automatic domain submission');

    checkpoint('commit the explicitly edited observation and reopen it');
    await page.locator('#media-review').fill('Human-reviewed fixture observation');
    // Responsive layout evidence from desktop Chromium, not physical-device
    // qualification. The candidate, suggestion and explicit human edit are live.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: join(dirname(reportPath), 'first-app-starter-desktop.png'), fullPage: true });
    report.screenshots.starter_review_desktop = 'first-app-starter-desktop.png';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(dirname(reportPath), 'first-app-starter-mobile.png'), fullPage: true });
    report.screenshots.starter_review_narrow_viewport = 'first-app-starter-mobile.png';
    await page.setViewportSize({ width: 1280, height: 960 });
    // Programmatic/provider text can bypass the textarea's maxlength. Reject it
    // before saving a pending reference or dispatching the reviewed command.
    await page.locator('#media-review').evaluate(element => { element.value = 'x'.repeat(2001); });
    await page.locator('#media-commit').click();
    await expect(page.locator('#media-result')).toContainText('2,000');
    assert.deepEqual((await peer.request('query')).value, beforeMedia, 'Oversized reviewed text must not submit a note.');
    assert.equal((await peer.request('inference-status')).calls, 1);
    await page.locator('#media-review').fill('Human-reviewed fixture observation');
    await page.locator('#media-commit').click();
    await expect(page.locator('#media-result')).toContainText('Applied: accepted', { timeout: 30_000 });
    const reviewedNotes = (await peer.request('query')).value;
    assert.equal(reviewedNotes.length, 5);
    const evidenceNote = reviewedNotes.at(-1);
    assert.equal(evidenceNote.text, 'Human-reviewed fixture observation');
    assert.equal(evidenceNote.author, browserDevice);
    assert.equal(evidenceNote.source.candidateId, inferred.source.candidateId);
    assert.equal(evidenceNote.source.sha256, sha256(evidencePng));
    assert.equal(evidenceNote.source.reference.id, inferred.source.contentId);
    assert.equal(evidenceNote.source.reference.applicationId, handle.application.id);
    assert.equal(evidenceNote.source.reference.bytes, evidencePng.length);
    assert.equal(evidenceNote.source.reference.mediaType, 'image/png');
    await expect(page.locator('#notes li')).toHaveCount(5);
    await page.reload(); await page.locator('#connect').click();
    await expect(page.locator('#device-key')).toHaveValue(browserDevice, { timeout: 30_000 });
    await expect(page.locator('#notes li')).toHaveCount(5, { timeout: 60_000 });
    assert.deepEqual((await peer.request('query')).value.at(-1), evidenceNote);
    assert.equal((await peer.request('inference-status')).calls, 1, 'Reload must not launch another provider request.');
    report.media_inference = { provider: 'injected deterministic native test function', calls: inferred.calls,
      candidate_id: evidenceNote.source.candidateId, sha256: evidenceNote.source.sha256,
      content_id: evidenceNote.source.reference.id, operation_id: evidenceNote.operationId };
    report.limits.push('Inference provider output is injected in the private native test process; no live provider, credential validity or billing tested.');
    passed('human-edited evidence command retains exact source identity and survives browser reopen');
    report.status = 'passed'; report.browser_checks = 'passed'; report.note_count = 5;
    console.log('First-app native/browser integration passed. Synthetic local claim and relay limits are recorded in the report.');
  }
  }
} catch (error) {
  report.status = 'failed'; report.failed_stage = stage; report.error = error.message;
  if (report.native_checks === 'running') report.native_checks = 'failed';
  if (report.browser_checks === 'running') report.browser_checks = 'failed';
  if (page && !page.isClosed()) {
    report.browser_diagnostics = await page.evaluate(() => Object.fromEntries([
      'connection', 'data-status', 'result', 'media-status', 'media-result', 'media-suggestion', 'operation-status',
    ].map(id => [id, document.getElementById(id)?.textContent ?? null]))).catch(failure => ({ error: failure.message }));
    try {
      await page.screenshot({ path: join(dirname(reportPath), 'first-app-failure.png'), fullPage: true, timeout: 10_000 });
      report.screenshots ??= {}; report.screenshots.failure = 'first-app-failure.png';
    } catch { /* Preserve the original test failure if the page has crashed. */ }
  }
  if (peer) report.native_inference_diagnostics = await peer.request('inference-status', {}, 5_000).catch(failure => ({ error: failure.message }));
  if (peer) report.native_session_diagnostics = await peer.request('diagnostics', {}, 5_000).catch(failure => ({ error: failure.message }));
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
