import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaults } from './faults.mjs';
import { activityTimeline, assertDirectWork, assertIdle, counterDelta } from './evidence.mjs';

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
