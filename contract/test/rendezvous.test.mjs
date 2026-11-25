import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerRendezvous, createPeersClient, PEER_RENDEZVOUS_LIMITS, validatePeerDescription } from '../peers.mjs';

class Socket extends EventTarget {
  readyState = 1; sent = []; closes = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })); }
  close(code, reason) { this.closes.push({ code, reason }); this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const pairing = (socket, role = 'offerer', session = 'session-1') => socket.receive({ t: 'ready', version: 1, session, role });
const offer = { type: 'offer', sdp: 'v=0\r\n' }, answer = { type: 'answer', sdp: 'v=0\r\n' };

test('rendezvous exchanges one complete SDP per peer and closes independently of application work', async () => {
  const socket = new Socket(), session = createPeerRendezvous(socket);
  pairing(socket);
  assert.deepEqual(await session.ready, { session: 'session-1', role: 'offerer' });
  await session.send(offer);
  assert.deepEqual(socket.sent, [{ t: 'description', session: 'session-1', description: offer }]);
  socket.receive({ t: 'description', session: 'session-1', description: answer });
  socket.receive({ t: 'complete', session: 'session-1' });
  const messages = [];
  for await (const value of session.messages) messages.push(value);
  assert.deepEqual(messages, [answer]);
  assert.equal(session.stats.closed, true);
  assert.equal(session.stats.sentDescriptions, 1);
  assert.equal(session.stats.receivedDescriptions, 1);
  session.close(); assert.equal(socket.closes.length, 1);
  await assert.rejects(session.send(offer), { code: 'rendezvous_closed' });
});

test('rendezvous rejects role conflicts, repeated sends and descriptions beyond the UTF-8 bound', async () => {
  const socket = new Socket(), session = createPeerRendezvous(socket);
  pairing(socket, 'answerer'); await session.ready;
  await assert.rejects(session.send(offer), { code: 'invalid_description' });
  await session.send(answer);
  await assert.rejects(session.send(answer), { code: 'invalid_description' });
  assert.throws(() => validatePeerDescription({ type: 'offer', sdp: 'é'.repeat(PEER_RENDEZVOUS_LIMITS.descriptionBytes / 2 + 1) }), { code: 'invalid_description' });
  assert.throws(() => validatePeerDescription({ ...offer, candidates: [] }), { code: 'invalid_description' });
  session.close();
});

test('stale session descriptions fail closed without delivering any bytes', async () => {
  const socket = new Socket(), session = createPeerRendezvous(socket);
  pairing(socket); await session.ready;
  socket.receive({ t: 'description', session: 'retired', description: answer });
  await assert.rejects(session.messages[Symbol.asyncIterator]().next(), { code: 'invalid_rendezvous' });
  assert.equal(session.stats.receivedDescriptions, 0);
  assert.equal(socket.closes[0].code, 1008);
});

test('abort and deadlines release unpaired sessions and reject waiting readers and senders', async () => {
  for (const timeout of [false, true]) {
    const socket = new Socket(), controller = new AbortController();
    const session = createPeerRendezvous(socket, { signal: controller.signal, timeoutMs: timeout ? 5 : 1000 });
    const expected = timeout ? { code: 'rendezvous_timeout' } : { name: 'AbortError' };
    const waits = [session.ready, session.send(offer), session.messages[Symbol.asyncIterator]().next()].map(value => assert.rejects(value, expected));
    if (!timeout) controller.abort();
    await Promise.all(waits);
    assert.equal(session.stats.closed, true); assert.equal(socket.closes.length, 1);
  }
});

test('binary or excessive incoming data cannot become a peer application relay', async () => {
  for (const data of [new Uint8Array([1, 2]).buffer, 'x'.repeat(PEER_RENDEZVOUS_LIMITS.messageBytes + 1)]) {
    const socket = new Socket(), session = createPeerRendezvous(socket);
    pairing(socket); await session.ready;
    socket.dispatchEvent(new MessageEvent('message', { data }));
    await assert.rejects(session.messages[Symbol.asyncIterator]().next(), { code: 'invalid_rendezvous' });
    assert.equal(session.stats.receivedDescriptions, 0);
  }
});

test('client construction is quiet and agent credentials stay in the protocol header', async () => {
  const calls = [], sockets = [], headers = ['tendriller.rendezvous.v1', 'agent-token'];
  const client = createPeersClient({ base: 'https://example.test/api/agent/pages/id', protocols: headers,
    request: async (...args) => { calls.push(args); return { version: 2, endpoints: [] }; },
    socket: (url, protocols) => { sockets.push({ url, protocols }); return new Socket(); } });
  assert.equal(calls.length, 0); assert.equal(sockets.length, 0);
  assert.equal(client.initialBootstrap, null);
  const pending = client.rendezvous('room', 'endpoint');
  assert.deepEqual(sockets, [{ url: 'wss://example.test/api/agent/pages/id/peers/rendezvous?channel=room&peerId=endpoint', protocols: headers }]);
  pending.close();
  assert.deepEqual(await client.bootstrap(), { version: 2, endpoints: [] });
  assert.deepEqual(calls, [['peers/bootstrap']]);
  assert.throws(() => client.rendezvous('bad/path', 'endpoint'), { code: 'invalid_rendezvous' });
  assert.throws(() => client.rendezvous('room', 'endpoint', { timeoutMs: 0 }), { code: 'invalid_rendezvous' });
  assert.equal(sockets.length, 1, 'Invalid options must not open an abandoned socket');
});
