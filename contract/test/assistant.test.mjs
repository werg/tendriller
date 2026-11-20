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

const flush = () => new Promise(resolve => setImmediate(resolve));
async function startupFixture(t, options = {}) {
  const { connectApplicationAssistant } = await import('../assistant.mjs');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const reports = [], stop = new AbortController(); let attempts = 0, socket;
  class Socket extends EventTarget {
    readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    close(code = 1000) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
  }
  const participant = connectApplicationAssistant({ api: 'https://staging.example/api/t/aaaaaaaaaaaa',
    key: 'td_a_' + 'a'.repeat(64), session: { deviceId: 'b'.repeat(64), signal: stop.signal }, tools: {},
    onStatus: value => reports.push(value), ...options,
    openSocket: () => { attempts++; if (attempts < (options.succeedAt ?? Infinity)) throw Error('awaiting owner consent'); return socket = new Socket(); },
  });
  t.after(() => participant.close());
  await flush();
  return { participant, reports, stop, attempts: () => attempts, socket: () => socket };
}

test('initial owner consent can take longer than six failed dials without stopping the participant', async t => {
  const f = await startupFixture(t, { succeedAt: 7 });
  for (let second = 0; second < 90 && !f.participant.online; second++) { t.mock.timers.tick(1000); await flush(); }
  assert.equal(f.attempts(), 7); assert.equal(f.participant.online, true);
  await f.participant.waitUntilOnline();
  assert(!f.reports.some(value => value.state === 'disconnected'));
  await f.participant.close();
});

test('unapproved initial connections stop at their bounded deadline and report it precisely', async t => {
  const f = await startupFixture(t, { initialConnectTimeoutMs: 1000 });
  t.mock.timers.tick(1000); await flush(); await f.participant.closed;
  assert.equal(f.attempts(), 1);
  assert.deepEqual(f.reports.at(-1), { state: 'disconnected', reason: 'startup_timeout' });
});

test('revocation remains terminal even with time left in the initial consent window', async t => {
  const f = await startupFixture(t, { succeedAt: 1 });
  await f.participant.waitUntilOnline(); f.socket().close(4003); await flush(); await f.participant.closed;
  t.mock.timers.tick(600000); await flush();
  assert.equal(f.attempts(), 1);
  assert.deepEqual(f.reports.at(-1), { state: 'disconnected', reason: 'approval_changed' });
});

test('cancelling pending initial consent closes its retry timer and opens no further sockets', async t => {
  const f = await startupFixture(t); f.stop.abort(); await f.participant.closed;
  t.mock.timers.tick(600000); await flush(); assert.equal(f.attempts(), 1);
});

test('startup consent windows reject unbounded or unsupported values before opening a socket', async () => {
  const { connectApplicationAssistant } = await import('../assistant.mjs');
  for (const initialConnectTimeoutMs of [0, NaN, Infinity, 600001, 2.5])
    assert.throws(() => connectApplicationAssistant({ key: 'td_a_' + 'a'.repeat(64), initialConnectTimeoutMs,
      openSocket() { assert.fail('invalid options opened a socket'); } }), { code: 'INVALID_ASSISTANT_STARTUP_TIMEOUT' });
});
