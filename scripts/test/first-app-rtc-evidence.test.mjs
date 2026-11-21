import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrowserRtcEvidence, hasNonTurnTraffic, observeRtcTraffic } from '../first-app-rtc-evidence.mjs';
const direct = () => [{ local: 'host', remote: 'srflx', bytesSent: 20, bytesReceived: 30 }];

test('proof rejects unknown/missing types, TURN and incomplete byte evidence', () => {
  for (const local of ['host', 'srflx', 'prflx']) for (const remote of ['host', 'srflx', 'prflx'])
    assert.equal(hasNonTurnTraffic([{ ...direct()[0], local, remote }]), true);
  for (const field of ['local', 'remote']) for (const value of [undefined, null, 'unknown', 'relay', 'private-label'])
    assert.equal(hasNonTurnTraffic([{ ...direct()[0], [field]: value }]), false);
  for (const field of ['bytesSent', 'bytesReceived']) for (const value of [undefined, 0, -1, NaN, Infinity])
    assert.equal(hasNonTurnTraffic([{ ...direct()[0], [field]: value }]), false);
});

test('bounded observation retains initially empty, then zero-byte, then real proof samples', async () => {
  let reads = 0;
  const samples = [[], [{ ...direct()[0], bytesReceived: 0 }], direct()];
  const result = await observeRtcTraffic(async () => samples[reads++], { pause: async () => {} });
  assert.deepEqual(result.initial, []);
  assert.deepEqual(result.final, direct());
  assert.equal(result.attempts, 3);
  assert.equal(result.completed, true);
  assert.equal(result.timedOut, false);
  assert.ok(result.elapsedMs >= 0);
});

test('observation cannot qualify permanently missing or TURN candidate evidence', async () => {
  for (const routes of [[], [{ ...direct()[0], local: 'relay' }], [{ ...direct()[0], remote: undefined }]]) {
    const result = await observeRtcTraffic(async () => routes, { timeoutMs: 10, intervalMs: 5, pause: async () => {} });
    assert.equal(result.completed, false);
    assert.equal(result.timedOut, true);
    assert.ok(result.attempts <= 3);
    assert.deepEqual(result.final, routes);
  }
});

test('a stalled getStats read is bounded and cannot fabricate proof', async () => {
  const result = await observeRtcTraffic(() => new Promise(() => {}), { timeoutMs: 15, intervalMs: 5 });
  assert.equal(result.completed, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.final, []);
});

test('stats read error preserves original error and partial observation', async () => {
  const failure = Error('read failed');let reads = 0;
  await assert.rejects(observeRtcTraffic(async () => {
    if (++reads === 2) throw failure;
    return [];
  }, { pause: async () => {} }), error => {
    assert.equal(error, failure);
    assert.equal(error.rtcObservation.diagnosticFailed, true);
    assert.equal(error.rtcObservation.attempts, 2);
    assert.deepEqual(error.rtcObservation.initial, []);
    return true;
  });
});

test('browser collector retains only bounded types/bytes from succeeded candidate pairs', async t => {
  const previous = globalThis.__firstAppRtcPeers;
  t.after(() => { if (previous === undefined) delete globalThis.__firstAppRtcPeers; else globalThis.__firstAppRtcPeers = previous; });
  const stats = new Map([
    ['private-local', { candidateType: 'host', address: 'private-address' }],
    ['private-remote', { candidateType: 'private-type', usernameFragment: 'secret' }],
    ['pair-private-id', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'private-local', remoteCandidateId: 'private-remote', bytesSent: 12, bytesReceived: 14 }],
    ['pending', { type: 'candidate-pair', state: 'in-progress' }],
  ]);
  globalThis.__firstAppRtcPeers = Array.from({ length: 40 }, () => ({ getStats: async () => stats }));
  const value = await readBrowserRtcEvidence();
  assert.equal(value.length, 32);
  assert.deepEqual(value[0], { local: 'host', remote: 'unknown', bytesSent: 12, bytesReceived: 14 });
  for (const secret of ['private', 'address', 'secret', 'usernameFragment', 'CandidateId']) assert.ok(!JSON.stringify(value).includes(secret));
  assert.equal(hasNonTurnTraffic(value), false);
});
