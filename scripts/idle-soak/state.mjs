import { openSync, closeSync, writeFileSync, renameSync, fsyncSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const HOUR = 3600000;
export const counters = ['requests', 'socketsOpened', 'socketsClosed', 'framesSent', 'framesReceived', 'bytesSent', 'bytesReceived', 'modelTurns', 'wakeups'];
export const digest = value => createHash('sha256').update(value).digest('hex');
export function privateJSON(path) {
  const s = statSync(path);
  if (!s.isFile() || (s.mode & 0o077) || s.uid !== process.getuid()) throw Error('PRIVATE_FILE_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function save(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function validateConfig(c) {
  if (![24, 48].includes(c.hours) || c.isolated !== true) throw Error('ISOLATED_24_OR_48_HOURS_REQUIRED');
  if (!/^[a-f0-9]{32}$/.test(c.account) || !/^[a-zA-Z0-9_-]+$/.test(c.worker) || !Array.isArray(c.namespaces) || !c.namespaces.length || !c.namespaces.every(x => /^[a-f0-9]{32}$/.test(x))) throw Error('EXPLICIT_CLOUDFLARE_SCOPE_REQUIRED');
  const url = new URL(c.pageUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('CLEAN_HTTPS_PAGE_REQUIRED');
  if (!c.provenance || !/^[a-f0-9]{40}$/.test(c.provenance.sourceCommit) || !/^[a-f0-9]{64}$/.test(c.provenance.compositionId)) throw Error('DEPLOYED_PROVENANCE_REQUIRED');
  if (!Array.isArray(c.native?.argv) || !c.native.argv.length || !c.native.argv.every(x => typeof x === 'string') || !c.native.cwd?.startsWith('/')) throw Error('EXISTING_NATIVE_COMMAND_REQUIRED');
  if (!c.adapter?.startsWith('/') || !c.browserProfile?.startsWith('/')) throw Error('PRIVATE_ADAPTER_AND_PROFILE_REQUIRED');
  if (!c.wrangler?.startsWith('/')) throw Error('ABSOLUTE_WRANGLER_REQUIRED');
  if (c.metricsLagMs !== undefined && (!Number.isSafeInteger(c.metricsLagMs) || c.metricsLagMs < 300000 || c.metricsLagMs > HOUR)) throw Error('METRICS_LAG_5_TO_60_MINUTES');
  return c;
}
export function newState(c, now = Date.now()) {
  return { format: 'tendriller-idle-soak-v1', configHash: digest(JSON.stringify(c)), plannedHours: c.hours,
    createdAt: now, status: 'running', segments: [], events: [], metrics: [], interruptions: [], failures: [],
    counts: Object.fromEntries(counters.map(k => [k, 0])), coverage: { modelTurns: false, wakeups: false, bootstrapScope: 'operator-command-unverified', modelScope: 'external-dispatch-unverified', nativeTransport: 'global-fetch-websocket-only', browserTransport: 'playwright-context-http-page-websocket' } };
}
export function record(s, event) {
  // Fixed vocabulary and numeric increments only. Never retain URLs, headers, payloads, error text or arbitrary labels.
  if (!event || !['browser', 'native', 'adapter', 'runner'].includes(event.source) || !counters.includes(event.kind) || !Number.isSafeInteger(event.count ?? 1) || (event.count ?? 1) < 0) return false;
  s.counts[event.kind] += event.count ?? 1;
  return true;
}
export function beginSegment(s, phase, now = Date.now()) {
  if (!['closed', 'background', 'foreground'].includes(phase)) throw Error('INVALID_PHASE');
  const segment = { phase, startedAt: now, deadline: now + s.plannedHours * HOUR / 3, counts: { ...s.counts } };
  s.segments.push(segment); return segment;
}
export function endSegment(s, now = Date.now()) {
  const segment = s.segments.at(-1); segment.endedAt = now;
  segment.observedMs = now - segment.startedAt;
  segment.delta = Object.fromEntries(counters.map(k => [k, s.counts[k] - segment.counts[k]]));
  segment.overruns = Object.entries(segment.delta).filter(([, value]) => value > 0).map(([key, value]) => ({ counter: key, actual: value, budget: 0 }));
  if (now < segment.deadline) segment.incomplete = true;
  return segment;
}
export async function boundedActive(action, { signal, attempts = 4, expiresAt = Date.now() + 30000, now = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let i = 0; i < attempts && now() < expiresAt; i++) {
    signal?.throwIfAborted();
    try {
      const active = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, expiresAt - now()))]);
      return await new Promise((resolve, reject) => {
        const abort = () => reject(Error('ACTIVE_RETRY_EXPIRED'));
        if (active.aborted) { abort(); return; }
        active.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => action(i, active)).then(resolve, reject).finally(() => active.removeEventListener('abort', abort));
      });
    }
    catch { if (i + 1 === attempts || now() >= expiresAt || signal?.aborted) break; }
    await wait(Math.min(1000 * 2 ** i, Math.max(0, expiresAt - now())));
  }
  throw Error('ACTIVE_RETRY_EXPIRED');
}
export function report(s) {
  const metricsComplete = s.metrics.length > 0 && s.metrics.every(m => m.status === 'available');
  const complete = s.status === 'complete' && s.interruptions.length === 0 && s.failures.length === 0 && s.segments.length === 3 && s.segments.every(x => x.endedAt >= x.deadline && !x.incomplete);
  return { format: s.format, status: complete && metricsComplete && s.coverage.modelTurns && s.coverage.wakeups && s.segments.every(x => !x.overruns.length) && s.metrics.every(x => !x.overruns?.length) ? 'pass' : 'incomplete-or-over-budget',
    realWallClockComplete: complete, plannedHours: s.plannedHours, metricsComplete,
    provenance: s.provenance, provenanceHash: s.provenanceHash, adapterHash: s.adapterHash, runnerHash: s.runnerHash, nativeStartedAt: s.nativeStartedAt, nativeExitedAt: s.nativeExitedAt, nativeExit: s.nativeExit, coverage: s.coverage, counts: Object.fromEntries(Object.entries(s.counts).map(([k,v]) => [k, ['modelTurns','wakeups'].includes(k) && !s.coverage[k] ? null : v])), segments: s.segments.map(x => ({...x, counts: Object.fromEntries(Object.entries(x.counts).map(([k,v]) => [k, ['modelTurns','wakeups'].includes(k) && !s.coverage[k] ? null : v])), delta: x.delta && Object.fromEntries(Object.entries(x.delta).map(([k,v]) => [k, ['modelTurns','wakeups'].includes(k) && !s.coverage[k] ? null : v]))})), metrics: s.metrics,
    interruptions: s.interruptions, failures: s.failures, events: s.events,
    idleBudgets: Object.fromEntries(counters.map(k => [k, 0])),
    limitations: ['Client counters cover the declared observer scopes, not all OS traffic.', 'Provider aggregates may be sampled or delayed; empty datasets are missing, never zero.', 'No account-wide free-tier capacity or invoice claim is established.'] };
}
export function pathOutsideRepo(path, root) {
  const p = resolve(path), r = resolve(root);
  if (p === r || p.startsWith(r + '/')) throw Error('PRIVATE_STATE_MUST_BE_OUTSIDE_REPOSITORY');
  return p;
}
