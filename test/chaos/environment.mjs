// The real world a chaos run acts on: an isolated packed host, the downloaded
// first-app workspace with N notes pages, one agent program, and persistent
// Chromium profiles. Setup is done once into a "golden" directory (pages created,
// initialized, built, published v1 and claimed, then the agent and host stopped);
// every run (and every shrink trial) starts from a fresh copy of it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setGlobalDispatcher } from 'undici';
import { chromium } from '@playwright/test';
import { verifyFirstAppComposition } from '../../scripts/first-app-composition.mjs';
import { createLocalDispatcher, localCertificatePin, startPackedHost, writeLocalNetworkPreload, startAgentProgram,
  fixtureBrowserOptions, claimOwnerThroughPage, FIXTURE_OWNER, serviceOrigin } from '../../scripts/first-app-fixture.mjs';
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
export async function prepareGolden({ root, firstAppArchive, directory, port, pages: pageCount = 2, log = console.log }) {
  const version = (await jsonFile(join(root, 'package.json'))).version;
  const proof = await jsonFile(join(root, 'dist/provenance.json'));
  const toolsProof = await jsonFile(join(root, 'dist/tools-manifest.json'));
  const archives = Object.fromEntries(['sdk', 'tools', 'engine', 'runtime'].map(name =>
    [name, join(root, 'dist', `tendriller-${name}-${version}.tgz`)]));
  for (const artifact of [...proof.artifacts, ...toolsProof.artifacts])
    assert.equal(sha256(await readFile(join(root, 'dist', artifact.file))), artifact.sha256, `Archive changed: ${artifact.file}`);
  const archive = resolve(firstAppArchive);
  const release = await jsonFile(join(root, 'dist/manifest.json'));
  const record = release.artifacts.find(item => item.role === 'first-app' && item.file === release.first_app?.file);
  assert.ok(record, 'The release manifest must bind the first-app archive.');
  assert.equal(sha256(await readFile(archive)), record.sha256, 'The first-app archive must match the release manifest (rebuild artifacts).');
  const composition = JSON.parse(await run('tar', ['-xOf', archive, 'composition.json']));
  await verifyFirstAppComposition({ release, composition, coreProof: proof, toolsProof, archives, version, contract: CONTRACT_VERSION });
  const kit = { archive, release, composition, record };

  await mkdir(directory, { recursive: true });
  const app = join(directory, 'application'), engine = join(directory, 'engine');
  const npmCache = process.env.FIRST_APP_NPM_CACHE ? resolve(process.env.FIRST_APP_NPM_CACHE) : join(directory, 'npm-cache');
  await mkdir(app); await mkdir(engine);
  await run('tar', ['-xzf', archives.engine, '-C', engine]);
  log('chaos setup: start isolated packed host');
  const host = await startPackedHost({ root, engine, directory, kit, port });
  let agent;
  try {
    const SERVICE = host.service;
    const readiness = await (await fetch(SERVICE + '/api/readiness')).json();
    assert.equal(readiness.creation?.available, true, 'The isolated host must allow creation.');
    log('chaos setup: install the first-app kit and its exact packages');
    await run('tar', ['-xzf', archive, '-C', app]);
    let sessionArchive;
    for (const item of composition.components.filter(item => ['sdk', 'tools', 'session'].includes(item.role))) {
      const path = join(app, 'packages', item.file);
      assert.equal(sha256(await readFile(path)), item.sha256, `First-app package changed: ${item.role}`);
      if (item.role === 'session') sessionArchive = path; else archives[item.role] = path;
    }
    const packDependency = async name => {
      const path = dirname(require.resolve(`${name}/package.json`));
      const result = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--offline', '--json',
        '--cache', npmCache, '--pack-destination', directory, path], { cwd: app }));
      return join(directory, result[0].filename);
    };
    const buildDependencies = [await packDependency('esbuild'), await packDependency(`@esbuild/${process.platform}-${process.arch}`)];
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCache,
      archives.sdk, archives.tools, sessionArchive, ...buildDependencies], { cwd: app });
    const sessionProof = await jsonFile(join(app, 'node_modules/@chronolog/peer-session/provenance.json'));
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
      log(`chaos setup: create, initialize and build page ${slug}`);
      const created = await setup(['new', slug, '--template', 'notes', '--name', `Chaos ${slug}`]);
      await setup(['init', slug]);
      const device = await jsonFile(join(app, '.tendriller/pages', created.id, 'initialized.json'));
      const built = (await setup(['build', slug])).built;
      pages[slug] = { slug, id: created.id, page_url: created.page_url, nativeDeviceId: device.deviceId,
        built: built.startsWith(app) ? built.slice(app.length + 1) : built };
    }
    const events = [];
    agent = startAgentProgram({ cwd: app, preload, cli, events });
    await agent.waitFor(value => value.hub === 'connected', 'a hub connection');
    for (const slug of Object.keys(pages))
      await agent.waitFor(value => value.page === pages[slug].id && value.state === 'running', `page ${slug} running`);
    for (const slug of Object.keys(pages)) {
      log(`chaos setup: publish ${slug} v1`);
      await markUiVersion(join(app, pages[slug].built), 1);
      const published = await tendril(['--page', slug, 'publish', join(app, pages[slug].built), '--operation', `chaos-${slug}-publication-1`]);
      assert.ok(published.publication?.id, 'Publication must return a receipt.');
    }
    log('chaos setup: owner sign-in claims the agent and every page');
    await claimOwnerThroughPage({ pageUrl: Object.values(pages)[0].page_url, port });
    const stopped = await agent.stop(); agent = undefined;
    assert.deepEqual(stopped, { code: 0, signal: null }, 'Setup agent program must exit cleanly.');
    const golden = { format: 'tendriller-chaos-golden-v1', port, service: SERVICE, version, agentId: workspaceFile.agent.id, pages,
      core: { source: proof.source, dirty: proof.dirty, version },
      chronolog: { source: sessionProof.source, dirty: sessionProof.dirty },
      composition: { id: composition.id, first_app_sha256: record.sha256 }, createdAt: new Date().toISOString() };
    await writeFile(join(directory, 'golden.json'), JSON.stringify(golden, null, 2) + '\n');
    return golden;
  } finally {
    if (agent) await agent.stop().catch(() => {});
    await host.dispose().catch(() => {});
  }
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
    async restartHost() { await host.restart(); },
    browser: undefined, profiles: new Map(),
    async close() {
      for (const profile of world.profiles.values()) await profile.context?.close().catch(() => {});
      if (agent) { agent.child.kill('SIGCONT'); await agent.stop().catch(() => {}); }
      await host.dispose().catch(() => {});
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
export async function launchProfile(world, id) {
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
  if (world.trace) await context.tracing.start({ screenshots: true, snapshots: true, title: `chaos ${id}` }).catch(() => {});
  // A persistent context opens one blank page; reuse it as a spare.
  return context;
}

export async function makeWorkDirectory(prefix = 'tch-') {
  // Short paths: the agent program's attach socket must fit sun_path limits.
  return mkdtemp(join(tmpdir(), prefix));
}
