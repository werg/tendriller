import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerConnection, decodePeerFrame, encodePeerFrame, PEER_LIMITS, validatePeerBootstrap } from '../peers.mjs';
class Socket extends EventTarget {
  readyState = 1; bufferedAmount = 0; sent = []; closes = [];
  send(value) { this.sent.push(value); }
  close(code, reason) {
    if (this.closes.length || this.readyState > 1) throw new Error('WebSocket already closed');
    this.closes.push({ code, reason }); this.remoteClose();
  }
  remoteClose() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
test('record and signal frames have distinct bounded wire domains', () => {
  const data = new Uint8Array([0, 1, 255]);
  for (const domain of ['records', 'signals', 'control']) assert.deepEqual(decodePeerFrame(encodePeerFrame({ domain, payload: data })), { domain, payload: data });
  assert.throws(() => encodePeerFrame({ domain: 'signals', payload: new Uint8Array(PEER_LIMITS.signalBytes + 1) }), { code: 'frame_too_large' });
  assert.throws(() => decodePeerFrame(new Uint8Array([0x54, 2, 0, 1])), { code: 'invalid_frame' });
});
test('bounded transport counts actual bytes and closes overflowing receive queues', async () => {
  const socket = new Socket(), peer = createPeerConnection(socket, { route: 'direct', queueBytes: PEER_LIMITS.frameBytes + 3 });
  await peer.ready;
  await peer.send({ domain: 'records', payload: new Uint8Array([1, 2]) });
  assert.equal(peer.stats.sentBytes, 5);
  socket.receive(encodePeerFrame({ domain: 'records', payload: new Uint8Array(PEER_LIMITS.frameBytes) }).buffer);
  socket.receive(encodePeerFrame({ domain: 'signals', payload: new Uint8Array([1]) }).buffer);
  assert.equal(socket.readyState, 3);
  const reader = peer.frames[Symbol.asyncIterator]();
  assert.equal((await reader.next()).value.payload.length, PEER_LIMITS.frameBytes);
  await assert.rejects(reader.next(), { code: 'backpressure' });
  peer.close(); peer.close();
  assert.deepEqual(socket.closes, [{ code: 1008, reason: 'backpressure' }]);
});
test('closing a pending relay session is idempotent and rejects all queued sends', async () => {
  const socket = new Socket(), peer = createPeerConnection(socket, { route: 'relay', relayHandshake: true });
  const one = peer.send({ domain: 'records', payload: new Uint8Array([1]) });
  const two = peer.send({ domain: 'signals', payload: new Uint8Array([2]) });
  const rejected = Promise.all([peer.ready, one, two].map(promise => assert.rejects(promise, { code: 'connection_closed' })));
  peer.close(); peer.close();
  await rejected;
  assert.deepEqual(socket.closes, [{ code: 1000, reason: 'Peer session closed' }]);
  assert.equal(peer.stats.queuedBytes, 0); assert.equal(socket.sent.length, 0);
  assert.deepEqual(await peer.frames[Symbol.asyncIterator]().next(), { value: undefined, done: true });
});
test('remote closure completes a waiting reader and makes later close harmless', async () => {
  const socket = new Socket(), peer = createPeerConnection(socket, { route: 'direct' });
  await peer.ready;
  const next = peer.frames[Symbol.asyncIterator]().next();
  socket.remoteClose();
  assert.deepEqual(await next, { value: undefined, done: true });
  peer.close(); peer.close();
  assert.deepEqual(socket.closes, []);
  await assert.rejects(peer.send({ domain: 'records', payload: new Uint8Array([1]) }), { code: 'connection_closed' });
});
test('transport error rejects pending work without preventing physical close', async () => {
  const socket = new Socket(), peer = createPeerConnection(socket, { route: 'relay', relayHandshake: true });
  const sent = peer.send({ domain: 'records', payload: new Uint8Array([1]) });
  const next = peer.frames[Symbol.asyncIterator]().next();
  const rejected = Promise.all([peer.ready, sent, next].map(promise => assert.rejects(promise, { code: 'connection_error' })));
  socket.dispatchEvent(new Event('error'));
  await rejected;
  assert.equal(socket.readyState, 1);
  peer.close(); peer.close();
  assert.deepEqual(socket.closes, [{ code: 1000, reason: 'Peer session closed' }]);
  assert.equal(peer.stats.queuedBytes, 0);
});
test('relay readiness and consumption credits are separate from durable application progress', async () => {
  const socket = new Socket(), peer = createPeerConnection(socket, { route: 'relay', relayHandshake: true });
  let ready = false; peer.ready.then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, false);
  socket.receive('{"t":"peer_ready","version":1}'); await peer.ready;
  const bytes = encodePeerFrame({ domain: 'records', payload: new Uint8Array([3]) });
  socket.receive(bytes.buffer); assert.equal(socket.sent.length, 0);
  const reader = peer.frames[Symbol.asyncIterator]();
  assert.equal((await reader.next()).value.payload[0], 3);
  assert.equal(socket.sent[0], '{"t":"peer_credit","bytes":4}');
  peer.close(); await reader.return();
});
test('bootstrap hints do not accept credentials or arbitrary insecure endpoints', () => {
  assert.deepEqual(validatePeerBootstrap({ version: 1, endpoints: [{ route: 'direct', url: 'wss://peer.example/socket' }] }).endpoints[0], { route: 'direct', url: 'wss://peer.example/socket' });
  for (const url of ['https://peer.example/socket', 'ws://peer.example/socket', 'wss://secret@peer.example/socket', 'wss://peer.example/socket#capability'])
    assert.throws(() => validatePeerBootstrap({ version: 1, endpoints: [{ route: 'relay', url }] }), { code: 'invalid_bootstrap' });
});

test('abort before relay readiness removes bounded pending sends without blocking later traffic', async () => {
  const socket = new Socket(), peer = createPeerConnection(socket, { route: 'relay', relayHandshake: true });
  const first = new AbortController(), second = new AbortController();
  const one = peer.send({ domain: 'records', payload: new Uint8Array(1000) }, { signal: first.signal });
  const two = peer.send({ domain: 'records', payload: new Uint8Array(1000) }, { signal: second.signal });
  const rejected = Promise.all([assert.rejects(one, { name: 'AbortError' }), assert.rejects(two, { name: 'AbortError' })]);
  second.abort(); first.abort(); await rejected;
  assert.equal(peer.stats.queuedBytes, 0); assert.equal(socket.sent.length, 0);
  socket.receive('{"t":"peer_ready","version":1}');
  await peer.send({ domain: 'control', payload: new Uint8Array([7]) });
  assert.equal(socket.sent.length, 1); peer.close();
});

test('relay credits bound sends until the remote reader consumes frames', async () => {
  const socket = new Socket(), peer = createPeerConnection(socket, { route: 'relay', relayHandshake: true });
  socket.receive('{"t":"peer_ready","version":1}');
  const frame = { domain: 'records', payload: new Uint8Array(PEER_LIMITS.frameBytes) };
  for (let index = 0; index < 15; index++) await peer.send(frame);
  let finished = false;
  const blocked = peer.send(frame).then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  socket.receive(JSON.stringify({ t: 'peer_credit', bytes: PEER_LIMITS.frameBytes + 3 }));
  await blocked; assert.equal(finished, true); peer.close();
});
