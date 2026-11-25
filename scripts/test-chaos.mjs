// Seeded monkey/chaos testing of the first-app workspace: one agent program,
// several notes pages and several real Chromium profiles, driven by a weighted,
// precondition-checked random action stream with continuous safety invariants and
// periodic liveness ("heal") phases. See docs/CHAOS_TESTING.md.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { parseSeed, randomSeed } from '../test/chaos/prng.mjs';
import { createPlanner, runIdForSeed } from '../test/chaos/planner.mjs';
import { runChaos, INJECTED_FAULTS } from '../test/chaos/runner.mjs';
import { buildReport, harnessIdentity, replayEntries } from '../test/chaos/report.mjs';
import { ddmin } from '../test/chaos/shrink.mjs';
import { installLocalDispatcher, makeWorkDirectory, openWorld, prepareGolden } from '../test/chaos/environment.mjs';
import { readTabState } from '../test/chaos/driver.mjs';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: {
  seed: { type: 'string' }, steps: { type: 'string' }, duration: { type: 'string' },
  browsers: { type: 'string', default: '3' }, pages: { type: 'string', default: '2' },
  'first-app-archive': { type: 'string' }, report: { type: 'string' },
  replay: { type: 'string' }, shrink: { type: 'boolean' }, 'shrink-budget': { type: 'string', default: '40' },
  network: { type: 'boolean' }, transport: { type: 'string', default: 'direct' },
  'heal-every': { type: 'string', default: '15' }, 'heal-deadline': { type: 'string', default: '120s' },
  'no-host-restart': { type: 'boolean' }, 'keep-going': { type: 'boolean' },
  fixture: { type: 'string' }, port: { type: 'string', default: '8791' }, keep: { type: 'boolean' },
  headed: { type: 'boolean' }, 'no-trace': { type: 'boolean' },
  'inject-fault': { type: 'string' }, help: { type: 'boolean' },
} });

const USAGE = `Usage: npm run test:chaos -- [--seed N] [--steps N | --duration 10m] [--browsers N] [--pages N]
  [--first-app-archive dist/tendriller-first-app-VERSION.tgz] [--report FILE] [--transport direct|relay]
  [--replay REPORT.json] [--shrink [--shrink-budget N]] [--network] [--heal-every N] [--heal-deadline 120s]
  [--no-host-restart] [--keep-going] [--fixture DIR] [--port 8791] [--keep] [--headed] [--no-trace]
  [--inject-fault ${Object.keys(INJECTED_FAULTS).join('|')}]   (test-only, demonstrates shrinking)`;
if (values.help) { console.log(USAGE); process.exit(0); }

export function parseDuration(text) {
  if (text === undefined) return Infinity;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text).trim());
  if (!match) throw Error(`Invalid duration: ${text}`);
  return Math.round(Number(match[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? 'ms']);
}
const positive = (name, text) => {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) throw Error(`--${name} must be a positive integer`);
  return value;
};
if (!['direct', 'relay'].includes(values.transport)) throw Error('Choose --transport direct or relay.');
if (values['inject-fault'] && !INJECTED_FAULTS[values['inject-fault']]) throw Error(`Unknown --inject-fault. ${USAGE}`);

const replayed = values.replay ? JSON.parse(await readFile(resolve(values.replay), 'utf8')) : null;
const seed = replayed ? replayed.seed : (parseSeed(values.seed) ?? randomSeed());
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const firstAppArchive = resolve(values['first-app-archive'] ?? join(root, 'dist', `tendriller-first-app-${version}.tgz`));
const durationMs = parseDuration(values.duration);
const config = replayed ? { ...replayed.config, failFast: !values['keep-going'] } : {
  steps: values.steps ? positive('steps', values.steps) : (Number.isFinite(durationMs) ? Infinity : 60),
  durationMs, browsers: positive('browsers', values.browsers), pages: Math.min(positive('pages', values.pages), 4),
  healEvery: positive('heal-every', values['heal-every']), healDeadlineMs: parseDuration(values['heal-deadline']),
  transport: values.transport, network: Boolean(values.network), hostRestart: !values['no-host-restart'],
  failFast: !values['keep-going'], injectFault: values['inject-fault'] ?? null,
};
if (replayed && values['inject-fault']) config.injectFault = values['inject-fault'];
const reportPath = resolve(values.report ?? join(root, '.results/chaos', `chaos-${seed}${replayed ? '-replay' : ''}.json`));
const evidenceDirectory = reportPath.replace(/\.json$/, '');
const port = positive('port', values.port);
console.log(`chaos seed: ${seed}${replayed ? ` (replaying ${replayed.actions.length} entries from ${values.replay})` : ''}`);
console.log(`chaos config: ${JSON.stringify({ ...config, durationMs: Number.isFinite(config.durationMs) ? config.durationMs : null })}`);
if (!existsSync(firstAppArchive)) throw Error(`First-app archive not found: ${firstAppArchive}. Run npm run build:artifacts && npm run release:artifacts.`);

const limits = ['Synthetic local owner session on an isolated packed host; no OAuth provider, Internet or mobile device.',
  'Events-backed notes pages from the first-app kit; the SQL inventory template is not exercised.',
  'Actions are sequential (one at a time); concurrency comes from the product (agent program, workers, timers), not overlapping harness actions.'];
const dispatcher = installLocalDispatcher();
let faults = null;
if (config.network) {
  const { createFaults } = await import('../test/e2e/network-qualification/faults.mjs');
  const candidate = createFaults();
  try { await candidate.restoreUdp(); faults = candidate; }
  catch (error) {
    console.log(`chaos: --network requested but the Docker network lab is unavailable (${error.message}); packet-fault actions are disabled.`);
    limits.push(`Network faults requested but unavailable: ${error.message}`);
    config.network = false;
  }
}

const work = await makeWorkDirectory();
const goldenDirectory = values.fixture ? resolve(values.fixture) : join(work, 'golden');
let golden;
if (existsSync(join(goldenDirectory, 'golden.json'))) {
  golden = JSON.parse(await readFile(join(goldenDirectory, 'golden.json'), 'utf8'));
  if (golden.port !== port || Object.keys(golden.pages).length !== config.pages)
    throw Error(`Fixture ${goldenDirectory} was prepared for port ${golden.port} with ${Object.keys(golden.pages).length} pages.`);
  console.log(`chaos: reusing prepared fixture ${goldenDirectory}`);
} else {
  golden = await prepareGolden({ root, firstAppArchive, directory: goldenDirectory, port, pages: config.pages });
}
const harness = harnessIdentity(root);

/** One complete run from a fresh copy of the golden fixture. */
async function runOnce({ label, replay, injectFault, saveEvidence }) {
  const started = Date.now();
  const world = await openWorld({ golden, goldenDirectory, directory: join(work, label), transport: config.transport,
    trace: !values['no-trace'], headless: !values.headed });
  world.faults = faults;
  let outcome, browserVersion = null;
  const evidence = {};
  try {
    await world.startAgent();
    const planner = replay ? undefined : createPlanner({ seed, runId: runIdForSeed(seed), healEvery: config.healEvery });
    outcome = await runChaos({ world, config, planner, replay, injectFault });
    const anyContext = [...outcome.runtime.profiles.values()].find(handle => handle.context)?.context;
    browserVersion = anyContext?.browser()?.version() ?? null;
    if (saveEvidence && outcome.violations.length) {
      await mkdir(evidenceDirectory, { recursive: true });
      evidence.screenshots = [];
      for (const [profile, handle] of outcome.runtime.profiles) {
        if (!handle.context) continue;
        for (const [tab, page] of handle.tabs) {
          if (page.isClosed()) continue;
          const file = join(evidenceDirectory, `screenshot-${profile}-${tab}.png`);
          if (await page.screenshot({ path: file, fullPage: true, timeout: 10_000 }).then(() => true, () => false)) evidence.screenshots.push(file);
          evidence[`state-${profile}-${tab}`] = await readTabState(page).then(({ html, ...state }) => state).catch(() => null);
        }
        if (world.trace) {
          const file = join(evidenceDirectory, `trace-${profile}.zip`);
          await handle.context.tracing.stop({ path: file }).then(() => { (evidence.traces ??= []).push(file); }, () => {});
        }
      }
      for (const trace of outcome.runtime.traces) {
        const file = join(evidenceDirectory, basename(trace.path));
        await cp(trace.path, file).then(() => { (evidence.traces ??= []).push(file); }, () => {});
      }
    }
  } finally {
    await world.close();
    if (saveEvidence && outcome?.violations.length) {
      await mkdir(evidenceDirectory, { recursive: true });
      await cp(world.logs, join(evidenceDirectory, 'agent-logs'), { recursive: true }).catch(() => {});
      evidence.agentLogs = join(evidenceDirectory, 'agent-logs');
    }
    if (!values.keep) await rm(join(work, label), { recursive: true, force: true }).catch(() => {});
  }
  return { outcome, started, finished: Date.now(), browserVersion, evidence };
}

let exitCode = 0;
try {
  const replay = replayed ? replayEntries(replayed) : undefined;
  const first = await runOnce({ label: 'run', replay, injectFault: config.injectFault, saveEvidence: true });
  const report = buildReport({ seed, config: { ...config, durationMs: Number.isFinite(config.durationMs) ? config.durationMs : null, steps: Number.isFinite(config.steps) ? config.steps : null },
    golden, harness, browserVersion: first.browserVersion, started: first.started, finished: first.finished, outcome: first.outcome,
    limits, evidence: first.evidence });
  if (replayed) report.replayOf = { path: resolve(values.replay), seed: replayed.seed, status: replayed.status, actions: replayed.actions.length };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`chaos ${report.status}: ${report.summary.actions} entries, ${report.summary.violations} violations, ${report.summary.actionErrors} action errors; report ${reportPath}`);

  if (values.shrink && report.status === 'failed') {
    const signature = report.violations[0].invariant;
    const candidates = replayEntries(report);
    console.log(`chaos shrink: ddmin over ${candidates.length} entries for invariant ${signature} (budget ${values['shrink-budget']} trials)`);
    let trial = 0;
    const shrinkConfig = { ...config, failFast: true };
    const shrunk = await ddmin(candidates, async subset => {
      trial++;
      const savedConfig = { ...config }; Object.assign(config, shrinkConfig);
      try {
        const { outcome } = await runOnce({ label: `shrink-${trial}`, replay: subset, injectFault: config.injectFault, saveEvidence: false });
        return outcome.violations.some(item => item.invariant === signature);
      } catch (error) {
        console.log(`chaos shrink trial ${trial} errored: ${error.message}`);
        return false;
      } finally { Object.assign(config, savedConfig); }
    }, { budget: positive('shrink-budget', values['shrink-budget']),
      onTrial: ({ trial, size, failed }) => console.log(`chaos shrink trial ${trial}: ${size} entries -> ${failed ? 'reproduces' : 'passes'}`) });
    report.shrink = { signature, original: candidates.length, minimal: shrunk.minimal, trials: shrunk.trials, exhausted: shrunk.exhausted, history: shrunk.history };
    const minimalPath = reportPath.replace(/\.json$/, '-minimal.json');
    // The minimal sequence as a replayable report.
    const minimalRun = await runOnce({ label: 'minimal', replay: shrunk.minimal, injectFault: config.injectFault, saveEvidence: false });
    await writeFile(minimalPath, JSON.stringify(buildReport({ seed, config: report.config, golden, harness, browserVersion: minimalRun.browserVersion,
      started: minimalRun.started, finished: minimalRun.finished, outcome: minimalRun.outcome, limits }), null, 2) + '\n');
    report.shrink.minimalReport = minimalPath;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`chaos shrink: ${candidates.length} -> ${shrunk.minimal.length} entries in ${shrunk.trials} trials: ${shrunk.minimal.map(entry => entry.name).join(', ')}`);
    console.log(`chaos shrink: minimal replayable report ${minimalPath}`);
  }
  if (report.status !== 'passed') exitCode = 1;
  console.log(`chaos seed: ${seed} (replay with: npm run test:chaos -- --replay ${reportPath})`);
} finally {
  if (!values.keep) await rm(work, { recursive: true, force: true }).catch(() => {});
  else console.log(`chaos: work directory retained: ${work}`);
  await dispatcher.close().catch(() => {});
}
process.exit(exitCode);
