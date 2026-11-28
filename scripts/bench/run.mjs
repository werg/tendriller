#!/usr/bin/env node
// End-to-end performance benchmark: isolated packed host + published notes
// starter pages + real Chromium profiles. See scripts/bench/README.md.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { setGlobalDispatcher } from 'undici';
import { createLocalDispatcher, localCertificatePin, startAgentProgram } from '../first-app-fixture.mjs';
import { hostLog as createHostLog } from './host.mjs';
import { buildIdentity, prepareWorld } from './workspace.mjs';
import { launchBrowser, measureLoad, MILESTONES, newProfile, throttlePage } from './browser.mjs';
import { aggregateRoutes, medianRun, summarize, summarizeRuns, table } from './stats.mjs';

const root = resolve(import.meta.dirname, '../..');
const execute = promisify(execFile);
const ALL = ['cold', 'warm', 'converge', 'fresh-large', 'agent'];
const USAGE = `Usage: npm run bench -- [options]
  --runs N            repetitions per load scenario (default 5)
  --ops N             operations for convergence scenarios (default 10)
  --scenarios LIST    comma list of ${ALL.join(',')} (default all)
  --items N           existing notes on the large page (default 200)
  --small-items N     existing notes on the small page (default 10)
  --throttle          4x CPU (CDP, page main thread) + 150 ms RTT injected at the host
  --cpu N             CPU slowdown factor (overrides --throttle's 4)
  --latency MS        injected RTT in ms (overrides --throttle's 150)
  --root DIR          checkout whose built dist/ + server/public are measured (default this repo;
                      e.g. a clean git worktree built with npm run build)
  --port N            loopback HTTPS port (default 8795)
  --out FILE          result JSON (default test-results/bench/<timestamp>.json)
  --headed            show the browser
  --keep              keep the temporary world directory`;
const { values } = parseArgs({ options: {
  runs: { type: 'string', default: '5' }, ops: { type: 'string', default: '10' }, scenarios: { type: 'string', default: ALL.join(',') },
  items: { type: 'string', default: '200' }, 'small-items': { type: 'string', default: '10' },
  throttle: { type: 'boolean' }, cpu: { type: 'string' }, latency: { type: 'string' },
  port: { type: 'string', default: '8795' }, root: { type: 'string' }, out: { type: 'string' }, headed: { type: 'boolean' }, keep: { type: 'boolean' },
  help: { type: 'boolean' },
} });
if (values.help) { console.log(USAGE); process.exit(0); }
const int = (name, min = 1) => { const value = Number(values[name]); if (!Number.isSafeInteger(value) || value < min) throw Error(`--${name} must be an integer >= ${min}`); return value; };
const runs = int('runs'), ops = int('ops'), items = int('items'), smallItems = int('small-items'), port = int('port', 1024);
const scenarios = values.scenarios.split(',').map(value => value.trim()).filter(Boolean);
for (const scenario of scenarios) if (!ALL.includes(scenario)) throw Error(`Unknown scenario ${scenario}. ${USAGE}`);
const throttle = { cpu: values.cpu ? Number(values.cpu) : values.throttle ? 4 : 1, latencyMs: values.latency ? Number(values.latency) : values.throttle ? 150 : 0 };
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = resolve(values.out ?? join(root, 'test-results/bench', `${stamp}${throttle.cpu > 1 || throttle.latencyMs ? '-throttled' : ''}.json`));

const measured = resolve(values.root ?? root);
const dispatcher = createLocalDispatcher();
setGlobalDispatcher(dispatcher);
const log = message => console.log(`[${new Date().toISOString().slice(11, 23)}] ${message}`);
const sleep = ms => new Promise(done => setTimeout(done, ms));

const build = await buildIdentity(measured);
const git = async args => (await execute('git', args, { cwd: measured })).stdout.trim();
const result = {
  format: 'tendriller-bench-v1', startedAt: new Date().toISOString(),
  options: { runs, ops, items, smallItems, scenarios, throttle, port },
  environment: { measuredRoot: measured, node: process.version, platform: `${process.platform}-${process.arch}`, gitHead: await git(['rev-parse', 'HEAD']),
    gitDirtyFiles: (await git(['status', '--porcelain'])).split('\n').filter(Boolean).length, build },
  setup: {}, scenarios: {}, server: {},
};
log(`bench: engine ${build.engineSha256.slice(0, 12)} built ${build.engineArchiveBuiltAt}; throttle ${JSON.stringify(throttle)}`);

const directory = await mkdtemp(join(tmpdir(), 'tbn-'));
let world, browser, agent;
const profiles = [];
try {
  const setupStarted = Date.now();
  world = await prepareWorld({ root: measured, directory, port, pages: ['small', 'large'], log });
  result.setup.worldMs = Date.now() - setupStarted;
  result.setup.pages = world.pages;
  result.setup.chronolog = world.chronolog;
  const hostLog = createHostLog(world.service);
  const setupSeq = await hostLog.seq();

  browser = await launchBrowser({ certificatePin: await localCertificatePin(port), port, headless: !values.headed });
  result.environment.chromium = browser.version();
  const profile = async options => { const value = await newProfile(browser, options); profiles.push(value); return value; };

  // The owner's first browser creates each page's data (browser-first) and stays
  // online for the whole run as the member that admits every new device.
  log('bench: owner browser creates page data and seeds notes');
  const owner = await profile({ label: 'owner', expected: 0 });
  const ownerTabs = {};
  for (const [slug, count] of [['small', smallItems], ['large', items]]) {
    const tab = ownerTabs[slug] = await owner.context.newPage();
    const started = Date.now();
    await tab.goto(world.pages[slug].page_url);
    await tab.waitForFunction(() => window.__bench?.marks.canAuthor !== undefined, null, { timeout: 120_000 });
    const created = Date.now() - started;
    const seedStarted = Date.now();
    await tab.evaluate(async count => {
      // Bounded batches: the session worker limits concurrent pending requests.
      const backend = window.tendril.application.backend;
      for (let index = 0; index < count; index += 16) {
        const pending = [];
        for (let offset = index; offset < Math.min(count, index + 16); offset++)
          pending.push(await backend.submit({ operationId: crypto.randomUUID(),
            updates: [{ topic: 'notes', input: { action: 'putNote', noteId: crypto.randomUUID(), text: `seed note ${offset}` } }] }));
        await Promise.all(pending.map(operation => operation.materialized()));
      }
    }, count);
    await tab.waitForFunction(count => document.querySelectorAll('#notes li').length >= count, count, { timeout: 120_000 });
    result.setup[slug] = { items: count, firstBrowserCreateMs: created, seedMs: Date.now() - seedStarted, seedMsPerOp: Math.round((Date.now() - seedStarted) / count * 10) / 10 };
    log(`bench: ${slug} page has ${count} notes (create ${created} ms, seed ${result.setup[slug].seedMs} ms)`);
  }
  result.server.setup = aggregateRoutes(await hostLog.since(0));
  if (throttle.latencyMs) await hostLog.setLatency(throttle.latencyMs);
  const scenarioSeq = await hostLog.seq();

  const loadScenario = (name, loads) => {
    const summary = summarizeRuns(loads.map(load => load.metrics));
    const representative = medianRun(loads, 'dataRendered');
    result.scenarios[name] = { runs: loads.map(({ waterfall, hostItems, ...load }) => ({ ...load, hostRoutes: aggregateRoutes(hostItems) })),
      summary, representative: { run: loads.indexOf(representative), waterfall: representative.waterfall,
        hostRoutes: aggregateRoutes(representative.hostItems) } };
    log(`bench: ${name}: dataRendered median ${summary.dataRendered?.median} ms p90 ${summary.dataRendered?.p90} ms`);
  };
  const coldLoad = async (slug, expected, label) => {
    const fresh = await profile({ label, expected });
    const page = await fresh.context.newPage();
    await throttlePage(page, throttle);
    const load = await measureLoad({ profile: fresh, page, url: world.pages[slug].page_url, hostLog });
    load.errors = fresh.errors;
    return { fresh, page, load };
  };

  let warm;
  if (scenarios.includes('cold')) {
    const loads = [];
    for (let index = 0; index < runs; index++) {
      log(`bench: cold load ${index + 1}/${runs} (fresh profile, small page)`);
      const { fresh, load } = await coldLoad('small', smallItems, `cold-${index}`);
      loads.push(load);
      await fresh.context.close(); profiles.splice(profiles.indexOf(fresh), 1);
    }
    loadScenario('cold', loads);
  }
  if (scenarios.includes('warm') || scenarios.includes('converge') || scenarios.includes('agent')) {
    log('bench: warm profile first visit (untimed admission)');
    warm = await coldLoad('small', smallItems, 'warm');
    if (scenarios.includes('warm')) {
      const loads = [];
      for (let index = 0; index < runs; index++) {
        log(`bench: warm reload ${index + 1}/${runs}`);
        await sleep(500);
        loads.push(await measureLoad({ profile: warm.fresh, page: warm.page, reload: true, hostLog }));
      }
      loadScenario('warm', loads);
    }
  }

  // A authors through the real form; B is the admitted warm profile on the same page.
  const converge = async (name, author) => {
    const samples = [];
    const seen = await warm.page.evaluate(() => document.querySelectorAll('#notes li').length);
    for (let index = 0; index < ops; index++) {
      const text = `${name} ${index} ${randomUUID()}`;
      const remote = warm.page.evaluate(text => window.__bench.waitForText(text), text).catch(() => null);
      const sample = await author(text, index);
      const remoteAt = await Promise.race([remote, sleep(60_000).then(() => null)]);
      samples.push({ ...sample, remoteMs: remoteAt === null ? null : remoteAt - sample.t0 });
      await sleep(250);
    }
    const after = await warm.page.evaluate(() => document.querySelectorAll('#notes li').length);
    return { samples, notesBefore: seen, notesAfter: after };
  };
  if (scenarios.includes('converge')) {
    log(`bench: two-browser convergence (${ops} ops, owner -> warm profile)`);
    const transportBefore = await hostLog.transport();
    const seq = await hostLog.seq();
    const a = ownerTabs.small;
    const outcome = await converge('converge', async text => {
      const local = a.evaluate(text => window.__bench.waitForText(text), text).catch(() => null);
      const t0 = await a.evaluate(text => {
        // "New note" first so every operation adds a note rather than editing the last one.
        document.querySelector('#new').click();
        const t0 = Date.now(); document.querySelector('#note').value = text; document.querySelector('#form').requestSubmit(); return t0;
      }, text);
      const localAt = await local;
      return { t0, localMs: localAt === null ? null : localAt - t0 };
    });
    result.scenarios.converge = { ...outcome, summary: { localMs: summarize(outcome.samples.map(s => s.localMs)), remoteMs: summarize(outcome.samples.map(s => s.remoteMs)) },
      transport: { before: transportBefore, after: await hostLog.transport() }, hostRoutes: aggregateRoutes(await hostLog.since(seq)) };
    log(`bench: converge remote median ${result.scenarios.converge.summary.remoteMs.median} ms`);
  }

  if (scenarios.includes('fresh-large')) {
    const loads = [];
    for (let index = 0; index < runs; index++) {
      log(`bench: fresh device on ${items}-note page ${index + 1}/${runs}`);
      const { fresh, load } = await coldLoad('large', items, `fresh-large-${index}`);
      loads.push(load);
      await fresh.context.close(); profiles.splice(profiles.indexOf(fresh), 1);
    }
    loadScenario('fresh-large', loads);
  }

  if (scenarios.includes('agent')) {
    log('bench: start agent program (admitted by the online owner browser)');
    const events = [], started = Date.now();
    agent = startAgentProgram({ cwd: world.app, preload: world.preload, cli: world.cli, events });
    await agent.waitFor(value => value.hub === 'connected', 'hub connection', 120_000);
    const hubMs = Date.now() - started;
    const small = world.pages.small.id;
    await agent.waitFor(value => value.page === small && value.canAuthor === true, 'small page admitted', 120_000);
    const admittedMs = Date.now() - started;
    const cli = async args => {
      const begun = Date.now();
      const { stdout } = await execute(process.execPath, ['--import', world.preload, world.cli, ...args], { cwd: world.app, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      return { ms: Date.now() - begun, value: JSON.parse(stdout) };
    };
    // First attach-CLI round trip to the running agent program (retried until it answers).
    const statusStarted = Date.now();
    for (let attempt = 0; ; attempt++) {
      try { await cli(['--page', 'small', 'status']); break; }
      catch (error) { if (attempt >= 60) throw error; await sleep(500); }
    }
    const firstStatusMs = Date.now() - statusStarted;
    const seq = await hostLog.seq();
    // The agent authors through the attach CLI; the warm browser profile observes.
    const outcome = await converge('agent', async text => {
      const t0 = Date.now();
      const reply = await cli(['--page', 'small', 'command', 'putNote', JSON.stringify({ noteId: randomUUID(), text }),
        '--operation', randomUUID(), '--wait', 'materialized']);
      return { t0, cliMs: reply.ms };
    });
    for (const sample of outcome.samples) sample.afterCliMs = sample.remoteMs === null ? null : sample.remoteMs - sample.cliMs;
    const { samples } = outcome;
    result.scenarios.agent = { hubMs, admittedMs, firstStatusMs, ...outcome,
      summary: { cliMs: summarize(samples.map(s => s.cliMs)), remoteMs: summarize(samples.map(s => s.remoteMs)), afterCliMs: summarize(samples.map(s => s.afterCliMs)) },
      hostRoutes: aggregateRoutes(await hostLog.since(seq)) };
    log(`bench: agent -> browser median ${result.scenarios.agent.summary.remoteMs.median} ms (CLI ${result.scenarios.agent.summary.cliMs.median} ms)`);
  }

  result.server.scenarios = aggregateRoutes(await hostLog.since(scenarioSeq));
  result.server.setupRequests = setupSeq;
  result.finishedAt = new Date().toISOString();
  // The engine is snapshotted at setup, but server/public assets are served live from --root.
  const buildAtEnd = await buildIdentity(measured);
  result.environment.buildChangedDuringRun = buildAtEnd.engineSha256 !== build.engineSha256 || buildAtEnd.workerBuiltAt !== build.workerBuiltAt;
  if (result.environment.buildChangedDuringRun) log('bench: WARNING the measured checkout was rebuilt during the run; use --root with a private build for stable numbers');
  await mkdir(resolve(outPath, '..'), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n');
  printReport(result);
  console.log(`\nbench: wrote ${outPath}`);
} finally {
  for (const value of profiles) await value.context.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (agent) await agent.stop().catch(() => {});
  await world?.host.dispose().catch(() => {});
  if (!values.keep) await rm(directory, { recursive: true, force: true }).catch(() => {});
  else console.log(`bench: kept ${directory}`);
  await dispatcher.close().catch(() => {});
}

function printReport(result) {
  const loadKeys = ['ttfb', 'domContentLoaded', ...MILESTONES, 'requests', 'transferBytes', 'hostRequests', 'idleGapMs'];
  const rows = [];
  for (const name of ['cold', 'warm', 'fresh-large']) {
    const scenario = result.scenarios[name]; if (!scenario) continue;
    for (const key of loadKeys) if (scenario.summary[key]) rows.push({ scenario: name, metric: key, ...scenario.summary[key] });
  }
  for (const [name, keys] of [['converge', ['localMs', 'remoteMs']], ['agent', ['cliMs', 'remoteMs', 'afterCliMs']]]) {
    const scenario = result.scenarios[name]; if (!scenario) continue;
    for (const key of keys) rows.push({ scenario: name, metric: key, ...scenario.summary[key] });
  }
  console.log('\n' + table(rows, ['scenario', 'metric', 'n', 'median', 'p90', 'min', 'max']));
  for (const name of ['cold', 'warm']) {
    const scenario = result.scenarios[name]; if (!scenario) continue;
    const run = scenario.runs[scenario.representative.run];
    console.log(`\n${name} waterfall (run ${scenario.representative.run}, ms since navigation start; * = worker request):`);
    console.log('milestones: ' + Object.entries(run.marks).sort((a, b) => a[1] - b[1]).map(([key, value]) => `${key} ${Math.round(value)}`).join(' | '));
    console.log('idle gaps >= 20 ms: ' + scenario.representative.waterfall.gaps.map(gap => `${Math.round(gap.from)}-${Math.round(gap.to)}`).join(', '));
    console.log(table(scenario.representative.waterfall.rows.slice(0, 120).map(row => ({ start: row.start, dur: row.duration, ttfb: row.ttfb,
      type: row.type + (row.worker ? '*' : ''), status: row.status, bytes: row.bytes, cached: row.cached ? 'y' : '', url: row.url.slice(0, 80) })),
      ['start', 'dur', 'ttfb', 'type', 'status', 'bytes', 'cached', 'url']));
  }
  console.log('\nhost endpoints during scenarios (top 20 by count):');
  console.log(table(result.server.scenarios.slice(0, 20).map(group => ({ endpoint: group.endpoint.slice(0, 70), count: group.count,
    median: group.ms.median, p90: group.ms.p90, max: group.ms.max, timing: Object.keys(group.serverTiming).join(',').slice(0, 30) })),
    ['endpoint', 'count', 'median', 'p90', 'max', 'timing']));
}
