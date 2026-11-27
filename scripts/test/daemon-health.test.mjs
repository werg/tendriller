import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHealthAlertMonitor,
  parseAgentDiagnosticLine,
  sendAntigravityAlert,
} from '../../docs/tutorial/shared/helpers/daemon-health.mjs';

test('parseAgentDiagnosticLine classifies tendril agent run faults and healthy events accurately', () => {
  assert.deepEqual(
    parseAgentDiagnosticLine('{"page":"3riqjips7lnz","slug":"copy-editor-v2","connection":"disconnected","error":"advertise:invalid_response"}'),
    {
      kind: 'fault',
      severity: 'warn',
      code: 'advertise:invalid_response',
      page: 'copy-editor-v2',
      message: '{"page":"3riqjips7lnz","slug":"copy-editor-v2","connection":"disconnected","error":"advertise:invalid_response"}',
    },
  );
  assert.equal(parseAgentDiagnosticLine('{"state":"agent_revoked","next":"reenroll"}').severity, 'critical');
  assert.equal(parseAgentDiagnosticLine('{"state":"grants_unavailable","code":"page_unavailable","status":null}').code, 'grants:page_unavailable');
  assert.equal(parseAgentDiagnosticLine('{"page":"3riqjips7lnz","admission":"error","error":"terminated"}').code, 'admission:terminated');
  assert.equal(parseAgentDiagnosticLine('StorageSchemaError: missing required tables (v2_mailbox_envelopes)').code, 'StorageSchemaError');
  assert.deepEqual(parseAgentDiagnosticLine('{"hub":"connected"}'), { kind: 'healthy', source: 'hub', page: null });
  assert.deepEqual(parseAgentDiagnosticLine('{"page":"3riqjips7lnz","slug":"copy-editor-v2","connection":"connected"}'), { kind: 'healthy', source: 'peer', page: 'copy-editor-v2' });
  assert.equal(parseAgentDiagnosticLine('{"page":"3riqjips7lnz","connection":"connecting"}'), null);
});

test('createHealthAlertMonitor ignores transient blips, alerts on sustained faults with cooldown, and reports recovery', () => {
  let clock = 1_000_000;
  const alerts = [];
  const recoveries = [];
  const monitor = createHealthAlertMonitor({
    label: 'copy-editor',
    threshold: 3,
    windowMs: 60_000,
    cooldownMs: 300_000,
    healthyToRecover: 2,
    now: () => clock,
    onAlert: (r) => alerts.push(r),
    onRecovered: (n) => recoveries.push(n),
  });

  // 2 transient blips do NOT trigger an alert.
  monitor.recordLine('{"page":"p1","slug":"copy-editor-v2","connection":"disconnected","error":"discovery:invitation_failed"}');
  clock += 1000;
  monitor.recordLine('{"page":"p1","slug":"copy-editor-v2","connection":"disconnected","error":"advertise:invalid_response"}');
  assert.equal(alerts.length, 0);

  // 3rd fault within window triggers exactly 1 alert.
  clock += 1000;
  monitor.recordLine('{"page":"p1","slug":"copy-editor-v2","connection":"disconnected","error":"discovery:invitation_failed"}');
  assert.equal(alerts.length, 1);
  assert.equal(monitor.alerting, true);
  assert.equal(alerts[0].totalFaults, 3);
  assert.deepEqual(alerts[0].pages, ['copy-editor-v2']);
  assert.match(alerts[0].summary, /discovery:invitation_failed \(×2\)/);

  // Additional faults with the same signature during cooldown are suppressed (no storm).
  clock += 5000;
  monitor.recordLine('{"page":"p1","slug":"copy-editor-v2","connection":"disconnected","error":"discovery:invitation_failed"}');
  assert.equal(alerts.length, 1);

  // Recovery after 2 healthy signals emits one recovery notice and re-arms alerting.
  clock += 10_000;
  monitor.recordLine('{"hub":"connected"}');
  assert.equal(recoveries.length, 0);
  clock += 1000;
  monitor.recordLine('{"page":"p1","slug":"copy-editor-v2","connection":"connected"}');
  assert.equal(recoveries.length, 1);
  assert.equal(monitor.alerting, false);
  assert.match(recoveries[0].summary, /recovered/i);
});

test('createHealthAlertMonitor alerts immediately on unexpected exit and stays silent after graceful stop', () => {
  const alerts = [];
  const monitor = createHealthAlertMonitor({ label: 'copy-editor', onAlert: (r) => alerts.push(r) });
  monitor.reportExit(1, null);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].summary, /exited unexpectedly/);

  const graceful = createHealthAlertMonitor({ label: 'copy-editor', onAlert: (r) => alerts.push(r) });
  graceful.stop();
  graceful.reportExit(1, 'SIGTERM');
  assert.equal(alerts.length, 1);
});

test('sendAntigravityAlert invokes agentapi send-message only with valid conversation UUID', () => {
  const calls = [];
  const fakeExec = (bin, args) => { calls.push({ bin, args }); };
  assert.equal(sendAntigravityAlert({ title: 'Test', body: 'hi', env: {}, execute: fakeExec }), false);
  assert.equal(calls.length, 0);

  const ok = sendAntigravityAlert({
    title: 'Health Alert',
    body: 'DO error',
    env: { ANTIGRAVITY_CONVERSATION_ID: '9e40855f-fb38-41db-b7c8-90512ee1320e' },
    execute: fakeExec,
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'agentapi');
  assert.deepEqual(calls[0].args, ['send-message', '--title=Health Alert', '9e40855f-fb38-41db-b7c8-90512ee1320e', 'DO error']);
});
