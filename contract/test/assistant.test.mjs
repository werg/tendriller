import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardApplicationEvents } from '../assistant.mjs';

test('the assistant forwarder rearms a committed event and skips only a declined projection', async () => {
  const generation = 'a'.repeat(64), lifetime = new AbortController();
  const fixtures = [{ id: 'first' }, { id: 'declined' }, { id: 'last' }];
  const deliveries = [], skipped = [], checkpoints = [];
  let released = 0;
  const session = {
    signal: lifetime.signal,
    async *changes() { yield { kind: 'applied' }; },
    async readView() {
      return { readEvents: () => ({ cursor: 'saved', hasMore: false, revision: { generation }, events: fixtures }),
        release: () => { released++; } };
    },
  };
  const assistant = {
    async waitUntilOnline() {},
    async publish(event) {
      deliveries.push(event);
      if (deliveries.length === 1) throw Object.assign(new Error('Alarm write failed'), { code: 'application_event_unavailable' });
      if (event.name === 'declined') throw Object.assign(new Error('Owner declined'), { code: 'event_not_approved' });
    },
  };
  await forwardApplicationEvents({ session, assistant, topics: ['test'],
    checkpoint: { load: () => undefined, save: cursor => checkpoints.push(cursor) },
    onSkipped: event => skipped.push(event),
    project: event => ({ name: event.id, payload: { value: event.id } }),
  });
  assert.equal(released, 1);
  assert.deepEqual(deliveries.map(event => event.sourceEventId), ['first', 'first', 'declined', 'last']);
  assert.deepEqual(deliveries[0], deliveries[1]);
  assert.deepEqual(skipped, [{ name: 'declined', sourceEventId: 'declined' }]);
  assert.deepEqual(checkpoints, ['saved']);
});
