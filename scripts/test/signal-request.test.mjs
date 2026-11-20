import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignalRequests, serveSignalRequests } from '../../docs/tutorial/helpers/signal-request.mjs';

// Two sessions on one in-memory live-signal bus. `faults` lets a test drop or refuse
// individual sends, as a slow phone link or a stalled relay would.
function bus(faults = {}) {
  const subscribers = new Set(), sent = [];
  const session = (deviceId, peer) => ({
    deviceId,
    participation: { status: { connectedPeers: [peer] }, onStatus() { return () => {}; } },
    signals: {
      async send(topic, payload) {
        sent.push({ from: deviceId, topic, payload });
        const fault = faults.send?.({ from: deviceId, topic, payload });
        if (fault === 'refuse') throw Object.assign(Error('stalled'), { code: 'SIGNAL_SEND_TIMEOUT' });
        if (fault === 'drop') return; // accepted locally, lost on the way (live signals are unreliable)
        for (const subscriber of subscribers) if (subscriber.from !== deviceId && subscriber.topics.includes(topic))
          subscriber.push({ authorId: deviceId, topic, payload: structuredClone(payload) });
      },
      subscribe({ topics, signal }) {
        const queue = [], waiters = [];
        const subscriber = { from: deviceId, topics, push(value) { const waiter = waiters.shift(); if (waiter) waiter({ value, done: false }); else queue.push(value); } };
        subscribers.add(subscriber);
        signal?.addEventListener('abort', () => { subscribers.delete(subscriber); for (const waiter of waiters.splice(0)) waiter({ done: true }); }, { once: true });
        return { [Symbol.asyncIterator]() { return { next: () => queue.length ? Promise.resolve({ value: queue.shift(), done: false })
          : signal?.aborted ? Promise.resolve({ done: true }) : new Promise(resolve => waiters.push(resolve)) }; } };
      },
    },
  });
  return { browser: session('browser', 'native'), native: session('native', 'browser'), sent };
}

async function roundTrip(faults) {
  const { browser, native, sent } = bus(faults), stop = new AbortController();
  let computed = 0;
  void serveSignalRequests(native, { signal: stop.signal, handle: async () => { computed++; return { rows: Array.from({ length: 40 }, (_v, i) => 'row ' + i + ' ' + 'x'.repeat(900)) }; } });
  const requests = createSignalRequests(browser, { peer: 'native', retryMs: 50 });
  try {
    const answer = await requests.request('rows', null, { timeoutMs: 10_000 });
    return { answer, computed, sent };
  } finally { requests.close(); stop.abort(); }
}

test('a multi-piece reply completes even when a middle piece is lost in transit', async () => {
  let dropped = false;
  const { answer, computed, sent } = await roundTrip({ send: ({ topic, payload }) =>
    topic === 'app/reply' && payload.i === 2 && !dropped && (dropped = true) ? 'drop' : undefined });
  assert.equal(answer.rows.length, 40);
  assert.equal(computed, 1, 'a repeat request is answered from the cache, not recomputed');
  assert.ok(sent.filter(item => item.topic === 'app/request').length >= 2, 'the page asked again for the incomplete reply');
});

test('a piece refused with SIGNAL_SEND_TIMEOUT is retried and does not drop the rest of the reply', async () => {
  let refused = 0;
  const { answer, sent } = await roundTrip({ send: ({ topic, payload }) =>
    topic === 'app/reply' && payload.i === 1 && refused++ < 2 ? 'refuse' : undefined });
  assert.equal(answer.rows.length, 40);
  assert.equal(refused >= 3, true, 'the refused piece was attempted again');
  const pieces = new Set(sent.filter(item => item.topic === 'app/reply').map(item => item.payload.i));
  assert.equal(pieces.size, answer.rows.length ? Math.max(...pieces) + 1 : 0, 'every piece index was sent');
});
