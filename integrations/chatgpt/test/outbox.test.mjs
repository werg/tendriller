import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.mjs';
import { createOutbox } from '../outbox.mjs';

const owner = { id: 'alice', issuer: 'https://issuer.example' }, revision = { generation: 'g1', point: { sequence: 1 } };
const source = (id = 'source-1') => ({ sourceEventId: id, sourceOperationId: 'operation-1', sourceTimestampMs: 1000000,
  revision, name: 'assistant.help_requested', data: { request_id: 'request-1', summary: 'Help requested' } });
const subscription = (id = 'sub-a', applicationId = 'app-a') => ({ id, applicationId, owner, name: 'assistant.help_requested', active: true,
  version: 1, expiresAt: 9000000, sourceCursor: 'tail', url: 'https://callback.example/' + id, secret: 'whsec_' + Buffer.alloc(32).toString('base64') });
function fixture(options = {}) {
  let now = 1000000, selected = true, allowed = true;
  const sent = [], store = createMemoryStore({ subscriptions: { 'sub-a': subscription(), 'sub-b': subscription('sub-b', 'app-b') } });
  const bridge = { verifySource: async () => ({ selected }), getStatus: async () => ({ status: { generation: 'g2' } }),
    readEvents: async () => ({ cursor: 'new-tail', revision, hasMore: false, events: [] }) };
  const outbox = createOutbox({ store, bridge, clock: () => now,
    authorize: async () => { if (!allowed) throw Object.assign(Error('revoked'), { status: 403 }); },
    send: async (url, request) => { sent.push({ url, ...request }); return { status: 200, body: '' }; }, ...options });
  return { outbox, store, bridge, sent, advance: n => { now += n; }, select: v => { selected = v; }, allow: v => { allowed = v; } };
}
const batch = (event = source()) => ({ applicationId: 'app-a', revision, cursor: 'next', events: [event], hasMore: false });
function gate() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { enter, release, entered, wait };
}

test('jobs and cursor commit together, deduplicate immutable sources, never cross application filters', async () => {
  const f = fixture();
  assert.equal(await f.outbox.ingest('sub-a', batch(), { expectedCursor: 'tail' }), true);
  assert.equal((await f.store.read()).subscriptions['sub-a'].sourceCursor, 'next');
  assert.equal(await f.outbox.ingest('sub-a', batch(), { expectedCursor: 'next' }), true);
  await assert.rejects(f.outbox.ingest('sub-b', batch(), { expectedCursor: 'tail' }), /another application/);
  assert.equal(Object.keys((await f.store.read()).jobs).length, 1);
  await f.outbox.dispatchDue(); assert.equal(f.sent.length, 1);
  const state = await f.outbox.status(owner, 'app-a', 'request-1');
  assert.equal(state.jobs[0].state, 'accepted'); assert.equal(state.jobs[0].responseOperationId, null);
  await f.outbox.noteReply(owner, 'app-a', 'request-1', 'reply-operation');
  assert.equal((await f.outbox.status(owner, 'app-a')).jobs[0].responseOperationId, 'reply-operation');
});

test('oversized or unapproved projected data cannot advance the durable cursor', async () => {
  const f = fixture();
  await assert.rejects(f.outbox.ingest('sub-a', batch({ ...source(), data: { question: 'private raw text' } }), { expectedCursor: 'tail' }), /egress schema/);
  assert.equal((await f.store.read()).subscriptions['sub-a'].sourceCursor, 'tail');
  assert.equal((await f.store.read()).jobs, undefined);
});

test('retry retains event identity, re-signs fresh time and survives a lost in-flight receipt', async () => {
  const sent = []; let status = 503;
  const f = fixture({ send: async (_url, request) => { sent.push(request); return { status, body: '' }; } });
  await f.outbox.ingest('sub-a', batch(), { expectedCursor: 'tail' });
  await f.outbox.dispatchDue(); f.advance(3000); status = 204;
  await f.outbox.dispatchDue();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].headers['webhook-id'], sent[1].headers['webhook-id']);
  assert.notEqual(sent[0].headers['webhook-timestamp'], sent[1].headers['webhook-timestamp']);
  await f.store.transaction(state => { const job = Object.values(state.jobs)[0]; Object.assign(job, { state: 'sending', leaseUntil: 0, nextAttemptAt: 0 }); });
  await f.outbox.dispatchDue();
  assert.equal(sent.length, 3); assert.equal(sent[2].body, sent[1].body);
});

test('revocation and abandoned source history stop egress, and 410/413 do not retry', async () => {
  for (const mode of ['revoked', 'abandoned', 410, 413]) {
    const sent = [], f = fixture({ send: async (_url, request) => { sent.push(request); return { status: mode, body: '' }; } });
    await f.outbox.ingest('sub-a', batch(), { expectedCursor: 'tail' });
    if (mode === 'revoked') f.allow(false);
    if (mode === 'abandoned') f.select(false);
    await f.outbox.dispatchDue(); f.advance(100000); await f.outbox.dispatchDue();
    assert.equal(sent.length, typeof mode === 'number' ? 1 : 0);
    const state = (await f.outbox.status(owner, 'app-a')).jobs[0].state;
    assert.equal(state, mode === 'revoked' ? 'cancelled' : mode === 'abandoned' ? 'abandoned' : 'failed');
  }
});

test('recovery pauses notifications until explicit resume and records the selected strategy', async () => {
  const f = fixture();
  await f.outbox.ingest('sub-a', batch(), { expectedCursor: 'tail' });
  await f.outbox.pauseForRecovery('sub-a', { revision: { generation: 'g2' } });
  await f.outbox.dispatchDue(); assert.equal(f.sent.length, 0);
  await assert.rejects(f.outbox.resume({ ...owner, id: 'other' }, { subscriptionId: 'sub-a', strategy: 'from_current' }), /not found/);
  await f.outbox.resume(owner, { subscriptionId: 'sub-a', strategy: 'from_current' });
  const state = await f.store.read();
  assert.equal(state.subscriptions['sub-a'].sourceCursor, 'new-tail');
  assert.equal(Object.values(state.jobs)[0].reason, 'reviewed_start_from_current');
});

test('a cancelled claim cannot send after another process recreates the same subscription', async () => {
  const f = fixture(), checking = gate();
  f.bridge.verifySource = async () => { checking.enter(); await checking.wait; return { selected: true }; };
  await f.store.transaction(state => { state.subscriptions['sub-a'].activationId = 'activation-old'; });
  await f.outbox.ingest('sub-a', batch(), { expectedCursor: 'tail' });
  const dispatch = f.outbox.dispatchDue({ limit: 1 }); await checking.entered;
  // A different worker has no access to this process's AbortControllers.
  await f.store.transaction(state => {
    Object.assign(Object.values(state.jobs)[0], { state: 'cancelled', reason: 'unsubscribed' });
    state.subscriptions['sub-a'] = { ...subscription(), activationId: 'activation-new' };
  });
  checking.release(); await dispatch;
  assert.equal(f.sent.length, 0);
  assert.equal(Object.values((await f.store.read()).jobs)[0].state, 'cancelled');
});

test('reclaimed leases invalidate old workers without disturbing the current delivery controller', async () => {
  const firstCheck = gate(), secondSend = gate();
  let checks = 0, deliveredSignal;
  const f = fixture({ send: async (_url, { signal }) => { deliveredSignal = signal; secondSend.enter(); await secondSend.wait; return { status: 200 }; } });
  f.bridge.verifySource = async () => {
    if (++checks === 1) { firstCheck.enter(); await firstCheck.wait; }
    return { selected: true };
  };
  await f.outbox.ingest('sub-a', batch(), { expectedCursor: 'tail' });
  const stale = f.outbox.dispatchDue({ limit: 1 }); await firstCheck.entered;
  f.advance(30_001);
  const current = f.outbox.dispatchDue({ limit: 1 }); await secondSend.entered;
  firstCheck.release(); await stale;
  await f.store.transaction(state => { Object.values(state.jobs)[0].state = 'cancelled'; });
  await f.outbox.cancelInactive();
  assert.equal(deliveredSignal.aborted, true, 'The old worker must not remove the new controller');
  secondSend.release(); await current;
  assert.equal(checks, 2);
  assert.equal(Object.values((await f.store.read()).jobs)[0].state, 'cancelled');
});

test('a late 410 cannot stop a newly activated subscription with the same version', async () => {
  const delivery = gate();
  const f = fixture({ send: async () => { delivery.enter(); await delivery.wait; return { status: 410 }; } });
  await f.store.transaction(state => { state.subscriptions['sub-a'].activationId = 'activation-old'; });
  await f.outbox.ingest('sub-a', batch(), { expectedCursor: 'tail' });
  const dispatch = f.outbox.dispatchDue({ limit: 1 }); await delivery.entered;
  await f.store.transaction(state => { state.subscriptions['sub-a'] = { ...subscription(), activationId: 'activation-new' }; });
  delivery.release(); await dispatch;
  assert.equal((await f.store.read()).subscriptions['sub-a'].active, true);
});

test('old activation jobs are cancelled before being claimed or sent', async () => {
  const f = fixture();
  await f.store.transaction(state => { state.subscriptions['sub-a'].activationId = 'activation-old'; });
  await f.outbox.ingest('sub-a', batch(), { expectedCursor: 'tail' });
  await f.store.transaction(state => { state.subscriptions['sub-a'].activationId = 'activation-new'; });
  await f.outbox.dispatchDue();
  assert.equal(f.sent.length, 0);
  assert.equal(Object.values((await f.store.read()).jobs)[0].reason, 'subscription_replaced');
});
