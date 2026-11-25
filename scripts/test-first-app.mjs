// Exercise the downloaded first-app workspace as an independent public-package consumer:
// one agent (workspace init, and the account-linked register_agent route), several
// pages, the one long-running `tendril agent run`, and real browsers on each page.
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
import { once } from 'node:events';
import { connect as connectTls } from 'node:tls';
import { parseArgs, promisify } from 'node:util';
import { Agent, setGlobalDispatcher } from 'undici';
import { chromium, expect } from '@playwright/test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from 'wrangler';
import { TUTORIAL_FILES } from './onboarding.mjs';
import { readBrowserRtcEvidence, observeRtcTraffic, hasNonTurnTraffic } from './first-app-rtc-evidence.mjs';
import { FIRST_APP_WEBSOCKET_PROXY_WORKER } from './first-app-websocket-host.mjs';
import { verifyFirstAppComposition } from './first-app-composition.mjs';
import { CONTRACT_VERSION } from '../contract/index.mjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { values } = parseArgs({ options: {
  'session-archive': { type: 'string' }, 'first-app-archive': { type: 'string' }, report: { type: 'string' }, keep: { type: 'boolean' },
  'native-only': { type: 'boolean' }, transport: {type:'string', default:'direct'},
  'feedback-qualification': { type: 'boolean' },
} });
if (!values['session-archive'] && !values['first-app-archive'])
  throw Error('Usage: node scripts/test-first-app.mjs --first-app-archive /absolute/tendriller-first-app-VERSION.tgz [--native-only] [--report FILE] [--keep]; or --session-archive FILE for an explicit source/SQL composition.');
if (values['session-archive'] && values['first-app-archive']) throw Error('Use the companion inside the first-app archive; do not override its composition.');
if (!['direct','relay'].includes(values.transport)) throw Error('Choose --transport direct or relay for qualification.');
// The signal, recovery and publication-gate feedback scenarios drove a bespoke
// single-page native peer process; they are not yet expressed against the agent program.
if (values['feedback-qualification'])
  throw Error('Feedback qualification is not available for the agent workspace yet; run the ordinary first-app qualification.');
let sessionArchive = values['session-archive'] ? resolve(values['session-archive']) : undefined;
const defaultReportPath = join(root, '.results/first-app.json');
const reportPath = resolve(values.report ?? defaultReportPath);
const directory = await mkdtemp(join(tmpdir(), 'tfa-'));
// A local cache can be reused without sharing the independent consumer install.
const npmCache = process.env.FIRST_APP_NPM_CACHE ? resolve(process.env.FIRST_APP_NPM_CACHE) : join(directory, 'npm-cache');
const app = join(directory, 'application');
const SERVICE = 'https://service.localhost:8790';
const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));
const report = { status: 'running', qualification: 'isolated-local-agent-workspace',
  native_checks: 'running', browser_checks: 'not-run',
  limits: ['Synthetic local owner session; no OAuth provider tested.',
    'Local Chromium and real native/browser RTC, with forced-failure relay qualification; no Internet NAT or physical mobile qualification.',
    'Events-backed notes pages only; the SQL inventory template needs the SQL Chronolog archives.',
    'Scripted tutorial execution; not an unassisted fresh-agent usability result.',
    'An ordinary test-host WebSocket forwarding boundary isolates workerd issue #8185; the packed host is unchanged. Direct production TCP closure is not qualified.'], steps: [] };
let host, agentProgram, browser, page, stage = 'preflight';
const agentEvents = [];

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
  return page.evaluate(readBrowserRtcEvidence);
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
    '--cache', npmCache, '--pack-destination', directory, path]));
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
  // Manual network qualification keeps current harness code, while archive
  // names/version belong to the selected immutable product graph.
  const version = (await jsonFile(join(root, 'package.json'))).version;
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
  const buildDependencies = [await packDependency('esbuild'),
    await packDependency(`@esbuild/${process.platform}-${process.arch}`)];
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', npmCache, archives.sdk, archives.tools, sessionArchive, ...buildDependencies]);
  const sessionProof = await jsonFile(join(app, 'node_modules/@chronolog/peer-session/provenance.json'));
  assert.equal(sessionProof.dirty, false, 'Use a clean, explicitly selected public Chronolog archive.');
  report.chronolog = { source: sessionProof.source, dirty: sessionProof.dirty, sha256: sha256(await readFile(sessionArchive)) };

  const preload = join(directory, 'local-network.mjs');
  await writeFile(preload, `import { Agent, setGlobalDispatcher, WebSocket } from ${JSON.stringify(pathToFileURL(require.resolve('undici')).href)};
${createLocalDispatcher.toString()}
const dispatcher = createLocalDispatcher();
setGlobalDispatcher(dispatcher);
globalThis.WebSocket = class extends WebSocket {
  constructor(url, protocols = []) { super(url, { protocols, dispatcher }); }
};
`);
  const node = async (args, options = {}) => run(process.execPath, ['--import', preload, ...args], options);
  const cli = join(app, 'node_modules/@tendriller/tools/bin/tendril.mjs');
  const tendril = async (args, options) => JSON.parse(await node([cli, ...args], options));
  const setup = async (args, options) => JSON.parse(await node([join(app, 'setup.mjs'), ...args], options));
  const credential = () => jsonFile(join(app, '.tendriller/agent/credential.json'));
  passed('domain-served starter workspace and independently installed public packages');

  checkpoint('register the workspace agent for the owner email');
  const enrolled = await tendril(['workspace', 'init', '--service', SERVICE, '--owner', 'owner@example.test', '--name', 'first-app']);
  const workspaceFile = await jsonFile(join(app, 'tendriller.json'));
  assert.equal(workspaceFile.service, SERVICE);
  assert.match(workspaceFile.agent.id, /^ag_[a-z2-7]{26}$/);
  const agentToken = (await credential()).token;
  assert.match(agentToken, /^ta_[a-z2-7]{32}$/);
  assert.equal(JSON.stringify(enrolled).includes(agentToken), false, 'workspace init must not print the agent token.');
  assert.equal(JSON.stringify(workspaceFile).includes(agentToken), false, 'tendriller.json must not hold the agent token.');
  const unclaimed = await (await fetch(SERVICE + '/api/agent', { headers: { Authorization: 'Bearer ' + agentToken } })).json();
  assert.equal(unclaimed.account.claimed, false);
  report.agent_id = workspaceFile.agent.id;
  passed('one unclaimed agent credential and shared signing key for the workspace');

  // Two pages from one agent and one install. Both are prepared and published
  // before the owner signs in; signing in to either claims the agent and both pages.
  const pages = {};
  for (const [slug, name] of [['notes', 'First-app qualification'], ['journal', 'Second page of the workspace']]) {
    checkpoint(`create, initialize and build page ${slug} before owner claim`);
    const created = await setup(['new', slug, '--template', 'notes', '--name', name]);
    assert.match(created.id, /^[a-z2-7]{12}$/);
    const resumed = await setup(['new', slug, '--template', 'notes', '--name', name]);
    assert.equal(resumed.resumed, true); assert.equal(resumed.id, created.id, 'page:new retry must resume the same page.');
    const record = await jsonFile(join(app, '.tendriller/pages', created.id, 'page.json'));
    assert.equal(record.page_url, created.page_url);
    const initialized = await setup(['init', slug]);
    assert.equal(initialized.initialized, true); assert.equal(initialized.applicationId, record.application.id);
    const device = await jsonFile(join(app, '.tendriller/pages', created.id, 'initialized.json'));
    await setup(['init', slug]);
    assert.deepEqual(await jsonFile(join(app, '.tendriller/pages', created.id, 'initialized.json')), device, 'Initialization retry preserves identity.');
    const built = (await setup(['build', slug])).built;
    const initial = await jsonFile(join(app, '.tendriller/pages', created.id, 'initial-input.json'));
    for (const path of await files(built)) {
      const bytes = await readFile(path);
      assert.equal(bytes.includes(Buffer.from(agentToken)), false, 'Agent token leaked into authored output.');
      assert.equal(bytes.includes(Buffer.from(initial.epochKey)), false, 'Bootstrap epoch key leaked into authored output.');
      assert.doesNotMatch(path, /\.tendriller|device\.sqlite/);
    }
    pages[slug] = { slug, id: created.id, page_url: created.page_url, application: record.application, device, built };
  }
  // One signing key per agent: every page's device signs with the shared agent key,
  // from its own device store.
  assert.equal(pages.notes.device.deviceId, pages.journal.device.deviceId, 'Pages share the agent signing key.');
  for (const item of Object.values(pages)) await readFile(join(app, '.tendriller/pages', item.id, 'device.sqlite'));
  const listed = await (await fetch(SERVICE + '/api/agent/pages', { headers: { Authorization: 'Bearer ' + agentToken } })).json();
  assert.deepEqual(listed.pages.map(item => item.id).sort(), [pages.notes.id, pages.journal.id].sort(), 'The agent is granted the pages it created.');
  report.pages = Object.fromEntries(Object.values(pages).map(item => [item.slug, { id: item.id, application_id: item.application.id, native_device_id: item.device.deviceId }]));
  passed('two pages from one agent: exact page:new and init retries, private-only authored graphs');

  checkpoint('start the one agent program');
  function startAgent() {
    const child = spawn(process.execPath, ['--import', preload, cli, 'agent', 'run'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-6_000); });
    const waiters = new Set();
    createInterface({ input: child.stdout }).on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (agentEvents.length < 2_000) agentEvents.push(value);
      for (const waiter of waiters) if (waiter.match(value)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(value); }
    });
    const exited = once(child, 'exit');
    const program = { child, exited, stderr: () => stderr,
      waitFor(match, label, timeoutMs = 60_000) {
        const seen = agentEvents.slice(program.from).find(match);
        if (seen) return Promise.resolve(seen);
        return new Promise((resolve, reject) => {
          const waiter = { match, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(Error(`Agent program did not report ${label}: ${stderr}`)); }, timeoutMs) };
          waiters.add(waiter);
          exited.then(([code]) => { if (waiters.delete(waiter)) { clearTimeout(waiter.timer); reject(Error(`Agent program exited (${code}) before ${label}: ${stderr}`)); } });
        });
      },
      async stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        const [code, signal] = await exited; clearTimeout(timer);
        return { code, signal };
      } };
    program.from = agentEvents.length;
    return program;
  }
  const running = slug => value => value.page === pages[slug].id && value.state === 'running';
  agentProgram = startAgent();
  await agentProgram.waitFor(value => value.hub === 'connected', 'a hub connection');
  for (const slug of Object.keys(pages)) {
    const opened = await agentProgram.waitFor(running(slug), `page ${slug} running`);
    assert.equal(opened.deviceId, pages[slug].device.deviceId);
    assert.equal(opened.applicationId, pages[slug].application.id);
  }
  const status = await tendril(['status']);
  assert.equal(status.agentProgram.endpointRecorded, true);
  assert.deepEqual(status.pages.map(item => item.granted), [true, true]);
  passed('one agent program opens every initialized page with its own device and the shared signer');

  checkpoint('publish both pages through the running agent program before owner claim');
  for (const slug of Object.keys(pages)) {
    const operation = `first-app-${slug}-publication-1`;
    const publication = await tendril(['--page', slug, 'publish', pages[slug].built, '--operation', operation]);
    assert.ok(publication.publication.id);
    const retry = await tendril(['--page', slug, 'publish', pages[slug].built, '--operation', operation]);
    assert.deepEqual(retry, publication, 'Exact publication retry must recover its original receipt.');
    assert.deepEqual(await tendril(['--page', slug, 'publication-operation', operation]),
      { publication: publication.publication, receipt: publication }, 'A separate attach process reopens the original signed intent and receipt.');
    assert.equal((await tendril(['--page', slug, 'publication'])).publication.id, publication.publication.id);
    pages[slug].publication = publication.publication.id;
  }
  report.publications = Object.fromEntries(Object.values(pages).map(item => [item.slug, item.publication]));
  passed('signed publication per page through the attach socket, exact retry and receipt recovery');

  checkpoint('owner sign-in claims the agent and the page');
  const localPage = new URL(pages.notes.page_url); localPage.port = '8790';
  const initialClaim = await fetch(localPage, { redirect: 'manual' });
  assert.equal(initialClaim.status, 302); await initialClaim.body?.cancel();
  const claim = await fetch(initialClaim.headers.get('Location'), { redirect: 'manual',
    headers: { Cookie: `__Host-tendriller=${ownerToken}` } });
  assert.equal(claim.status, 303, 'Synthetic owner must traverse the actual claim flow.'); await claim.body?.cancel();
  const redeemUrl = new URL(claim.headers.get('Location')); redeemUrl.port = '8790';
  const redeem = await fetch(redeemUrl, { redirect: 'manual' });
  assert.equal(redeem.status, 303); await redeem.body?.cancel();
  const claimed = await (await fetch(SERVICE + '/api/agent', { headers: { Authorization: 'Bearer ' + agentToken } })).json();
  assert.equal(claimed.account.claimed, true); assert.equal(claimed.account.email, 'owner@example.test');
  const ownerOf = async id => (await accounts.prepare('SELECT owner_account FROM tendrils WHERE id=?').bind(id).first())?.owner_account ?? null;
  assert.equal(await ownerOf(pages.notes.id), 'e2e-owner');
  // Each other page stays an owner invitation until the owner signs in to it.
  assert.equal(await ownerOf(pages.journal.id), null);
  passed('owner sign-in to one page claims that page and the agent');

  checkpoint('native commands through the attach socket');
  assert.deepEqual((await tendril(['--page', 'notes', 'query', 'notes', 'null'])).value, []);
  assert.equal((await tendril(['--page', 'notes', 'command', 'addNote', JSON.stringify({ text: 'Native setup and durable reopen' }),
    '--operation', 'native-setup-1'])).outcome, 'accepted');
  assert.equal((await tendril(['--page', 'notes', 'command', 'addNote', JSON.stringify({ text: 'Native setup and durable reopen' }),
    '--operation', 'native-setup-1'])).outcome, 'accepted', 'An exact command retry recovers the original operation.');
  const retained = await tendril(['--page', 'notes', 'query', 'notes', 'null']);
  assert.equal(retained.value.length, 1);
  // Attached clients name operations in their own namespace; the owner scopes the id.
  const operation = await tendril(['--page', 'notes', 'operation', 'native-setup-1']);
  assert.equal(operation.state.outcome, 'accepted');
  assert.equal(retained.value[0].operationId, operation.reference?.operationId ?? retained.value[0].operationId);
  assert.deepEqual((await tendril(['--page', 'journal', 'query', 'notes', 'null'])).value, [], 'Pages keep separate histories.');
  const self = await tendril(['--page', 'notes', 'self']);
  assert.equal(self.deviceId, pages.notes.device.deviceId);
  passed('separate CLI processes attach to the page owner inside the agent program; histories stay per page');
  report.native_checks = 'passed';

  if (values['native-only']) {
    const stopped = await agentProgram.stop(); agentProgram = undefined;
    assert.deepEqual(stopped, { code: 0, signal: null }, 'SIGTERM closes every page owner and exits cleanly.');
    report.status = 'partial';
    report.limits.push('Browser and cross-device behavior omitted by --native-only.');
    console.log('First-app workspace native/package/host checks passed; browser qualification remains untested.');
  } else {
    report.browser_checks = 'running';
    checkpoint('launch browser');
    // Context.ignoreHTTPSErrors does not cover subsequent SharedWorker fetches.
    // Trust only this loopback fixture certificate across Chromium targets.
    const certificatePin = await localCertificatePin();
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--host-resolver-rules=MAP *.localhost:443 127.0.0.1:8790, MAP *.localhost 127.0.0.1',
        `--ignore-certificate-errors-spki-list=${certificatePin}`] });
    report.browser = await browser.version();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(({ mode }) => {
      const Native = globalThis.RTCPeerConnection;
      window.__firstAppRtcPeers = [];
      globalThis.RTCPeerConnection = class extends Native {
        constructor(...args) {
          if (mode === 'relay') throw new Error('QUALIFICATION_RTC_UNAVAILABLE');
          super(...args); window.__firstAppRtcPeers.push(this);
        }
      };
    }, { mode: values.transport });
    report.expected_transport = values.transport;
    // FIRST_APP_NO_SHARED_WORKER=1 runs the whole flow on the fallback owner, as on browsers without SharedWorker.
    if (process.env.FIRST_APP_NO_SHARED_WORKER === '1') { await context.addInitScript(() => { delete globalThis.SharedWorker; }); report.owner_route = 'elected'; }
    const watchPage = target => {
      target.on('pageerror', error => { report.browser_errors ??= []; if (report.browser_errors.length < 12) report.browser_errors.push(error.message); });
      target.on('console', message => {
        if (!['error', 'warning'].includes(message.type())) return;
        report.browser_console ??= [];
        report.browser_console.push(`${message.type()}: ${message.text()}`.slice(0, 400));
        if (report.browser_console.length > 40) report.browser_console.shift();
      });
    };
    page = await context.newPage(); watchPage(page);
    report.screenshots = {};
    await context.addCookies([{ name: '__Host-tendriller', value: ownerToken,
      domain: 'service.localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const shot = async (target, name) => {
      await target.screenshot({ path: join(dirname(reportPath), `first-app-${name}.png`), fullPage: true });
      report.screenshots[name] = `first-app-${name}.png`;
    };
    const noteText = target => target.locator('#notes').innerText();

    async function connectBrowser(target, slug) {
      await target.goto(pages[slug].page_url);
      await expect(target.locator('#device-key')).toHaveValue(/^[a-f0-9]{64}$/, { timeout: 30_000 });
      const key = await target.locator('#device-key').inputValue();
      // The agent program's page owner reviews and commits the authenticated
      // browser's enrollment from its setup notification: no button, no redirect.
      await expect(target.locator('#app-content')).toBeVisible({ timeout: 90_000 });
      assert.equal(new URL(target.url()).origin, new URL(pages[slug].page_url).origin, 'The browser stays on the app page.');
      await expect(target.locator('#data-status')).toContainText('Data: ready; application: ready', { timeout: 60_000 });
      return key;
    }

    checkpoint('a new browser on the first page sets itself up through the agent program');
    const browserDevice = await connectBrowser(page, 'notes');
    report.browser_device_id = browserDevice;
    await expect(page.locator('#notes')).toContainText('Native setup and durable reopen', { timeout: 30_000 });
    await shot(page, 'connected-mobile');
    const pairingEvent = agentEvents.find(value => value.page === pages.notes.id && value.pairing);
    report.pairing = pairingEvent?.pairing ?? null;
    passed('the agent program enrolls the signed-in owner browser automatically from the setup notification');

    checkpoint('browser and agent exchange commands over the selected transport');
    const transportBefore = await transportCounters();
    await page.locator('#note').fill('Created in the browser'); await page.locator('#submit').click();
    await expect(page.locator('#result')).toContainText('Applied: accepted', { timeout: 30_000 });
    await expect.poll(async () => (await tendril(['--page', 'notes', 'query', 'notes', 'null'])).value.map(note => note.text),
      { timeout: 30_000 }).toEqual(['Native setup and durable reopen', 'Created in the browser']);
    const transportAfter = await transportCounters();
    assert.equal(transportAfter.instance, transportBefore.instance, 'Network counter restart invalidates measurement');
    report.transport = { expected: values.transport, before: transportBefore, after: transportAfter };
    if (values.transport === 'direct') {
      assert.equal(transportAfter.relayUpgrades, 0, 'The shipping default must establish RTC without a hosted relay');
      assert.equal(transportAfter.relayBinaryBytes - transportBefore.relayBinaryBytes, 0, 'Direct application work used host relay bytes');
      // Candidate-pair statistics may lag the just-applied command; observe local stats only.
      const observation = await observeRtcTraffic(() => page.evaluate(readBrowserRtcEvidence));
      report.transport.rtc = observation.final;
      assert.ok(hasNonTurnTraffic(observation.final), 'Real RTC application traffic and known non-TURN candidate types are required');
    } else {
      assert.ok(transportAfter.relayUpgrades > 0, 'A failed RTC capability must open the maintained fallback');
      assert.ok(transportAfter.relayBinaryBytes > transportBefore.relayBinaryBytes, 'Fallback must carry the verified application command');
    }
    assert.equal((await tendril(['--page', 'notes', 'command', 'addNote', JSON.stringify({ text: 'Created by the agent' }),
      '--operation', 'native-note-1'])).outcome, 'accepted');
    await expect(page.locator('#notes')).toContainText('Created by the agent', { timeout: 30_000 });
    passed(`browser and agent commands converge over the ${values.transport} transport`);

    checkpoint('local data and drafts survive while the agent program is stopped; agent work converges on reopen');
    const stopped = await agentProgram.stop(); agentProgram = undefined;
    assert.deepEqual(stopped, { code: 0, signal: null }, 'SIGTERM closes every page owner, the hub and the attach socket.');
    await page.locator('#note').fill('Draft kept while the agent is away');
    await page.reload();
    await expect(page.locator('#notes')).toContainText('Created by the agent', { timeout: 60_000 });
    await expect(page.locator('#device-key')).toHaveValue(browserDevice);
    await expect(page.locator('#note')).toHaveValue('Draft kept while the agent is away');
    // The notes template saves through a connected coordinator; with the only
    // coordinator stopped, Save stays disabled and the draft stays on the device.
    report.browser_without_agent = { submitEnabled: await page.locator('#submit').isEnabled(),
      submission: await page.locator('#submission-status').textContent(), peer: await page.locator('#peer-status').textContent() };
    // Leave the app in this tab; its per-tab view state (the draft) stays with the tab.
    await page.goto('about:blank');
    agentProgram = startAgent();
    await agentProgram.waitFor(running('notes'), 'page notes running again');
    assert.equal((await tendril(['--page', 'notes', 'self'])).deviceId, pages.notes.device.deviceId, 'The restarted agent reopens the same device.');
    assert.equal((await tendril(['--page', 'notes', 'command', 'addNote', JSON.stringify({ text: 'Written while the browser was closed' }),
      '--operation', 'native-note-2'])).outcome, 'accepted');
    await page.goto(pages.notes.page_url);
    await expect(page.locator('#app-content')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#device-key')).toHaveValue(browserDevice);
    await expect(page.locator('#notes')).toContainText('Written while the browser was closed', { timeout: 60_000 });
    await expect(page.locator('#note')).toHaveValue('Draft kept while the agent is away');
    await page.locator('#submit').click();
    await expect(page.locator('#result')).toContainText('Applied: accepted', { timeout: 30_000 });
    await expect.poll(async () => (await tendril(['--page', 'notes', 'query', 'notes', 'null'])).value.map(note => note.text),
      { timeout: 30_000 }).toContain('Draft kept while the agent is away');
    passed('persistence across reload with the agent stopped, retained draft, and convergence of work done while the browser was closed');

    checkpoint('a second page of the same workspace in another tab');
    const second = await context.newPage(); watchPage(second);
    const secondDevice = await connectBrowser(second, 'journal');
    assert.equal(await ownerOf(pages.journal.id), 'e2e-owner', 'Opening the second page signed in claims it.');
    assert.notEqual(new URL(pages.journal.page_url).origin, new URL(pages.notes.page_url).origin, 'Pages keep separate origins.');
    await second.locator('#note').fill('Journal entry from the browser'); await second.locator('#submit').click();
    await expect(second.locator('#result')).toContainText('Applied: accepted', { timeout: 30_000 });
    await expect.poll(async () => (await tendril(['--page', 'journal', 'query', 'notes', 'null'])).value.map(note => note.text),
      { timeout: 30_000 }).toEqual(['Journal entry from the browser']);
    assert.equal((await tendril(['--page', 'journal', 'command', 'addNote', JSON.stringify({ text: 'Journal entry from the agent' }),
      '--operation', 'journal-note-1'])).outcome, 'accepted');
    await expect(second.locator('#notes')).toContainText('Journal entry from the agent', { timeout: 30_000 });
    assert.equal((await noteText(page)).includes('Journal entry'), false, 'The first page never shows the second page’s notes.');
    await shot(second, 'second-page-mobile');
    report.second_page_browser_device_id = secondDevice;
    passed('the same agent program serves a second page: enrollment, browser and agent commands');

    checkpoint('a page created while the agent program runs opens without a restart');
    const late = await setup(['new', 'late', '--template', 'notes', '--name', 'Created while running']);
    await setup(['init', 'late']);
    await agentProgram.waitFor(value => value.page === late.id && value.state === 'running', 'page late running', 60_000);
    assert.equal((await tendril(['--page', 'late', 'command', 'addNote', JSON.stringify({ text: 'Late page note' }),
      '--operation', 'late-note-1'])).outcome, 'accepted');
    passed('the agent program notices an initialized page without a restart');

    report.note_counts = Object.fromEntries(await Promise.all(['notes', 'journal', 'late'].map(async slug =>
      [slug, (await tendril(['--page', slug, 'query', 'notes', 'null'])).value.length])));
    const finished = await agentProgram.stop(); agentProgram = undefined;
    assert.deepEqual(finished, { code: 0, signal: null }, 'SIGTERM closes every page owner and exits cleanly.');
    const hubs = agentEvents.filter(value => value.hub === 'connected').length;
    report.hub_connections = hubs;
    passed('agent program cleanup closes every page owner with a natural exit');
    report.status = 'passed'; report.browser_checks = 'passed';
  }

  checkpoint('the account-linked register_agent route');
  const linked = join(directory, 'linked');
  await mkdir(linked);
  const mcp = async (name, args) => {
    const response = await fetch(SERVICE + '/mcp', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: 'Bearer ' + oauthToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.ok(reply.result && reply.result.isError !== true, `The linked-account ${name} tool must succeed: ${JSON.stringify(reply).slice(0, 400)}`);
    return reply.result.structuredContent;
  };
  const key = await tendril(['workspace', 'key', '--service', SERVICE, '--name', 'linked-agent'], { cwd: linked });
  const registration = await mcp('register_agent', key.register_agent);
  await writeFile(join(linked, 'register-agent.json'), JSON.stringify(registration), { mode: 0o600 });
  await tendril(['workspace', 'adopt', '--service', SERVICE, '--credential', 'register-agent.json'], { cwd: linked });
  const linkedStatus = await tendril(['status'], { cwd: linked });
  assert.equal(linkedStatus.agent.remote.account.claimed, true, 'register_agent creates an agent under the linked account.');
  const linkedPage = await tendril(['page', 'new', 'linked', '--name', 'Linked page'], { cwd: linked });
  assert.match(linkedPage.id, /^[a-z2-7]{12}$/);
  const linkedOwner = await accounts.prepare('SELECT owner_account FROM tendrils WHERE id=?').bind(linkedPage.id).first();
  assert.equal(linkedOwner.owner_account, 'e2e-owner', 'A claimed agent creates pages already owned by the account.');
  passed('workspace key, register_agent through MCP and workspace adopt create an account agent whose pages are owned');
  console.log(`First-app workspace qualification ${report.status}. Synthetic local claim and transport limits are recorded in the report.`);
} catch (error) {
  report.status = 'failed'; report.failed_stage = stage; report.error = error.message;
  if (report.native_checks === 'running') report.native_checks = 'failed';
  if (report.browser_checks === 'running') report.browser_checks = 'failed';
  if (agentProgram) report.agent_stderr = agentProgram.stderr();
  if (page && !page.isClosed()) {
    report.browser_diagnostics = await page.evaluate(() => Object.fromEntries([
      'connection-slot', 'peer-status', 'data-status', 'submission-status', 'result',
    ].map(id => [id, document.getElementById(id)?.textContent ?? null]))).catch(failure => ({ error: failure.message }));
    report.opfs_at_failure = await opfsInventory(page);
    try {
      await page.screenshot({ path: join(dirname(reportPath), 'first-app-failure.png'), fullPage: true, timeout: 10_000 });
      report.screenshots ??= {}; report.screenshots.failure = 'first-app-failure.png';
    } catch { /* Preserve the original test failure if the page has crashed. */ }
  }
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  if (agentProgram) await agentProgram.stop().catch(error => { report.agent_cleanup = { status: 'failed', message: error.message }; });
  report.agent_events = agentEvents.slice(-80);
  await browser?.close().catch(() => {}); await host?.dispose().catch(() => {}); await dispatcher.close().catch(() => {});
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (values.keep) console.log(`Private test directory retained: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
}
