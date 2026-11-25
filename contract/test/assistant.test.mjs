import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantEventDelivery } from '../assistant.mjs';

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
  const participant = connectApplicationAssistant({ page: { request: async () => ({}), socket() { throw Error('unused'); } },
    key: 'td_a_' + 'a'.repeat(64), session: { deviceId: 'b'.repeat(64), signal: stop.signal }, tools: { execute: async () => {} },
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

test('a raw unscoped tool service fails before opening a hosted connection', async () => {
  const { connectApplicationAssistant } = await import('../assistant.mjs');
  assert.throws(() => connectApplicationAssistant({ key: 'td_a_' + 'a'.repeat(64), tools: { call() {} },
    openSocket() { assert.fail('invalid tool controller opened a socket'); } }), { code: 'INVALID_ASSISTANT_TOOLS' });
});

test('the hosted adapter uses scoped execute and preserves the canonical signed reference on its wire', async t => {
  const { connectApplicationAssistant } = await import('../assistant.mjs');
  const stop = new AbortController(), calls = [], frames = [], generation = 'a'.repeat(64), author = 'b'.repeat(64);
  let socket;
  class Socket extends EventTarget {
    readyState = 0;
    send(data) { frames.push(JSON.parse(data)); }
    close(code = 1000) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
  }
  const reference = { applicationId: 'c'.repeat(64), historyId: 'history', author,
    operationId: 'scoped/original-id', attemptId: 'd'.repeat(64), generation };
  const participant = connectApplicationAssistant({ page: { request: async () => ({}), socket() { throw Error('unused'); } }, key: 'td_a_' + 'e'.repeat(64),
    session: { applicationId: reference.applicationId, historyId: reference.historyId, deviceId: author, status: { generation }, signal: stop.signal },
    tools: { execute: async (call, options) => {
      calls.push({ call, options });
      return { operationId: reference.operationId, operationReference: reference };
    } }, openSocket() {
      socket = new Socket(); queueMicrotask(() => { socket.readyState = 1; socket.dispatchEvent(new Event('open')); }); return socket;
    } });
  t.after(() => participant.close()); await participant.waitUntilOnline();
  const message = { type: 'call', id: 'call-1', applicationId: reference.applicationId, generation,
    kind: 'operation', name: 'addNote', operationId: reference.operationId };
  socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(message) }));
  await flush(); await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].call.kind, 'operation'); assert.equal(calls[0].call.name, 'addNote');
  assert.equal(calls[0].call.operationId, reference.operationId); assert(calls[0].options.signal instanceof AbortSignal);
  const { author: _author, ...wire } = reference;
  assert.deepEqual(frames.find(frame => frame.id === message.id), { type: 'result', id: message.id,
    value: { operationId: reference.operationId, operationReference: { ...wire, deviceId: author } } });
});

test('event delivery does not publish or report a skip after cancellation during an internal wait', async () => {
  const stop = new AbortController(), gate = Promise.withResolvers(), cause = Error('owner stopped');
  let published = 0, skipped = 0;
  const deliver = createAssistantEventDelivery({ assistant: {
    waitUntilOnline: () => gate.promise, publish: async () => { published++; },
  }, onSkipped: () => skipped++ });
  const pending = deliver({ name: 'note', payload: null }, { id: 'event-1' }, { revision: { generation: 'a'.repeat(64) } }, stop.signal);
  stop.abort(cause); gate.resolve(); await assert.rejects(pending, error => error === cause);
  assert.equal(published, 0); assert.equal(skipped, 0);

  const second = new AbortController(), response = Promise.withResolvers();
  const late = createAssistantEventDelivery({ assistant: { waitUntilOnline: async () => {}, publish: () => response.promise },
    onSkipped: () => skipped++ })({ name: 'note', payload: null }, { id: 'event-2' }, { revision: { generation: 'a'.repeat(64) } }, second.signal);
  await flush(); second.abort(cause); response.reject(Object.assign(Error('declined'), { code: 'event_not_approved' }));
  await assert.rejects(late, error => error === cause); assert.equal(skipped, 0);
});
