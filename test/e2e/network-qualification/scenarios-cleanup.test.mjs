import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaults } from './faults.mjs';
import { runNetworkScenario } from './scenarios.mjs';

const proof = () => ({ commandApplied: true, remoteRead: true, operationIdentityPreserved: true,
  signalDelivered: true, cameraDelivered: true });
function application({ nonzeroIdle = false } = {}) {
  const state = { instance: 'retained-session', kind: 'direct', hostRequests: 0, relayBytes: 0,
    sentReliableBytes: 0, receivedReliableBytes: 0, sentLiveBytes: 0, receivedLiveBytes: 0 };
  let idle = false, idleReads = 0, cleaned = false;
  return {
    async snapshot() {
      if (idle && ++idleReads === 2 && nonzeroIdle) state.hostRequests++;
      return { ...state };
    },
    async exercise() {
      for (const key of ['sentReliableBytes', 'receivedReliableBytes', 'sentLiveBytes', 'receivedLiveBytes']) state[key]++;
      return proof();
    },
    reloadAndVerify: async () => proof(), waitForDirect: async () => {},
    settle: async () => { idle = true; },
    cleanup: async () => { cleaned = true; },
    cleaned: () => cleaned,
  };
}

test('terminal progress rejection preserves the original scenario error and cleanup report', async () => {
  const adapter = application(), original = new Error('exercise failed'), publication = new Error('private progress error');
  adapter.exercise = async () => { throw original; };
  await assert.rejects(runNetworkScenario(adapter, { profile: 'idle', idleMs: 1000,
    onProgress: async value => { if (value.state === 'failed') throw publication; },
  }), error => {
    assert.equal(error, original);
    assert.equal(error.networkReport.success, false);
    assert.equal(error.networkReport.cleanup, true);
    assert.equal(error.networkReport.progressPublished, false);
    assert.ok(error.networkReport.timeline.items.some(item => item.event === 'failure'));
    assert.doesNotMatch(JSON.stringify(error.networkReport), /private progress error/);
    return true;
  });
  assert.equal(adapter.cleaned(), true);
});

test('an exact nonzero closed idle segment survives terminal publication failure', async () => {
  const adapter = application({ nonzeroIdle: true });
  let terminal;
  await assert.rejects(runNetworkScenario(adapter, { profile: 'idle', idleMs: 1000,
    onProgress: async value => { if (value.state === 'failed') { terminal = value; throw new Error('publication failed'); } },
  }), error => {
    assert.notEqual(error.message, 'publication failed');
    const report = error.networkReport;
    assert.equal(report.success, false); assert.equal(report.cleanup, true);
    assert.equal(report.idle.closed, true);
    assert.equal(report.idle.before.hostRequests, 0); assert.equal(report.idle.after.hostRequests, 1);
    assert.equal(report.idle.delta.hostRequests, 1); assert.ok(report.idle.observedMs >= 1000);
    assert.equal(terminal.idle, report.idle);
    assert.ok(report.timeline.items.some(item => item.phase === 'idle' && item.event === 'end'));
    assert.equal(report.timeline.items.at(-1).phase, 'cleanup');
    return true;
  });
});

test('sole terminal publication failure becomes an unsuccessful error with the complete report', async () => {
  const adapter = application(), original = new Error('terminal writer failed');
  await assert.rejects(runNetworkScenario(adapter, { profile: 'idle', idleMs: 1000,
    onProgress: async value => { if (value.state === 'complete') throw original; },
  }), error => {
    assert.equal(error, original);
    assert.equal(error.networkReport.success, false); assert.equal(error.networkReport.cleanup, true);
    assert.equal(error.networkReport.supported, true); assert.equal(error.networkReport.progressPublished, false);
    assert.equal(error.networkReport.idle.closed, true);
    assert.equal(error.networkReport.idle.delta.hostRequests, 0);
    assert.ok(error.networkReport.timeline.items.some(item => item.event === 'reload-verified'));
    return true;
  });
});

test('cleanup failure takes precedence over a later terminal publication failure', async () => {
  const adapter = application(), original = new Error('cleanup failed');
  adapter.background = async () => ({ hiddenObserved: false });
  adapter.cleanup = async () => { throw original; };
  await assert.rejects(runNetworkScenario(adapter, { profile: 'background', idleMs: 1000,
    onProgress: async value => { if (value.state === 'failed') throw new Error('publication failed'); },
  }), error => {
    assert.equal(error, original);
    assert.equal(error.networkReport.success, false); assert.equal(error.networkReport.cleanup, false);
    assert.equal(error.networkReport.progressPublished, false);
    return true;
  });
});

test('a phase timeout cannot report cleanup success while the first fault syscall remains in flight', async () => {
  let resolveStarted, release, released = false;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const held = new Promise(resolve => { release = () => { released = true; resolve(); }; });
  let commands = 0, resources = 0, finished = false;
  const faults = createFaults({ isolated: true, run: async (_tool, args) => {
    commands++;
    if (commands === 1) { resolveStarted(); await held; resources++; }
    if (args.includes('-X')) resources--;
  } });
  const adapter = application();
  adapter.faults = faults;
  adapter.setOffline = async () => faults.blockApplicationNetwork();
  adapter.cleanup = async () => { await faults.close(); assert.equal(resources, 0); };
  const scenario = runNetworkScenario(adapter, { profile: 'offline', phaseMs: 20, idleMs: 1000,
    onProgress: async value => { if (value.state === 'failed') { assert.equal(released, true); finished = true; } },
  });
  const result = assert.rejects(scenario, error => {
    assert.equal(error.name, 'TimeoutError'); assert.equal(error.networkReport.cleanup, true);
    assert.equal(error.networkReport.success, false); return true;
  });
  await started;
  // Cross the phase deadline. Cleanup owns the setup's outstanding first syscall.
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(finished, false); assert.equal(commands, 1);
  release(); await result;
  const count = commands;
  await new Promise(setImmediate);
  assert.equal(commands, count); assert.equal(resources, 0); assert.equal(finished, true);
});
