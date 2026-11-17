import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: [new URL('../src/signals.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser', metafile: true });
const { createHostedPageSignals } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const settle = () => new Promise(setImmediate);
class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  delivery = 0;
  send(raw) { this.sent.push(JSON.parse(raw)); }
  receive(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  ready() { this.receive({ t: 'signal_ready', scope: 'hosted:page' }); }
  reply(message) { this.receive({ t: 'signal_ack', delivery: ++this.delivery, cid: message.cid,
    ...(message.t === 'signal_send' ? { signal: { scope: 'hosted:page', authorId: 'page:owner', sessionId: 'fresh', sequence: 1,
      topic: message.topic, payload: message.payload, issuedAtMs: message.issuedAtMs, expiresAtMs: message.expiresAtMs } } : {}) }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
function fixture() {
  const sockets = [], destinations = [];
  const api = createHostedPageSignals({ api: 'https://page.test/page/_tendril', socket(url, protocols) {
    destinations.push({ url, protocols }); const socket = new Socket(); sockets.push(socket); return socket;
  } });
  return { api, sockets, destinations };
}

test('hosted runtime owns a dedicated live connection without a durable core or outbox dependency', async () => {
  assert.ok(Object.keys(built.metafile.inputs).every(path => !/runtime\/src\/(?:core|offline|requests|connection)\./.test(path)));
  const h = fixture();
  try {
    assert.deepEqual(h.destinations, [{ url: 'wss://page.test/page/_tendril/signals/socket', protocols: ['tendriller.signals.v1'] }]);
    await assert.rejects(h.api.send('typing', 'while opening'), { code: 'signal_disconnected' });
    assert.throws(() => h.api.subscribe(), { code: 'signal_disconnected' });
    assert.equal(h.sockets[0].sent.length, 0);
    h.sockets[0].ready(); await settle();
    const sending = h.api.send('typing', 'fresh');
    h.sockets[0].reply(h.sockets[0].sent.find(message => message.t === 'signal_send'));
    assert.equal((await sending).payload, 'fresh');
  } finally { h.api.suspend(); }
});

test('live connection loss terminates old subscriptions and fresh calls never replay old intent', async () => {
  const h = fixture();
  try {
    h.sockets[0].ready(); await settle();
    const reader = h.api.subscribe(), waiting = assert.rejects(reader.next(), { code: 'signal_disconnected' });
    h.sockets[0].reply(h.sockets[0].sent.find(message => message.t === 'signal_subscribe'));
    h.sockets[0].close(); await waiting; await settle();
    assert.equal(h.sockets.length, 1, 'no background connection retry or resubscription');
    const stopped = AbortSignal.abort(new Error('disposed'));
    assert.equal((await h.api.subscribe({ signal: stopped })[Symbol.asyncIterator]().next()).done, true);
    await assert.rejects(h.api.send('typing', 'disposed', { signal: stopped }), /disposed/);
    assert.throws(() => h.api.subscribe({ cursor: 'unsupported' }), { code: 'signal_options_invalid' });
    await assert.rejects(h.api.send('typing', true, { retry: true }), { code: 'signal_options_invalid' });
    assert.equal(h.sockets.length, 1, 'cancelled or invalid intent cannot start a new connection');
    await assert.rejects(h.api.send('typing', 'lost current observation'), { code: 'signal_disconnected' });
    assert.equal(h.sockets.length, 2); assert.deepEqual(h.sockets[1].sent, []);
    h.sockets[1].ready(); await settle();
    assert.deepEqual(h.sockets[1].sent, [], 'a new authenticated session has no old subscription or send');
    const sending = h.api.send('typing', 'new observation');
    h.sockets[1].reply(h.sockets[1].sent.find(message => message.t === 'signal_send'));
    assert.equal((await sending).payload, 'new observation');
  } finally { h.api.suspend(); }
});

test('page suspension cancels an opening session and stale readiness cannot replace the new session', async () => {
  const h = fixture();
  try {
    h.api.suspend(); h.api.resume();
    h.sockets[0].ready(); await settle();
    assert.equal(h.api.connected, false);
    h.sockets[1].ready(); await settle(); assert.equal(h.api.connected, true);
    h.api.suspend();
    await assert.rejects(h.api.send('typing', 'while hidden'), { code: 'signal_disconnected' });
    assert.equal(h.sockets.length, 2);
  } finally { h.api.suspend(); }
});
