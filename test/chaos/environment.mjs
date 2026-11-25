// The real world a chaos run acts on: an isolated packed host, the downloaded
// first-app workspace with N notes pages, one agent program, and persistent
// Chromium profiles. Setup is done once into a "golden" directory (pages created,
// prepared and published v1, initialized by the harness owner browser, the agent
// signer explicitly provisioned, then the agent and host stopped);
// every run (and every shrink trial) starts from a fresh copy of it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setGlobalDispatcher } from 'undici';
import { chromium } from '@playwright/test';
import { verifyFirstAppComposition } from '../../scripts/first-app-composition.mjs';
import { FIRST_APP_PROFILES } from '../../scripts/release-composition.mjs';
import { createLocalDispatcher, localCertificatePin, startPackedHost, writeLocalNetworkPreload, startAgentProgram,
  fixtureBrowserOptions, FIXTURE_OWNER, serviceOrigin } from '../../scripts/first-app-fixture.mjs';
import { CONTRACT_VERSION } from '../../contract/index.mjs';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));
export const PAGE_SLUGS = Object.freeze(['notes', 'journal', 'diary', 'ledger']);
export const uiMarker = version => `chaos-ui-v${version}`;

let dispatcherInstalled;
export function installLocalDispatcher() {
  dispatcherInstalled ??= createLocalDispatcher();
  setGlobalDispatcher(dispatcherInstalled);
  return dispatcherInstalled;
}

async function run(command, args, options = {}) {
  const result = await execute(command, args, { timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...options });
  return result.stdout;
}

/** Prepare the golden fixture directory. Returns its description (also written to golden.json). */
// Authored-time CRDT first-app lifecycle, following scripts/test-first-app.mjs:
// events profile kit packages (sdk/tools/authority/session) extracted and verified;
// register the workspace agent; per page `new`/`init`/`deploy` (signed v1 before any
// browser key); the first authorized browser (a dedicated harness "owner" profile kept
// in the golden copy) initializes local data; the agent's shared signer is then
// provisioned per page through the explicit sign-enrollment / provisioning-request /
// import-provisioning steps; the agent program is started once to verify every page
// opens, then stopped cleanly.
export async function prepareGolden({ root, firstAppArchive, directory, port, pages: pageCount = 2, log = console.log }) {
  const profile = 'events', profileSpec = FIRST_APP_PROFILES[profile];
  const version = (await jsonFile(join(root, 'package.json'))).version;
  const proof = await jsonFile(join(root, 'dist/provenance.json'));
  const toolsProof = await jsonFile(join(root, 'dist/tools-manifest.json'));
  const archives = Object.fromEntries(['sdk', 'tools', 'engine', 'runtime'].map(name =>
    [name, join(root, 'dist', `tendriller-${name}-${version}.tgz`)]));
  for (const artifact of [...proof.artifacts, ...toolsProof.artifacts])
    assert.equal(sha256(await readFile(join(root, 'dist', artifact.file))), artifact.sha256, `Archive changed: ${artifact.file}`);
  const archive = resolve(firstAppArchive);
  const kitProfile = JSON.parse(await run('tar', ['-xOf', archive, 'first-app-profile.json']));
  assert.deepEqual(kitProfile, { profile, ...profileSpec }, 'The chaos harness needs the events (notes) first-app kit.');
  const release = await jsonFile(join(root, 'dist/manifest.json'));
  const record = release.artifacts.find(item => item.role === 'first-app' && item.file === release.first_app?.file);
  assert.ok(record, 'The release manifest must bind the first-app archive.');
  assert.equal(release.first_app.profile, profile); assert.deepEqual(release.first_app.packages, profileSpec.packages);
  assert.equal(sha256(await readFile(archive)), record.sha256, 'The first-app archive must match the release manifest (rebuild artifacts).');
  const composition = JSON.parse(await run('tar', ['-xOf', archive, 'composition.json']));
  assert.deepEqual(composition.profiles?.[profile], profileSpec);

  await mkdir(directory, { recursive: true });
  const app = join(directory, 'application'), engine = join(directory, 'engine');
  const npmCache = process.env.FIRST_APP_NPM_CACHE ? resolve(process.env.FIRST_APP_NPM_CACHE) : join(directory, 'npm-cache');
  await mkdir(app); await mkdir(engine);
  // The exact selected package archives come out of the kit itself (as in test-first-app).
  const selectedPackages = join(directory, 'selected-packages'); await mkdir(selectedPackages);
  for (const role of profileSpec.packages) {
    const matches = composition.components.filter(item => item.role === role); assert.equal(matches.length, 1, `Exactly one ${role} package`);
    const item = matches[0]; assert.equal(item.file, basename(item.file));
    const extracted = await execute('tar', ['-xOf', archive, 'packages/' + item.file], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(extracted.stdout.length, item.size); assert.equal(sha256(extracted.stdout), item.sha256);
    if (archives[role]) assert.equal(sha256(await readFile(archives[role])), item.sha256, `The selected kit ${role} must match the local qualification graph`);
    const path = join(selectedPackages, item.file); await writeFile(path, extracted.stdout); archives[role] = path;
  }
  await verifyFirstAppComposition({ release, composition, coreProof: proof, toolsProof, archives, version, contract: CONTRACT_VERSION, profile });
  const kit = { archive, release, composition, record, profile };

  await run('tar', ['-xzf', archives.engine, '-C', engine]);
  log('chaos setup: start isolated packed host');
  const host = await startPackedHost({ root, engine, directory, kit, port });
  let agent, owner;
  try {
    const SERVICE = host.service;
    const readiness = await (await fetch(SERVICE + '/api/readiness')).json();
    assert.equal(readiness.creation?.available, true, 'The isolated host must allow creation.');
    log('chaos setup: install the first-app kit and its exact packages');
    await run('tar', ['-xzf', archive, '-C', app]);
    for (const item of composition.components.filter(item => profileSpec.packages.includes(item.role))) {
      const path = join(app, 'packages', item.file);
      assert.equal(sha256(await readFile(path)), item.sha256, `First-app package changed: ${item.role}`);
      archives[item.role] = path;
    }
    const packDependency = async name => {
      const path = dirname(require.resolve(`${name}/package.json`));
      const result = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--offline', '--json',
        '--cache', npmCache, '--pack-destination', directory, path], { cwd: app }));
      return join(directory, result[0].filename);
    };
    const buildDependencies = [await packDependency('esbuild'), await packDependency(`@esbuild/${process.platform}-${process.arch}`)];
    // The kit's packages resolve their own dependencies from the registry; retry a
    // transient network failure once rather than failing the whole run in setup.
    for (let attempt = 1; ; attempt++) {
      try {
        await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCache,
          archives.sdk, archives.tools, archives.authority, archives[profileSpec.session], ...buildDependencies], { cwd: app });
        break;
      } catch (error) {
        if (attempt >= 3 || !/ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/i.test(String(error.stderr ?? error.message))) throw error;
        log(`chaos setup: npm install failed (${attempt}), retrying`);
      }
    }
    const sessionProof = await jsonFile(join(app, 'node_modules/@chronolog/peer-session/provenance.json'));
    const authorityProof = await jsonFile(join(app, 'node_modules/@chronolog/authority/provenance.json'));
    assert.equal(authorityProof.source, sessionProof.source, 'Authority and session must share a source checkpoint');
    const preload = await writeLocalNetworkPreload(join(directory, 'local-network.mjs'));
    const cli = join(app, 'node_modules/@tendriller/tools/bin/tendril.mjs');
    const node = args => run(process.execPath, ['--import', preload, ...args], { cwd: app });
    const tendril = async args => JSON.parse(await node([cli, ...args]));
    const setup = async args => JSON.parse(await node([join(app, 'setup.mjs'), ...args]));

    log('chaos setup: register the workspace agent');
    await tendril(['workspace', 'init', '--service', SERVICE, '--owner', FIXTURE_OWNER.email, '--name', 'chaos']);
    const workspaceFile = await jsonFile(join(app, 'tendriller.json'));
    const pages = {};
    for (const slug of PAGE_SLUGS.slice(0, pageCount)) {
      log(`chaos setup: create, prepare and publish page ${slug} v1 (before any browser key)`);
      const created = await setup(['new', slug, '--template', 'notes', '--name', `Chaos ${slug}`]);
      await setup(['init', slug]);
      const prepared = await jsonFile(join(app, '.tendriller/pages', created.id, 'prepared.json'));
      // The build copies the page's index.html; mark it so v1 is an observable version.
      await markUiVersion(join(app, 'pages', slug), 1);
      const published = await setup(['deploy', slug]);
      assert.match(published.publicationId ?? '', /^[a-f0-9]{64}$/, 'Publication must return a receipt.');
      pages[slug] = { slug, id: created.id, page_url: created.page_url, nativeDeviceId: prepared.publisherKey,
        built: join('pages', slug, 'dist') };
    }

    log('chaos setup: owner browser initializes each page, then provisions the agent signer explicitly');
    const certificatePin = await localCertificatePin(port);
    const setupWorld = { browserOptions: { ...fixtureBrowserOptions({ certificatePin, port }), headless: true }, transport: 'direct', trace: false,
      profileDirectory: id => join(directory, 'profiles', id) };
    owner = await launchProfile(setupWorld, OWNER_PROFILE);
    for (const page of Object.values(pages)) {
      const tab = await owner.newPage();
      const messages = [];
      tab.on('console', message => { if (messages.length < 40) messages.push(`${message.type()}: ${message.text().slice(0, 300)}`); });
      tab.on('pageerror', error => { if (messages.length < 40) messages.push(`pageerror: ${String(error?.stack ?? error).slice(0, 600)}`); });
      tab.on('requestfailed', request => { if (messages.length < 40) messages.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`); });
      try {
      await tab.goto(page.page_url, { timeout: 60_000 });
      await waitFor(() => tab.locator('#submit').isEnabled(), Boolean, 60_000, `owner browser ready on ${page.slug}`);
      await provisionNativeSigner({ page: tab, slug: page.slug, publicKey: page.nativeDeviceId, app, setup });
      page.ownerDeviceId = await tab.locator('#public-key').inputValue();
      } catch (error) { log(`chaos setup: owner tab diagnostics ${page.slug}: url=${tab.url()} hasRuntime=${await tab.evaluate(() => Boolean(window.tendril)).catch(e => e.message)} hasConfig=${await tab.evaluate(() => Boolean(window.__TENDRIL__)).catch(e => e.message)}\n${messages.join('\n')}`); throw error; }
      await tab.close();
    }
    await owner.close(); owner = undefined;

    const events = [];
    agent = startAgentProgram({ cwd: app, preload, cli, events });
    await agent.waitFor(value => value.hub === 'connected', 'a hub connection');
    for (const slug of Object.keys(pages)) {
      await agent.waitFor(value => value.page === pages[slug].id && value.state === 'running', `page ${slug} running`);
      const self = await tendril(['--page', slug, 'self']);
      assert.equal(self.identity?.publicKey, pages[slug].nativeDeviceId, 'The agent page owner must use the shared workspace signer.');
    }
    const stopped = await agent.stop(); agent = undefined;
    assert.deepEqual(stopped, { code: 0, signal: null }, 'Setup agent program must exit cleanly.');
    const golden = { format: 'tendriller-chaos-golden-v2', port, service: SERVICE, version, agentId: workspaceFile.agent.id, pages,
      ownerProfile: OWNER_PROFILE, profile,
      core: { source: proof.source, dirty: proof.dirty, version },
      chronolog: { source: sessionProof.source, dirty: sessionProof.dirty, authority: authorityProof.source },
      composition: { id: composition.id, first_app_sha256: record.sha256 }, createdAt: new Date().toISOString() };
    await writeFile(join(directory, 'golden.json'), JSON.stringify(golden, null, 2) + '\n');
    return golden;
  } finally {
    if (owner) await owner.close().catch(() => {});
    if (agent) await agent.stop().catch(() => {});
    await host.dispose().catch(() => {});
  }
}

/** The harness profile that initialized every page; it is the existing authorized device that reviews and grants new browsers. */
export const OWNER_PROFILE = 'owner';

async function waitFor(read, done, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let value;
  for (;;) {
    value = await read().catch(error => ({ error: error.message }));
    if (done(value)) return value;
    if (Date.now() >= deadline) throw Error(`Timed out waiting for ${label}: ${JSON.stringify(value)?.slice(0, 400)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
const openDetails = async locator => { if (!await locator.evaluate(node => node.open)) await locator.locator(':scope > summary').click(); };

/** The kit's explicit native key proof + recipient-bound provisioning (as scripts/first-app-workspace.mjs). */
async function provisionNativeSigner({ page, slug, publicKey, app, setup }) {
  await waitFor(() => page.evaluate(() => ({ mounted: Boolean(document.querySelector('#provisioning details')),
    connection: document.getElementById('connection-status')?.textContent, count: document.getElementById('count')?.textContent })),
  value => value.mounted === true, 60_000, `provisioning view mounted on ${slug}`);
  await openDetails(page.locator('#provisioning'));
  const external = page.locator('#provisioning details');
  await openDetails(external);
  await external.locator('input').fill(publicKey);
  await external.getByRole('button', { name: 'Create account-bound challenge for this key', exact: true }).click();
  const out = page.locator('[data-provisioning="out"]'), incoming = page.locator('[data-provisioning="in"]'), status = page.locator('[data-provisioning="status"]');
  await waitFor(async () => { try { return JSON.parse(await out.inputValue()).publicKey; } catch { return null; } }, value => value === publicKey, 30_000, 'native challenge');
  const challengeFile = join(app, '.tendriller', `chaos-${slug}-challenge.json`);
  await writeFile(challengeFile, await out.inputValue(), { mode: 0o600, flag: 'wx' });
  const proof = await setup(['sign-enrollment', slug, challengeFile]);
  await incoming.fill(JSON.stringify(proof));
  await external.getByRole('button', { name: 'Record external signed enrollment proof from incoming field', exact: true }).click();
  await waitFor(() => status.textContent(), text => /External key proof recorded/.test(text ?? ''), 30_000, 'native key proof');
  const request = await setup(['provisioning-request', slug]);
  await incoming.fill(JSON.stringify(request)); await page.locator('[data-provisioning="review"]').click();
  await waitFor(() => status.textContent(), text => (text ?? '').includes(publicKey), 30_000, 'native request review');
  await page.locator('[data-provisioning="writer"]').check(); await page.locator('[data-provisioning="grant"]').click();
  await waitFor(() => status.textContent(), text => /Recipient-bound encrypted key package created/.test(text ?? ''), 30_000, 'native key package');
  const packageFile = join(app, '.tendriller', `chaos-${slug}-package.json`);
  await writeFile(packageFile, await out.inputValue(), { mode: 0o600, flag: 'wx' });
  assert.equal((await setup(['import-provisioning', slug, packageFile])).provisioned, true);
}

/** Replace the chaos UI marker in a built page so each publication is a distinct, observable version. */
export async function markUiVersion(built, version) {
  const path = join(built, 'index.html');
  const html = (await readFile(path, 'utf8')).replace(/\n?<!-- chaos-ui-v\d+ -->\n?/g, '');
  await writeFile(path, html.replace(/<\/body>/i, `<!-- ${uiMarker(version)} -->\n</body>`));
}

/**
 * Start a run world from a golden copy. Returns an object with the host, agent
 * program control, CLI helpers, browser-profile management and log files.
 */
export async function openWorld({ golden, goldenDirectory, directory, transport = 'direct', trace = true, headless = true, log = console.log }) {
  await rm(directory, { recursive: true, force: true });
  await cp(goldenDirectory, directory, { recursive: true, verbatimSymlinks: true });
  const app = join(directory, 'application');
  const preload = await writeLocalNetworkPreload(join(directory, 'local-network.mjs'));
  const cli = join(app, 'node_modules/@tendriller/tools/bin/tendril.mjs');
  const logs = join(directory, 'logs'); await mkdir(logs, { recursive: true });
  const engine = join(directory, 'engine');
  const host = await startPackedHost({ root: resolve(import.meta.dirname, '../..'), engine, directory, port: golden.port, seed: false });
  const lifetime = (event, detail = {}) => log(`chaos lifetime: ${new Date().toISOString()} ${event} ${JSON.stringify(detail)}`);
  lifetime('host-start', { port: golden.port });
  const events = [];
  let agent, agentGeneration = 0;
  const world = {
    golden, directory, app, preload, cli, host, events, logs,
    get agent() { return agent; },
    /** Run the attach CLI; resolves parsed JSON or throws with stderr. */
    async tendril(args, { timeoutMs = 60_000 } = {}) {
      const result = await execute(process.execPath, ['--import', preload, cli, ...args],
        { cwd: app, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' });
      return JSON.parse(result.stdout);
    },
    async startAgent({ wait = true } = {}) {
      if (agent && agent.child.exitCode === null && agent.child.signalCode === null) throw Error('Agent program already running');
      const generation = ++agentGeneration;
      const out = join(logs, `agent-${generation}.stdout.log`), err = join(logs, `agent-${generation}.stderr.log`);
      agent = startAgentProgram({ cwd: app, preload, cli, events, maxEvents: 20_000, stderrLimit: 20_000,
        onLine: line => { void appendFile(out, line + '\n').catch(() => {}); } });
      agent.generation = generation;
      lifetime('agent-start', { generation, pid: agent.child.pid });
      const pid = agent.child.pid;
      agent.exited.then(([code, signal]) => lifetime('agent-exit', { generation, pid, code, signal }), () => {});
      agent.child.stderr.on('data', bytes => { void appendFile(err, bytes).catch(() => {}); });
      if (wait) {
        await agent.waitFor(value => value.hub === 'connected', 'a hub connection', 90_000);
        for (const page of Object.values(golden.pages))
          await agent.waitFor(value => value.page === page.id && value.state === 'running', `page ${page.slug} running`, 90_000);
      }
      return agent;
    },
    async killAgent(signal = 'SIGKILL') {
      if (!agent) return null;
      const current = agent; agent = undefined;
      if (current.child.exitCode !== null || current.child.signalCode !== null) return { code: current.child.exitCode, signal: current.child.signalCode };
      if (signal === 'SIGTERM') return current.stop();
      current.child.kill('SIGCONT'); current.child.kill(signal);
      const [code, exitSignal] = await current.exited;
      return { code, signal: exitSignal };
    },
    signalAgent(signal) { if (!agent) throw Error('No agent program'); agent.child.kill(signal); },
    async restartHost() { lifetime('host-restart-begin'); await host.restart(); lifetime('host-restart-ready'); },
    browser: undefined, profiles: new Map(),
    async close() {
      for (const profile of world.profiles.values()) await profile.context?.close().catch(() => {});
      if (agent) { agent.child.kill('SIGCONT'); await agent.stop().catch(() => {}); }
      await host.dispose().catch(() => {});
      lifetime('host-stop');
    },
  };
  const certificatePin = await localCertificatePin(golden.port);
  world.browserOptions = { ...fixtureBrowserOptions({ certificatePin, port: golden.port }), headless };
  world.transport = transport;
  world.trace = trace;
  world.profileDirectory = id => join(directory, 'profiles', id);
  log(`chaos world: host ${serviceOrigin(golden.port)}; copy of ${goldenDirectory}`);
  return world;
}

/** Launch (or relaunch) a persistent Chromium profile with the fixture's trust, cookie and transport setup. */
export async function launchProfile(world, id, { trace = world.trace } = {}) {
  const userDataDir = world.profileDirectory(id);
  await mkdir(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, { ...world.browserOptions, viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ mode }) => {
    const Native = globalThis.RTCPeerConnection;
    window.__firstAppRtcPeers = [];
    globalThis.RTCPeerConnection = class extends Native {
      constructor(...args) {
        if (mode === 'relay') throw new Error('QUALIFICATION_RTC_UNAVAILABLE');
        super(...args); window.__firstAppRtcPeers.push(this);
      }
    };
  }, { mode: world.transport });
  await context.addCookies([{ name: '__Host-tendriller', value: FIXTURE_OWNER.token,
    domain: 'service.localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  if (trace) await context.tracing.start({ screenshots: true, snapshots: true, title: `chaos ${id}` }).catch(() => {});
  // A persistent context opens one blank page; reuse it as a spare.
  return context;
}

export async function makeWorkDirectory(prefix = 'tch-') {
  // Short paths: the agent program's attach socket must fit sun_path limits.
  return mkdtemp(join(tmpdir(), prefix));
}
