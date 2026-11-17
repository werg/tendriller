import test from 'node:test';
import assert from 'node:assert/strict';
import { connectHostedSignals, createHostedSignals, HOSTED_SIGNAL_LIMITS } from '../signals.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ reply = true } = {}) {
  let online = true, now = 100_000, delivery = 0;
  const messages = new Set(), disconnects = new Set(), sent = [];
  const emit = value => {
    if ((value.t === 'signal' || value.t === 'signal_ack') && value.delivery === undefined) value = { ...value, delivery: ++delivery };
    for (const listener of [...messages]) listener(value);
  };
  const envelope = (sequence, payload = sequence, extra = {}) => ({ scope: 'hosted:page', authorId: 'account:owner', sessionId: 'server-session',
    sequence, topic: 'typing', payload, issuedAtMs: now, expiresAtMs: now + 5000, ...extra });
  const signals = createHostedSignals({ scope: 'hosted:page', now: () => now, connected: () => online,
    onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
    onDisconnect(listener) { disconnects.add(listener); return () => disconnects.delete(listener); },
    send(message) {
      sent.push(structuredClone(message));
      if (reply && message.cid) queueMicrotask(() => emit({ t: 'signal_ack', cid: message.cid,
        ...(message.t === 'signal_send' ? { signal: envelope(sent.length, message.payload,
          { topic: message.topic, issuedAtMs: message.issuedAtMs, expiresAtMs: message.expiresAtMs }) } : {}) }));
      return online;
    } });
  return { signals, sent, emit, envelope, advance: amount => { now += amount; },
    receive(sequence, payload, extra) { emit({ t: 'signal', signal: envelope(sequence, payload, extra) }); },
    offline() { online = false; delivery = 0; for (const listener of [...disconnects]) listener(); }, online() { online = true; } };
}

test('hosted live sends copy original intent and fail offline without any reconnect replay', async () => {
  const h = fixture();
  try {
    assert.equal(h.signals.connected, true);
    const payload = { sample: [1] }, pending = h.signals.send('typing', payload, { ttlMs: 1234 });
    payload.sample[0] = 99;
    const value = await pending;
    assert.deepEqual(value.payload, { sample: [1] });
    assert.equal(value.issuedAtMs, 100_000); assert.equal(value.expiresAtMs, 101_234);
    assert.equal(value.authorId, 'account:owner');
    h.offline(); const count = h.sent.length;
    assert.equal(h.signals.connected, false);
    await assert.rejects(h.signals.send('typing', true), { code: 'signal_disconnected' });
    assert.throws(() => h.signals.subscribe(), { code: 'signal_disconnected' });
    h.online(); await turn(); assert.equal(h.sent.length, count);
  } finally { h.signals.close(); }
});

test('all keeps FIFO while latest replaces only its pending author/session/topic values', async () => {
  const h = fixture(), all = h.signals.subscribe(), latest = h.signals.subscribe({ mode: 'latest', topics: ['typing'] });
  try {
    await turn(); assert.equal(h.sent.filter(value => value.t === 'signal_subscribe').length, 1);
    h.receive(1); h.receive(2); h.receive(3);
    assert.deepEqual([(await all.next()).value.sequence, (await all.next()).value.sequence, (await all.next()).value.sequence], [1, 2, 3]);
    assert.equal((await latest.next()).value.sequence, 3);
    assert.deepEqual(h.sent.filter(value => value.t === 'signal_credit').map(value => value.through), [1, 2, 3, 4]);
    h.receive(4, 4, { topic: 'ignored' }); h.receive(5);
    assert.equal((await latest.next()).value.sequence, 5);
  } finally { await all.return(); await latest.return(); h.signals.close(); }
});

test('each consumer owns a bounded queue and a slow FIFO fails visibly without failing latest', async () => {
  const h = fixture(), all = h.signals.subscribe(), latest = h.signals.subscribe({ mode: 'latest' });
  try {
    await turn();
    for (let index = 1; index <= HOSTED_SIGNAL_LIMITS.queuedSignals + 1; index++) h.receive(index);
    await assert.rejects(all.next(), { code: 'signal_subscription_overflow' });
    assert.equal((await latest.next()).value.sequence, HOSTED_SIGNAL_LIMITS.queuedSignals + 1);
  } finally { await all.return(); await latest.return(); h.signals.close(); }
});

test('expiry is checked again when a queued signal is consumed', async () => {
  const h = fixture(), controller = new AbortController(), iterator = h.signals.subscribe({ signal: controller.signal });
  try {
    h.receive(1); h.advance(5001);
    const pending = iterator.next();
    let delivered = false; void pending.then(() => { delivered = true; }, () => {});
    await turn(); assert.equal(delivered, false);
    controller.abort(new Error('stop expired queue'));
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    assert.deepEqual(await h.signals.subscribe({ signal: controller.signal }).next(), { done: true, value: undefined });
  } finally { h.signals.close(); }
});

test('latest cannot regress after consumption or after a newer short-lived value expires', async () => {
  const h = fixture(), reader = h.signals.subscribe({ mode: 'latest' });
  try {
    await turn();
    h.receive(2); assert.equal((await reader.next()).value.sequence, 2);
    const waiting = reader.next();
    h.receive(1); h.receive(2); h.receive(3);
    assert.equal((await waiting).value.sequence, 3);
    const older = h.envelope(4, 'older long TTL', { expiresAtMs: 130_000 });
    h.receive(5, 'newer short TTL', { expiresAtMs: 100_001 });
    assert.equal((await reader.next()).value.sequence, 5);
    h.advance(2);
    const afterExpiry = reader.next(); h.emit({ t: 'signal', signal: older }); h.receive(6);
    assert.equal((await afterExpiry).value.sequence, 6);
  } finally { await reader.return(); h.signals.close(); }
});

test('latest protects a bounded set of consumed identities until delayed values expire', async () => {
  const h = fixture(), full = h.signals.subscribe({ mode: 'latest' });
  let later;
  try {
    await turn();
    for (let index = 0; index < HOSTED_SIGNAL_LIMITS.latestKeys; index++) {
      h.receive(1, index, { authorId: `author-${index}` }); await full.next();
    }
    h.receive(1, 'excess', { authorId: 'extra' });
    await assert.rejects(full.next(), { code: 'signal_subscription_overflow' });
    later = h.signals.subscribe({ mode: 'latest' }); await turn();
    for (let index = 0; index < HOSTED_SIGNAL_LIMITS.latestKeys; index++) {
      h.receive(1, index, { authorId: `author-${index}` }); await later.next();
    }
    h.advance(HOSTED_SIGNAL_LIMITS.maxTtlMs * 2 + HOSTED_SIGNAL_LIMITS.futureSkewMs + 1);
    h.receive(1, 'fresh', { authorId: 'fresh' });
    assert.equal((await later.next()).value.payload, 'fresh');
  } finally { await full.return(); await later?.return(); h.signals.close(); }
});

test('closing a live port immediately cancels callers even when its transport never replies', async () => {
  const h = fixture({ reply: false });
  const sending = h.signals.send('progress', 'working');
  const failed = assert.rejects(sending, { code: 'signal_disconnected' });
  h.signals.close(); await failed;
  assert.equal(h.sent.filter(value => value.t === 'signal_send').length, 1);
  await assert.rejects(h.signals.send('progress', 'closed'), { code: 'signal_disconnected' });
});

test('observing expiry is irreversible when the wall clock moves backwards', async () => {
  const h = fixture(), iterator = h.signals.subscribe();
  try {
    h.receive(1); h.advance(6000);
    const waiting = iterator.next();
    h.advance(-6000);
    h.receive(2, 'expired before the clock adjustment', { expiresAtMs: 105_000 });
    h.receive(3, 'fresh', { issuedAtMs: 106_000, expiresAtMs: 111_000 });
    assert.equal((await waiting).value.payload, 'fresh');
    assert.equal((await h.signals.send('typing', true)).issuedAtMs, 106_000);
  } finally { await iterator.return(); h.signals.close(); }
});

test('disconnect terminates existing live intent and a new subscription starts without old data', async () => {
  const h = fixture({ reply: false }), iterator = h.signals.subscribe();
  const waiting = iterator.next(), sending = h.signals.send('typing', true);
  const rejected = [assert.rejects(waiting, { code: 'signal_disconnected' }), assert.rejects(sending, { code: 'signal_disconnected' })];
  h.offline(); await Promise.all(rejected);
  h.online(); await turn(); assert.equal(h.sent.filter(value => value.t === 'signal_subscribe').length, 1);
  const fresh = h.signals.subscribe();
  assert.equal(h.sent.filter(value => value.t === 'signal_subscribe').length, 2);
  h.receive(1, 'fresh'); assert.equal((await fresh.next()).value.payload, 'fresh');
  await fresh.return(); h.signals.close();
});

test('send cancellation and expiry retire volatile requests and never resend them', async () => {
  const h = fixture({ reply: false }), controller = new AbortController();
  const sending = h.signals.send('typing', true, { signal: controller.signal });
  controller.abort(new Error('cancel original send'));
  await assert.rejects(sending, /cancel original send/);
  await assert.rejects(h.signals.send('typing', true, { ttlMs: 1 }), { code: 'signal_expired' });
  assert.equal(h.sent.length, 2);
  h.signals.close();
});

test('cancelled sends retain transport capacity until an actual reply or disconnect releases it', async () => {
  const h = fixture({ reply: false });
  try {
    for (let index = 0; index < HOSTED_SIGNAL_LIMITS.pendingRequests; index++) {
      const abort = new AbortController(), sent = h.signals.send('typing', index, { signal: abort.signal });
      abort.abort(null); await assert.rejects(sent, value => value === null);
    }
    await assert.rejects(h.signals.send('typing', 'cannot grow the transport queue'), { code: 'signal_backpressure' });
    assert.equal(h.sent.filter(value => value.t === 'signal_send').length, HOSTED_SIGNAL_LIMITS.pendingRequests);
    h.emit({ t: 'signal_ack', cid: h.sent[0].cid });
    const fresh = h.signals.send('typing', 'one released slot');
    h.emit({ t: 'signal_ack', cid: h.sent.findLast(value => value.t === 'signal_send').cid, signal: h.envelope(100, 'one released slot') });
    assert.equal((await fresh).payload, 'one released slot');
    h.offline(); h.online();
    const resumed = h.signals.send('typing', 'new connection');
    h.emit({ t: 'signal_ack', cid: h.sent.findLast(value => value.t === 'signal_send').cid, signal: h.envelope(1, 'new connection') });
    assert.equal((await resumed).payload, 'new connection');
  } finally { h.signals.close(); }
});

test('invalid live payloads, topics, scopes and options are rejected at the public boundary', async () => {
  const h = fixture(), iterator = h.signals.subscribe();
  try {
    for (const payload of [undefined, NaN, { nested: Infinity }, new Map(), ['x'.repeat(33 * 1024)]])
      await assert.rejects(h.signals.send('typing', payload), error => error.code === 'signal_payload_invalid' || error.code === 'signal_frame_too_large');
    await assert.rejects(h.signals.send('', null), { code: 'signal_topic_invalid' });
    await assert.rejects(h.signals.send('typing', null, { ttlMs: 30_001 }), { code: 'signal_ttl_invalid' });
    await assert.rejects(h.signals.send('typing', null, { operationId: 'not-a-durable-operation' }), { code: 'signal_options_invalid' });
    assert.throws(() => h.signals.subscribe({ cursor: 'not-a-replay-stream' }), { code: 'signal_options_invalid' });
    await assert.rejects(h.signals.send('typing', Array(HOSTED_SIGNAL_LIMITS.jsonValues).fill(0)), { code: 'signal_payload_invalid' });
    const hidden = Object.defineProperty({}, 'notJSON', { value: true });
    const accessor = { get value() { throw new Error('must not evaluate payload getters'); } };
    for (const payload of [hidden, accessor, { [Symbol('secret')]: true }, Array(2), Object.assign([1], { extra: true })])
      await assert.rejects(h.signals.send('typing', payload), { code: 'signal_payload_invalid' });
    assert.equal((await h.signals.send('cursor café ✅', false)).topic, 'cursor café ✅');
    h.receive(1, null, { scope: 'hosted:another-page' });
    await assert.rejects(iterator.next(), { code: 'signal_scope_mismatch' });
  } finally { h.signals.close(); }
});

test('a retired subscription failure cannot terminate a newer subscription on the same socket', async () => {
  const h = fixture({ reply: false });
  const original = h.signals.subscribe(), old = h.sent.at(-1);
  await original.return();
  const current = h.signals.subscribe();
  h.emit({ t: 'signal_ack', cid: old.cid, error: 'signal_unauthorized' });
  await turn();
  h.receive(1, 'new subscription');
  assert.equal((await current.next()).value.payload, 'new subscription');
  await current.return(); h.signals.close();
});

test('an agent connection observes cancellation during socket creation and releases all listeners', async () => {
  const controller = new AbortController(), reason = new Error('retired while opening'), listeners = new Map();
  let closed = 0;
  await assert.rejects(connectHostedSignals({ api: 'https://example.test/api/t/page', token: 'private', signal: controller.signal,
    socket(url, protocols) {
      assert.equal(url, 'wss://example.test/api/t/page/signals/socket');
      assert.deepEqual(protocols, ['tendriller.signals.v1', 'private']);
      controller.abort(reason);
      return { readyState: 0, addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: type => listeners.delete(type), send() { throw new Error('must not send'); }, close() { closed++; } };
    } }), error => error === reason);
  assert.equal(closed, 1); assert.equal(listeners.size, 0);
});
