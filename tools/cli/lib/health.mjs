/**
 * Platform-wide health & fault alerting for `tendril agent run`.
 *
 * Observes every structured event emitted by `runAgent` (hub, grants, admission,
 * peer participation, page open/materialization, broadcasts) so agents are never
 * blind when a running workspace daemon degrades:
 *  - Critical faults (`agent_revoked`, `page_failed`, `session_ended`,
 *    `broadcast_rejected`, `materialization_error`) alert immediately.
 *  - Transient host/peer/network faults debounce across a rolling window
 *    (default 3 faults in 60s) with a 5-minute per-signature cooldown so brief
 *    reconnect blips never spam, while sustained outages alert promptly.
 *  - Persists `.tendriller/agent/health.json` so `tendril status` surfaces active
 *    degradation to any agent or CLI.
 *  - When running inside Google Antigravity (`ANTIGRAVITY_CONVERSATION_ID`),
 *    pushes a direct `agentapi send-message` wake alert (opt out with
 *    `TENDRILLER_NO_HEALTH_ALERTS=1`).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

/** Classify a structured `runAgent` report object into a fault, recovery, or neutral event. */
export function classifyAgentReport(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const page = typeof obj.slug === 'string'
    ? obj.slug
    : (typeof obj.page === 'string' ? obj.page : null);

  if (obj.state === 'agent_revoked') {
    return { kind: 'fault', severity: 'critical', code: 'agent_revoked', page, message: obj.next || 'Agent token revoked or host namespace cut over' };
  }
  if (obj.state === 'page_failed') {
    const code = typeof obj.code === 'string' ? `page_failed:${obj.code}` : 'page_failed';
    return { kind: 'fault', severity: 'critical', code, page, message: obj.message || code };
  }
  if (obj.state === 'session_ended') {
    const code = typeof obj.code === 'string' ? `session_ended:${obj.code}` : 'session_ended';
    return { kind: 'fault', severity: 'critical', code, page, message: code };
  }
  if (obj.broadcast_rejected && typeof obj.broadcast_rejected === 'object') {
    return { kind: 'fault', severity: 'critical', code: `broadcast_rejected:${obj.broadcast_rejected.reason || 'invalid'}`, page: null, message: JSON.stringify(obj.broadcast_rejected) };
  }
  if (obj.state === 'rescan_failed') {
    return { kind: 'fault', severity: 'warn', code: `rescan_failed:${obj.code || 'unknown'}`, page, message: JSON.stringify(obj) };
  }
  if (obj.state === 'grants_unavailable') {
    return { kind: 'fault', severity: 'warn', code: `grants:${obj.code || 'unavailable'}`, page, message: JSON.stringify(obj) };
  }
  if (obj.admission === 'error') {
    return { kind: 'fault', severity: 'warn', code: `admission:${obj.error || 'error'}`, page, message: JSON.stringify(obj) };
  }
  if (typeof obj.materializationError === 'string' && obj.materializationError) {
    return { kind: 'fault', severity: 'critical', code: 'materialization_error', page, message: obj.materializationError };
  }
  if (obj.database === 'error' || obj.database === 'corrupt') {
    return { kind: 'fault', severity: 'critical', code: `database:${obj.database}`, page, message: JSON.stringify(obj) };
  }
  if (typeof obj.error === 'string' && obj.error) {
    // participation.mjs retains the last `error` across `connecting` retries; only count actual disconnect/error transitions.
    if (obj.connection === 'connecting') return null;
    return { kind: 'fault', severity: 'warn', code: obj.error, page, message: JSON.stringify(obj) };
  }
  if (obj.error && typeof obj.error === 'object' && typeof obj.error.code === 'string') {
    return { kind: 'fault', severity: 'warn', code: obj.error.code, page, message: obj.error.message || JSON.stringify(obj) };
  }
  if (obj.hub === 'reconnecting' && Number(obj.retryInMs) >= 8000) {
    return { kind: 'fault', severity: 'warn', code: `hub:reconnecting_${obj.retryInMs}ms`, page: null, message: JSON.stringify(obj) };
  }
  if (obj.setup && typeof obj.setup === 'object') {
    if (obj.setup.state === 'connected') return { kind: 'healthy', source: 'setup', page };
    if (obj.setup.state === 'reconnecting' && Number(obj.setup.retryInMs) >= 8000) {
      return { kind: 'fault', severity: 'warn', code: `setup:reconnecting_${obj.setup.retryInMs}ms`, page, message: JSON.stringify(obj) };
    }
  }
  if (obj.connection === 'connected') return { kind: 'healthy', source: 'peer', page };
  if (obj.state === 'running') return { kind: 'healthy', source: 'page', page };
  if (obj.change === 'materialized') return { kind: 'healthy', source: 'materialized', page };
  if (obj.hub === 'connected') return { kind: 'healthy', source: 'hub', page };
  return null;
}

function writeHealthFile(filePath, snapshot) {
  if (!filePath) return;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, filePath);
  } catch { /* best-effort health snapshot; never crash agent run */ }
}

export function notifyAntigravityHealth({ title, body, env = process.env, execute = execFile } = {}) {
  if (env?.TENDRILLER_NO_HEALTH_ALERTS === '1') return false;
  if (execute === execFile && (env?.NODE_TEST_CONTEXT || env?.VITEST || env?.PLAYWRIGHT_TEST)) return false;
  const conversationId = String(env?.ANTIGRAVITY_CONVERSATION_ID ?? '').trim();
  if (!UUID.test(conversationId)) return false;
  const fromEnv = String(env?.ANTIGRAVITY_AGENTAPI_EXE ?? '').trim();
  const bin = fromEnv && /(?:^|[/\\])agentapi(?:\.exe)?$/iu.test(fromEnv) ? fromEnv : 'agentapi';
  execute(bin, ['send-message', `--title=${title || 'Tendriller Agent Health Alert'}`, conversationId, body], {
    shell: false,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  }, () => {});
  return true;
}

export function createAgentHealthTracker({
  label = 'tendril agent run',
  workspaceRoot = '',
  healthFilePath = '',
  threshold = 3,
  windowMs = 60_000,
  cooldownMs = 5 * 60_000,
  minAlertIntervalMs = 60_000,
  healthyToRecover = 2,
  now = () => Date.now(),
  env = process.env,
  execute = execFile,
  onAlert,
  onRecovered,
} = {}) {
  const events = [];
  const lastAlertBySignature = new Map();
  let lastAnyAlertAt = -Infinity;
  let alerting = false;
  let alertStartedAt = 0;
  let activeAlert = null;
  let consecutiveHealthy = 0;
  let stopped = false;

  const persist = () => {
    writeHealthFile(healthFilePath, {
      version: 1,
      state: alerting ? 'degraded' : 'healthy',
      label,
      workspace: workspaceRoot || null,
      updatedAt: new Date(now()).toISOString(),
      activeAlert,
      recentFaults: events.slice(-8).map(({ at, severity, code, page, message }) => ({
        at: new Date(at).toISOString(),
        severity,
        code,
        page,
        message: String(message).slice(0, 260),
      })),
    });
  };

  const defaultAlert = (report) => {
    const body = [
      `⚠️ ${report.summary}`,
      workspaceRoot ? `Workspace: ${workspaceRoot}` : null,
      report.pages.length ? `Affected page(s): ${report.pages.join(', ')}` : null,
      report.recentSamples.length ? `Recent errors:\n${report.recentSamples.map(s => `  - ${String(s).slice(0, 220)}`).join('\n')}` : null,
      'Run `tendril status` and inspect the agent/host logs; local browser edits remain safe until sync recovers.',
    ].filter(Boolean).join('\n');
    notifyAntigravityHealth({ title: `Tendriller Alert: ${label}`, body, env, execute });
  };
  const defaultRecovered = (notice) => {
    notifyAntigravityHealth({
      title: `Tendriller Recovered: ${label}`,
      body: `✅ ${notice.summary}`,
      env,
      execute,
    });
  };

  const emitAlert = onAlert ?? defaultAlert;
  const emitRecovered = onRecovered ?? defaultRecovered;

  const prune = (t) => {
    const cutoff = t - windowMs;
    while (events.length && events[0].at < cutoff) events.shift();
  };

  const buildReport = (t, severity) => {
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
      severity,
      signature,
      counts,
      totalFaults: events.length,
      pages: [...pages],
      summary: severity === 'critical'
        ? `${label} hit a critical error: ${topCodes}`
        : `${label} sustained ${events.length} faults in ${Math.round(windowMs / 1000)}s: ${topCodes}`,
      recentSamples: events.slice(-5).map(e => e.message),
      at: t,
    };
  };

  function observe(value) {
    if (stopped) return null;
    const parsed = classifyAgentReport(value);
    if (!parsed) return null;
    const t = now();

    if (parsed.kind === 'fault') {
      consecutiveHealthy = 0;
      events.push({ at: t, ...parsed });
      prune(t);
      const immediate = parsed.severity === 'critical';
      if (!immediate && events.length < threshold) return null;

      const report = buildReport(t, immediate ? 'critical' : 'warn');
      const lastSent = lastAlertBySignature.get(report.signature) ?? -Infinity;
      if (t - lastSent < cooldownMs || (!immediate && t - lastAnyAlertAt < (alerting ? cooldownMs : minAlertIntervalMs))) {
        activeAlert = { summary: report.summary, signature: report.signature, severity: report.severity, at: new Date(t).toISOString() };
        persist();
        return null;
      }
      lastAlertBySignature.set(report.signature, t);
      lastAnyAlertAt = t;
      if (!alerting) {
        alerting = true;
        alertStartedAt = t;
      }
      activeAlert = { summary: report.summary, signature: report.signature, severity: report.severity, at: new Date(t).toISOString() };
      persist();
      try { emitAlert(report); } catch {}
      return report;
    }

    if (parsed.kind === 'healthy' && alerting) {
      consecutiveHealthy += 1;
      if (consecutiveHealthy < healthyToRecover) return null;
      const durationMs = Math.max(0, t - alertStartedAt);
      alerting = false;
      alertStartedAt = 0;
      activeAlert = null;
      consecutiveHealthy = 0;
      events.length = 0;
      lastAlertBySignature.clear();
      persist();
      const notice = {
        label,
        source: parsed.source,
        page: parsed.page,
        durationMs,
        summary: `${label} recovered (${parsed.source}${parsed.page ? ` on ${parsed.page}` : ''}) after ${Math.round(durationMs / 1000)}s.`,
        at: t,
      };
      try { emitRecovered(notice); } catch {}
      return notice;
    }
    return null;
  }

  persist();

  return Object.freeze({
    observe,
    stop() { stopped = true; },
    get alerting() { return alerting; },
  });
}
