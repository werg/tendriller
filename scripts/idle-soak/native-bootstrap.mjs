// Run with cwd set to the dedicated, already prepared synthetic agent workspace (one page,
// initialized, published, owner signed in, browser enrolled). It starts that workspace's one
// `tendril agent run` and observes its reports; it performs no setup, enrollment, assistant
// preparation or model invocation, and never opens a page store itself.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function bootstrapOptions(args) {
  const { values } = parseArgs({ args, options: { assistant: { type: 'boolean', default: false }, events: { type: 'boolean', default: false } } });
  if (values.events && !values.assistant) throw Error('EVENTS_REQUIRE_ASSISTANT');
  return values;
}

const fail = code => Object.assign(Error(code), { code });

/** The soak workspace has exactly one initialized page; its assistant preparation matches the selected scope. */
export async function readSoakWorkspace(root, { assistant = false, events = false } = {}, { read = path => readFile(path, 'utf8'), exists = existsSync } = {}) {
  let config;
  try { config = JSON.parse(await read(join(root, 'tendriller.json'))); } catch { throw fail('AGENT_WORKSPACE_REQUIRED'); }
  if (typeof config?.agent?.id !== 'string' || !exists(join(root, '.tendriller/agent/credential.json'))) throw fail('WORKSPACE_AGENT_CREDENTIAL_REQUIRED');
  const pages = Object.entries(config.pages ?? {});
  // The agent program opens every initialized page; other pages would pollute attribution.
  if (pages.length !== 1) throw fail('DEDICATED_SOAK_WORKSPACE_REQUIRED');
  const [[slug, { id }]] = pages;
  const directory = join(root, '.tendriller/pages', id);
  if (!exists(join(directory, 'page.json'))) throw fail('PAGE_RECORD_REQUIRED');
  if (!exists(join(directory, 'initialized.json'))) throw fail('PAGE_INITIALIZATION_REQUIRED');
  if (!exists(join(root, 'pages', slug, 'agent.mjs'))) throw fail('PAGE_MODULE_REQUIRED');
  if (!exists(join(root, 'node_modules/@tendriller/tools/bin/tendril.mjs'))) throw fail('INSTALLED_TOOLS_REQUIRED');
  // The page module starts its approved adapter whenever assistant.json exists, so the
  // selected scope must equal the operator's completed preparation.
  let prepared = null;
  if (exists(join(directory, 'assistant.json'))) {
    const { proposalId } = JSON.parse(await read(join(directory, 'assistant.json')));
    prepared = JSON.parse(await read(join(directory, `assistant-proposal-${proposalId}.json`)));
  }
  if (assistant !== Boolean(prepared) || assistant && Boolean(prepared.forwardEvents) !== events) throw fail('ASSISTANT_PREPARATION_MISMATCH');
  return { root, agent: config.agent.id, page: { slug, id } };
}

/** The workspace's own agent program, with the observer preload inherited through NODE_OPTIONS. */
export function spawnAgentProgram(root, { onReport, onMessage }) {
  const child = spawn(process.execPath, [join(root, 'node_modules/@tendriller/tools/bin/tendril.mjs'), 'agent', 'run'],
    // Stderr is discarded: it may carry application detail. Reports are fixed-shape JSON lines.
    { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { let value; try { value = JSON.parse(line); } catch { return; } onReport(value); });
  // Observer counters from the agent program's own fetch/WebSocket calls reach the runner unchanged.
  child.on('message', message => onMessage(message));
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ended = new Promise(resolve => lines.once('close', resolve));
  return { exited: Promise.all([exited, ended]).then(([exit]) => exit),
    stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); } };
}

const READY_PHASES = ['connected'];
const RECONCILIATION_FAILURES = ['awaiting_owner_claim', 'setup_retry', 'setup_channel_closed'];

/** Observation/readiness only: the page owner, authority refresh and assistant lifecycle stay inside the agent program. */
export async function runNativeBootstrap({ assistant = false, events = false, workspace, signal, record, send }, { spawnAgent }) {
  if (events && !assistant) throw Error('EVENTS_REQUIRE_ASSISTANT');
  if (typeof record !== 'function' || typeof send !== 'function') throw Error('START_WITH_IDLE_SOAK_RUNNER');
  if (!workspace?.page?.id) throw Error('AGENT_WORKSPACE_REQUIRED');
  signal?.throwIfAborted();
  const pageId = workspace.page.id;
  let hubConnected = false, activated = false, localCanAuthor = false, participationReady = false, reconciled = false, adapterReady = !assistant;
  let sentReady = false, observing = true, lastOnline, lastBlocked, eventsForwardingBlocked = false, stoppedReported = false, failure;
  const assistantStatus = online => {
    adapterReady = online;
    if (!assistant || lastOnline === online && lastBlocked === eventsForwardingBlocked) return;
    lastOnline = online; lastBlocked = eventsForwardingBlocked;
    send({ idleSoakAssistantStatus: 1, online, eventsForwarding: events, eventsForwardingBlocked });
  };
  const ready = () => {
    if (sentReady || !observing || !hubConnected || !activated || !localCanAuthor || !participationReady || !reconciled || !adapterReady || eventsForwardingBlocked) return;
    sentReady = true;
    send({ idleSoakCoverage: 1, bootstrapScope: assistant ? 'native-with-mcp-adapter' : 'native-only-without-mcp-adapter', wakeups: true, modelTurns: false, eventsForwarding: assistant && events });
    send({ idleSoakReady: 1 });
  };
  const stopped = Promise.withResolvers();
  const fatal = code => { failure ??= fail(code); stopped.resolve(); };
  const onReport = value => {
    if (value?.running === false) { stoppedReported = true; return; }
    if (!observing || !value || typeof value !== 'object') return;
    if (value.hub !== undefined) {
      record('wakeups'); hubConnected = value.hub === 'connected';
      if (value.hub === 'revoked') fatal('AGENT_REVOKED');
      return ready();
    }
    if (value.state === 'agent_revoked') return fatal('AGENT_REVOKED');
    if (value.page !== pageId) return;
    // Counts every actual page callback: setup notices and retries, admission notices,
    // participation status, application changes and assistant status.
    record('wakeups');
    if (value.state === 'running') activated = true;
    if (typeof value.canAuthor === 'boolean') localCanAuthor = value.canAuthor;
    if (['page_failed', 'page_retry', 'session_ended', 'closed'].includes(value.state)) { activated = false; localCanAuthor = false; participationReady = false; }
    if (value.connection !== undefined) participationReady = READY_PHASES.includes(value.connection) && !value.error;
    if (value.setup) reconciled = value.setup.state === 'connected';
    if (RECONCILIATION_FAILURES.includes(value.state)) reconciled = false;
    if (assistant) {
      if (value.state === 'adapter_activity_failed' && events) { eventsForwardingBlocked = true; assistantStatus(adapterReady); }
      if (value.state === 'adapter_online') assistantStatus(true);
      if (['adapter_offline', 'assistant_stopped', 'setup_channel_closed', 'awaiting_assistant_consent'].includes(value.state) ||
          ['disconnected', 'closed'].includes(value.assistant?.state)) assistantStatus(false);
    }
    ready();
  };
  if (assistant) assistantStatus(false);
  const program = spawnAgent({ onReport, onMessage: message => send(message) });
  const abort = () => stopped.resolve();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let exit;
  try {
    exit = await Promise.race([program.exited, stopped.promise.then(() => undefined)]);
    if (exit && !signal?.aborted) failure ??= fail('AGENT_PROGRAM_EXITED');
  } finally {
    signal?.removeEventListener('abort', abort);
    observing = false; if (assistant) assistantStatus(false);
    program.stop();
    exit ??= await program.exited;
  }
  if (failure) throw failure;
  // SIGTERM closes every page owner, the hub and the attach socket before a zero exit.
  const ownerClosed = stoppedReported && exit.code === 0 && exit.signal === null;
  return { ownerClosed, observersSettled: true, assistantSettled: true };
}

// The dedicated runner child owns its process too. Dispose it only after the agent
// program has exited from its own owned shutdown. This is explicit process disposal,
// not a claim that every WebSocket completed a graceful remote close handshake.
export async function disposeStoppedBootstrap(receipt, { send, disconnect, exit }) {
  if (!receipt?.ownerClosed || !receipt.observersSettled || !receipt.assistantSettled) throw Error('NATIVE_OWNED_SHUTDOWN_REQUIRED');
  await send({ idleSoakStopped: 1, ownerClosed: true, observersSettled: true, assistantSettled: true, processDisposal: true });
  disconnect(); exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = bootstrapOptions(process.argv.slice(2));
  const record = globalThis[Symbol.for('tendriller.idle-soak.record')];
  if (!record || !process.send) throw Error('START_WITH_IDLE_SOAK_RUNNER');
  const stop = new AbortController(), abort = () => stop.abort();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, abort);
  try {
    const root = resolve('.');
    const workspace = await readSoakWorkspace(root, options);
    const receipt = await runNativeBootstrap({ ...options, workspace, record, send: value => process.send(value), signal: stop.signal },
      { spawnAgent: callbacks => spawnAgentProgram(root, callbacks) });
    await disposeStoppedBootstrap(receipt, { send: value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve())),
      disconnect: () => { if (process.connected) process.disconnect(); }, exit: code => process.exit(code) });
  } finally { for (const event of ['SIGTERM', 'SIGINT']) process.removeListener(event, abort); }
}
