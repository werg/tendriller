import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.mjs';
import { createSubscriptions, selectedTail, subscriptionIdentity } from '../subscriptions.mjs';

const owner = { id: 'owner', issuer: 'https://issuer.example' };
const request = () => ({ name: 'assistant.help_requested', arguments: { application_id: 'app-a' },
  delivery: { mode: 'webhook', url: 'https://callback.example/event', secret: 'whsec_' + Buffer.alloc(32).toString('base64') }, cursor: null });
function fixture(options = {}) {
  let now = 1000000, calls = 0, captures = 0;
  const store = createMemoryStore();
  const service = createSubscriptions({ store, clock: () => now,
    authorize: async (principal, app) => { if (principal.id !== 'owner' || app !== 'app-a') throw Error('denied'); },
    applicationIds: async () => ['app-a'],
    captureCursor: async () => { captures++; return { cursor: 'current-tail', revision: { generation: 'g1' } }; },
    send: async (_url, { body }) => { calls++; return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }; }, ...options });
  return { service, store, advance: value => { now += value; }, calls: () => calls, captures: () => captures };
}

test('subscriptions are owner-bound, start at selected tail and refresh without skipping pending history', async () => {
  const f = fixture(), input = request();
  const first = await f.service.subscribe(owner, input);
  await f.store.transaction(state => { state.subscriptions[first.id].sourceCursor = 'pending-history'; });
  f.advance(1000);
  const again = await f.service.subscribe(owner, input);
  assert.equal(again.id, first.id); assert.equal(f.captures(), 1); assert.equal(f.calls(), 1);
  assert.equal((await f.store.read()).subscriptions[first.id].sourceCursor, 'pending-history');
  assert.equal(again.cursor, null); assert.equal(again.truncated, false);
  await assert.rejects(f.service.subscribe({ ...owner, id: 'other' }, input), /denied/);
  await f.service.unsubscribe(owner, { name: input.name, arguments: input.arguments, delivery: { mode: 'webhook', url: input.delivery.url } });
  assert.equal((await f.service.active()).length, 0);
});

test('new secret gets a fresh challenge and finite overlap, expiry restarts from current tail', async () => {
  const f = fixture(), input = request();
  const first = await f.service.subscribe(owner, { ...input, ttlMs: 5000 });
  const newSecret = 'whsec_' + Buffer.alloc(32, 4).toString('base64');
  await f.service.subscribe(owner, { ...input, delivery: { ...input.delivery, secret: newSecret }, ttlMs: 5000 });
  assert.equal(f.calls(), 2);
  assert.equal((await f.store.read()).subscriptions[first.id].previousSecret.secret, input.delivery.secret);
  f.advance(5001);
  assert.equal((await f.service.active()).length, 0);
  await f.service.subscribe(owner, input);
  assert.equal(f.captures(), 2);
});

test('unsubscribe while challenge is in flight prevents late activation', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture({ send: async (_url, { body }) => {
    entered(); await new Promise(resolve => { release = resolve; });
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  } });
  const input = request(), pending = f.service.subscribe(owner, input);
  await ready;
  await f.service.unsubscribe(owner, { name: input.name, arguments: input.arguments, delivery: { mode: 'webhook', url: input.delivery.url } });
  release(); await assert.rejects(pending, /changed while/);
  assert.equal((await f.service.active()).length, 0);
});

test('invalid cursors and callbacks cannot activate; empty scanned batches still advance baseline', async () => {
  const f = fixture();
  await assert.rejects(f.service.subscribe(owner, { ...request(), cursor: 'untrusted-skip' }), /replay cursors/);
  assert.deepEqual(await f.store.read(), {});
  let calls = 0;
  const tail = await selectedTail({ readEvents: async (_app, { cursor }) => {
    calls++; return cursor ? { events: [], cursor: 'end', hasMore: false, revision: { generation: 'g' } } :
      { events: [], cursor: 'scanned-empty', hasMore: true, revision: { generation: 'g' } };
  } }, 'app-a');
  assert.equal(calls, 2); assert.equal(tail.cursor, 'end');
});

test('disconnect during initial account lookup defeats the pending reservation', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture({ authorize: async () => { entered(); await new Promise(resolve => { release = resolve; }); } });
  const input = request(), pending = f.service.subscribe(owner, input);
  await ready;
  await f.service.unsubscribe(owner, { name: input.name, arguments: input.arguments, delivery: { mode: 'webhook', url: input.delivery.url } });
  // The second authorization uses a new waiter; release both lookups.
  release(); await new Promise(resolve => setImmediate(resolve)); release();
  await assert.rejects(pending, /changed while/);
  assert.equal((await f.service.active()).length, 0);
});

test('expired subscriptions cannot bypass quota, and unknown unsubscribes do not grow storage', async () => {
  const f = fixture({ maxPerOwner: 1 }), input = request();
  await f.service.subscribe(owner, { ...input, ttlMs: 1 }); f.advance(2);
  await f.service.subscribe(owner, { ...input, delivery: { ...input.delivery, url: 'https://second.example/callback' } });
  await assert.rejects(f.service.subscribe(owner, input), /Too many/);
  const count = Object.keys((await f.store.read()).subscriptions).length;
  for (let i = 0; i < 20; i++) await f.service.unsubscribe(owner, { name: input.name, arguments: input.arguments,
    delivery: { mode: 'webhook', url: `https://unused.example/${i}` } });
  assert.equal(Object.keys((await f.store.read()).subscriptions).length, count);
});

test('refresh preserves recovery review across expiry, while a fresh activation cancels old pending jobs', async () => {
  const f = fixture(), input = request(), first = await f.service.subscribe(owner, { ...input, ttlMs: 100 });
  const activation = (await f.store.read()).subscriptions[first.id].activationId;
  await f.store.transaction(state => {
    Object.assign(state.subscriptions[first.id], { pausedReason: 'recovery_review_required', recoveryRevision: { generation: 'g2' }, recoveryVersion: 2, recoveryNoticeError: 'OUTBOX_CAPACITY' });
  });
  f.advance(101); await f.service.subscribe(owner, input);
  const refreshed = (await f.store.read()).subscriptions[first.id];
  assert.equal(refreshed.activationId, activation); assert.equal(refreshed.pausedReason, 'recovery_review_required');
  assert.equal(refreshed.recoveryNoticeError, 'OUTBOX_CAPACITY'); assert.equal(f.captures(), 1);
  const fresh = fixture(), old = await fresh.service.subscribe(owner, { ...input, ttlMs: 10 });
  await fresh.store.transaction(state => { state.jobs = { pending: { subscriptionId: old.id, state: 'queued' } }; });
  fresh.advance(11); await fresh.service.subscribe(owner, input);
  assert.equal((await fresh.store.read()).jobs.pending.state, 'cancelled');
});

test('failed refresh preserves an inactive recovery pause until explicit review', async () => {
  let failChallenge = false;
  const f = fixture({ send: async (_url, { body }) => {
    if (failChallenge) throw Error('CALLBACK_UNAVAILABLE');
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  } });
  const input = request(), first = await f.service.subscribe(owner, input);
  await f.store.transaction(state => {
    const sub = state.subscriptions[first.id];
    Object.assign(sub, { active: false, pausedReason: 'recovery_review_required', recoveryRevision: { generation: 'g2' },
      recoveryVersion: 1, sourceCursor: 'reviewed-later', stopReason: 'callback_gone' });
    delete sub.secret;
  });
  failChallenge = true;
  await assert.rejects(f.service.subscribe(owner, input), /Callback verification failed/);
  let sub = (await f.store.read()).subscriptions[first.id];
  assert.equal(sub.active, false); assert.equal(sub.pausedReason, 'recovery_review_required');
  assert.equal(sub.pendingToken, undefined); assert.equal(sub.pendingUntil, undefined);
  failChallenge = false; await f.service.subscribe(owner, input);
  sub = (await f.store.read()).subscriptions[first.id];
  assert.equal(sub.active, true); assert.equal(sub.pausedReason, 'recovery_review_required');
  assert.equal(sub.sourceCursor, 'reviewed-later'); assert.deepEqual(sub.recoveryRevision, { generation: 'g2' });
  assert.equal(f.captures(), 1, 'A failed refresh cannot turn paused history into a new baseline');
});

test('trusted OAuth grant metadata survives delivery and refresh without changing identity or quota', async () => {
  const checked = [], f = fixture({ maxPerOwner: 1, authorize: async principal => { checked.push(principal); } });
  const input = request(), old = { ...owner, oauthGrantId: 'grant-old', scopes: ['events:subscribe'], accessToken: 'never-persist' };
  const first = await f.service.subscribe(old, input);
  assert.equal(first.id, subscriptionIdentity(owner, input.name, input.arguments, input.delivery.url));
  assert.equal((await f.service.list(old)).events.length, 4);
  assert.equal(checked.every(principal => principal.oauthGrantId === 'grant-old'), true);
  await f.store.transaction(state => { state.subscriptions[first.id].sourceCursor = 'pending-history'; });
  const fresh = { ...old, oauthGrantId: 'grant-new', scopes: ['applications:read', 'events:subscribe'] };
  const refreshed = await f.service.subscribe(fresh, input);
  assert.equal(refreshed.id, first.id);
  const stored = (await f.store.read()).subscriptions[first.id];
  assert.deepEqual(stored.owner, { ...owner, oauthGrantId: 'grant-new', scopes: fresh.scopes });
  assert.equal(stored.sourceCursor, 'pending-history'); assert.equal(f.captures(), 1);
  await assert.rejects(f.service.subscribe({ ...fresh, oauthGrantId: 'grant-third' }, { ...input,
    delivery: { ...input.delivery, url: 'https://second.example/callback' } }), { code: 'SUBSCRIPTION_LIMIT' });
  assert.equal(JSON.stringify(await f.store.read()).includes('never-persist'), false);
});

test('approved sibling bindings get independent subscriptions while sharing the account cap', async () => {
  const f = fixture({ maxPerOwner: 2 }), input = request();
  const binding = id => ({ ...owner, agentBinding: { id, revision: 1, applications: { 'app-a': { events: ['assistant.help_requested'] } } } });
  const planner = binding('planner'), reviewer = binding('reviewer');
  const one = await f.service.subscribe(planner, input), two = await f.service.subscribe(reviewer, input);
  assert.notEqual(one.id, two.id); assert.equal(f.calls(), 2);
  await assert.rejects(f.service.subscribe(binding('extra'), input), { code: 'SUBSCRIPTION_LIMIT' });
  const rotated = await f.service.subscribe({ ...planner, oauthGrantId: 'rotated-token' }, input);
  assert.equal(rotated.id, one.id); assert.equal(f.captures(), 2);
  await f.service.unsubscribe(planner, { name: input.name, arguments: input.arguments, delivery: { mode: 'webhook', url: input.delivery.url } });
  assert.deepEqual((await f.service.active()).map(value => value.id), [two.id]);
  const saved = (await f.store.read()).subscriptions[two.id];
  assert.equal(saved.owner.agentBindingId, 'reviewer');
  assert.equal(saved.cursorScope.consumerId.startsWith('consumer_'), true);
  assert.equal(saved.cursorScope.filter, 'assistant.help_requested');
});
