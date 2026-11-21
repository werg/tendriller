import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaults } from './faults.mjs';
import { activityTimeline, assertDirectWork, assertIdle, counterDelta } from './evidence.mjs';
import { runNetworkScenario } from './scenarios.mjs';
import { observeIdleDuration, progressWriter } from './idle-progress.mjs';
import { releaseAnchor, selectedProductVersion, sha256 } from './anchor.mjs';
import { currentOperationApplied } from './first-app.mjs';
import { authenticatedTransportSnapshot, authenticatedRouteMatches } from '../../../scripts/first-app-peer.mjs';
import { prepareMountTargets } from './mounts.mjs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseline = () => ({ instance: 'private-epoch', hostRequests: 10, relayBytes: 100,
  sentReliableBytes: 20, receivedReliableBytes: 20, sentLiveBytes: 30, receivedLiveBytes: 30 });

test('controls refuse the host and never invoke a command', async () => {
  let called = false;
  const faults = createFaults({ isolated: false, run: async () => { called = true; } });
  await assert.rejects(faults.blockUdp(), /CONTAINER_REQUIRED/);
  await assert.rejects(faults.impair(), /CONTAINER_REQUIRED/);
  assert.equal(called, false);
});

test('second-family failure rolls back the first family and its partial chain', async () => {
  const calls = [];
  const faults = createFaults({ isolated: true, run: async (tool, args) => {
    calls.push([tool, ...args]);
    if (tool === 'ip6tables' && args.includes('DROP')) throw new Error('unsupported');
  } });
  await assert.rejects(faults.blockUdp(), /unsupported/);
  for (const tool of ['iptables', 'ip6tables']) {
    assert.ok(calls.some(call => call[0] === tool && call.includes('-F')));
    assert.ok(calls.some(call => call[0] === tool && call.includes('-X')));
  }
});

test('cleanup attempts traffic shaping even when firewall restoration fails', async () => {
  const calls = [];
  let fail = false;
  const faults = createFaults({ isolated: true, run: async (tool, args) => {
    calls.push([tool, ...args]);
    if (fail && tool === 'iptables') throw new Error('restore failure');
  } });
  await faults.blockUdp(); await faults.impair(); fail = true;
  await assert.rejects(faults.close(), /CLEANUP_FAILED/);
  assert.ok(calls.some(call => call[0] === 'tc' && call.includes('del')));
  assert.ok(calls.some(call => call[0] === 'ip6tables' && call.includes('-X')));
});

test('second qdisc failure rolls back the first without leaving a partially impaired profile', async () => {
  const calls = [];
  const faults = createFaults({ isolated: true, run: async (tool, args) => {
    calls.push([tool, ...args]);
    if (tool === 'tc' && args.includes('add') && args.includes('eth0')) throw new Error('qdisc unsupported');
  } });
  await assert.rejects(faults.impair(), /qdisc unsupported/);
  assert.ok(calls.some(call => call[0] === 'tc' && call.includes('del') && call.includes('lo')));
});

test('timeline is bounded, timestamps receipt phase, discards secret labels and rejects invalid counters', () => {
  const timeline = activityTimeline({ limit: 2, now: () => '2026-11-21T01:02:03.004Z' });
  timeline.record('startup', 'start');
  timeline.record('blocked', 'relay', { relayBytes: 123, url: 'secret-url', peerId: 'secret-id', payload: 'secret' });
  timeline.record('restored', 'direct', { sentReliableBytes: 77 });
  const value = timeline.snapshot();
  assert.equal(value.dropped, 1);
  assert.equal(value.items.length, 2);
  assert.deepEqual(value.items[0], { at: '2026-11-21T01:02:03.004Z', phase: 'blocked', event: 'relay', relayBytes: 123 });
  assert.doesNotMatch(JSON.stringify(value), /secret/);
  assert.throws(() => timeline.record('secret', 'command'));
  assert.throws(() => timeline.record('idle', 'end', { relayBytes: -1 }));
  value.items.length = 0;
  assert.equal(timeline.snapshot().items.length, 2);
});

test('idle scope requires exact zero host/payload increments and never claims model wake measurement', () => {
  const before = baseline();
  assert.equal(assertIdle(before, { ...before }).modelTurns, null);
  assert.throws(() => assertIdle(before, { ...before, relayBytes: 101 }), /relay payload/);
  assert.throws(() => assertIdle(before, { ...before, hostRequests: 11 }), /host requests/);
  assert.throws(() => counterDelta(before, { ...before, instance: 'replacement' }), /restart/);
  assert.throws(() => counterDelta(before, { ...before, sentLiveBytes: 0 }), /reset/);
});

test('direct proof requires bidirectional reliable and live bytes without relay payload', () => {
  const before = baseline();
  const after = Object.fromEntries(Object.entries(before).map(([key, value]) =>
    [key, key.endsWith('Bytes') && key !== 'relayBytes' ? value + 8 : value]));
  assertDirectWork(before, after);
  assert.throws(() => assertDirectWork(before, { ...after, receivedLiveBytes: before.receivedLiveBytes }), /live work/);
  assert.throws(() => assertDirectWork(before, { ...after, relayBytes: before.relayBytes + 1 }), /relay payload/);
});

const proof = () => ({ commandApplied: true, remoteRead: true, operationIdentityPreserved: true, signalDelivered: true, cameraDelivered: true });
function fakeApplication({ kind = 'direct' } = {}) {
  const state = { ...baseline(), kind };
  const calls = [];
  const adapter = {
    faults: { restoreUdp: async () => calls.push('udp-restored'), impair: async () => calls.push('impaired'), restoreImpairment: async () => calls.push('impairment-restored') },
    snapshot: async () => ({ ...state }),
    exercise: async () => {
      calls.push('work');
      if (state.kind === 'relay') state.relayBytes += 10;
      for (const key of ['sentReliableBytes', 'receivedReliableBytes', 'sentLiveBytes', 'receivedLiveBytes']) state[key] += 10;
      return proof();
    },
    networkChange: async () => { calls.push('network-event'); return { type: 'connection-change', observed: true }; },
    waitForDirect: async () => { calls.push('direct'); state.kind = 'direct'; },
    reloadAndVerify: async () => { calls.push('reload'); return proof(); },
    settle: async () => calls.push('settle'),
    cleanup: async () => calls.push('cleanup'),
  };
  return { adapter, calls, state };
}

test('upgrade contract proves fallback before restoring packets, observed event, direct work, reload and closed idle', async () => {
  const { adapter, calls } = fakeApplication({ kind: 'relay' });
  const result = await runNetworkScenario(adapter, { profile: 'relay-upgrade', idleMs: 1000 });
  assert.equal(result.success, true);
  assert.deepEqual(calls, ['work', 'udp-restored', 'network-event', 'direct', 'work', 'reload', 'direct', 'settle', 'cleanup']);
  assert.equal(result.idle.delta.relayBytes, 0);
  assert.equal(result.idle.modelTurns, null);
  assert.ok(result.idle.observedMs >= 1000);
});

test('an unobserved event or absent camera proof cannot qualify recovery', async () => {
  for (const missing of ['event', 'camera']) {
    const { adapter, calls } = fakeApplication({ kind: 'relay' });
    if (missing === 'event') adapter.networkChange = async () => ({ type: 'connection-change', observed: false });
    else adapter.exercise = async () => ({ ...proof(), cameraDelivered: false });
    await assert.rejects(runNetworkScenario(adapter, { profile: 'relay-upgrade', idleMs: 1000 }), error => {
      assert.equal(error.networkReport.success, false);
      assert.equal(error.networkReport.cleanup, true);
      assert.ok(error.networkReport.timeline.items.some(item => item.event === 'failure'));
      return true;
    });
    assert.equal(calls.at(-1), 'cleanup');
    assert.ok(!calls.includes('reload'));
  }
});

test('unsupported headless background remains unsupported, never a successful pass', async () => {
  const { adapter, calls } = fakeApplication();
  adapter.background = async () => ({ hiddenObserved: false });
  const result = await runNetworkScenario(adapter, { profile: 'background', idleMs: 1000 });
  assert.equal(result.supported, false);
  assert.equal(result.success, false);
  assert.deepEqual(calls, ['cleanup']);
});

test('abort during suspension cleans up without claiming a closed idle segment', async () => {
  const { adapter, calls } = fakeApplication();
  adapter.setFrozen = async value => calls.push(value ? 'frozen' : 'resumed');
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error('operator stop')), 10);
  try {
    await assert.rejects(runNetworkScenario(adapter, { profile: 'freeze', pauseMs: 1000, idleMs: 1000, signal: stop.signal }), error => {
      assert.equal(error.networkReport.idle, undefined);
      assert.equal(error.networkReport.timeline.items.at(-2).event, 'stop-request');
      return true;
    });
  } finally { clearTimeout(timer); }
  assert.deepEqual(calls, ['frozen', 'cleanup']);
});

test('local idle progress reports fixed start/end without requesting app counters', async () => {
  const values = [];
  const result = await observeIdleDuration(65, { intervalMs: 10, onProgress: async value => values.push(value) });
  assert.ok(values.length >= 2);
  assert.ok(values.every(value => value.counterCoverage === 'start-only-until-segment-close' && value.modelTurns === null));
  assert.ok(values.every(value => value.idleStartedAt === result.idleStartedAt && value.idlePlannedEndAt === result.idlePlannedEndAt));
  assert.equal(Date.parse(result.idlePlannedEndAt) - Date.parse(result.idleStartedAt), 65);
});

test('nonzero closed idle segment retains exact counts and elapsed time in failure evidence', async () => {
  const { adapter } = fakeApplication();
  const snapshot = adapter.snapshot;
  let calls = 0;
  adapter.snapshot = async options => {
    const value = await snapshot(options);
    if (++calls === 5) value.hostRequests++;
    return value;
  };
  await assert.rejects(runNetworkScenario(adapter, { profile: 'idle', idleMs: 1000 }), error => {
    assert.equal(error.networkReport.idle.before.hostRequests, 10);
    assert.equal(error.networkReport.idle.after.hostRequests, 11);
    assert.equal(error.networkReport.idle.delta.hostRequests, 1);
    assert.ok(error.networkReport.idle.observedMs >= 1000);
    return true;
  });
});

test('release anchor rejects changed bytes and traversal without launching the application', async t => {
  const root = await mkdtemp(join(tmpdir(), 'network-anchor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist'));
  const bytes = Buffer.from('fixture-package');
  const manifest = { source_commit: 'a'.repeat(40), runtime: 'b'.repeat(64), composition: { id: 'c'.repeat(64) },
    first_app: { file: 'fixture.tgz' }, artifacts: [{ file: 'fixture.tgz', sha256: sha256(bytes), size: bytes.length }] };
  const save = () => writeFile(join(root, 'dist/manifest.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'dist/fixture.tgz'), bytes); await save();
  assert.equal((await releaseAnchor(root)).source, manifest.source_commit);
  await writeFile(join(root, 'dist/fixture.tgz'), Buffer.alloc(bytes.length));
  await assert.rejects(releaseAnchor(root), /bytes changed/);
  manifest.artifacts[0].file = '../private'; await save();
  await assert.rejects(releaseAnchor(root), /within dist/);
});

test('fresh harness has nested read-only mount targets without building or replacing bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'network-mounts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareMountTargets(root);
  assert.deepEqual(await readdir(join(root, 'dist')), []);
  assert.deepEqual(await readdir(join(root, 'server/public')), []);
  await writeFile(join(root, 'server/public/retained'), 'qualified bytes');
  await prepareMountTargets(root);
  assert.equal(await readFile(join(root, 'server/public/retained'), 'utf8'), 'qualified bytes');
});

test('manual qualification selects product metadata without replacing the newer harness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'network-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  await writeFile(join(root, 'dist/manifest.json'), JSON.stringify({ version: '1.0.0' }));
  assert.equal(await selectedProductVersion(root), '1.0.0');
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).version, '2.0.0');
  await writeFile(join(root, 'dist/manifest.json'), JSON.stringify({ version: '../private' }));
  await assert.rejects(selectedProductVersion(root));
});

test('transport counters and revision come from the same synchronous snapshot turn', async () => {
  const participation = { status: { connectionRevision: 8 }, diagnostics() {
    const links = [{ peerId: 'private-peer', kind: 'relay', sentReliableBytes: 12,
      receivedReliableBytes: 13, sentLiveBytes: 14, receivedLiveBytes: 15 }];
    queueMicrotask(() => { participation.status.connectionRevision = 9; });
    return Promise.resolve(links);
  } };
  const value = await authenticatedTransportSnapshot(participation, 'private-peer');
  assert.equal(participation.status.connectionRevision, 9);
  assert.equal(value.connectionRevision, 8);
  assert.equal(value.sentReliableBytes, 12);
  assert.equal(value.kind, 'relay');
  assert.equal(value.peerId, undefined);
});

test('old applied/retention labels and reused IDs cannot prove a fresh browser command', () => {
  const status = id => `${id}: Applied: accepted. 1 peer retention receipt(s) observed.`;
  assert.equal(currentOperationApplied('old', 'old', status('old')), false);
  assert.equal(currentOperationApplied('old', 'new', status('old')), false);
  assert.equal(currentOperationApplied('old', 'new', 'new: Saved. 1 peer retention receipt(s) observed.'), false);
  assert.equal(currentOperationApplied('old', 'new', 'new: Applied: accepted. Peer retention has not been observed here.'), false);
  assert.equal(currentOperationApplied('old', 'new', status('new')), true);
});

test('reopen cannot qualify a cached direct route or a new non-direct route', () => {
  assert.equal(authenticatedRouteMatches({ kind: 'direct', connectionRevision: 6 }, 'direct', 6), false);
  assert.equal(authenticatedRouteMatches({ kind: 'relay', connectionRevision: 8 }, 'direct', 6), false);
  assert.equal(authenticatedRouteMatches({ kind: 'unknown', connectionRevision: 7 }, 'direct', 6), false);
  assert.equal(authenticatedRouteMatches({ kind: 'direct', connectionRevision: 8 }, 'direct', 6), true);
});

// Docker runs as root for isolated NET_ADMIN, while Actions uploads as the host
// user. Report permissions must permit that read without exposing the directory.
test('redacted atomic progress remains readable by the host evidence uploader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'network-progress-permissions-'));
  try {
    const path = join(dir, 'progress.json');
    await progressWriter(path)({ state: 'idle-observation-open', elapsedMs: 5, modelTurns: null });
    assert.equal((await stat(path)).mode & 0o777, 0o644);
    assert.equal((await stat(dir)).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { state: 'idle-observation-open', elapsedMs: 5, modelTurns: null });
    assert.deepEqual(await readdir(dir), ['progress.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
