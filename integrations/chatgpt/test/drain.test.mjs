import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryDrain } from '../drain.mjs';

test('a bounded wake scans only new pages and an alarm for retries does not scan', async () => {
  const seen = [], dispatched = [];
  let cursor = 'a';
  const subscription = { id: 's', applicationId: 'app', owner: 'owner', name: 'change', active: true, expiresAt: 1_000 };
  const store = { read: async () => ({ subscriptions: { s: subscription }, jobs: {
    retry: { subscriptionId: 's', state: 'retry', nextAttemptAt: 500 },
  } }) };
  const drain = createDeliveryDrain({ batches: 1, deliveries: 2, clock: () => 100, store, authorize: async () => {},
    subscriptions: { active: async () => [{ ...subscription, sourceCursor: cursor }] },
    bridge: { async readEvents(_id, { cursor }) {
      return { cursor: cursor === 'a' ? 'b' : 'c', hasMore: cursor === 'a' };
    } },
    outbox: {
      async ingest(_id, batch, { expectedCursor }) {
        assert.equal(expectedCursor, cursor);
        seen.push(batch.cursor);
        cursor = batch.cursor;
        return true;
      },
      async dispatchDue({ limit }) { dispatched.push(limit); },
    } });
  assert.deepEqual(await drain({ observe: true }), { more: true, nextDue: 500 });
  assert.deepEqual(await drain({ observe: true }), { more: false, nextDue: 500 });
  assert.deepEqual(await drain(), { more: false, nextDue: 500 });
  assert.deepEqual(seen, ['b', 'c']);
  assert.deepEqual(dispatched, [2, 2, 2]);
});
