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
  const pair = (liveWindow = PEER_RELAY_LIMITS.livePendingPackets) => {
    for (const lane of ['reliable', 'live']) sockets[lane].receive({ t: 'ready', version: 1, session, lane, peerId, remotePeerId, liveWindow });
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

test('live pressure stays on its own lane: an explicit one-packet grant queues the rest in order', async () => {
  const { relay, sockets, pair } = fixture(); pair(1); await relay.ready;
  try {
    relay.live.send(new Uint8Array(16_448));
    assert.equal(relay.live.bufferedAmount, 0, 'queued live packets do not refuse the next piece');
    relay.live.send(new Uint8Array([1]));
    assert.equal(sockets.live.sent.length, 1); assert.equal(relay.live.stats.queuedPackets, 1); assert.equal(relay.reliable.bufferedAmount, 0);
    sockets.live.receive({ t: 'credit', session, sequence: 1 });
    assert.equal(sockets.live.sent.length, 2); assert.deepEqual([...new Uint8Array(sockets.live.sent[1])], [0, 0, 0, 2, 1]);
    sockets.live.receive({ t: 'credit', session, sequence: 2 });
    relay.live.send(new Uint8Array([2])); assert.equal(sockets.live.sent.length, 3);
    sockets.live.receive(packet(3)); // Dropped disposable packets may leave sequence gaps.
    assert.equal(relay.signal.aborted, false);
  } finally { relay.close(); }
});

test('a multi-piece live message of several hundred KB flows through the granted window without refusal', async () => {
  const sockets = { reliable: new Socket(), live: new Socket() }, relay = createPeerRelay(sockets, { peerId, remotePeerId });
  for (const lane of ['reliable', 'live']) sockets[lane].receive({ t: 'ready', version: 1, session, lane, peerId, remotePeerId,
    liveWindow: PEER_RELAY_LIMITS.livePendingPackets });
  await relay.ready;
  try {
    const pieces = Array.from({ length: 40 }, (_value, index) => new Uint8Array(16_448).fill(index));
    for (const piece of pieces) {
      // The Chronolog live channel refuses a frame when bufferedAmount + frame > 64 KiB.
      assert.ok(relay.live.bufferedAmount + piece.length <= 65_536, 'the relay never reports a full live lane for this reply');
      relay.live.send(piece);
    }
    assert.equal(sockets.live.sent.length, PEER_RELAY_LIMITS.livePendingPackets);
    for (let credited = 1; credited <= pieces.length; credited++) sockets.live.receive({ t: 'credit', session, sequence: credited });
    assert.equal(sockets.live.sent.length, pieces.length);
    assert.deepEqual(sockets.live.sent.map(value => new DataView(value).getUint32(0)), pieces.map((_value, index) => index + 1));
    assert.deepEqual(sockets.live.sent.map(value => new Uint8Array(value)[4]), pieces.map((_value, index) => index));
    const full = Math.floor(PEER_RELAY_LIMITS.liveQueueBytes / PEER_RELAY_LIMITS.packetBytes);
    for (let index = 0; index < PEER_RELAY_LIMITS.livePendingPackets + full; index++) relay.live.send(new Uint8Array(PEER_RELAY_LIMITS.packetBytes));
    assert.equal(relay.live.bufferedAmount, PEER_RELAY_LIMITS.liveBufferedBytes, 'a full local queue is reported as genuine backpressure');
    assert.throws(() => relay.live.send(new Uint8Array(PEER_RELAY_LIMITS.packetBytes)), { code: 'invalid_relay' });
  } finally { relay.close(); }
  const excessive = fixture();
  excessive.sockets.live.receive({ t: 'ready', version: 1, session, lane: 'live', peerId, remotePeerId, liveWindow: 99 });
  await assert.rejects(excessive.relay.ready, { code: 'invalid_relay' });
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
  const calls = [], client = createPeersClient({ base: 'https://host.test/api/agent/pages/page', request: async () => {},
    protocols: ['tendriller.rendezvous.v1', 'private-agent-token'], socket(url, protocols) { calls.push({ url, protocols }); return new Socket(); } });
  const relay = client.relay('join:one', peerId, { remotePeerId });
  try {
    assert.equal(calls.length, 2);
    for (const [index, call] of calls.entries()) {
      const url = new URL(call.url);
      assert.equal(url.protocol, 'wss:'); assert.equal(url.pathname, '/api/agent/pages/page/peers/relay');
      assert.equal(url.searchParams.get('lane'), index ? 'live' : 'reliable');
      assert.equal(url.searchParams.get('remotePeerId'), remotePeerId);
      assert.deepEqual(call.protocols, [PEER_RELAY_PROTOCOL, 'private-agent-token']);
      assert.equal(call.url.includes('private-agent-token'), false);
    }
    assert.throws(() => client.relay('join:two', peerId, { remotePeerId: peerId }), { code: 'invalid_relay' });
  } finally { relay.close(); }
});


test('readiness requires an explicit bounded window and tiny packets cannot exhaust queue metadata', async () => {
  for (const liveWindow of [undefined, 0, 1.5, PEER_RELAY_LIMITS.livePendingPackets + 1]) {
    const { relay, sockets } = fixture();
    sockets.live.receive({ t: 'ready', version: 1, session, lane: 'live', peerId, remotePeerId,
      ...(liveWindow === undefined ? {} : { liveWindow }) });
    await assert.rejects(relay.ready, { code: 'invalid_relay' });
    assert.equal(sockets.reliable.closed, 1); assert.equal(sockets.live.closed, 1);
  }
  const { relay, sockets, pair } = fixture(); pair(); await relay.ready;
  try {
    for (let i = 0; i < PEER_RELAY_LIMITS.livePendingPackets + PEER_RELAY_LIMITS.liveQueuePackets; i++) relay.live.send(new Uint8Array([i]));
    assert.equal(relay.live.stats.queuedPackets, PEER_RELAY_LIMITS.liveQueuePackets);
    assert.equal(relay.live.bufferedAmount, PEER_RELAY_LIMITS.liveBufferedBytes);
    assert.throws(() => relay.live.send(new Uint8Array([0])), { code: 'invalid_relay' });
    for (let sequence = 1; sequence <= PEER_RELAY_LIMITS.livePendingPackets + PEER_RELAY_LIMITS.liveQueuePackets; sequence++)
      sockets.live.receive({ t: 'credit', session, sequence });
    assert.equal(relay.live.stats.queuedPackets, 0); assert.equal(relay.live.stats.pendingPackets, 0);
  } finally { relay.close(); }
});
