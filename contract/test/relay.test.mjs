import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerRelay, createPeersClient, PEER_RELAY_LIMITS, PEER_RELAY_PROTOCOL } from '../peers.mjs';

const peerId = 'ab'.repeat(32), remotePeerId = 'cd'.repeat(32), session = '01234567-0123-4123-8123-0123456789ab';
class Socket extends EventTarget {
  readyState = 1; bufferedAmount = 0; sent = []; closed = 0;
  send(value) { this.sent.push(typeof value === 'string' ? JSON.parse(value) : value); }
  close() { this.closed++; this.readyState = 3; }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data })); }
}
function fixture(options = {}) {
  const sockets = { reliable: new Socket(), live: new Socket() }, relay = createPeerRelay(sockets, { peerId, remotePeerId, ...options });
  const pair = () => {
    for (const lane of ['reliable', 'live']) sockets[lane].receive({ t: 'ready', version: 1, session, lane, peerId, remotePeerId });
  };
  return { sockets, relay, pair };
}
function packet(sequence, values = [1, 2, 3]) {
  const bytes = new Uint8Array(20 + values.length);
  new DataView(bytes.buffer).setUint32(0, sequence); bytes.fill(0xab, 4, 20); bytes.set(values, 20); return bytes.buffer;
}

test('relay readiness pairs both lanes, strips transport controls and accounts for receipt backpressure', async () => {
  const { relay, sockets, pair } = fixture(), received = [];
  relay.reliable.addEventListener('message', event => received.push(new Uint8Array(event.data)));
  try {
    assert.equal(relay.reliable.readyState, 0); pair(); assert.deepEqual(await relay.ready, { session });
    relay.reliable.send(new Uint8Array([4, 5, 6]));
    assert.deepEqual([...new Uint8Array(sockets.reliable.sent[0])], [0, 0, 0, 1, 4, 5, 6]);
    assert.equal(relay.reliable.bufferedAmount, 16 * 1024);
    sockets.reliable.receive({ t: 'credit', session, sequence: 1 }); assert.equal(relay.reliable.bufferedAmount, 0);
    sockets.reliable.receive(packet(1));
    assert.deepEqual(received, [new Uint8Array([1, 2, 3])]);
    assert.deepEqual(sockets.reliable.sent[1], { t: 'received', session, sequence: 1, receipt: 'ab'.repeat(16) });
    assert.equal(relay.reliable.stats.receivedBytes, 3);
    assert.equal(sockets.live.sent.length, 0);
  } finally { relay.close(); }
  assert.equal(sockets.reliable.closed, 1); assert.equal(sockets.live.closed, 1);
});

test('live pressure stays on its own lane with one outstanding packet and no frame queue', async () => {
  const { relay, sockets, pair } = fixture(); pair(); await relay.ready;
  try {
    relay.live.send(new Uint8Array(16_448));
    assert.equal(relay.live.bufferedAmount, PEER_RELAY_LIMITS.liveBufferedBytes);
    assert.throws(() => relay.live.send(new Uint8Array([1])), { code: 'invalid_relay' });
    assert.equal(sockets.live.sent.length, 1); assert.equal(relay.reliable.bufferedAmount, 0);
    sockets.live.receive({ t: 'credit', session, sequence: 1 }); assert.equal(relay.live.bufferedAmount, 0);
    relay.live.send(new Uint8Array([2])); assert.equal(sockets.live.sent.length, 2);
    sockets.live.receive(packet(3)); // Dropped disposable packets may leave sequence gaps.
    assert.equal(relay.signal.aborted, false);
  } finally { relay.close(); }
});

test('malformed controls, foreign sessions, repeated receipts and early binary close the whole relay', async () => {
  for (const invalid of [
    sockets => sockets.reliable.receive(packet(1)),
    sockets => sockets.live.receive({ t: 'ready', version: 1, session, lane: 'live', peerId, remotePeerId: peerId }),
    sockets => sockets.reliable.receive('x'.repeat(513)),
  ]) {
    const { relay, sockets } = fixture(); invalid(sockets);
    await assert.rejects(relay.ready); assert.equal(relay.signal.aborted, true);
    assert.equal(sockets.reliable.closed, 1); assert.equal(sockets.live.closed, 1);
  }
  const { relay, sockets, pair } = fixture(); pair(); await relay.ready;
  sockets.reliable.receive({ t: 'credit', session, sequence: 1 });
  assert.equal(relay.signal.aborted, true); assert.equal(sockets.live.closed, 1);
});

test('cancellation and bounded pairing timeout release both physical sockets', async () => {
  const controller = new AbortController(), first = fixture({ signal: controller.signal });
  controller.abort(Error('owner ended')); await assert.rejects(first.relay.ready, /owner ended/);
  assert.equal(first.sockets.reliable.closed, 1); assert.equal(first.sockets.live.closed, 1);
  const second = fixture({ timeoutMs: 1 });
  await assert.rejects(second.relay.ready, { code: 'relay_timeout' });
  assert.equal(second.sockets.reliable.closed, 1); assert.equal(second.sockets.live.closed, 1);
});

test('host client opens secure reciprocal lane URLs and preserves credentials in subprotocols only', () => {
  const calls = [], client = createPeersClient({ base: 'https://host.test/api/t/page', request: async () => {},
    protocols: ['tendriller.rendezvous.v1', 'private-agent-token'], socket(url, protocols) { calls.push({ url, protocols }); return new Socket(); } });
  const relay = client.relay('join:one', peerId, { remotePeerId });
  try {
    assert.equal(calls.length, 2);
    for (const [index, call] of calls.entries()) {
      const url = new URL(call.url);
      assert.equal(url.protocol, 'wss:'); assert.equal(url.pathname, '/api/t/page/peers/relay');
      assert.equal(url.searchParams.get('lane'), index ? 'live' : 'reliable');
      assert.equal(url.searchParams.get('remotePeerId'), remotePeerId);
      assert.deepEqual(call.protocols, [PEER_RELAY_PROTOCOL, 'private-agent-token']);
      assert.equal(call.url.includes('private-agent-token'), false);
    }
    assert.throws(() => client.relay('join:two', peerId, { remotePeerId: peerId }), { code: 'invalid_relay' });
  } finally { relay.close(); }
});
