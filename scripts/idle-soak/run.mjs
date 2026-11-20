import { readFileSync, openSync, closeSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { validateConfig, privateJSON, save, newState, record, markStopRequested, beginSegment, endSegment, report, digest, pathOutsideRepo, boundedActive } from './state.mjs';
import { measure } from './cloudflare.mjs';
import { startBrowser } from './browser.mjs';
import { nativeReady, quietBoundary } from './warmup.mjs';

export const NATIVE_BOOTSTRAP_SCOPES = Object.freeze(['native-only-without-mcp-adapter', 'native-with-mcp-adapter']);
export function nativeCoverage(state, message) {
  if (message?.idleSoakCoverage !== 1 || !NATIVE_BOOTSTRAP_SCOPES.includes(message.bootstrapScope)) return false;
  state.coverage.bootstrapScope = message.bootstrapScope;
  state.coverage.eventsForwarding = message.bootstrapScope === 'native-with-mcp-adapter' && message.eventsForwarding === true;
  state.coverage.wakeups ||= message.wakeups === true;
  state.coverage.modelTurns ||= message.modelTurns === true;
  return true;
}

/** Status is observation, never a reason to terminate the independently owned app. */
export function nativeAssistantStatus(state, message, now = Date.now()) {
  if (message?.idleSoakAssistantStatus !== 1 || typeof message.online !== 'boolean' || typeof message.eventsForwarding !== 'boolean' || typeof message.eventsForwardingBlocked !== 'boolean') return false;
  if (state.coverage.mcpOnline === message.online && state.coverage.eventsForwarding === message.eventsForwarding && state.coverage.eventsForwardingBlocked === message.eventsForwardingBlocked) return false;
  state.coverage.mcpOnline = message.online;
  state.coverage.eventsForwardingBlocked = message.eventsForwardingBlocked;
  state.coverage.mcpStatusAt = now;
  state.coverage.eventsForwarding = message.eventsForwarding;
  record(state, { source: 'native', kind: 'assistant-status', online: message.online, eventsForwarding: message.eventsForwarding, eventsForwardingBlocked: message.eventsForwardingBlocked }, now);
  return true;
}
export function nativeStopped(state, message, now = Date.now()) {
  if (message?.idleSoakStopped !== 1 || ['ownerClosed', 'observersSettled', 'assistantSettled', 'processDisposal'].some(key => message[key] !== true)) return false;
  state.events.push({ kind: 'native-owned-shutdown', at: now, ownerClosed: true, observersSettled: true, assistantSettled: true, processDisposal: true });
  return true;
}
export const nativeAssistantBusy = state => state?.coverage.bootstrapScope === 'native-with-mcp-adapter' && (state.coverage.mcpOnline !== true || state.coverage.eventsForwarding && state.coverage.eventsForwardingBlocked !== false);

export const waitUntil = (deadline, signal) => new Promise((resolve, reject) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
  const abort = () => { clearTimeout(timer); reject(Error('INTERRUPTED')); };
  const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
});
export function requestStop(state, abort, persist, now = Date.now()) {
  try { if (state && markStopRequested(state, now)) persist(); }
  finally { abort.abort(); }
}
export async function run(configPath, directory) {
  const root = resolve(import.meta.dirname, '../..');
  configPath = pathOutsideRepo(configPath, root); directory = pathOutsideRepo(directory, root);
  const c = validateConfig(privateJSON(configPath));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (statSync(directory).mode & 0o077) throw Error('PRIVATE_DIRECTORY_REQUIRED');
  const lockPath = resolve(directory, 'runner.lock');
  // Atomic local process lock. Stale locks are reclaimed only if the recorded PID is absent.
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = privateJSON(lockPath).pid;
    try { process.kill(pid, 0); throw Error('RUNNER_ALREADY_ACTIVE'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(lockPath); lock = openSync(lockPath, 'wx', 0o600);
  }
  const { writeFileSync } = await import('node:fs'); writeFileSync(lock, JSON.stringify({ pid: process.pid })); closeSync(lock);
  const checkpoint = resolve(directory, 'checkpoint.json');
  let s, native, browser, stopping = false;
  const abort = new AbortController();
  const stop = () => requestStop(s, abort, persist); process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const persist = () => { save(checkpoint, s); save(resolve(directory, 'report.json'), report(s)); };
  const pending = { browser: 0, native: 0 };
  const boundary = quietBoundary({ signal: abort.signal, busy: () => pending.browser + pending.native > 0 || nativeAssistantBusy(s) });
  const emit = event => {
    if (event?.kind === 'activity' && ['browser', 'native'].includes(event.source) && Number.isSafeInteger(event.pending) && event.pending >= 0) {
      pending[event.source] = event.pending; boundary.activity(); return;
    }
    if (record(s, event)) { boundary.activity(); persist(); }
  };
  try {
    try { s = privateJSON(checkpoint); } catch (e) { if (e.code !== 'ENOENT') throw e; s = newState(c); }
    if (s.configHash !== digest(JSON.stringify(c))) throw Error('CONFIG_CHANGED_USE_NEW_RUN_DIRECTORY');
    if (s.status === 'complete') return;
    if (s.segments.some(x => !x.endedAt)) {
      s.interruptions.push({ at: Date.now(), reason: 'PROCESS_RESTART_UNOBSERVED_GAP' });
      endSegment(s); s.segments.at(-1).incomplete = true;
    }
    s.provenance = { sourceCommit:c.provenance.sourceCommit, compositionId:c.provenance.compositionId };
    s.provenanceHash = digest(JSON.stringify(c.provenance));
    s.runnerHash = digest(readFileSync(fileURLToPath(import.meta.url)));
    s.adapterHash = createHash('sha256').update(readFileSync(c.adapter)).digest('hex');
    // A resumed attempt has its own stop boundary; prior timeline markers and
    // interruption/overrun evidence remain retained.
    delete s.stopRequestedAt;
    s.status = 'running'; persist();
    // Explicit read-only baseline before any measured target phase. Never store credentials or raw API errors.
    if (!s.baseline) { s.baseline = await measure(c, Date.now() - 3600000, Date.now()); save(resolve(directory, 'baseline.json'), s.baseline); persist(); }
    native = spawn(c.native.argv[0], [...c.native.argv.slice(1)], { cwd: c.native.cwd,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${fileURLToPath(new URL('./native-observer.mjs', import.meta.url))}` },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ready = nativeReady(native, { signal: abort.signal }); ready.catch(() => {});
    s.nativeStartedAt = Date.now(); s.events.push({kind:'native-start',at:s.nativeStartedAt}); persist();
    native.on('message', message => {
      if (message?.idleSoak === 1) emit(message);
      if (message?.idleSoakActivity === 1) emit({ ...message, kind: 'activity' });
      if (nativeAssistantStatus(s, message)) { boundary.activity(); persist(); }
      if (nativeCoverage(s, message)) { boundary.activity(); persist(); }
      if (nativeStopped(s, message)) persist();
    });
    native.on('error', () => { s.failures.push('NATIVE_START_FAILED'); stop(); });
    native.on('exit', (code, signal) => { s.nativeExitedAt = Date.now(); s.nativeExit = { code, signal }; s.events.push({kind:'native-exit',at:s.nativeExitedAt,code,signal}); if (!stopping) { s.failures.push('NATIVE_EXITED_DURING_SOAK'); stop(); } persist(); });
    browser = await startBrowser(c, emit);
    const coverage = await browser.adapter.audit?.({ config: c });
    s.coverage.modelTurns ||= coverage?.modelTurns === true;
    s.coverage.wakeups ||= coverage?.wakeups === true;
    // Optional event-driven external audit; no periodic calls are scheduled.
    await browser.adapter.observe?.({ record: emit, config: c, signal: abort.signal });
    await ready; s.events.push({ kind: 'native-ready', at: Date.now() }); persist();
    for (const phase of ['closed', 'background', 'foreground']) {
      if (s.segments.some(x => x.phase === phase && !x.incomplete && x.endedAt >= x.deadline)) continue;
      const transitionStart = Date.now();
      const residency = await boundedActive(() => browser.phase(phase), {attempts:1, expiresAt:Date.now()+60000, signal:abort.signal});
      await boundedActive(() => browser.settle(), {attempts:1, expiresAt:Date.now()+60000, signal:abort.signal});
      s.events.push({ kind: 'residency', phase, ...residency, workerBootstrap: browser.workerBootstrapEvidence(), at: Date.now(), transitionMs: Date.now() - transitionStart });
      // Complete startup and drain boundary traffic before measuring; continuous
      // activity fails this bounded barrier instead of earning idle credit.
      await boundary.wait();
      beginSegment(s, phase); s.segments.at(-1).pendingClientRequestsAtStart = { ...pending }; persist();
      await waitUntil(s.segments.at(-1).deadline, abort.signal);
      endSegment(s); persist();
      if (phase !== 'closed') { s.events.push({ kind: 'reconnect', phase, ...await browser.reconnect(), workerBootstrap: browser.workerBootstrapEvidence(), at: Date.now() }); persist(); }
    }
    s.status = 'collecting'; persist();
    stopping = true;
    if (markStopRequested(s)) persist();
    await browser.close(); browser = undefined;
    await stopNative(native); native = undefined;
    // Metrics windows exclude transitions and controlled reconnects. Collect after sockets close + ingestion lag.
    s.collectAfter = Date.now() + (c.metricsLagMs ?? 900000); persist();
    await waitUntil(s.collectAfter, abort.signal);
    s.metrics = [];
    for (const segment of s.segments.filter(x => !x.incomplete)) {
      const values = await measure(c, segment.startedAt, segment.endedAt);
      s.metrics.push(...values.map(x => ({ phase: segment.phase, ...x }))); persist();
    }
    s.status = 'complete'; s.finishedAt = Date.now(); persist();
  } catch (e) {
    if (s) { s.status = 'interrupted'; s.failures.push(abort.signal.aborted ? 'INTERRUPTED' : 'RUNNER_STEP_FAILED');
      if (s.segments.at(-1) && !s.segments.at(-1).endedAt) { endSegment(s); s.segments.at(-1).incomplete = true; }
      persist(); }
    throw Error('SOAK_INCOMPLETE_SEE_PRIVATE_CHECKPOINT');
  } finally {
    try { if (s && markStopRequested(s)) persist(); }
    finally {
      stopping = true; await browser?.close().catch(() => {}); if (native) await stopNative(native);
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); unlinkSync(lockPath);
    }
  }
}
async function stopNative(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, state: { type: 'string' } } });
  if (!values.config || !values.state) throw Error('Use --config PRIVATE_JSON --state PRIVATE_DIRECTORY');
  run(values.config, values.state).catch(() => { console.error('Idle soak incomplete; inspect the private checkpoint and documentation.'); process.exitCode = 1; });
}
