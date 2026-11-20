import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerInvitationListener, createPeersClient, PEER_INVITATION_LIMITS, PEER_INVITATION_PROTOCOL, validatePeerAdvertisement, createParticipantResponse } from '../peers.mjs';

class Socket extends EventTarget {
  readyState = 1; sent = []; closed;
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; this.dispatchEvent(Object.assign(new Event('close'), { code, reason })); }
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
  await assert.rejects(listener.invitations[Symbol.asyncIterator]().next(), { code: 'invitation_backpressure' });
  const abort = new AbortController(), cancelled = createPeerInvitationListener(new Socket(), 'target', { signal: abort.signal });
  abort.abort(); await assert.rejects(cancelled.ready, { name: 'AbortError' }); await cancelled.closed;
  const deadline = createPeerInvitationListener(new Socket(), 'target', { timeoutMs: 1 });
  await assert.rejects(deadline.ready, { code: 'invitation_timeout' }); await deadline.closed;
  const invalidSocket = new Socket(), invalid = createPeerInvitationListener(invalidSocket, 'target');
  invalidSocket.receive({ t: 'ready', version: 1, peerId: 'somebody-else' });
  await assert.rejects(invalid.ready, { code: 'invalid_invitation' });
});

test('pairing notices wake only listeners that asked for them and carry no data', async () => {
  const notices = [], socket = new Socket(), listener = createPeerInvitationListener(socket, 'target', { onNotice: notice => notices.push(notice) });
  socket.receive({ t: 'ready', version: 1, peerId: 'target' }); await listener.ready;
  socket.receive({ t: 'notice', kind: 'pairing', version: 1 }); socket.receive({ t: 'notice', kind: 'pairing', version: 1 });
  assert.deepEqual(notices, [{ kind: 'pairing' }, { kind: 'pairing' }]);
  assert.deepEqual(socket.sent, []); assert.equal(listener.stats.closed, false);
  socket.receive({ t: 'notice', kind: 'other', version: 1 });
  assert.equal((await listener.closed).code, 1008);
  const plainSocket = new Socket(), plain = createPeerInvitationListener(plainSocket, 'target');
  plainSocket.receive({ t: 'ready', version: 1, peerId: 'target' }); await plain.ready;
  plainSocket.receive({ t: 'notice', kind: 'pairing', version: 1 });
  assert.equal((await plain.closed).code, 1008, 'Listeners that did not opt in keep the strict frame set.');
  const sockets = [], client = createPeersClient({ base: 'https://host.test/api/app', applicationId: 'ab'.repeat(32),
    request: async () => ({}), socket: (url, protocols) => { const value = new Socket(); sockets.push({ url, value }); return value; } });
  client.listenInvitations('ab'.repeat(32), { onNotice: () => {} }).close();
  client.listenInvitations('ab'.repeat(32)).close();
  assert.equal(new URL(sockets[0].url).searchParams.get('notices'), 'pairing');
  assert.equal(new URL(sockets[1].url).searchParams.has('notices'), false);
});

test('the public client preserves private protocol credentials and only posts on demand', async () => {
  const calls = [], sockets = [];
  const client = createPeersClient({ base: 'https://host.test/api/app', applicationId: 'ab'.repeat(32), protocols: ['tendriller.rendezvous.v1', 'private-token'],
    request: async (path, options) => { calls.push({ path, options }); return createParticipantResponse(options.body, { invited: options.body.payload.peerId, channel: options.body.payload.channel }); },
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
  assert.equal(calls[0].path, 'peers/participant');
  assert.deepEqual([calls[0].options.body.facet, calls[0].options.body.action, calls[0].options.body.payload], ['ephemeral', 'invite', { peerId: 'target', channel: 'fresh', requesterPeerId: 'source' }]);
  const advertisement = validatePeerAdvertisement({ peerId: 'target', storageId: 'disk',
    routes: [{ kind: 'invitation', peerId: 'target' }] });
  assert.deepEqual(advertisement.routes, [{ kind: 'invitation', peerId: 'target' }]);
  listener.close();
});
