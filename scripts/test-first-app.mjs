// Exercise the downloaded first-app source as an independent public-package consumer.
// The local host has synthetic account sessions; no OAuth provider or live service is used.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
import { TUTORIAL_FILES } from './onboarding.mjs';
import { nativeTestPeerSource, closeTestPeer, memoryAvailableGb, installSoakObserver, installStateSignalObservers } from './first-app-peer.mjs';
import { FIRST_APP_WEBSOCKET_PROXY_WORKER } from './first-app-websocket-host.mjs';
import { verifyFirstAppComposition } from './first-app-composition.mjs';
import { CONTRACT_VERSION } from '../contract/index.mjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { values } = parseArgs({ options: {
  'session-archive': { type: 'string' }, 'first-app-archive': { type: 'string' }, report: { type: 'string' }, keep: { type: 'boolean' },
  'native-only': { type: 'boolean' }, 'sql-native-only': { type: 'boolean' }, transport: {type:'string', default:'direct'},
  'network-lab-profile': { type: 'string' },
} });
if (!values['session-archive'] && !values['first-app-archive'])
  throw Error('Usage: node scripts/test-first-app.mjs --first-app-archive /absolute/tendriller-first-app-VERSION.tgz [--native-only] [--report FILE] [--keep]; or --session-archive FILE for an explicit source/SQL composition.');
if (values['session-archive'] && values['first-app-archive']) throw Error('Use the companion inside the first-app archive; do not override its composition.');
if (values['native-only'] && values['sql-native-only']) throw Error('Choose --native-only for events or --sql-native-only for SQL.');
if (values['first-app-archive'] && values['sql-native-only']) throw Error('The first-app release archive has the SQL-free events profile.');
if (!['direct','relay'].includes(values.transport)) throw Error('Choose --transport direct or relay for qualification.');
if (values['network-lab-profile'] && (process.env.TENDRILLER_NETWORK_LAB !== '1' || values.transport !== 'direct' || !values['first-app-archive']))
  throw Error('Network lab requires its isolated container, real RTC and an immutable first-app kit.');
const sqlOnly = Boolean(values['sql-native-only']);
let sessionArchive = values['session-archive'] ? resolve(values['session-archive']) : undefined;
const reportPath = resolve(values.report ?? join(root, `.results/${sqlOnly ? 'first-app-sql' : 'first-app'}.json`));
const directory = await mkdtemp(join(tmpdir(), 'tfa-'));
const app = join(directory, 'application');
const SERVICE = 'https://service.localhost:8790';
const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));
const report = { status: 'running', qualification: sqlOnly ? 'isolated-local-sql-tutorial' : 'isolated-local-tutorial',
  native_checks: 'running', browser_checks: 'not-run',
  limits: ['Synthetic local owner session; no OAuth provider tested.',
    sqlOnly ? 'Native SQL only; no browser SQL, publication, cross-device transport, Internet or mobile qualification.'
      : 'Local Chromium and real native/browser RTC, with forced-failure relay qualification; no Internet NAT or physical mobile qualification.',
    'Scripted tutorial execution; not an unassisted fresh-agent usability result.',
    'An ordinary test-host WebSocket forwarding boundary isolates workerd issue #8185; the packed host is unchanged. Direct production TCP closure is not qualified.'], steps: [] };
let host, peer, browser, labBrowser, page, stage = 'preflight';

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

let trackStorage = async () => {};
// OPFS inventory for failure diagnosis: top-level entries plus file count/bytes of each chronolog directory.
const opfsInventory = target => target.evaluate(async () => {
  const out = {};
  try {
    for await (const [name, handle] of (await navigator.storage.getDirectory()).entries()) {
      if (handle.kind !== 'directory') { out[name] = 'file'; continue; }
      let files = 0, bytes = 0, empty = 0, directories = 0;
      for await (const [, entry] of handle.entries()) {
        if (entry.kind === 'directory') { directories++; continue; }
        const size = (await entry.getFile()).size; files++; bytes += size; if (!size) empty++;
      }
      out[name] = { files, bytes, empty, directories };
    }
  } catch (error) { out.error = error.name; }
  return out;
}).catch(failure => ({ error: failure.message }));

async function run(command, args, options = {}) {
  const result = await execute(command, args, { cwd: app, timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024, ...options });
  return result.stdout;
}
async function transportCounters() {
  const response = await fetch(SERVICE + '/__first_app_transport', {cache:'no-store'});
  if (!response.ok) throw Error('TRANSPORT_MEASUREMENT_UNAVAILABLE');
  return response.json();
}
async function browserRtcEvidence() {
  return page.evaluate(async () => {
    const result = [];
    for (const peer of window.__firstAppRtcPeers ?? []) {
      const stats = await peer.getStats();
      for (const row of stats.values()) if (row.type === 'candidate-pair' && row.state === 'succeeded') {
        const local = stats.get(row.localCandidateId), remote = stats.get(row.remoteCandidateId);
        result.push({ local:local?.candidateType, remote:remote?.candidateType,
          bytesSent:row.bytesSent ?? 0, bytesReceived:row.bytesReceived ?? 0 });
      }
    }
    return result;
  });
}
function checkpoint(name) { stage = name; console.log(`First app: ${name}`); }
function passed(name) { report.steps.push(name); }
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
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
  const archives = Object.fromEntries(['sdk', 'tools', 'engine', 'runtime'].map(name =>
    [name, join(root, 'dist', `tendriller-${name}-${version}.tgz`)]));
  for (const artifact of [...proof.artifacts, ...toolsProof.artifacts]) {
    assert.equal(sha256(await readFile(join(root, 'dist', artifact.file))), artifact.sha256, `Archive changed: ${artifact.file}`);
  }
  report.core = { source: proof.source, dirty: proof.dirty, version,
    artifacts: Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, sha256(await readFile(path))]))) };
  let kit;
  if (values['first-app-archive']) {
    const archive = resolve(values['first-app-archive']);
    const release = await jsonFile(join(root, 'dist/manifest.json'));
    const record = release.artifacts.find(item => item.role === 'first-app' && item.file === release.first_app?.file);
    assert.ok(record, 'The release manifest must bind the first-app archive.');
    assert.equal(sha256(await readFile(archive)), record.sha256, 'The first-app archive must match the release manifest.');
    const composition = JSON.parse(await run('tar', ['-xOf', archive, 'composition.json']));
    await verifyFirstAppComposition({ release, composition, coreProof: proof, toolsProof, archives, version, contract: CONTRACT_VERSION });
    kit = { archive, release, composition, record };
    passed('complete exact-kit SDK/runtime/engine/tools identities before isolated host startup');
  }
  const engine = join(directory, 'engine'); await mkdir(engine);
  await run('tar', ['-xzf', archives.engine, '-C', engine]);
  const engineProof = await jsonFile(join(engine, 'package/provenance.json'));
  if (kit) {
    assert.equal(engineProof.dirty, false);
    assert.equal(engineProof.source, kit.composition.core.source, 'The packed host must have the exact composition source.');
    assert.equal(engineProof.sourceTree, kit.composition.core.sourceTree, 'The packed host must have the exact composition tree.');
  }
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
  // These credentials exist only in the isolated synthetic host. Exercise the
  // actual OAuth verifier, scope checks and MCP setup route without a provider.
  const oauthKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const oauthJwk = { ...await crypto.subtle.exportKey('jwk', oauthKey.privateKey), alg: 'ES256', kid: 'first-app-test' };
  const oauthConfiguration = { resource: SERVICE + '/mcp', clients: [{ id: 'first-app-test', name: 'First app test',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'], scopes: ['tendrils:create', 'tendrils:list'] }] };
  host = new Miniflare({ ...convertV4MiniflareOptions({
    host: '127.0.0.1', port: 8790, https: true, cf: false,
    workers: [
      { name: 'first-app-network', modules: true, script: FIRST_APP_WEBSOCKET_PROXY_WORKER,
        compatibilityDate: workerOptions.compatibilityDate, serviceBindings: { PACKED_HOST: 'first-app-packed-host' } },
      { ...workerOptions, name: 'first-app-packed-host',
        scriptPath: join(engine, 'package/worker.mjs'), modulesRoot: join(engine, 'package'), modules: true,
        bindings: { ...workerOptions.bindings, PUBLIC_BASE: SERVICE, PAGE_BASE_DOMAIN: 'pages.localhost',
          OAUTH_SIGNING_JWK: JSON.stringify(oauthJwk), OAUTH_CONFIG_JSON: JSON.stringify(oauthConfiguration),
          ...(kit ? { SERVICE_SOURCE_COMMIT: kit.composition.core.source, SERVICE_COMPOSITION_ID: kit.composition.id } : {}) } },
    ],
  }), resourcePersistencePath: join(directory, 'host-state'), resourceTmpPath: join(directory, 'host-tmp'),
  enableDevRegistry: false, logRequests: false });
  await host.ready;
  const accounts = await host.getD1Database('ACCOUNTS', 'first-app-packed-host');
  for (const migration of (await readdir(join(engine, 'package/migrations')))
    .filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort())
    for (const query of unstable_splitSqlQuery(await readFile(join(engine, 'package/migrations', migration), 'utf8')))
      await accounts.prepare(query).run();
  const now = Date.now(), ownerToken = 'tendriller-local-e2e-session';
  const oauthGrant = crypto.randomUUID(), oauthJti = crypto.randomUUID();
  const jwtPart = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = jwtPart({ alg: 'ES256', typ: 'JWT', kid: oauthJwk.kid }) + '.' + jwtPart({
    iss: SERVICE, aud: SERVICE + '/mcp', sub: 'e2e-owner', client_id: 'first-app-test', sid: oauthGrant,
    jti: oauthJti, scope: 'tendrils:create tendrils:list', exp: Math.floor((now + 86_400_000) / 1000) });
  const oauthToken = signingInput + '.' + Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
    oauthKey.privateKey, new TextEncoder().encode(signingInput))).toString('base64url');
  await accounts.batch([
    accounts.prepare("UPDATE service_state SET mode = 'open' WHERE id = 1"),
    accounts.prepare('INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)').bind('e2e-owner', now, 'owner@example.test'),
    accounts.prepare('INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('github', 'e2e-subject', 'e2e-owner', 'e2e-owner', 'owner@example.test', now),
    accounts.prepare('INSERT INTO identity_emails (provider, subject, email) VALUES (?, ?, ?)').bind('github', 'e2e-subject', 'owner@example.test'),
    accounts.prepare('INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(sha256(ownerToken), 'e2e-owner', now, now + 86_400_000),
    accounts.prepare('INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
      .bind(oauthGrant, 'e2e-owner', 'first-app-test', SERVICE + '/mcp', 'tendrils:create tendrils:list', now, now + 86_400_000),
    accounts.prepare('INSERT INTO integration_oauth_access(hash,grant_id,jti,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)')
      .bind(sha256(oauthToken), oauthGrant, oauthJti, 'tendrils:create tendrils:list', now, now + 86_400_000),
  ]);
  if (kit) {
    const readiness = await (await fetch(SERVICE + '/api/readiness')).json();
    assert.equal(readiness.serviceOrigin, SERVICE);
    assert.equal(readiness.build.sourceCommit, kit.composition.core.source);
    assert.equal(readiness.build.compositionId, kit.composition.id);
    assert.equal(readiness.creation.available, true);
    passed('actual isolated service readiness advertises the same source and composition');
  }
  passed('packed host with isolated storage');

  checkpoint('download first-app source and install exact public packages');
  const source = await fetch(`${SERVICE}/downloads/tendriller-first-app.tgz`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(source.status, 200, 'The domain must serve the first-app archive.');
  const sourceBytes = new Uint8Array(await source.arrayBuffer());
  report.tutorial_sha256 = sha256(sourceBytes);
  const sourceArchive = join(directory, 'first-app.tgz'); await writeFile(sourceArchive, sourceBytes);
  if (kit) {
    const { archive: firstAppArchive, composition, record } = kit;
    assert.equal(sha256(await readFile(firstAppArchive)), record.sha256, 'The first-app archive changed after preflight.');
    await run('tar', ['-xzf', firstAppArchive, '-C', app]);
    assert.deepEqual(await jsonFile(join(app, 'composition.json')), composition, 'Extracted first-app identity changed after preflight.');
    assert.equal(composition.components.find(item => item.role === 'starter')?.sha256, report.tutorial_sha256,
      'The isolated host must serve the starter bound by the release composition.');
    // Compare every extracted source file with the actual served archive, then
    // install the archives carried by the release kit, not checkout dependencies.
    for (const file of TUTORIAL_FILES) {
      const original = await execute('tar', ['-xOf', sourceArchive, file], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
      assert.equal(sha256(await readFile(join(app, file))), sha256(original.stdout), `First-app source changed: ${file}`);
    }
    for (const item of composition.components.filter(item => ['sdk', 'tools', 'session'].includes(item.role))) {
      const path = join(app, 'packages', item.file);
      assert.equal(sha256(await readFile(path)), item.sha256, `First-app package changed: ${item.role}`);
      if (item.role === 'session') sessionArchive = path;
      else {
        assert.equal(sha256(await readFile(archives[item.role])), item.sha256);
        archives[item.role] = path;
      }
    }
    assert.ok(sessionArchive, 'The first-app archive must carry its pinned session package.');
    report.composition = { id: composition.id, first_app_sha256: record.sha256 };
  } else await run('tar', ['-xzf', sourceArchive, '-C', app]);
  const buildDependencies = sqlOnly ? [] : [await packDependency('esbuild'),
    await packDependency(`@esbuild/${process.platform}-${process.arch}`)];
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
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
const sockets = new Set();
globalThis.WebSocket = class extends WebSocket {
  constructor(url, protocols = []) {
    super(url, { protocols, dispatcher }); sockets.add(this);
    this.addEventListener('close', () => sockets.delete(this), {once:true});
  }
};
export async function closeLocalTransport() {
  // Never turn a leaked OPEN application socket into a successful owner close.
  if ([...sockets].some(socket => socket.readyState < 2)) throw Error('Native owner left an open fixture WebSocket');
  await Promise.all([...sockets].map(socket => new Promise((resolve, reject) => {
    const close = () => { clearTimeout(timer); socket.removeEventListener('close', close); resolve(); };
    const timer = setTimeout(() => {
      socket.removeEventListener('close', close);
      const url = new URL(socket.url), lane = url.searchParams.get('lane');
      reject(Error('Native WebSocket close handshake did not finish: ' + url.pathname +
        (['reliable','live'].includes(lane) ? ' lane=' + lane : '') + ' readyState=' + socket.readyState));
    }, 3000);
    socket.addEventListener('close', close, {once:true}); if (socket.readyState === 3) close();
  })));
  // This pool belongs to the loopback/TLS fixture, not to the public bootstrap.
  // Graceful close drains outstanding requests; it does not destroy live work.
  await dispatcher.close();
}
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
  if (sqlOnly) await node(['setup.mjs', 'create', SERVICE, 'owner@example.test', 'First-app qualification']);
  else {
    const preparation = JSON.parse(await node(['account-setup.mjs', 'prepare', SERVICE, 'First-app qualification']));
    const privateIntent = await jsonFile(join(project, '.tendriller/account-setup.json'));
    assert.equal(JSON.stringify(preparation).includes(privateIntent.credential), false);
    const mcp = async (name, args) => {
      const response = await fetch(SERVICE + '/mcp', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: 'Bearer ' + oauthToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      assert.equal(response.status, 200);
      const reply = await response.json();
      assert.ok(reply.result && reply.result.isError !== true, 'The actual linked-account setup tool must succeed.');
      return reply.result.structuredContent;
    };
    // Deliberately ignore the first ready reply: inspect restores the same page
    // using only the previously retained operation and local credential.
    const first = await mcp(preparation.prepare.tool, preparation.prepare.arguments);
    const recovered = await mcp(preparation.inspect.tool, preparation.inspect.arguments);
    assert.equal(recovered.pageId, first.pageId); assert.equal(recovered.state, 'ready');
    assert.equal(JSON.stringify(recovered).includes(privateIntent.credential), false);
    const receiptPath = join(project, '.tendriller/account-setup-result.json');
    await writeFile(receiptPath, JSON.stringify(recovered), { mode: 0o600, flag: 'wx', flush: true });
    await node(['account-setup.mjs', 'finish', receiptPath]);
    assert.equal((await jsonFile(join(project, '.tendriller/handle.json'))).token, privateIntent.credential);
    await node(['account-setup.mjs', 'finish', receiptPath]);
    assert.equal((await accounts.prepare('SELECT COUNT(*) AS n FROM account_setups WHERE account_id=?').bind('e2e-owner').first()).n, 1);
    passed('account-linked MCP setup with private preflight intent and exact lost-reply recovery');
  }
  const handle = await jsonFile(join(project, '.tendriller/handle.json'));
  const localPage = new URL(handle.page_url); localPage.port = '8790';
  const beforeClaim = JSON.parse(await node(['setup.mjs', 'init']));
  assert.equal(beforeClaim.initialized, true);
  let preparedPublication;
  if (!sqlOnly) {
    await node(['build.mjs']);
    const preparedSizes = await Promise.all((await files(join(app, 'page'))).map(async path => (await readFile(path)).byteLength));
    report.preclaim_code = { totalBytes: preparedSizes.reduce((sum, n) => sum + n, 0), largestFileBytes: Math.max(...preparedSizes) };
    preparedPublication = await cliJson(['publish', join(app, 'page'), '--operation', 'first-app-publication-1']);
    assert.ok(preparedPublication.publication.id);
    assert.deepEqual(await cliJson(['publication-operation', 'first-app-publication-1']),
      { publication: preparedPublication.publication, receipt: preparedPublication },
      'A separate native process must reopen the original signed intent and retained receipt.');
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
  assert.deepEqual(publication, preparedPublication, 'Owner claim and rebuild must preserve the pre-claim publication identity.');
  assert.deepEqual(await cliJson(['publication-operation', 'first-app-publication-1']),
    { publication: publication.publication, receipt: publication }, 'Exact retry and another process reopen preserve the acknowledged receipt.');
  report.publication_id = publication.publication.id;
  passed('retained publication receipt inspected after native process reopen and exact retry');
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
    const browserOptions = { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--host-resolver-rules=MAP *.localhost:443 127.0.0.1:8790, MAP *.localhost 127.0.0.1',
        `--ignore-certificate-errors-spki-list=${certificatePin}`] };
    if (values['network-lab-profile']) {
      const { launchNetworkBrowser } = await import('../test/e2e/network-qualification/browser-launch.mjs');
      labBrowser = await launchNetworkBrowser(browserOptions); browser = labBrowser.browser;
    } else browser = await chromium.launch(browserOptions);
    report.browser = await browser.version();
    const context = labBrowser?.context ?? await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    report.connectionErrors = [];
    await context.exposeBinding('__firstAppConnection',(_source,value)=>{if(report.connectionErrors.length<50&&/^(?:APPLICATION_|PEER_|DEVICE_|OWNER_|ENDPOINT_)[A-Z_]{1,90}$/.test(value))report.connectionErrors.push(value);});
    report.rtcLifecycle = [];
    report.rtcBridge = [];
    await context.exposeBinding('__firstAppRtcBridge', (_source,value) => { if(report.rtcBridge.length<200) report.rtcBridge.push(value); });
    await context.exposeBinding('__firstAppRtcLifecycle', (_source, value) => {
      if (report.rtcLifecycle.length < 200 && value && ['created','state'].includes(value.type))
        report.rtcLifecycle.push({ type:value.type, connection:value.connection, ice:value.ice, gathering:value.gathering });
    });
    await context.addInitScript(({mode}) => {
      const callers = () => String(new Error().stack).split('\n').slice(2,10).map(line=>/^\s*at ([A-Za-z0-9_.$<> ]+) \(/.exec(line)?.[1]).filter(Boolean);
      addEventListener('DOMContentLoaded',()=>{let last;new MutationObserver(()=>{const value=document.querySelector('#connection-card code')?.textContent;if(value&&value!==last){last=value;const code=/\b(?:APPLICATION_|PEER_|DEVICE_|OWNER_|ENDPOINT_)[A-Z_]{1,90}\b/.exec(value.slice(0,400))?.[0];if(code)void window.__firstAppConnection(code).catch(()=>{});}}).observe(document.documentElement,{subtree:true,childList:true,characterData:true});},{once:true});
      const abort = AbortController.prototype.abort;
      AbortController.prototype.abort = function(reason){
        if(reason?.message==='RTC_PROVIDER_LOST')void window.__firstAppRtcBridge({action:'provider-closed',callers:callers()}).catch(()=>{});
        return abort.call(this,reason);
      };
      const observe = (data,direction) => {
        const value = data?.protocol === 'tendriller/browser-rtc-provider/v1' ? data.payload : data;
        if(value?.type!=='chronolog/peer-session/rtc-endpoint/v1'||!['open','ready','send','description','sent','close-signaling','signaling-closed','ended','close'].includes(value.action)) return;
        const error = typeof value.error==='string'&&/^(?:WEBRTC_|APPLICATION_|RTC_)[A-Z_]{1,100}$/.test(value.error) ? value.error : undefined;
        void window.__firstAppRtcBridge({direction,action:value.action,...(error?{error}:{})}).catch(()=>{});
      };
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function(value,...rest){ observe(value,'page');return post.call(this,value,...rest); };
      if(globalThis.SharedWorker){const Original=globalThis.SharedWorker;globalThis.SharedWorker=class extends Original{constructor(...args){super(...args);this.port.addEventListener('message',event=>observe(event.data,'worker'));}};}
      if(globalThis.Worker){const Original=globalThis.Worker;globalThis.Worker=class extends Original{constructor(...args){super(...args);this.addEventListener('message',event=>observe(event.data,'worker'));}postMessage(value,...rest){observe(value,'page');return super.postMessage(value,...rest);}};}
      const Native = globalThis.RTCPeerConnection;
      window.__firstAppRtcPeers = [];
      globalThis.RTCPeerConnection = class extends Native {
        constructor(...args) {
          if (mode === 'relay') throw new Error('QUALIFICATION_RTC_UNAVAILABLE');
          super(...args); window.__firstAppRtcPeers.push(this);
          const report = type => { void window.__firstAppRtcLifecycle({type,connection:this.connectionState,ice:this.iceConnectionState,gathering:this.iceGatheringState}).catch(()=>{}); };
          report('created');
          for (const type of ['connectionstatechange','iceconnectionstatechange','icegatheringstatechange']) this.addEventListener(type,()=>report('state'));
        }
      };
    }, {mode:values.transport});
    report.expected_transport = values.transport;
    // FIRST_APP_NO_SHARED_WORKER=1 runs the whole flow on the fallback owner, as on browsers without SharedWorker.
    if (process.env.FIRST_APP_NO_SHARED_WORKER === '1') { await context.addInitScript(() => { delete globalThis.SharedWorker; }); report.owner_route = 'elected'; }
    context.on('requestfailed', request => {
      report.browser_network_failures ??= [];
      if (report.browser_network_failures.length < 20) {
        const url = new URL(request.url());
        report.browser_network_failures.push({ endpoint: url.origin + url.pathname, error: request.failure()?.errorText });
      }
    });
    page = await context.newPage();
    // Chromium's own record of storage buckets being created, updated or deleted (eviction evidence).
    report.storage_bucket_events = [];
    const storageEvents = await context.newCDPSession(page);
    for (const name of ['Storage.storageBucketCreatedOrUpdated', 'Storage.storageBucketDeleted'])
      storageEvents.on(name, event => { if (report.storage_bucket_events.length < 200) report.storage_bucket_events.push({ at: new Date().toISOString(), event: name.slice(8), detail: JSON.stringify(event).slice(0, 300) }); });
    trackStorage = origin => storageEvents.send('Storage.setStorageBucketTracking', { storageKey: new URL(origin).origin + '/', enable: true }).catch(error => { report.storage_tracking_error = error.message; });
    page.on('pageerror', error => {
      report.browser_errors ??= [];
      if (report.browser_errors.length < 12) report.browser_errors.push(error.message);
    });
    // Bounded browser console tail for failure diagnosis (errors and warnings only).
    page.on('console', message => {
      if (!['error', 'warning'].includes(message.type())) return;
      report.browser_console ??= [];
      report.browser_console.push(`${message.type()}: ${message.text()}`.slice(0, 400));
      if (report.browser_console.length > 40) report.browser_console.shift();
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
    checkpoint('open the page: a new browser sets itself up without a button');
    await page.setViewportSize({ width: 390, height: 844 });
    await trackStorage(handle.page_url);
    await page.goto(handle.page_url);
    await expect(page.locator('#connection-card')).toBeVisible();
    await expect(page.locator('#connection-card button:visible')).toHaveCount(0);
    await expect(page.locator('#app-content')).toBeHidden();
    await expect(page.locator('#device-key')).toHaveValue(/^[a-f0-9]{64}$/, { timeout: 30_000 });
    const browserDevice = await page.locator('#device-key').inputValue();
    const retainedPairing = () => page.evaluate(id => JSON.parse(localStorage.getItem(`tendriller-browser-${id}:pairing-v1`)), handle.application.id);
    await expect.poll(async () => (await retainedPairing())?.pairingId, { timeout: 30_000 }).toMatch(/^[a-f0-9]{64}$/);
    const firstRequest = await retainedPairing();
    await expect(page.locator('#connection')).toContainText('Setting up this browser');
    await page.screenshot({ path: join(dirname(reportPath), 'first-app-connect-mobile.png'), fullPage: true });
    report.screenshots.connect_narrow_viewport = 'first-app-connect-mobile.png';
    await page.reload();
    await expect(page.locator('#device-key')).toHaveValue(browserDevice, { timeout: 30_000 });
    assert.deepEqual((await retainedPairing()).pairingId, firstRequest.pairingId, 'Reload must retain the original pairing request.');
    report.browser_device_id = browserDevice;

    // Drive the same real native bootstrap without a second store owner. This is
    // the agent side of the test; it adds no protocol, backend or fixture state.
    // Only the inference provider function is replaced, inside this private test
    // process. Signals, encrypted content and reviewed commands remain real.
    const evidencePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
    await writeFile(join(app, 'test-peer.mjs'), nativeTestPeerSource({
      evidenceBase64: evidencePng.toString('base64'), browserDeviceId: browserDevice, transportModule: pathToFileURL(preload).href,
      networkQualification: Boolean(values['network-lab-profile']),
    }));
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
      child.once('close', code => {
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
    checkpoint('retain the exact reviewed prefix across native restart');
    await expect.poll(async () => (await peer.request('ordering-pause')).pause,
      { timeout: 30_000, message: 'The native participant must durably pause ordering before owner review.' }).not.toBeNull();
    const paused = (await peer.request('ordering-pause')).pause;
    assert.match(paused.operationId, /^pairing:/);
    assert.ok(paused.base);
    await closeTestPeer(peer); peer = undefined;
    await startPeer();
    assert.deepEqual((await peer.request('ordering-pause')).pause, paused,
      'Closing and reopening the native owner must preserve the exact review prefix.');
    const prepared = await peer.request('pairing-process');
    assert.equal(prepared.find(item => item.publicKey === browserDevice)?.state, 'pending',
      'The original signed proposal must be prepared and awaiting owner review.');
    // A pending proof alone cannot authorize enrollment. The actual native
    // participant prepares and retains the full signed control change first.
    // Once it has, the page opens the service-origin approval by itself.
    await page.waitForURL(url => url.pathname.startsWith('/pairings/'), { timeout: 30_000 });
    const reviewUrl = new URL(page.url());
    assert.equal(reviewUrl.origin, SERVICE);
    assert.equal(new URL(reviewUrl.searchParams.get('return_to')).origin, new URL(handle.page_url).origin);
    const reviewResponse = await page.reload();
    assert.match(reviewResponse.headers()['content-security-policy'], /frame-ancestors 'none'/);
    await expect(page.getByRole('heading', { name: /Add this browser to/ })).toBeVisible();
    await page.locator('#pairing-details > summary').click();
    await expect(page.getByText(browserDevice.match(/.{1,8}/g).join(' '), { exact: true })).toBeVisible();
    await expect(page.locator('#pairing-proposal')).toContainText(paused.base.point.generation);
    await page.locator('#pairing-details > summary').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      'The approval must fit a phone without horizontal overflow.');
    await page.screenshot({ path: join(dirname(reportPath), 'first-app-pairing-review-mobile.png'), fullPage: true });
    report.screenshots.pairing_review_narrow_viewport = 'first-app-pairing-review-mobile.png';
    await expect(page.getByRole('button', { name: 'Approve this device', exact: true })).toBeEnabled({ timeout: 30_000 });
    await page.locator('#pairing-approve').focus();
    await expect(page.locator('#pairing-approve')).toBeFocused();
    // The one confirmation tap. The service returns to the page, which finishes and connects.
    await page.keyboard.press('Enter');
    await page.waitForURL(url => url.origin === new URL(handle.page_url).origin, { timeout: 30_000 });
    await expect(page.locator('#app-content')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#connection-card')).toBeHidden();
    await expect.poll(async () => (await peer.request('ordering-pause')).pause,
      { timeout: 30_000, message: 'Only verified committed authority may release the retained pause.' }).toBeNull();
    await page.screenshot({ path: join(dirname(reportPath), 'first-app-connected-after-approval-mobile.png'), fullPage: true });
    report.screenshots.connected_after_approval_narrow_viewport = 'first-app-connected-after-approval-mobile.png';
    await page.setViewportSize({ width: 1280, height: 960 });
    report.pairing = { reviewed_prefix: paused.base, recovered_native_pause: true, committed: true };
    passed('retained browser proof, full owner review, durable native pause across restart and exact signed enrollment');
    const attached = JSON.parse(await node([cli, '--session', join(project, 'session.mjs'), '--mode', 'attach', 'self']));
    assert.equal(attached.deviceId, device.deviceId);
    assert.equal(attached.endpoint.ownerInstanceId, peer.metadata.ownerInstanceId);
    const attachedNotes = JSON.parse(await node([cli, '--session', join(project, 'session.mjs'), '--mode', 'attach', 'query', 'notes', 'null']));
    assert.deepEqual(attachedNotes.value, (await peer.request('query')).value);
    passed('separate CLI processes attach to the resident native owner without another signer/store');
    checkpoint('exchange retained commands from the automatically connected browser');
    report.opfs_snapshots = { connected: await opfsInventory(page) };
    await expect(page.locator('#data-status')).toContainText('Data: ready; application: ready', { timeout: 60_000 });
    const transportBefore = await transportCounters();
    await page.locator('#note').fill('Created in the browser'); await page.locator('#submit').click();
    await expect(page.locator('#result')).toContainText('Applied: accepted', { timeout: 30_000 });
    await expect(page.locator('#operation-status')).toContainText('Applied: accepted', { timeout: 30_000 });
    await expect(page.locator('#operation-status')).toContainText('peer retention receipt(s) observed', { timeout: 30_000 });
    assert.deepEqual((await peer.request('query')).value.map(note => note.text),
      ['Native setup and durable reopen', 'Created in the browser']);
    const transportAfter = await transportCounters();
    assert.equal(transportAfter.instance, transportBefore.instance, 'Network counter restart invalidates measurement');
    const rtc = await browserRtcEvidence();
    report.transport = { expected:values.transport, before:transportBefore, after:transportAfter, rtc };
    if (values.transport === 'direct') {
      assert.equal(transportAfter.relayUpgrades, 0, 'The shipping default must establish RTC without a hosted relay');
      assert.equal(transportAfter.relayBinaryBytes - transportBefore.relayBinaryBytes, 0, 'Direct application work used host relay bytes');
      assert.ok(rtc.some(route => route.local !== 'relay' && route.remote !== 'relay' && route.bytesSent > 0 && route.bytesReceived > 0), 'Real RTC application traffic and a non-TURN route are required');
    } else {
      assert.ok(transportAfter.relayUpgrades > 0, 'A failed RTC capability must open the maintained fallback');
      assert.ok(transportAfter.relayBinaryBytes > transportBefore.relayBinaryBytes, 'Fallback must carry the verified application command');
    }
    passed('browser command observed by the real native session, with independently measured ' + values.transport + ' transport');
    passed('public UI adapters expose actual operation outcome and separate retained coverage');

    report.opfs_snapshots.after_commands = await opfsInventory(page);
    checkpoint('a second tab attaches to the same device owner without any prompt');
    const second = await context.newPage();
    second.on('pageerror', error => { report.browser_errors ??= []; if (report.browser_errors.length < 12) report.browser_errors.push(`second tab: ${error.message}`); });
    await second.goto(handle.page_url);
    await expect(second.locator('#app-content')).toBeVisible({ timeout: 60_000 });
    await expect(second.locator('#device-key')).toHaveValue(browserDevice);
    await expect(second.locator('#connection-card button:visible')).toHaveCount(0);
    await second.locator('#note').fill('Created in a second tab'); await second.locator('#submit').click();
    await expect(second.locator('#result')).toContainText('Applied: accepted', { timeout: 30_000 });
    await expect(page.locator('#notes')).toContainText('Created in a second tab', { timeout: 30_000 });
    await second.reload();
    await expect(second.locator('#app-content')).toBeVisible({ timeout: 60_000 });
    if (values.transport === 'direct') {
      // Lose the page actually hosting RTC, while a sibling keeps the same
      // application open. A fresh native request must work over a new direct
      // connection, not merely display an old materialized read.
      const beforeHandoff = await transportCounters();
      await page.close(); page = second;
      await expect(async () => {
        const value = await page.evaluate(() => window.appRequests.request('rows', {count:1,width:1}, {timeoutMs:5000}));
        assert.equal(value.rows[0].label, 'row "0"');
      }).toPass({timeout:60_000,intervals:[100,1000]});
      const afterHandoff = await transportCounters();
      assert.equal(afterHandoff.instance, beforeHandoff.instance);
      assert.equal(afterHandoff.relayBinaryBytes, beforeHandoff.relayBinaryBytes, 'Provider handoff must reconnect P2P when another provider exists');
      const rtc = await browserRtcEvidence();
      assert.ok(rtc.some(route=>route.local!=='relay'&&route.remote!=='relay'&&route.bytesSent>0&&route.bytesReceived>0));
      report.providerHandoff = {nativeRead:true,relayByteDelta:0,rtc};
      passed('closing the RTC-serving page reconnects through the remaining view without hosted payloads');
    } else await second.close();
    await expect(page.locator('#notes')).toContainText('Created in a second tab');
    report.opfs_snapshots.after_second_tab = await opfsInventory(page);
    passed('a second tab and its reload attach to the existing owner; no OWNER_BUSY or pairing UI');

    checkpoint('multi-piece replies and a quiet connection over the selected transport');
    const bulkBefore = await transportCounters();
    const soakMs = Number(process.env.FIRST_APP_SOAK_MS ?? 60_000), frozenMs = Number(process.env.FIRST_APP_FROZEN_MS ?? 30_000);
    // Browser application status transitions, kept in sessionStorage so they survive reloads.
    const recordStatus = () => page.evaluate(async () => {
      const app = await window.tendril.application.ready();
      app.onStatus(status => {
        const log = JSON.parse(sessionStorage.getItem('first-app-status-log') || '[]'), last = log.at(-1);
        if (last && last.phase === status.phase && last.generation === status.generation && last.database === status.database) return;
        log.push({ at: Date.now(), phase: status.phase, generation: status.generation, database: status.database });
        sessionStorage.setItem('first-app-status-log', JSON.stringify(log.slice(-200)));
      });
    }).catch(() => {});
    await recordStatus();
    await page.evaluate(installSoakObserver);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await peer.request('participation-log');
    const burst = async (pieces, bytes = 15_000) => {
      const before = await page.evaluate(() => window.soak.complete ?? 0);
      const sent = await peer.request('signal-burst', { topic: 'soak', pieces, bytes }, 60_000);
      if (sent.failures.length) report.failed_burst = { ...sent, at: new Date().toISOString() };
      report.slowest_burst = !report.slowest_burst || sent.ms > report.slowest_burst.ms ? { ms: sent.ms, pieceMs: sent.pieceMs, eventLoopLagMaxMs: sent.eventLoopLagMaxMs } : report.slowest_burst;
      if (sent.retries) (report.burst_retries ??= []).push({ at: new Date().toISOString(), retries: sent.retries, pieceMs: sent.pieceMs, eventLoopLagMaxMs: sent.eventLoopLagMaxMs });
      assert.deepEqual(sent.failures, [], `Every piece of a ${pieces}-piece reply must be accepted (${JSON.stringify(sent.failures.slice(0, 3))}).`);
      await expect.poll(() => page.evaluate(() => {
        if (window.soak.error) throw Error(window.soak.error);
        return window.soak.complete;
      }), { timeout: 30_000 }).toBe(before + 1);
      return sent.ms;
    };
    report.multi_piece_reply = { pieces: 40, bytes: 40 * 15_000, ms: await burst(40) };
    passed('a 600 KB reply in 40 signal pieces reaches the browser without SIGNAL_BACKPRESSURE');
    const churn = entries => entries.filter(entry => !entry.peers.includes(browserDevice)).length;
    const soakStarted = Date.now();
    report.opfs_timeline = [];
    let lastInventory = 0;
    while (Date.now() - soakStarted < soakMs) {
      if (Date.now() - lastInventory >= 60_000) {
        lastInventory = Date.now();
        // Host memory beside each sample: browser storage eviction depends on it.
        const memAvailableGb = memoryAvailableGb();
        report.opfs_timeline.push({ atS: Math.round((Date.now() - soakStarted) / 1000), memAvailableGb,
          ...(process.env.FIRST_APP_OPFS_TIMELINE === '1' ? { opfs: await opfsInventory(page) } : {}) });
      }
      await burst(5); // like a dashboard answer every ten seconds
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    const soakLog = await peer.request('participation-log');
    report.soak = { ms: Date.now() - soakStarted, statusChanges: soakLog.entries.length, browserAbsent: churn(soakLog.entries), current: soakLog.current };
    assert.equal(churn(soakLog.entries), 0, `The idle browser connection must not churn: ${JSON.stringify(soakLog.entries.slice(0, 8))}`);
    assert.ok(soakLog.current.peers.includes(browserDevice));
    passed(`a ${Math.round(soakMs / 1000)} s soak with periodic multi-piece replies keeps one browser connection`);

    checkpoint('a backgrounded phone tab resumes');
    await page.setViewportSize({ width: 390, height: 844 });
    if (values['network-lab-profile']) {
      // With real visibility, raw CDP frozen/active can leave an already-selected
      // tab hidden. Use the observed background/freeze/resume/foreground cycle.
      const { createBrowserNetworkControls } = await import('../test/e2e/network-qualification/browser-controls.mjs');
      const lifecycle = await createBrowserNetworkControls(page);
      const signal = AbortSignal.timeout(frozenMs + 15_000);
      try {
        await lifecycle.setFrozen(true, { signal });
        await new Promise(resolve => setTimeout(resolve, frozenMs));
        await lifecycle.setFrozen(false, { signal });
      } finally { await lifecycle.cleanup(); }
    } else {
      const lifecycle = await context.newCDPSession(page);
      await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' });
      await new Promise(resolve => setTimeout(resolve, frozenMs));
      await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
      await lifecycle.detach();
    }
    const resumedAt = Date.now();
    await burst(5);
    const resumeLog = await peer.request('participation-log');
    report.background_resume = { frozenMs, firstReplyAfterMs: Date.now() - resumedAt, browserAbsent: churn(resumeLog.entries), statusChanges: resumeLog.entries.length };
    await expect(page.locator('#app-content')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 960 });
    const bulkAfter = await transportCounters();
    assert.equal(bulkAfter.instance, bulkBefore.instance);
    report.bulkTransport = { relayByteDelta:bulkAfter.relayBinaryBytes-bulkBefore.relayBinaryBytes, before:bulkBefore, after:bulkAfter };
    if (values.transport === 'direct') assert.equal(report.bulkTransport.relayByteDelta,0,'Bulk replies, soak and background resume must retain direct delivery');
    else assert.ok(report.bulkTransport.relayByteDelta>600_000,'Forced fallback must carry the measured bulk traffic');
    passed('a frozen (backgrounded) tab receives live replies again after resuming, without reload or prompts');

    checkpoint('a request sent right after connecting is answered, and periodic updates arrive in every subscription mode');
    report.opfs_before_reload = await opfsInventory(page);
    await page.reload();
    await expect(page.locator('#app-content')).toBeVisible({ timeout: 60_000 });
    const requested = Date.now();
    const answer = await page.evaluate(() => window.appRequests.request('rows', { count: 300, width: 900 }).then(value => ({ rows: value.rows.length, last: value.rows.at(-1).label })));
    assert.deepEqual(answer, { rows: 300, last: 'row "299"' });
    report.first_request_after_connect = { ms: Date.now() - requested, bytes: 300 * 900 };
    await page.evaluate(installStateSignalObservers);
    await new Promise(resolve => setTimeout(resolve, 500));
    await peer.request('signal-state', { count: 5, intervalMs: 500 });
    await expect.poll(() => page.evaluate(() => window.stateModes.all), { timeout: 10_000 }).toBe(5);
    report.periodic_updates = await page.evaluate(() => window.stateModes);
    assert.deepEqual(await page.evaluate(() => window.stateModeErrors), []);
    assert.ok(report.periodic_updates.latest >= 1, `A 'latest' subscription must observe periodic updates: ${JSON.stringify(report.periodic_updates)}`);
    passed('the first request after connect is answered (300 rows, ~270 KB) and periodic updates reach all and latest subscribers');


    checkpoint('cancel an applied waiter, reload and retry its original operation');
    // The network lab deliberately disables focus emulation for real lifecycle
    // tests. Interactive foreground actions must actually foreground this tab;
    // a hidden page can have no animation frames for Playwright's stability check.
    if (values['network-lab-profile']) await page.bringToFront();
    if (values['network-lab-profile']) {
      report.before_uncertain_click = await page.evaluate(() => new Promise(resolve => {
        let finished = false;
        const finish = raf => { if (finished) return; finished = true; clearTimeout(timer);
          resolve({ raf, visibility: document.visibilityState, hasFocus: document.hasFocus(),
            submitDisabled: document.querySelector('#submit')?.disabled,
            width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height }); };
        const timer = setTimeout(() => finish(false), 1000);
        requestAnimationFrame(() => finish(true));
      }));
      assert.equal(report.before_uncertain_click.visibility, 'visible', 'Foreground lab tab remained hidden');
      assert.equal(report.before_uncertain_click.raf, true, 'Foreground lab tab has no animation frames');
    }
    await page.evaluate(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = milliseconds => milliseconds === 15_000
        ? AbortSignal.abort(Error('TEST_APPLIED_WAITER_CANCELLED')) : timeout(milliseconds);
    });
    await page.locator('#note').fill('Preserve this uncertain operation'); await page.locator('#submit').click();
    await expect(page.locator('#result')).toContainText('TEST_APPLIED_WAITER_CANCELLED', { timeout: 30_000 });
    const operation = await page.locator('#operation-id').inputValue();
    await expect(page.locator('#submit')).toBeDisabled();
    await page.reload();
    await expect(page.locator('#device-key')).toHaveValue(browserDevice, { timeout: 30_000 });
    await expect(page.locator('#data-status')).toContainText('Data: ready; application: ready', { timeout: 60_000 });
    await expect(page.locator('#operation-id')).toHaveValue(operation);
    // Normal operation observation may already resolve the retained attempt on
    // reconnect. Retry is offered only while that exact attempt is uncertain.
    await expect.poll(async () => await page.locator('#retry').isEnabled() || await page.locator('#submit').isEnabled(),
      { timeout: 30_000 }).toBe(true);
    if (await page.locator('#retry').isEnabled()) await page.locator('#retry').click();
    await expect(page.locator('#submit')).toBeEnabled({ timeout: 30_000 });
    await expect(page.locator('#operation-status')).toContainText('Applied: accepted', { timeout: 30_000 });
    const afterRetry = (await peer.request('query')).value;
    assert.equal(afterRetry.filter(note => note.operationId === operation).length, 1);
    assert.equal(afterRetry.length, 4);
    report.retried_operation_id = operation;
    passed('cancelled waiter, pending identity across reload and exact retry without duplication');

    const applied = await peer.request('command', { text: 'Created by the native agent', operationId: 'native-note-1' });
    assert.equal(applied.outcome, 'accepted');
    await expect(page.locator('#notes')).toContainText('Created by the native agent', { timeout: 30_000 });
    await expect(page.locator('#notes li')).toHaveCount(5);
    passed('native command observed by the browser without state injection');

    checkpoint('close and reopen both original devices');
    await page.locator('#close').click();
    await expect(page.locator('#connection')).toContainText('Connection closed');
    await closeTestPeer(peer); peer = undefined;

    checkpoint('continue the same application with owner-reviewed host access');
    const retainedDescriptor = await readFile(join(project, '.tendriller/descriptor.json'));
    const retainedInitialization = await readFile(join(project, '.tendriller/initialized.json'));
    const management = await context.newPage();
    await management.goto(new URL('_tendril/manage', handle.page_url).href);
    const delegation = management.locator('form:has(input[name="action"][value="delegate-agent"])');
    await delegation.locator('input[name="name"]').fill('native-continuation');
    for (const scope of ['host:read', 'participants:connect', 'control:write', 'publication:write', 'assistant:manage'])
      await delegation.locator(`input[name="scopes"][value="${scope}"]`).check();
    await delegation.getByRole('button', { name: 'Add agent', exact: true }).click();
    const notice = await management.locator('[role="status"]').textContent();
    const code = notice?.match(new RegExp(`\\b${handle.id}-[0-9]{6}\\b`))?.[0];
    assert.ok(code, 'The actual owner review must return a one-use code for the retained page.');
    await writeFile(join(project, '.tendriller/delegation-code.txt'), code + '\n', { mode: 0o600, flag: 'wx', flush: true });
    // Retain a private checkpoint but make the original handle unavailable to
    // the tutorial. Recovery must use the public receipt and signed descriptor.
    await rename(join(project, '.tendriller/handle.json'), join(project, '.tendriller/handle-before-reviewed-adoption.json'));
    const adopted = JSON.parse(await node(['host-adoption.mjs', SERVICE, '.tendriller/delegation-code.txt']));
    assert.equal(adopted.state, 'host_credential_saved');
    assert.equal(adopted.pageId, handle.id); assert.equal(adopted.applicationId, handle.application.id);
    const resumedAdoption = JSON.parse(await node(['host-adoption.mjs', SERVICE, '.tendriller/delegation-code.txt']));
    assert.equal(resumedAdoption.attemptId, adopted.attemptId);
    assert.equal(resumedAdoption.resumed, true, 'A retained response is reused without redeeming the code twice.');
    await management.locator('form:has(input[name="agent"][value="setup"])').getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(management.locator('[role="status"]')).toContainText('Disconnected setup.');
    await management.close();
    const rejectedSetup = await fetch(handle.api, { headers: { Authorization: 'Bearer ' + handle.token }, redirect: 'error' });
    assert.equal(rejectedSetup.status, 401, 'The old setup credential must no longer authorize host access.');
    await rejectedSetup.body?.cancel();
    const resumedCreation = JSON.parse(await node(['setup.mjs', 'create', SERVICE, 'owner@example.test', 'Retain the existing application']));
    assert.equal(resumedCreation.resumed, true); assert.equal(resumedCreation.page_url, handle.page_url);
    assert.equal((await accounts.prepare('SELECT COUNT(*) AS n FROM account_setups WHERE account_id=?').bind('e2e-owner').first()).n, 1);
    assert.equal((await accounts.prepare('SELECT COUNT(*) AS n FROM tendrils').first()).n, 1,
      'Recovery and creation retry must not allocate a second page through either setup route.');
    assert.deepEqual(await readFile(join(project, '.tendriller/descriptor.json')), retainedDescriptor);
    assert.deepEqual(await readFile(join(project, '.tendriller/initialized.json')), retainedInitialization);
    assert.deepEqual(await cliJson(['publication-operation', 'first-app-publication-1']),
      { publication: preparedPublication.publication, receipt: preparedPublication });
    report.host_continuation = { application_id: handle.application.id, native_device_id: device.deviceId,
      original_setup_revoked: true, original_handle_unavailable: true, retained_response_reused: true };
    passed('actual owner-scoped delegation, retained response recovery and same-app continuation after setup revocation and handle loss');

    await startPeer(); assert.equal((await peer.request('query')).value.length, 5);
    await page.reload();
    await expect(page.locator('#device-key')).toHaveValue(browserDevice, { timeout: 30_000 });
    await expect(page.locator('#notes li')).toHaveCount(5, { timeout: 60_000 });
    passed('same native/browser identities and retained notes after both reopen');

    checkpoint('analyze immutable evidence through the authorized native peer');
    // The reopened notes can be read from local storage before the new peer
    // link exists. Ephemeral signals have no reconnect outbox: wait for the
    // actual coordinator connection before this one deliberate request.
    await expect(page.locator('#peer-status')).toContainText('Connection: following', { timeout: 60_000 });
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
    assert.equal(reviewedNotes.length, 6);
    const evidenceNote = reviewedNotes.at(-1);
    assert.equal(evidenceNote.text, 'Human-reviewed fixture observation');
    assert.equal(evidenceNote.author, browserDevice);
    assert.equal(evidenceNote.source.candidateId, inferred.source.candidateId);
    assert.equal(evidenceNote.source.sha256, sha256(evidencePng));
    assert.equal(evidenceNote.source.reference.id, inferred.source.contentId);
    assert.equal(evidenceNote.source.reference.applicationId, handle.application.id);
    assert.equal(evidenceNote.source.reference.bytes, evidencePng.length);
    assert.equal(evidenceNote.source.reference.mediaType, 'image/png');
    await expect(page.locator('#notes li')).toHaveCount(6);
    await page.reload();
    await expect(page.locator('#device-key')).toHaveValue(browserDevice, { timeout: 30_000 });
    await expect(page.locator('#notes li')).toHaveCount(6, { timeout: 60_000 });
    assert.deepEqual((await peer.request('query')).value.at(-1), evidenceNote);
    assert.equal((await peer.request('inference-status')).calls, 1, 'Reload must not launch another provider request.');
    report.media_inference = { provider: 'injected deterministic native test function', calls: inferred.calls,
      candidate_id: evidenceNote.source.candidateId, sha256: evidenceNote.source.sha256,
      content_id: evidenceNote.source.reference.id, operation_id: evidenceNote.operationId };
    report.limits.push('Inference provider output is injected in the private native test process; no live provider, credential validity or billing tested.');
    passed('human-edited evidence command retains exact source identity and survives browser reopen');
    if (values['network-lab-profile']) {
      checkpoint('qualify real packet faults and application recovery');
      const { qualifyFirstAppNetwork } = await import('../test/e2e/network-qualification/first-app.mjs');
      try {
        const { NETWORK_PROFILES } = await import('../test/e2e/network-qualification/scenarios.mjs');
        const profiles = values['network-lab-profile'] === 'suite' ? NETWORK_PROFILES : [values['network-lab-profile']];
        report.network_qualification = { profiles: [], success: false };
        for (const profile of profiles) report.network_qualification.profiles.push(await qualifyFirstAppNetwork({ page, context, peer, expect, transportCounters,
          evidencePng, browserDevice, sha256, profile }));
        report.network_qualification.success = true;
        report.network_note_count = (await peer.request('query')).value.length;
      } catch (error) {
        if (error.networkReport) report.network_qualification?.profiles.push(error.networkReport);
        throw error;
      }
    }
    await closeTestPeer(peer); peer = undefined;
    passed('native supervisor cleanup and natural child exit without forced termination');
    report.status = 'passed'; report.browser_checks = 'passed'; report.note_count = reviewedNotes.length;
    console.log('First-app native/browser integration passed. Synthetic local claim, selected transport and byte-measurement limits are recorded in the report.');
  }
  }
} catch (error) {
  report.status = 'failed'; report.failed_stage = stage; report.error = error.message;
  if (report.native_checks === 'running') report.native_checks = 'failed';
  if (report.browser_checks === 'running') report.browser_checks = 'failed';
  if (page && !page.isClosed()) {
    report.browser_diagnostics = await page.evaluate(() => Object.fromEntries([
      'connection', 'connection-card', 'pairing-status', 'data-status', 'peer-status', 'submission-status', 'result', 'media-status', 'media-result', 'media-suggestion', 'operation-status',
    ].map(id => [id, document.getElementById(id)?.textContent ?? null]))).catch(failure => ({ error: failure.message }));
    report.browser_actionability = await page.evaluate(() => ({ visibility: document.visibilityState,
      hasFocus: document.hasFocus(), submitDisabled: document.querySelector('#submit')?.disabled,
      formBusy: document.querySelector('#form')?.getAttribute('aria-busy') })).catch(() => null);
    // Which browser stores exist (names only): distinguishes a missing store from an emptied one.
    report.opfs_at_failure = await opfsInventory(page);
    report.browser_status_log = await page.evaluate(() => JSON.parse(sessionStorage.getItem('first-app-status-log') || '[]')).catch(() => null);
    report.browser_storage = await page.evaluate(async () => {
      const opfs = [];
      try { for await (const [name, handle] of (await navigator.storage.getDirectory()).entries()) opfs.push(`${handle.kind}:${name}`); } catch (error) { opfs.push(`error:${error.name}`); }
      let indexed = [];
      try { indexed = (await indexedDB.databases()).map(db => `${db.name}@${db.version}`); } catch (error) { indexed = [`error:${error.name}`]; }
      return { opfs: opfs.slice(0, 40), indexedDB: indexed.slice(0, 40) };
    }).catch(failure => ({ error: failure.message }));
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
  if (peer) await closeTestPeer(peer).catch(error => {
    report.native_cleanup = { status: 'failed', message: error.message };
  });
  await (labBrowser ? labBrowser.close() : browser?.close())?.catch(() => {}); await host?.dispose().catch(() => {}); await dispatcher.close().catch(() => {});
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (values.keep) console.log(`Private test directory retained: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
}
