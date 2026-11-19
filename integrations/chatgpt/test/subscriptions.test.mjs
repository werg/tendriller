import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.mjs';
import { createSubscriptions, selectedTail } from '../subscriptions.mjs';

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
