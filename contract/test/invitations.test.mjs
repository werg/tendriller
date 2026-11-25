import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerInvitationListener, createPeersClient, PEER_INVITATION_LIMITS, PEER_INVITATION_PROTOCOL, validatePeerAdvertisement } from '../peers.mjs';

class Socket extends EventTarget {
  readyState = 1; sent = []; closed;
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code, reason) {
    if (code !== 1000 && !(code >= 3000 && code <= 4999)) throw new DOMException('Invalid code', 'InvalidAccessError');
    this.readyState = 3; this.closed = { code, reason }; this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}

test('a quiet invitation listener acknowledges consumed hints and reports lifetime without heartbeats', async () => {
  const socket = new Socket(), listener = createPeerInvitationListener(socket, 'target');
  socket.receive({ t: 'ready', version: 1, peerId: 'target' }); await listener.ready;
  const invitation = { channel: 'fresh-channel', requesterPeerId: 'new-peer' };
  socket.receive({ t: 'invitation', ...invitation });
  assert.deepEqual(socket.sent, []);
  const reader = listener.invitations[Symbol.asyncIterator]();
  assert.deepEqual(await reader.next(), { value: invitation, done: false });
  assert.deepEqual(socket.sent, [{ t: 'received', ...invitation }]);
  assert.equal(listener.stats.receivedInvitations, 1);
  listener.close(); assert.deepEqual(await listener.closed, { code: 1000, reason: 'Invitation listener closed' });
  assert.equal((await reader.next()).done, true);
});

test('invitation queues, cancellation, malformed frames and opening deadlines remain bounded', async () => {
  const socket = new Socket(), listener = createPeerInvitationListener(socket, 'target');
  socket.receive({ t: 'ready', version: 1, peerId: 'target' }); await listener.ready;
  for (let i = 0; i <= PEER_INVITATION_LIMITS.pending; i++) socket.receive({ t: 'invitation', channel: `channel-${i}`, requesterPeerId: 'source' });
  assert.equal((await listener.closed).code, 1008);
  assert.equal(socket.closed.code, 1000);
  await assert.rejects(listener.invitations[Symbol.asyncIterator]().next(), { code: 'invitation_backpressure' });
  const abort = new AbortController(), cancelled = createPeerInvitationListener(new Socket(), 'target', { signal: abort.signal });
  abort.abort(); await assert.rejects(cancelled.ready, { name: 'AbortError' }); await cancelled.closed;
  const deadline = createPeerInvitationListener(new Socket(), 'target', { timeoutMs: 1 });
  await assert.rejects(deadline.ready, { code: 'invitation_timeout' }); await deadline.closed;
  const invalidSocket = new Socket(), invalid = createPeerInvitationListener(invalidSocket, 'target');
  invalidSocket.receive({ t: 'ready', version: 1, peerId: 'somebody-else' });
  await assert.rejects(invalid.ready, { code: 'invalid_invitation' });
});

test('acknowledgement failures retain their cause even when closing the transport also fails', async t => {
  for (const closeThrows of [false, true]) await t.test(`close throws: ${closeThrows}`, async () => {
    const socket = new Socket(), listener = createPeerInvitationListener(socket, 'target');
    socket.receive({ t: 'ready', version: 1, peerId: 'target' }); await listener.ready;
    const cause = Error('Acknowledgement send failed');
    socket.send = () => { throw cause; };
    if (closeThrows) socket.close = () => { throw Error('Transport already failed'); };
    socket.receive({ t: 'invitation', channel: 'fresh', requesterPeerId: 'source' });
    await assert.rejects(listener.invitations[Symbol.asyncIterator]().next(), error => error === cause);
    assert.deepEqual(await listener.closed, { code: 1011, reason: 'Invitation acknowledgement failed' });
    assert.equal(listener.stats.closed, true);
    if (!closeThrows) assert.equal(socket.closed.code, 1000);
    assert.doesNotThrow(() => listener.close());
  });
});

test('the public client preserves private protocol credentials and only posts on demand', async () => {
  const calls = [], sockets = [];
  const client = createPeersClient({ base: 'https://host.test/api/app', applicationId: 'ab'.repeat(32), protocols: ['tendriller.rendezvous.v1', 'private-token'],
    request: async (path, options) => { calls.push({ path, options }); return { invited: options.body.peerId, channel: options.body.channel }; },
    socket: (url, protocols) => { const socket = new Socket(); sockets.push({ url, protocols, socket }); return socket; } });
  assert.equal(calls.length + sockets.length, 0);
  assert.throws(() => client.listenInvitations('target', { timeoutMs: 0 }), { code: 'invalid_invitation' });
  assert.equal(sockets.length, 0);
  const listener = client.listenInvitations('target');
  assert.equal(sockets[0].url, 'wss://host.test/api/app/peers/invitations?peerId=target');
  assert.deepEqual(sockets[0].protocols, [PEER_INVITATION_PROTOCOL, 'private-token']);
  sockets[0].socket.receive({ t: 'ready', version: 1, peerId: 'target' }); await listener.ready;
  await client.invite('target', { channel: 'fresh', requesterPeerId: 'source' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'peers/invite');
  assert.deepEqual(calls[0].options.body, { peerId: 'target', channel: 'fresh', requesterPeerId: 'source' });
  const advertisement = validatePeerAdvertisement({ peerId: 'target', storageId: 'disk',
    routes: [{ kind: 'invitation', peerId: 'target' }] });
  assert.deepEqual(advertisement.routes, [{ kind: 'invitation', peerId: 'target' }]);
  listener.close();
});
