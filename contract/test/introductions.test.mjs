import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerIntroductions, createPeersClient } from '../peers.mjs';

const local = 'ab'.repeat(32), remote = 'cd'.repeat(32), other = 'ef'.repeat(32);
const options = () => ({ signal: new AbortController().signal });
const route = identity => ({ kind: 'invitation', peerId: identity });
function fixture(overrides = {}, opener) {
  const calls = [], openings = [], channels = [];
  const peers = {
    async discover(value) { calls.push(['discover', value]); return { peers: [] }; },
    async advertise(value, options) { calls.push(['advertise', value, options]); },
    async withdraw(value, options) { calls.push(['withdraw', value, options]); },
    listenInvitations(identity, options) {
      calls.push(['listen', identity, options]);
      const stopped = Promise.withResolvers(); let closed = false;
      const close = () => { if (!closed) { closed = true; stopped.resolve(); calls.push(['closeListener']); } };
      options.signal.addEventListener('abort', close, { once: true });
      return { ready: Promise.resolve(), invitations: { async *[Symbol.asyncIterator]() { await stopped.promise; } }, close };
    },
    async invite(identity, value, options) { calls.push(['invite', identity, value, options]); },
    rendezvous(channel, identity, options) {
      calls.push(['rendezvous', channel, identity, options]);
      const signaling = { ready: Promise.resolve({ session: 'paired', role: 'answerer' }),
        messages: { async *[Symbol.asyncIterator]() {} }, async send() {}, close() { calls.push(['closeSignaling', channel]); } };
      channels.push(signaling); return signaling;
    },
    ...overrides,
  };
  const connection = { async close() { calls.push(['closeConnection']); } };
  const ports = createPeerIntroductions({ peers, identity: local, openConnection: opener ?? (async input => { openings.push(input); return connection; }) });
  return { ...ports, calls, openings, channels, connection };
}

test('construction is inert and discovery pins only valid remote identities with supported routes', async () => {
  const advertisement = (peerId, routes) => ({ advertisement: { peerId, storageId: 'disk', routes } });
  const f = fixture({ async discover() { return { peers: [
    advertisement(local, [route(local)]), advertisement('untrusted-alias', [route('untrusted-alias')]),
    advertisement(remote, [{ kind: 'https', url: 'https://peer.test/' }, route(other), route(remote)]),
    advertisement(other, [{ kind: 'rendezvous', channel: 'join:other' }]),
    advertisement('01'.repeat(32), [{ kind: 'https', url: 'https://peer.test/' }]),
  ] }; } });
  assert.deepEqual(f.calls, []);
  const found = await f.discovery.read(options());
  assert.deepEqual(found, [{ identity: remote, route: route(remote) }, { identity: other, route: { kind: 'rendezvous', channel: 'join:other' } }]);
  assert.throws(() => { found[0].route.peerId = other; }, TypeError);
  assert.deepEqual(f.calls, []);
});

test('availability carries identity and routes only, forwards cancellation, and owns no renewal timer', async () => {
  const f = fixture(), controller = new AbortController(), selected = { signal: controller.signal };
  const reading = f.discovery.invitations(selected)[Symbol.asyncIterator]().next();
  await Promise.resolve(); f.calls.length = 0;
  await f.discovery.advertise({ identity: local, storageId: 'owned-disk', generation: 'never-published', point: { sequence: 9 } }, { ...selected, ttlMs: 120000 });
  assert.deepEqual(f.calls, [['advertise', { peerId: local, storageId: 'owned-disk', routes: [route(local)] }, { ...selected, ttlMs: 120000 }]]);
  await f.discovery.withdraw(selected);
  assert.deepEqual(f.calls[1], ['withdraw', local, selected]);
  await assert.rejects(f.discovery.advertise({ identity: remote, storageId: 'disk' }, { ...selected, ttlMs: 120000 }), { code: 'invalid_introduction' });
  const stopped = new AbortController(); stopped.abort(Error('session closed'));
  for (const action of [() => f.discovery.read({ signal: stopped.signal }),
    () => f.discovery.withdraw({ signal: stopped.signal }),
    () => f.discovery.advertise({ identity: local, storageId: 'disk' }, { signal: stopped.signal, ttlMs: 120000 })])
    await assert.rejects(action(), /session closed/);
  assert.equal(f.calls.length, 2);
  controller.abort(); await reading;
});

test('outbound introduction uses a fresh channel, the paired role and closes host signaling after raw connection', async () => {
  const f = fixture(), selected = options(), peer = { identity: remote, route: route(remote) };
  assert.equal(await f.transport.open({ peer }, selected), f.connection);
  const [opened, invitation, closed] = f.calls;
  assert.equal(opened[0], 'rendezvous'); assert.equal(opened[2], local); assert.equal(opened[3].signal, selected.signal);
  assert.deepEqual(invitation, ['invite', remote, { channel: opened[1], requesterPeerId: local }, selected]);
  assert.deepEqual(closed, ['closeSignaling', opened[1]]);
  assert.deepEqual(f.openings, [{ role: 'answerer', signaling: f.channels[0], signal: selected.signal }]);
  await f.transport.open({ peer }, selected);
  assert.notEqual(f.calls[3][1], opened[1], 'A new transport attempt cannot reuse the previous pairing channel');
});

test('invitations translate to expected signing identities and close their listener on early exit', async () => {
  let closed = 0, listening;
  const f = fixture({ listenInvitations(identity, opts) {
    listening = { identity, opts };
    return { ready: Promise.resolve(), invitations: { async *[Symbol.asyncIterator]() {
      yield { channel: 'join:invalid', requesterPeerId: 'alias' };
      yield { channel: 'join:self', requesterPeerId: local };
      yield { channel: 'join:valid', requesterPeerId: remote };
      yield { channel: 'join:other', requesterPeerId: other };
    } }, close() { closed++; } };
  } });
  const selected = options(), received = [];
  for await (const invitation of f.discovery.invitations(selected)) { received.push(invitation); break; }
  assert.deepEqual(listening, { identity: local, opts: selected });
  assert.deepEqual(received, [{ peer: { identity: remote, route: route(remote) }, token: { channel: 'join:valid', requesterPeerId: remote } }]);
  assert.equal(closed, 1);
});

test('incoming and pre-opened rendezvous routes open once without sending another invitation', async () => {
  const f = fixture(), selected = options();
  await f.transport.open({ peer: { identity: remote, route: route(remote) }, invitation: { channel: 'join:received', requesterPeerId: remote } }, selected);
  await f.transport.open({ peer: { identity: remote, route: { kind: 'rendezvous', channel: 'join:ready' } } }, selected);
  assert.deepEqual(f.calls.map(call => [call[0], call[1]]), [
    ['rendezvous', 'join:received'], ['closeSignaling', 'join:received'], ['rendezvous', 'join:ready'], ['closeSignaling', 'join:ready'],
  ]);
  await assert.rejects(f.transport.open({ peer: { identity: remote, route: route(remote) },
    invitation: { channel: 'join:forged', requesterPeerId: other } }, selected), { code: 'invalid_introduction' });
  await assert.rejects(f.transport.open({ peer: { identity: remote, route: route(other) } }, selected), { code: 'invalid_introduction' });
  assert.equal(f.calls.length, 4);
});

test('failed invitations close signaling and cancellation closes a late connection without retries', async () => {
  const failing = fixture({ async invite() { throw Error('host unavailable'); } });
  await assert.rejects(failing.transport.open({ peer: { identity: remote, route: route(remote) } }, options()), /host unavailable/);
  assert.deepEqual(failing.calls.map(call => call[0]), ['rendezvous', 'closeSignaling']);
  const controller = new AbortController(); let lateClosed = 0;
  const cancelled = fixture({}, async () => { controller.abort(Error('session ended')); return { async close() { lateClosed++; } }; });
  await assert.rejects(cancelled.transport.open({ peer: { identity: remote, route: route(remote) } }, { signal: controller.signal }), /session ended/);
  assert.equal(lateClosed, 1);
  assert.deepEqual(cancelled.calls.map(call => call[0]), ['rendezvous', 'invite', 'closeSignaling']);
});

test('the actual host SDK suppresses cancelled discovery and invitation exchanges before HTTP', async () => {
  let requests = 0;
  const peers = createPeersClient({ base: 'https://host.test/api', applicationId: '01'.repeat(32), request: async () => { requests++; } });
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  const options = { signal: controller.signal };
  for (const action of [() => peers.discover(options), () => peers.withdraw(local, options),
    () => peers.advertise({ peerId: local, storageId: 'disk', routes: [route(local)] }, options),
    () => peers.invite(remote, { channel: 'join:cancelled', requesterPeerId: local }, options)])
    await assert.rejects(action(), /cancelled/);
  assert.equal(requests, 0);
});


test('advertising waits for the owned invitation listener acknowledgement and respects cancellation', async () => {
  const ready = Promise.withResolvers(), stopped = Promise.withResolvers();
  const controller = new AbortController(), selected = { signal: controller.signal };
  const f = fixture({ listenInvitations() {
    controller.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
    return { ready: ready.promise, invitations: { async *[Symbol.asyncIterator]() { await stopped.promise; } }, close() {} };
  } });
  const first = f.discovery.advertise({ identity: local, storageId: 'disk' }, { ...selected, ttlMs: 120000 });
  await Promise.resolve(); assert.deepEqual(f.calls, [], 'No listener has started yet');
  const reading = f.discovery.invitations(selected)[Symbol.asyncIterator]().next();
  await Promise.resolve(); assert.deepEqual(f.calls, [], 'Opening a socket is not an acknowledgement');
  ready.resolve(); await first;
  assert.equal(f.calls[0][0], 'advertise');
  controller.abort(); await reading;

  const cancelled = new AbortController();
  const waiting = f.discovery.advertise({ identity: local, storageId: 'disk' }, { signal: cancelled.signal, ttlMs: 120000 });
  cancelled.abort(Error('session ended before listening'));
  await assert.rejects(waiting, /session ended before listening/);
  assert.equal(f.calls.length, 1);
});
