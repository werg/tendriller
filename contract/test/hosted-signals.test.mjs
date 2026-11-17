import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostedSignalPort, createSignalInput, SIGNAL_LIMITS, validateSignalInput, connectHostedSignals } from '../hosted-signals.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const envelope = (sequence, payload = sequence, authorId = 'alice', sessionId = 'session') => ({
  scope: 'page', authorId, sessionId, sequence, ...createSignalInput('progress', payload),
});
function harness() {
  let online = true, receive, connection;
  const sent = [];
  const api = createHostedSignalPort({ connected: () => online,
    request: async (message, options) => { sent.push({ message, options }); return { signal: { ...envelope(sent.length), ...message.message } }; },
    onMessage(listener) { receive = listener; return () => { receive = () => {}; }; },
    onConnection(listener) { connection = listener; return () => {}; },
  });
  return { api, sent, receive: value => receive(value), connection(value) { online = value; connection(); } };
}

test('hosted live subscriptions have no catch-up, clear pending values at disconnect, and preserve independent senders', async () => {
  const h = harness(), first = h.api.subscribe({ mode: 'latest' });
  h.receive(envelope(1)); h.receive(envelope(2)); h.receive(envelope(1, 'bob', 'bob'));
  assert.equal((await first.next()).value.sequence, 2);
  assert.equal((await first.next()).value.authorId, 'bob');
  h.receive(envelope(3));
  const late = h.api.subscribe();
  h.connection(false);
  await assert.rejects(h.api.send('typing', true), { code: 'signal_disconnected' });
  h.connection(true); h.receive(envelope(4));
  assert.equal((await first.next()).value.sequence, 4);
  assert.equal((await late.next()).value.sequence, 4);
  assert.ok(h.sent.every(({ message }) => !Object.hasOwn(message, 'after') && !Object.hasOwn(message, 'operationId')));
  await first.return(); await late.return(); h.api.close();
});

test('FIFO overflow is visible to that consumer while latest remains bounded and usable', async () => {
  const h = harness(), fifo = h.api.subscribe(), latest = h.api.subscribe({ mode: 'latest' });
  for (let i = 1; i <= SIGNAL_LIMITS.queue + 1; i++) h.receive(envelope(i));
  await assert.rejects(fifo.next(), { code: 'signal_overflow' });
  assert.equal((await latest.next()).value.sequence, SIGNAL_LIMITS.queue + 1);
  await latest.return(); h.api.close();
});

test('expiry, cancellation and subscriber disposal release live work without replay', async () => {
  const h = harness(), stop = new AbortController(), iterator = h.api.subscribe({ signal: stop.signal });
  const pending = iterator.next(); stop.abort(); assert.equal((await pending).done, true);
  const next = h.api.subscribe(), waiting = next.next();
  h.receive({ ...envelope(1), issuedAtMs: Date.now() - 10, expiresAtMs: Date.now() - 1 });
  h.receive(envelope(2)); assert.equal((await waiting).value.sequence, 2);
  const cancelled = new AbortController(); cancelled.abort(new Error('disposed'));
  const before = h.sent.length;
  await assert.rejects(h.api.send('progress', 1, { signal: cancelled.signal }), /disposed/);
  assert.equal(h.sent.length, before);
  const idle = next.next(); await next.return(); assert.equal((await idle).done, true);
  h.api.close();
});

test('subscribers cannot mutate each other and payload/authentication fields are validated', async () => {
  const h = harness(), a = h.api.subscribe(), b = h.api.subscribe();
  h.receive(envelope(1, { n: 1 }));
  (await a.next()).value.payload.n = 7;
  assert.equal((await b.next()).value.payload.n, 1);
  const input = createSignalInput('typing', false);
  assert.throws(() => validateSignalInput({ ...input, authorId: 'forged' }), { code: 'invalid_signal' });
  assert.throws(() => createSignalInput('typing', Infinity), { code: 'invalid_signal' });
  assert.throws(() => createSignalInput('typing', 'x'.repeat(SIGNAL_LIMITS.bytes)), { code: 'signal_too_large' });
  assert.throws(() => validateSignalInput({ ...input, expiresAtMs: input.issuedAtMs + SIGNAL_LIMITS.ttlMs + 1 }), { code: 'invalid_signal' });
  await a.return(); await b.return(); h.api.close();
});

test('the explicit SDK connection uses headers, correlated cancellation, and no automatic resend', async () => {
  class Socket extends EventTarget {
    readyState = 1; bufferedAmount = 0; sent = [];
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  }
  const socket = new Socket();
  const opening = connectHostedSignals({ base: 'https://service.test/api/t/page', protocols: ['tendriller.signals.v1', 'private'],
    open(url, protocols) { assert.equal(url, 'wss://service.test/api/t/page/signals/socket'); assert.deepEqual(protocols, ['tendriller.signals.v1', 'private']); return socket; } });
  socket.receive({ t: 'signal_ready', scope: 'page' });
  const signals = await opening, stop = new AbortController();
  const cancelled = signals.send('progress', 1, { signal: stop.signal });
  const original = socket.sent[0]; stop.abort(new Error('no longer relevant'));
  await assert.rejects(cancelled, /no longer relevant/);
  socket.receive({ t: 'ack', cid: original.cid, signal: envelope(1) });
  assert.equal(socket.sent.length, 1);
  const send = signals.send('progress', 2);
  socket.receive({ t: 'ack', cid: socket.sent.at(-1).cid, signal: envelope(2) });
  assert.equal((await send).sequence, 2);
  signals.close();
  await assert.rejects(signals.send('progress', 3), { code: 'signal_disconnected' });
  await turn(); assert.equal(socket.sent.length, 2);
});

test('subscription reconciliation bounds requests and handles synchronous transport failure', async () => {
  let attempts = 0;
  const api = createHostedSignalPort({ connected: () => true,
    request() { attempts++; throw new Error('transport failed'); }, onMessage: () => () => {} });
  const readers = Array.from({ length: 10 }, () => api.subscribe());
  const waits = readers.map(reader => assert.rejects(reader.next(), /transport failed/));
  await Promise.all(waits); await turn();
  assert.equal(attempts, 1); api.close();
});
