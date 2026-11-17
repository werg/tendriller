import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedSignalPort, createSignalInput, validateSignalInput, SIGNAL_LIMITS, connectHostedSignals } from '../hosted-signals.mjs';
import { createClient } from '../client.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const envelope = (sequence = 1, payload = sequence, options = {}) => ({ scope: 'cf:app', authorId: 'account:owner', sessionId: 'live-session',
  sequence, topic: 'progress', payload, issuedAtMs: 100, expiresAtMs: 500, ...options });
function fixture({ manual = false } = {}) {
  let online = true, time = 100, receive, connection;
  const sent = [], pending = new Map();
  const port = createHostedSignalPort({ scope: () => 'cf:app', connected: () => online, now: () => time,
    request(message, { signal }) {
      sent.push(message);
      if (message.t !== 'signal_send' || !manual) return Promise.resolve({ signal: { ...envelope(sent.length), ...message.message } });
      return new Promise((resolve, reject) => {
        const finish = (error, value) => { pending.delete(message); signal.removeEventListener('abort', cancel); error ? reject(error) : resolve(value); };
        const cancel = () => finish(signal.reason);
        signal.addEventListener('abort', cancel, { once: true }); pending.set(message, finish);
      });
    },
    onMessage(listener) { receive = listener; return () => { receive = () => {}; }; },
    onConnection(listener) { connection = listener; return () => {}; },
  });
  return { port, sent, pending, receive: message => receive(message), time(value) { time = value; },
    connection(value) { online = value; connection(); },
    reply(value) { const finish = pending.values().next().value; assert.ok(finish); finish(undefined, { signal: value }); },
  };
}

test('hosted sends snapshot input and never enter an offline or reconnect retry queue', async () => {
  const f = fixture({ manual: true });
  f.connection(false);
  await assert.rejects(f.port.send('progress', 1), { code: 'signal_disconnected' });
  assert.equal(f.sent.length, 0);
  f.connection(true);
  const input = { progress: 2 }, sending = f.port.send('progress', input);
  input.progress = 99;
  assert.equal(f.sent[0].message.payload.progress, 2);
  assert.equal(f.sent[0].message.expiresAtMs, 5100);
  f.connection(false);
  await assert.rejects(sending, { code: 'signal_disconnected' });
  assert.equal(f.pending.size, 0);
  f.connection(true); assert.equal(f.sent.length, 1);
  const next = f.port.send('progress', 3);
  f.reply(envelope(3)); assert.equal((await next).sequence, 3);
  f.port.close();
});

test('first and last readers control one server subscription and reconnect restores demand only', async () => {
  const f = fixture(), first = f.port.subscribe(), second = f.port.subscribe({ mode: 'latest' });
  await turn(); assert.deepEqual(f.sent.map(m => m.t), ['signal_subscribe']);
  f.receive(envelope(1));
  f.connection(false); f.connection(true); await turn();
  assert.deepEqual(f.sent.map(m => m.t), ['signal_subscribe', 'signal_subscribe']);
  f.receive(envelope(2)); assert.equal((await first.next()).value.sequence, 2);
  assert.equal((await second.next()).value.sequence, 2);
  await first.return(); await turn(); assert.equal(f.sent.length, 2);
  await second.return(); await turn(); assert.equal(f.sent.at(-1).t, 'signal_unsubscribe');
  const count = f.sent.length; f.connection(false); f.connection(true); await turn();
  assert.equal(f.sent.length, count);
  const alreadyStopped = new AbortController(); alreadyStopped.abort();
  assert.equal((await f.port.subscribe({ signal: alreadyStopped.signal }).next()).done, true);
  assert.equal(f.sent.length, count); f.port.close();
});

test('FIFO and latest preserve independent senders and latest never resurrects an older longer-lived value', async () => {
  const f = fixture(), all = f.port.subscribe(), latest = f.port.subscribe({ mode: 'latest' });
  f.receive(envelope(2, 'new', { expiresAtMs: 150 })); f.receive(envelope(1, 'old'));
  assert.equal((await all.next()).value.sequence, 2); assert.equal((await all.next()).value.sequence, 1);
  assert.equal((await latest.next()).value.sequence, 2);
  f.time(200); f.receive(envelope(1, 'old with longer TTL'));
  f.receive(envelope(1, 'another sender', { authorId: 'account:bob' }));
  assert.equal((await latest.next()).value.authorId, 'account:bob');
  f.receive(envelope(3)); assert.equal((await latest.next()).value.sequence, 3);
  f.port.close();
});

test('scope, future skew, expiry and local clock rollback cannot revive stale observations', async () => {
  const f = fixture(), input = f.port.subscribe();
  f.receive(envelope(1, 'wrong scope', { scope: 'cf:another' }));
  f.receive(envelope(2, 'future', { issuedAtMs: 5000, expiresAtMs: 6000 }));
  f.time(600); f.receive(envelope(3)); f.time(50); f.receive(envelope(4));
  const pending = input.next(); await input.return(); assert.equal((await pending).done, true);
  f.port.close();
});

test('overflow is visible and isolated to the slow live subscription', async () => {
  const f = fixture(), slow = f.port.subscribe(), latest = f.port.subscribe({ mode: 'latest' });
  for (let i = 1; i <= SIGNAL_LIMITS.pendingMessages + 1; i++) f.receive(envelope(i));
  await assert.rejects(slow.next(), { code: 'signal_overflow' });
  assert.equal((await latest.next()).value.sequence, SIGNAL_LIMITS.pendingMessages + 1); f.port.close();
});

test('byte budgets and latest sender budgets are independent of the message-count limit', async () => {
  const f = fixture(), bytes = f.port.subscribe(), latest = f.port.subscribe({ mode: 'latest' });
  const payload = 'x'.repeat(SIGNAL_LIMITS.payloadBytes - 2);
  for (let i = 1; i <= 17; i++) f.receive(envelope(i, payload));
  await assert.rejects(bytes.next(), { code: 'signal_overflow' });
  assert.equal((await latest.next()).value.sequence, 17);
  for (let i = 1; i < SIGNAL_LIMITS.latestKeys; i++) {
    f.receive(envelope(1, i, { authorId: `account:${i}` }));
    assert.equal((await latest.next()).value.payload, i);
  }
  f.receive(envelope(1, 'excess', { authorId: 'account:extra' }));
  await assert.rejects(latest.next(), { code: 'signal_overflow' }); f.port.close();
});

test('latest tracking survives reconnect, respects a sender clock offset and eventually expires', async () => {
  const f = fixture(), latest = f.port.subscribe({ mode: 'latest' });
  f.receive(envelope(5, 'new short value', { issuedAtMs: 2100, expiresAtMs: 2101 }));
  assert.equal((await latest.next()).value.sequence, 5);
  f.connection(false); f.connection(true);
  f.time(32_200); // Receipt-time retention alone would have forgotten sequence 5.
  f.receive(envelope(4, 'old long value', { issuedAtMs: 3000, expiresAtMs: 33_000 }));
  f.receive(envelope(6, 'fresh', { issuedAtMs: 32_200, expiresAtMs: 32_201 }));
  assert.equal((await latest.next()).value.sequence, 6);
  f.time(100_000);
  f.receive(envelope(1, 'new observation after expiry', { issuedAtMs: 100_000, expiresAtMs: 101_000 }));
  assert.equal((await latest.next()).value.sequence, 1); f.port.close();
});

test('subscription options are captured and cannot change cancellation or delivery mode later', async () => {
  const f = fixture(), stop = new AbortController(), unrelated = new AbortController();
  const options = { mode: 'latest', signal: stop.signal }, reader = f.port.subscribe(options);
  options.mode = 'all'; options.signal = unrelated.signal;
  f.receive(envelope(1)); f.receive(envelope(2));
  assert.equal((await reader.next()).value.sequence, 2);
  const waiting = reader.next(); unrelated.abort(); stop.abort();
  assert.equal((await waiting).done, true); f.port.close();
});

test('subscribers cannot mutate each other and cancellation releases pending readers', async () => {
  const f = fixture(), a = f.port.subscribe(), b = f.port.subscribe();
  f.receive(envelope(1, { value: 1 })); (await a.next()).value.payload.value = 99;
  assert.equal((await b.next()).value.payload.value, 1);
  const stop = new AbortController(), c = f.port.subscribe({ signal: stop.signal }), pending = c.next();
  await assert.rejects(c.next(), { code: 'signal_reader_busy' });
  stop.abort(); assert.equal((await pending).done, true);
  const idle = a.next(); await a.return(); assert.equal((await idle).done, true); f.port.close();
});

test('strict JSON snapshots never execute payload getters or toJSON and reject lossy values', () => {
  let calls = 0;
  const symbol = { [Symbol('hidden')]: 1 }, sparse = []; sparse.length = 1;
  const extra = [1]; extra.other = 2;
  for (const value of [Object.defineProperty({}, 'x', { enumerable: true, get() { calls++; return 1; } }),
    Object.defineProperty({}, 'toJSON', { value() { calls++; return 1; } }), new Date(), [undefined], { x: Infinity }, -0, symbol, sparse, extra])
    assert.throws(() => createSignalInput('progress', value), { code: 'invalid_signal' });
  assert.equal(calls, 0);
  assert.throws(() => createSignalInput('progress', 'x'.repeat(SIGNAL_LIMITS.payloadBytes)), { code: 'signal_too_large' });
  const input = createSignalInput('progress', true, {}, 100);
  assert.throws(() => validateSignalInput({ ...input, authorId: 'forged' }, 100), { code: 'invalid_signal' });
  assert.throws(() => validateSignalInput({ ...input, expiresAtMs: 100 + SIGNAL_LIMITS.ttlMs + 1 }, 100), { code: 'invalid_signal' });
  assert.throws(() => validateSignalInput({ ...input, issuedAtMs: 0, expiresAtMs: 1 }, 100), { code: 'signal_expired' });
});

test('subscription failure performs at most one uncertain-ACK cleanup and never loops', async () => {
  const sent = [];
  const port = createHostedSignalPort({ connected: () => true, scope: () => 'cf:app',
    request(message) { sent.push(message); throw new Error('transport failed'); }, onMessage: () => () => {} });
  const readers = Array.from({ length: 10 }, () => port.subscribe());
  await Promise.all(readers.map(reader => assert.rejects(reader.next(), /transport failed/)));
  await turn(); assert.deepEqual(sent.map(m => m.t), ['signal_subscribe', 'signal_unsubscribe']); port.close();
});

test('deadlines and caller cancellation abort transport requests without closing the port or retrying', async () => {
  const f = fixture({ manual: true }), stop = new AbortController();
  const first = f.port.send('progress', 1, { signal: stop.signal });
  stop.abort(new Error('disposed')); await assert.rejects(first, /disposed/); assert.equal(f.pending.size, 0);
  await assert.rejects(f.port.send('progress', 2, { ttlMs: 5 }), { code: 'signal_timeout' });
  await turn(); assert.equal(f.pending.size, 0); assert.equal(f.port.connected, true); assert.equal(f.sent.length, 2);
  const wrongScope = f.port.send('progress', 3); f.reply(envelope(3, 3, { scope: 'wrong' }));
  await assert.rejects(wrongScope, { code: 'invalid_signal' }); f.port.close();
});

test('a noncooperative custom transport cannot release its work budget merely by cancellation', async () => {
  const outstanding = [];
  const port = createHostedSignalPort({ connected: () => true, scope: () => 'cf:app',
    request: () => new Promise(resolve => outstanding.push(resolve)), onMessage: () => () => {} });
  for (let i = 0; i < SIGNAL_LIMITS.pendingSends; i++) {
    const stop = new AbortController(), pending = port.send('progress', i, { signal: stop.signal });
    stop.abort(); await assert.rejects(pending);
  }
  await assert.rejects(port.send('progress', 99), { code: 'signal_backpressure' });
  assert.equal(outstanding.length, SIGNAL_LIMITS.pendingSends);
  for (const resolve of outstanding) resolve({ signal: envelope() });
  await turn(); port.close();
});

test('closing a shared port cancels callers even when its transport ignores cancellation', async () => {
  let requestSignal, complete, calls = 0;
  const port = createHostedSignalPort({ connected: () => true, scope: () => 'cf:app', onMessage: () => () => {},
    request(message, options) {
      calls++; requestSignal = options.signal;
      return new Promise(resolve => { complete = () => resolve({ signal: { ...envelope(), ...message.message } }); });
    } });
  const pending = port.send('progress', 'working');
  port.close(); await assert.rejects(pending, { code: 'signal_disconnected' });
  assert.equal(requestSignal.aborted, true); complete(); await turn(); assert.equal(calls, 1);
});

class Socket extends EventTarget {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}

test('the public SDK authenticates an explicit scoped connection and bounds pressure without closing it', async () => {
  const socket = new Socket(); let opened;
  const host = createClient({ api: 'https://host.example/api/t/app', token: 'private-token' });
  const connecting = host.connectSignals({ open(url, protocols) { opened = { url, protocols }; return socket; } });
  assert.equal(opened.url, 'wss://host.example/api/t/app/signals/socket');
  assert.deepEqual(opened.protocols, ['tendriller.signals.v1', 'private-token']);
  socket.message({ t: 'signal_ready', scope: 'cf:app' });
  const signals = await connecting, subscription = signals.subscribe();
  socket.message({ t: 'ack', cid: socket.sent.at(-1).cid }); await turn();
  const now = Date.now();
  socket.message({ t: 'signal', signal: envelope(1, true, { issuedAtMs: now, expiresAtMs: now + 5000 }) });
  assert.equal((await subscription.next()).value.payload, true);
  socket.bufferedAmount = SIGNAL_LIMITS.pendingBytes;
  await assert.rejects(signals.send('progress', 2), { code: 'signal_backpressure' });
  assert.equal(signals.connected, true); socket.bufferedAmount = 0;
  const stop = new AbortController(), pending = signals.send('progress', 3, { signal: stop.signal }), original = socket.sent.at(-1);
  stop.abort(new Error('no longer relevant')); await assert.rejects(pending, /no longer relevant/);
  socket.message({ t: 'ack', cid: original.cid, signal: envelope(3) });
  assert.equal(socket.sent.filter(m => m.t === 'signal_send').length, 1);
  const wrongScope = signals.send('progress', 4);
  socket.message({ t: 'ack', cid: socket.sent.at(-1).cid, signal: envelope(4, 4, { scope: 'cf:other' }) });
  await assert.rejects(wrongScope, { code: 'invalid_signal' });
  signals.close(); assert.equal(signals.connected, false); assert.equal((await subscription.next()).done, true);
  await assert.rejects(signals.send('progress', 5), { code: 'signal_disconnected' });
  await assert.rejects(connectHostedSignals({ base: 'http://insecure.example' }), { code: 'invalid_signal' });
});

test('closing a dedicated connection releases pending sends and aborted connection attempts', async () => {
  const socket = new Socket(), connecting = connectHostedSignals({ base: 'https://host.test', open: () => socket });
  socket.message({ t: 'signal_ready', scope: 'cf:app' }); const signals = await connecting;
  const sending = signals.send('progress', 1); socket.close();
  await assert.rejects(sending, { code: 'signal_disconnected' });
  const stop = new AbortController(), opening = connectHostedSignals({ base: 'https://host.test', open: () => new Socket(), signal: stop.signal });
  stop.abort(new Error('cancel bootstrap')); await assert.rejects(opening, /cancel bootstrap/);
});
