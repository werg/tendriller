import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForDirectEvidence } from './wait-direct.mjs';

function fixture() {
  let ticks = 0;
  return {
    evidence: { expectedKind: 'direct' },
    now: () => ++ticks * 100,
    snapshot: async () => ({ kind: 'relay' }),
    wait: async () => ({ kind: 'direct', connectionRevision: 3 }),
    counters: async () => ({ instance: 'private-epoch', relayBinaryBytes: 42 }),
  };
}
const rejectsWith = (operation, expected) => assert.rejects(operation, error => error === expected);

test('route failure survives failed snapshot, host counters and progress with retained evidence', async () => {
  const f = fixture();
  const route = new Error('route timeout');
  let snapshots = 0;
  let counters = 0;
  f.wait = async () => { throw route; };
  f.snapshot = async () => {
    if (++snapshots === 2) throw new Error('snapshot unavailable');
    return { kind: 'relay' };
  };
  f.counters = async () => {
    if (++counters === 2) throw new Error('counter unavailable');
    return { instance: 'secret-epoch', relayBinaryBytes: 7 };
  };
  f.publish = async evidence => {
    assert.equal(evidence.diagnosticFailures.afterSnapshot, true);
    assert.equal(evidence.diagnosticFailures.hostAfter, true);
    throw new Error('progress unavailable');
  };
  await rejectsWith(waitForDirectEvidence(f), route);
  assert.deepEqual(f.evidence.diagnosticFailures, { afterSnapshot: true, hostAfter: true, progress: true });
  assert.equal(f.evidence.completed, false);
  assert.equal(f.evidence.diagnosticFailed, true);
  assert.equal(f.evidence.progressFailed, true);
  assert.deepEqual(f.evidence.before, { kind: 'relay' });
  assert.deepEqual(f.evidence.hostBefore, { relayBinaryBytes: 7 });
  assert.equal(f.evidence.elapsedMs, 100);
  assert.ok(!JSON.stringify(f.evidence).includes('secret-epoch'));
});

for (const stage of ['hostAfter', 'progress']) {
  test(`successful direct route fails qualification on ${stage} failure and keeps its route result`, async () => {
    const f = fixture();
    const diagnostic = new Error(stage);
    let counters = 0;
    if (stage === 'hostAfter') f.counters = async () => {
      if (++counters === 2) throw diagnostic;
      return { instance: 'private', relayBinaryBytes: 42 };
    };
    else f.publish = async () => { throw diagnostic; };
    await rejectsWith(waitForDirectEvidence(f), diagnostic);
    assert.equal(f.evidence.completed, true);
    assert.equal(f.evidence.after.kind, 'direct');
    assert.equal(f.evidence.diagnosticFailed, true);
    assert.deepEqual(f.evidence.diagnosticFailures, { [stage]: true });
    assert.ok(!JSON.stringify(f.evidence).includes('private'));
  });
}

test('route failure retains a successful fallback snapshot and final host counters', async () => {
  const f = fixture();
  const route = new Error('opening failed');
  f.wait = async () => { throw route; };
  await rejectsWith(waitForDirectEvidence(f), route);
  assert.equal(f.evidence.after.kind, 'relay');
  assert.equal(f.evidence.sameHostEpoch, true);
  assert.equal(f.evidence.diagnosticFailed, false);
  assert.deepEqual(f.evidence.hostAfter, { relayBinaryBytes: 42 });
});

for (const sameEpoch of [true, false]) {
  test(`direct success records epoch equality ${sameEpoch} without retaining either private instance`, async () => {
    const f = fixture();
    let calls = 0;
    f.counters = async () => ({ instance: ++calls === 1 || sameEpoch ? 'secret-A' : 'secret-B', relayBinaryBytes: calls });
    assert.equal(await waitForDirectEvidence(f), f.evidence);
    assert.equal(f.evidence.completed, true);
    assert.equal(f.evidence.sameHostEpoch, sameEpoch);
    assert.equal(f.evidence.diagnosticFailed, false);
    assert.ok(!JSON.stringify(f.evidence).includes('secret-'));
  });
}

for (const stage of ['beforeSnapshot', 'hostBefore']) {
  test(`initial ${stage} failure retains a full failed report without attempting an unobserved route`, async () => {
    const f = fixture();
    const diagnostic = new Error(stage);
    f.wait = async () => { assert.fail('must not wait without initial observations'); };
    if (stage === 'beforeSnapshot') f.snapshot = async () => { throw diagnostic; };
    else {
      let calls = 0;
      f.counters = async () => {
        if (++calls === 1) throw diagnostic;
        return { instance: 'secret', relayBinaryBytes: 5 };
      };
    }
    await rejectsWith(waitForDirectEvidence(f), diagnostic);
    assert.equal(f.evidence.completed, false);
    assert.equal(f.evidence.diagnosticFailures[stage], true);
    assert.ok(f.evidence.hostAfter);
    assert.equal(f.evidence.sameHostEpoch, stage === 'beforeSnapshot' ? true : undefined);
  });
}

test('successful route preserves first diagnostic error when final progress also fails', async () => {
  const f = fixture();
  const counterError = new Error('counter unavailable');
  let calls = 0;
  f.counters = async () => {
    if (++calls === 2) throw counterError;
    return { instance: 'secret', relayBinaryBytes: 10 };
  };
  f.publish = async evidence => {
    assert.equal(evidence.completed, true);
    assert.equal(evidence.diagnosticFailed, true);
    throw new Error('progress unavailable');
  };
  await rejectsWith(waitForDirectEvidence(f), counterError);
  assert.deepEqual(f.evidence.diagnosticFailures, { hostAfter: true, progress: true });
  assert.equal(f.evidence.after.kind, 'direct');
  assert.deepEqual(f.evidence.hostBefore, { relayBinaryBytes: 10 });
});
