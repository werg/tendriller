import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyAgentReport, createAgentHealthTracker } from '../lib/health.mjs';

test('classifyAgentReport detects critical and warning faults across hub, grants, admission, pages, and peer links', () => {
  assert.equal(classifyAgentReport({ state: 'agent_revoked', next: 'reenroll' }).severity, 'critical');
  assert.equal(classifyAgentReport({ page: 'p1', slug: 'notes', state: 'page_failed', code: 'corrupt', message: 'boom' }).severity, 'critical');
  assert.equal(classifyAgentReport({ page: 'p1', slug: 'notes', state: 'session_ended', code: 'crash' }).severity, 'critical');
  assert.equal(classifyAgentReport({ broadcast_rejected: { reason: 'bad_sig' } }).severity, 'critical');
  assert.equal(classifyAgentReport({ state: 'grants_unavailable', code: 'page_unavailable' }).severity, 'warn');
  assert.equal(classifyAgentReport({ page: 'p1', slug: 'notes', connection: 'disconnected', error: 'advertise:invalid_response' }).severity, 'warn');
  assert.equal(classifyAgentReport({ hub: 'reconnecting', retryInMs: 16000 }).severity, 'warn');
  assert.equal(classifyAgentReport({ hub: 'reconnecting', retryInMs: 1000 }), null);
  assert.deepEqual(classifyAgentReport({ hub: 'connected' }), { kind: 'healthy', source: 'hub', page: null });
});

test('createAgentHealthTracker alerts immediately on critical faults, debounces transient warnings, persists health.json, and recovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tendril-health-'));
  const healthFile = join(dir, 'health.json');
  let clock = 5_000_000;
  const alerts = [];
  const recoveries = [];
  try {
    const tracker = createAgentHealthTracker({
      label: '@atlas',
      workspaceRoot: dir,
      healthFilePath: healthFile,
      threshold: 3,
      windowMs: 60_000,
      cooldownMs: 300_000,
      healthyToRecover: 2,
      now: () => clock,
      onAlert: r => alerts.push(r),
      onRecovered: n => recoveries.push(n),
    });

    assert.equal(JSON.parse(readFileSync(healthFile, 'utf8')).state, 'healthy');

    // 1. Two transient warnings do not alert.
    tracker.observe({ page: 'p1', slug: 'notes', connection: 'disconnected', error: 'discovery:invitation_failed' });
    clock += 1000;
    tracker.observe({ state: 'grants_unavailable', code: 'page_unavailable' });
    assert.equal(alerts.length, 0);

    // 2. Third warning crosses threshold -> alerts and writes degraded health.json.
    clock += 1000;
    tracker.observe({ page: 'p1', slug: 'notes', connection: 'disconnected', error: 'discovery:invitation_failed' });
    assert.equal(alerts.length, 1);
    assert.equal(tracker.alerting, true);
    const degraded = JSON.parse(readFileSync(healthFile, 'utf8'));
    assert.equal(degraded.state, 'degraded');
    assert.match(degraded.activeAlert.summary, /discovery:invitation_failed/);

    // 3. Recovery clears alert and writes healthy health.json.
    clock += 5000;
    tracker.observe({ hub: 'connected' });
    tracker.observe({ page: 'p1', slug: 'notes', connection: 'connected' });
    assert.equal(recoveries.length, 1);
    assert.equal(tracker.alerting, false);
    assert.equal(JSON.parse(readFileSync(healthFile, 'utf8')).state, 'healthy');

    // 4. Critical fault alerts immediately on occurrence #1.
    clock += 5000;
    tracker.observe({ page: 'p1', slug: 'notes', state: 'page_failed', code: 'db_error', message: 'no such table' });
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1].severity, 'critical');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
