/**
 * Debounced, storm-proof health & fault alerting for long-running Tendriller
 * native daemons (`tendril agent run`, copy-editor, Antigravity bridges).
 *
 * Parses structured JSON lines and error output from `tendril agent run`, ignores
 * single transient reconnect blips, and immediately alerts the active agent
 * conversation (e.g. via `agentapi send-message` in Google Antigravity) when a
 * host/peer/schema fault persists or the daemon exits unexpectedly.
 */
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const RAW_FAULT_RE = /\b(StorageSchemaError|SQLITE_ERROR|ECONNREFUSED|500 Internal Server Error|no such table:)/i;

/**
 * Classifies one stdout/stderr line emitted by `tendril agent run` into:
 * - `{ kind: 'fault', code, page, message }`
 * - `{ kind: 'healthy', source, page }`
 * - `null` (neutral informational line)
 */
export function parseAgentDiagnosticLine(rawLine) {
  const line = String(rawLine ?? '').trim();
  if (!line) return null;

  if (line.startsWith('{') && line.endsWith('}')) {
    let obj;
    try { obj = JSON.parse(line); } catch { obj = null; }
    if (obj && typeof obj === 'object') {
      const page = typeof obj.slug === 'string'
        ? obj.slug
        : (typeof obj.page === 'string' ? obj.page : null);

      if (obj.state === 'agent_revoked') {
        return { kind: 'fault', severity: 'critical', code: 'agent_revoked', page, message: obj.next || line };
      }
      if (obj.state === 'page_failed') {
        const code = typeof obj.code === 'string' ? `page_failed:${obj.code}` : 'page_failed';
        return { kind: 'fault', severity: 'critical', code, page, message: obj.message || line };
      }
      if (obj.state === 'session_ended') {
        const code = typeof obj.code === 'string' ? `session_ended:${obj.code}` : 'session_ended';
        return { kind: 'fault', severity: 'critical', code, page, message: line };
      }
      if (obj.broadcast_rejected && typeof obj.broadcast_rejected === 'object') {
        return { kind: 'fault', severity: 'critical', code: `broadcast_rejected:${obj.broadcast_rejected.reason || 'invalid'}`, page: null, message: line };
      }
      if (obj.state === 'rescan_failed') {
        const code = typeof obj.code === 'string' ? `rescan_failed:${obj.code}` : 'rescan_failed';
        return { kind: 'fault', severity: 'warn', code, page, message: line };
      }
      if (obj.state === 'grants_unavailable') {
        const code = typeof obj.code === 'string' ? `grants:${obj.code}` : 'grants_unavailable';
        return { kind: 'fault', severity: 'warn', code, page, message: line };
      }
      if (obj.admission === 'error') {
        const code = typeof obj.error === 'string' ? `admission:${obj.error}` : 'admission:error';
        return { kind: 'fault', severity: 'warn', code, page, message: line };
      }
      if (typeof obj.error === 'string' && obj.error) {
        // participation.mjs retains the last `error` across `connecting` retries; only count actual disconnect/error transitions.
        if (obj.connection === 'connecting') return null;
        return { kind: 'fault', severity: 'warn', code: obj.error, page, message: line };
      }
      if (obj.error && typeof obj.error === 'object' && typeof obj.error.code === 'string') {
        return { kind: 'fault', severity: 'warn', code: obj.error.code, page, message: obj.error.message || line };
      }
      if (typeof obj.materializationError === 'string' && obj.materializationError) {
        return { kind: 'fault', severity: 'critical', code: 'materialization_error', page, message: obj.materializationError };
      }
      if (obj.hub === 'reconnecting' && Number(obj.retryInMs) >= 8000) {
        return { kind: 'fault', severity: 'warn', code: `hub:reconnecting_${obj.retryInMs}ms`, page: null, message: line };
      }
      if (obj.setup && typeof obj.setup === 'object') {
        if (obj.setup.state === 'connected') return { kind: 'healthy', source: 'setup', page };
        if (obj.setup.state === 'reconnecting' && Number(obj.setup.retryInMs) >= 8000) {
          return { kind: 'fault', severity: 'warn', code: `setup:reconnecting_${obj.setup.retryInMs}ms`, page, message: line };
        }
      }
      if (obj.connection === 'connected') return { kind: 'healthy', source: 'peer', page };
      if (obj.state === 'running') return { kind: 'healthy', source: 'page', page };
      if (obj.change === 'materialized') return { kind: 'healthy', source: 'materialized', page };
      if (obj.hub === 'connected') return { kind: 'healthy', source: 'hub', page };
      return null;
    }
  }

  const m = RAW_FAULT_RE.exec(line);
  if (m) {
    return { kind: 'fault', severity: 'critical', code: m[1], page: null, message: line };
  }
  return null;
}

/**
 * Tracks rolling daemon faults and fires `onAlert` once sustained degradation crosses
 * `threshold` within `windowMs` (or immediately on unexpected process exit), with
 * per-signature cooldown suppression and a single `onRecovered` notification when healthy.
 */
export function createHealthAlertMonitor({
  label = 'Tendriller daemon',
  threshold = 3,
  windowMs = 60_000,
  cooldownMs = 5 * 60_000,
  minAlertIntervalMs = 60_000,
  healthyToRecover = 2,
  now = () => Date.now(),
  onAlert = () => {},
  onRecovered = () => {},
} = {}) {
  const events = [];
  const lastAlertBySignature = new Map();
  let lastAnyAlertAt = -Infinity;
  let alerting = false;
  let alertStartedAt = 0;
  let consecutiveHealthy = 0;
  let stopped = false;

  const prune = (t) => {
    const cutoff = t - windowMs;
    while (events.length && events[0].at < cutoff) events.shift();
  };

  const buildReport = (t) => {
    const counts = {};
    const pages = new Set();
    for (const ev of events) {
      counts[ev.code] = (counts[ev.code] ?? 0) + 1;
      if (ev.page) pages.add(ev.page);
    }
    const signature = Object.keys(counts).sort().join(',');
    const topCodes = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code, n]) => `${code} (×${n})`)
      .join(', ');
    return {
      label,
      signature,
      counts,
      totalFaults: events.length,
      pages: [...pages],
      summary: `${label} sustained ${events.length} faults in ${Math.round(windowMs / 1000)}s: ${topCodes}`,
      recentSamples: events.slice(-5).map((e) => e.message),
      at: t,
    };
  };

  function recordFault({ severity = 'warn', code = 'unknown_fault', page = null, message = code } = {}) {
    if (stopped) return null;
    const t = now();
    consecutiveHealthy = 0;
    events.push({ at: t, severity, code, page, message });
    prune(t);
    if (severity !== 'critical' && events.length < threshold) return null;

    const report = buildReport(t);
    const lastSent = lastAlertBySignature.get(report.signature) ?? -Infinity;
    if (t - lastSent < cooldownMs) return null;
    if (severity !== 'critical' && (t - lastAnyAlertAt < (alerting ? cooldownMs : minAlertIntervalMs))) return null;

    lastAlertBySignature.set(report.signature, t);
    lastAnyAlertAt = t;
    if (!alerting) {
      alerting = true;
      alertStartedAt = t;
    }
    try { onAlert(report); } catch {}
    return report;
  }

  function recordHealthy({ source = 'daemon', page = null } = {}) {
    if (stopped) return null;
    if (!alerting) return null;
    consecutiveHealthy += 1;
    if (consecutiveHealthy < healthyToRecover) return null;

    const t = now();
    const durationMs = Math.max(0, t - alertStartedAt);
    alerting = false;
    alertStartedAt = 0;
    consecutiveHealthy = 0;
    events.length = 0;
    lastAlertBySignature.clear();
    const notice = {
      label,
      source,
      page,
      durationMs,
      summary: `${label} recovered (${source}${page ? ` on ${page}` : ''}) after ${Math.round(durationMs / 1000)}s.`,
      at: t,
    };
    try { onRecovered(notice); } catch {}
    return notice;
  }

  function recordLine(line) {
    const parsed = parseAgentDiagnosticLine(line);
    if (!parsed) return null;
    if (parsed.kind === 'fault') return recordFault(parsed);
    if (parsed.kind === 'healthy') return recordHealthy(parsed);
    return null;
  }

  function reportExit(code, signal = null) {
    if (stopped) return null;
    if (code === 0 && !signal) return null;
    const t = now();
    const report = {
      label,
      signature: `exit:${code ?? signal}`,
      counts: { [`exit:${code ?? signal}`]: 1 },
      totalFaults: 1,
      pages: [],
      summary: `${label} exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`,
      recentSamples: events.slice(-5).map((e) => e.message),
      at: t,
    };
    alerting = true;
    alertStartedAt = t;
    try { onAlert(report); } catch {}
    return report;
  }

  return Object.freeze({
    recordLine,
    recordFault,
    recordHealthy,
    reportExit,
    stop() { stopped = true; },
    get alerting() { return alerting; },
  });
}

/**
 * Best-effort wake alert pushed to the active Google Antigravity conversation via
 * the documented `agentapi send-message` CLI. No-ops cleanly outside Antigravity.
 */
export function sendAntigravityAlert({
  title,
  body,
  env = process.env,
  execute = execFile,
} = {}) {
  if (env?.TENDRILLER_NO_HEALTH_ALERTS === '1') return false;
  if (execute === execFile && (env?.NODE_TEST_CONTEXT || env?.VITEST || env?.PLAYWRIGHT_TEST)) return false;
  const conversationId = String(env?.ANTIGRAVITY_CONVERSATION_ID ?? '').trim();
  if (!UUID.test(conversationId)) return false;
  const fromEnv = String(env?.ANTIGRAVITY_AGENTAPI_EXE ?? '').trim();
  const bin = fromEnv && /(?:^|[/\\])agentapi(?:\.exe)?$/iu.test(fromEnv) ? fromEnv : 'agentapi';
  execute(bin, ['send-message', `--title=${title || 'Tendriller Health Alert'}`, conversationId, body], {
    shell: false,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  }, () => {});
  return true;
}

/**
 * Tees a spawned `tendril agent run` child process's stdout/stderr to the parent
 * stdio while scanning every line for sustained faults and unexpected exits.
 */
export function monitorAgentProcess(child, {
  label = 'tendril agent run',
  threshold = 3,
  windowMs = 60_000,
  cooldownMs = 5 * 60_000,
  onAlert,
  onRecovered,
  env = process.env,
} = {}) {
  const defaultAlert = (report) => {
    const body = [
      `⚠️ ${report.summary}`,
      report.pages.length ? `Affected page(s): ${report.pages.join(', ')}` : null,
      report.recentSamples.length ? `Recent log samples:\n${report.recentSamples.map((s) => `  - ${s}`).join('\n')}` : null,
      'Inspect the daemon and local host logs right away — browser edits may be queued locally until sync recovers.',
    ].filter(Boolean).join('\n');
    sendAntigravityAlert({ title: `Health Alert: ${label}`, body, env });
  };
  const defaultRecovered = (notice) => {
    sendAntigravityAlert({
      title: `Recovered: ${label}`,
      body: `✅ ${notice.summary}`,
      env,
    });
  };

  const monitor = createHealthAlertMonitor({
    label,
    threshold,
    windowMs,
    cooldownMs,
    onAlert: onAlert ?? defaultAlert,
    onRecovered: onRecovered ?? defaultRecovered,
  });

  const wireStream = (stream, dest) => {
    if (!stream) return;
    stream.on('data', (chunk) => { dest.write(chunk); });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => { monitor.recordLine(line); });
  };

  wireStream(child.stdout, process.stdout);
  wireStream(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    monitor.reportExit(code, signal);
  });

  return monitor;
}
