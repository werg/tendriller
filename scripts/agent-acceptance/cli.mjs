#!/usr/bin/env node
import { createServer, request } from 'node:http';
import { mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir, platform, release, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AppServer } from './protocol.mjs';
import { Evidence, privateDirectory, innocentPrompt, now, hash, readJson, externalReport } from './evidence.mjs';
import { createOwner, mcpBridge } from './owner.mjs';
import { adapterCall } from './adapter.mjs';
import { sourceIdentity } from '../release-composition.mjs';
import { StarterObserver } from './observer.mjs';

const help = `Usage (Node 24, Codex app-server, Playwright Chromium):
  node scripts/agent-acceptance/cli.mjs run --origin https://HOST --mode domain|mcp
    --output /private/new-run --release-root /clean/exact-deployed-checkout
    --access /private/review-access.json [--observer-config /private/run-observer.json]
    [--adapter /absolute/external-observer]
    [--no-browser] [--model MODEL] [--seconds 1800]
  ... send --output RUN --input /private/{kind,text}.json
  ... owner --output RUN --input /private/owner-action.json
  ... observe --output RUN --input /private/{check,options}.json
  ... status|stop --output RUN
  ... protocol-smoke --output /private/new-run [--seconds 20]
  ... external-report --output /private/new-run --input /private/external-host.json

No-browser requires an external observer adapter; it does not qualify browser behavior.
Only explicit evaluator actions control the owner. No implementation hints enter the initial prompt.
Reports remain blocked until every required check has independently observed evidence.
See docs/AGENT_ONBOARDING_TEST.md for the observer and owner protocols.`;

function isolatedEnvironment(directory) {
  const home = join(directory, 'home'), codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  // Copy only model credentials. Never inherit maintainer config, skills or memories.
  const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  if (existsSync(auth)) { copyFileSync(auth, join(codexHome, 'auth.json')); }
  return { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: join(directory, 'tmp'), RUST_LOG: 'off', OTEL_SDK_DISABLED: 'true',
    ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}) };
}
function version() {
  try { return execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { throw Error('Install a qualified Codex CLI with app-server support'); }
}
function exactOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || value !== url.origin) throw Error('Use an exact HTTPS service origin');
  return value;
}

export async function run(values) {
  if (!values.output) throw Error('Explicit --output is required');
  const smoke = values.command === 'protocol-smoke';
  const mode = values.mode ?? 'domain';
  if (!['domain', 'mcp'].includes(mode)) throw Error('Mode must be domain or mcp');
  if (!smoke && (!values.origin || !values['release-root'] || (!values.access && !values['no-browser']))) throw Error('Live runs require origin, release-root and owner access or an external adapter');
  if (values.adapter && values['observer-config']) throw Error('Choose maintained --observer-config or an external --adapter');
  if (!smoke && values['no-browser'] && (!values.adapter && !values['observer-config'] || mode === 'mcp')) throw Error('No-browser requires an observer; MCP requires genuine account OAuth in the owner browser');
  if (values.adapter && !isAbsolute(values.adapter)) throw Error('Adapter must be an absolute trusted executable path');
  const seconds = Number(values.seconds ?? (smoke ? 20 : 1800));
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 7200) throw Error('Seconds must be between 1 and 7200');
  const origin = smoke ? null : exactOrigin(values.origin);
  const directory = privateDirectory(values.output), project = join(directory, 'project');
  mkdirSync(project, { mode: 0o700 }); mkdirSync(join(directory, 'tmp'), { mode: 0o700 });
  const evidence = new Evidence(directory, { mode, origin, harnessSource: sourceIdentity(resolve(import.meta.dirname, '../..')),
    environment: { node: process.version, os: platform(), release: release(), arch: arch(), codex: version(),
    context: 'Empty project, isolated HOME/CODEX_HOME, model auth only, no copied configuration/skills/memories',
    network: 'Host network; no network sandbox', approvals: 'never', sandbox: 'danger-full-access' } });
  let host, browser, bridge, server, timer, busy = false, threadId, closing = false, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  // Configuration may be completed after the innocent agent produces its app.
  // It is evaluator-only and never included in any model message.
  const observer = values['observer-config'] ? new StarterObserver({ configPath: resolve(values['observer-config']), runDirectory: directory, project, origin }) : null;
  const close = async () => {
    if (closing) return; closing = true; clearTimeout(timer);
    if (server) { server.close(); server.closeAllConnections(); }
    const cleanup = await Promise.allSettled([host?.close(), bridge?.close(), browser?.close()]);
    try {
      evidence.data.nativeHost = { ...evidence.data.nativeHost, stoppedAt: now(), exitCode: host?.child.exitCode ?? null, signal: host?.child.signalCode ?? null };
      evidence.data.cleanup = { appServerStopped: !host || host.child.exitCode != null || host.child.signalCode != null, browserClosed: cleanup[2].status === 'fulfilled',
        privateProjectRetained: true, remoteApps: 'Observer must reconcile and delete only run-owned apps; no blanket account deletion',
        detachedParticipants: 'Not automatically discovered; cleanup observation required' };
      if (cleanup.some(result => result.status === 'rejected') || !evidence.data.cleanup.appServerStopped)
        evidence.data.checks.cleanup = { status: 'failed', source: 'harness', observedAt: now() };
      // Host caches/telemetry are not evidence. Preserve authored app stores, not
      // copied model credentials or any host-internal conversation representation.
      rmSync(join(directory, 'home/.codex'), { recursive: true, force: true });
      evidence.finish();
    } finally { resolveDone(); }
  };
  const signal = () => { close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', signal); process.once('SIGINT', signal);
  try {
    if (!smoke) {
      // Fail closed before model/tool/package acquisition, OAuth or owner mutation.
      const { reviewComposition, preflightReviewDeployment, reviewProvenance } = await import('../review/preflight.mjs');
      const composition = reviewComposition(resolve(values['release-root']));
      const readiness = await preflightReviewDeployment(origin, composition);
      evidence.data.deployment = reviewProvenance(composition, readiness);
      const manifest = readJson(join(resolve(values['release-root']), 'dist/manifest.json'));
      evidence.data.artifacts = manifest.artifacts.map(({ role, file, sha256, size }) => ({ role, file, sha256, size }));
      evidence.save();
      if (!values['no-browser']) {
        const { readReviewAccess } = await import('../review/access.mjs');
        if (readReviewAccess(resolve(values.access)).origin !== origin) throw Error('Owner account origin differs from selected deployment');
        const { chromium } = await import('@playwright/test');
        browser = await createOwner({ accessPath: resolve(values.access), chromium, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          record: value => evidence.private('owner', value) });
        if (observer) observer.owner = browser.owner;
        evidence.data.environment.browser = browser.version;
      } else evidence.data.limits.push('Owner browser unavailable: external observer evidence is required.');
    }
    const env = isolatedEnvironment(directory);
    const config = ['mcp_servers={}', 'web_search="live"', 'history.persistence="none"'];
    if (mode === 'mcp' && !smoke) {
      bridge = await mcpBridge({ origin, token: await browser.owner.freshToken(), freshToken: async options => {
        const token = await browser.owner.freshToken(options);
        evidence.private('mcp-auth', { event: 'request-driven-renewal', reason: 'http-401' });
        return token;
      } });
      config[0] = 'mcp_servers={tendriller={url=' + JSON.stringify(bridge.url) + ',startup_timeout_sec=30}}';
      evidence.data.mcp = { origin, authentication: 'Real review-account OAuth/PKCE; renewed before every model turn and once on HTTP 401 with coalesced renewal and exact request replay', catalog: 'Unmodified selected-origin tools through credential-isolating loopback transport' };
    }
    host = new AppServer({ cwd: project, env, config, deadlineMs: Math.min(seconds * 1000, 60000), onEvent: event => {
      evidence.private('observable', event);
      if (event.event === 'turn') { busy = false; evidence.data.lastTurn = { status: event.status, at: now() }; evidence.save(); }
    } });
    evidence.data.nativeHost = { pid: host.child.pid, startedAt: now(), processLifetime: 'Bounded harness process; no wake/handoff promised' };
    evidence.private('environment', { initialized: await host.initialize() });
    const thread = await host.rpc('thread/start', { cwd: project, ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access',
      ...(values.model ? { model: values.model } : {}) });
    threadId = thread.thread.id;
    evidence.private('instruction-sources', { sources: thread.instructionSources ?? [] });
    if (thread.instructionSources?.length) throw Error('Fresh thread inherited instruction sources');
    evidence.data.environment.model = thread.model ?? null; evidence.data.environment.provider = thread.modelProvider ?? null;
    evidence.private('thread', { threadId, project }); evidence.save();
    const turn = async text => {
      if (busy) throw Error('Model turn already running');
      busy = true;
      try {
        if (bridge) {
          bridge.refresh(await browser.owner.freshToken());
          await host.rpc('config/mcpServer/reload', null);
          const status = await host.rpc('mcpServerStatus/list', { threadId, serverName: 'tendriller', detail: 'full' });
          evidence.private('catalog', { status });
          const tools = status.data?.find(server => server.name === 'tendriller')?.tools;
          if (!tools || !Object.keys(tools).length) throw Error('Selected-origin tool catalog unavailable');
          evidence.data.mcp.catalogSha256 = hash(JSON.stringify(tools));
          evidence.data.mcp.refreshedAt = now(); evidence.save();
          // Status is retained for source/tool verification, never converted into an invented tool catalog.
        }
        evidence.private('prompts', { text });
        const result = await host.rpc('turn/start', { threadId, cwd: project, input: [{ type: 'text', text }], approvalPolicy: 'never', summary: 'none' });
        return { turnId: result.turn.id };
      } catch (error) { busy = false; throw error; }
    };
    if (smoke) {
      evidence.data.limits.push('Protocol smoke only: real app-server initialization and empty thread, no model turn, browser, service or app verification.');
      await close(); return directory;
    }
    server = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST') throw Error('POST required');
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) throw Error('Control input too large'); }
        const input = JSON.parse(raw); let result;
        if (input.action === 'status') result = { busy, report: evidence.data };
        else if (input.action === 'send') {
          if (busy) throw Error('Model turn already running');
          if (typeof input.text !== 'string' || !input.text.trim()) throw Error('Text required');
          evidence.intervention(input.kind, input.text); result = await turn(input.text);
        } else if (input.action === 'owner') {
          if (!browser) throw Error('Use the external owner adapter');
          let publishedPageUrl;
          if (observer && ['navigate', 'reopen'].includes(input.input.action)) {
            try { publishedPageUrl = observer.config().handle.page_url; } catch {} // Service-origin sign-in/review still works before app config exists.
          }
          result = await browser.owner.act(input.input, { publishedPageUrl });
        } else if (input.action === 'observe') {
          if (!observer && !values.adapter) throw Error('Configure --observer-config or a trusted external --adapter');
          const observation = observer ? await observer.observe(input.input) : await adapterCall(values.adapter,
            { ...input.input, protocol: 'tendriller-agent-adapter-v1', action: 'observe', runDirectory: directory, project, origin });
          if (observation.check !== input.input.check) throw Error('Observer returned a different check');
          evidence.observation(observation, observer ? 'maintained-starter-observer' : 'external-observer');
          result = { recorded: true, status: observation.status, ...(['missing', 'mismatches'].some(key => observation.evidence[key]) ? { metrics: observation.evidence } : {}) };
        } else if (input.action === 'stop') { res.end('{}'); await close(); return; }
        else throw Error('Unknown controller action');
        res.end(JSON.stringify(result));
      } catch (error) {
        evidence.private('control-failure', { message: error.message });
        res.writeHead(409); res.end(JSON.stringify({ error: 'Control action failed; inspect private control-failure.jsonl and current status. No private diagnostics were published.' }));
      }
    });
    const socket = join(directory, 'control.sock');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    writeFileSync(join(directory, 'controller.json'), JSON.stringify({ pid: process.pid, socket }), { mode: 0o600 });
    timer = setTimeout(() => { evidence.data.deadlineReached = true; signal(); }, seconds * 1000);
    await turn(innocentPrompt(origin, mode));
    console.log('Fresh agent running. Use status, owner, send, observe and stop with the private --output directory.');
    await done; return directory;
  } catch (error) {
    evidence.private('failure', { code: error.code ?? 'harness-error', message: error.message });
    evidence.data.failure = { stage: host ? 'agent-runtime' : 'preflight-or-owner',
      prerequisiteCode: /^[a-z_]+$/.test(error.code ?? '') ? error.code : 'see-private-failure-record',
      nextAction: 'Read failure.jsonl for the exact prerequisite and service next action. Preserve this run; start a new baseline after resolving it.' };
    await close(); throw Error('Acceptance run blocked; see the private report. Raw diagnostics withheld.');
  } finally { process.removeListener('SIGTERM', signal); process.removeListener('SIGINT', signal); }
}

export function control(directory, input) {
  const { socket } = readJson(join(resolve(directory), 'controller.json'));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: 'POST', path: '/', timeout: 60000 }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(Error('Control action rejected')));
    });
    req.on('error', () => reject(Error('Private controller unavailable')));
    req.on('timeout', () => req.destroy()); req.end(JSON.stringify(input));
  });
}
export async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries([
    ...['origin', 'mode', 'output', 'release-root', 'access', 'adapter', 'observer-config', 'model', 'seconds', 'input'].map(key => [key, { type: 'string' }]),
    ['no-browser', { type: 'boolean' }], ['help', { type: 'boolean' }],
  ]) });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  if (['run', 'protocol-smoke'].includes(command)) { await run({ ...values, command }); return; }
  if (command === 'external-report') {
    if (!values.output || !values.input) throw Error('External report requires --output and --input');
    externalReport(privateDirectory(values.output), readJson(resolve(values.input))); return;
  }
  if (!values.output || !['status', 'send', 'owner', 'observe', 'stop'].includes(command)) throw Error('Use --help');
  const input = values.input ? readJson(resolve(values.input)) : {};
  const result = await control(values.output, { ...(['owner', 'observe'].includes(command) ? { input } : input), action: command });
  // Controller responses can contain visible owner text. This is private terminal output.
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
