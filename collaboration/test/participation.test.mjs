import test from 'node:test';
import assert from 'node:assert/strict';
import { participateApplication, PEER_TRANSPORT_POLICY } from '../../session/participation.mjs';
import { validatePeerAdvertisement } from '../../contract/discovery.mjs';
import { createTransportDiagnostics } from '../../session/transport-diagnostics.mjs';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { p, memoryStore, genesisForDevices, createPhysicalSession } from './physical-fixture.mjs';
const flush = () => new Promise(setImmediate);
async function until(predicate) { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw Error('PARTICIPATION_TEST_DEADLINE'); await flush(); } }
function stream(signal, first = []) {
  const stop = new AbortController(), lifetime = AbortSignal.any([signal, stop.signal]);
  return { close() { stop.abort(); }, async *[Symbol.asyncIterator]() {
    for (const value of first) yield value;
    if (!lifetime.aborted) await new Promise(resolve => { lifetime.addEventListener('abort', resolve, { once: true }); if (lifetime.aborted) resolve(); });
  } };
}
function host({ fail = () => false } = {}) {
  const advertisements = [], attempts = []; let reads = 0;
  const peers = {
    async application() { return { authority: null }; },
    watchDiscovery(_key, { signal }) { const notifications = stream(signal, [{ type: 'ready' }]); return { ready: Promise.resolve(), notifications, close: () => notifications.close() }; },
    listenInvitations(_key, { signal }) { const invitations = stream(signal); return { ready: Promise.resolve(), invitations, close: () => invitations.close() }; },
    async discover() { reads++; return { applicationId: 'a'.repeat(64), peers: [] }; },
    async advertise(input) { const value = validatePeerAdvertisement(input); attempts.push(value); if (fail()) throw Object.assign(Error('Routing admission temporarily unavailable'), { code: 'routing_admission_unavailable' }); advertisements.push(value); return { advertisement: value }; },
    async withdraw() {}, async invite() { throw Error('UNEXPECTED_INVITATION'); }, rendezvous() { throw Error('UNEXPECTED_RENDEZVOUS'); }, relay() { throw Error('UNEXPECTED_RELAY'); },
  };
  return { peers, advertisements, attempts, get reads() { return reads; } };
}
const forbiddenDirect = async () => { throw Error('No foreign directory entry was supplied'); };

test('an ACTUAL public session advertises its retained DEVICE storage identity, without a kernel alias or Save gate', async () => {
  const session = await createPhysicalSession(), server = host();
  assert.equal(session.storageId, undefined, 'Do not invent a facade property to make the consumer pass');
  const controller = participateApplication(session, { peers: server.peers, openDirectConnection: forbiddenDirect });
  try {
    await until(() => server.advertisements.length === 1);
    assert.equal(server.advertisements[0].storageId, session.device.storageId);
    assert.equal(server.advertisements[0].peerId, session.identity.publicKey);
    const operation = await session.submit({ operationId: 'independent-local-write', updates: [{ topic: 'events', input: { eventTopic: 'local', payload: { stored: true } } }] });
    assert.equal(operation.stored, true); assert.equal(session.status.canAuthor, true);
    assert.equal(controller.status.connectedPeers.length, 0);
    await operation.materialized();
    assert.equal(PEER_TRANSPORT_POLICY.configuration.iceServers.every(server => !server.urls.startsWith('turn:')), true);
  } finally { await controller.close(); await session.close(); }
});

test('failed advertisement retries through the existing bounded lifecycle and preserves its actual error code', async () => {
  const session = await createPhysicalSession(); let rejected = false;
  const server = host({ fail() { if (!rejected) { rejected = true; return true; } return false; } });
  const controller = participateApplication(session, { peers: server.peers, openDirectConnection: forbiddenDirect });
  try {
    await until(() => controller.status.error === 'advertise:routing_admission_unavailable');
    assert.equal(session.status.canAuthor, true);
    await until(() => server.advertisements.length === 1);
    assert.equal(server.attempts.length, 2);
    assert.equal(controller.status.error, null);
    assert.deepEqual(server.attempts[0], server.attempts[1]);
    await controller.resume(); await flush();
    assert.equal(server.attempts.length, 2, 'A confirmed unchanged routing hint does not turn refresh into a heartbeat');
  } finally { await controller.close(); await session.close(); }
});

test('real keyless-to-reader membership changes retry routing admission, without creating data keys or fetching app facts', async () => {
  const root = await p.openApplicationDevice({ store: memoryStore(), create: true });
  const recipient = await p.openApplicationDevice({ store: memoryStore(), create: true });
  const { genesisBytes, casNodes, key } = await genesisForDevices([root]);
  const rootSession = await p.createApplicationSession({ device: root, definition: p.defineApplication({ id: 'root-routing', version: '1', commands: {}, queries: {} }), genesis: genesisBytes, casNodes, epochKeys: new Map([[0, key]]) });
  const session = await p.createApplicationSession({ device: recipient, definition: p.defineApplication({ id: 'recipient-routing', version: '1', commands: {}, queries: {} }), genesis: genesisBytes, casNodes });
  let admitted = false;
  const server = host({ fail: () => !admitted }), controller = participateApplication(session, { peers: server.peers, openDirectConnection: forbiddenDirect });
  try {
    await until(() => controller.status.error === 'advertise:routing_admission_unavailable'); await flush();
    assert.equal(session.status.canAuthor, false); assert.equal(session.epochKey(0), null);
    await rootSession.admitMember({ publicKey: recipient.identity.publicKey, reader: true, writer: true, administrator: false });
    const exported = await rootSession.exportFacts({ includePrivateCas: false });
    admitted = true;
    await session.mergeFacts({ publicOps: exported.publicOps, encryptedEnvelopes: [], casNodes: [], retentions: [], checkpoints: [] });
    await until(() => server.advertisements.length === 1);
    assert.equal(server.advertisements[0].storageId, recipient.storageId);
    assert.equal(session.epochKey(0), null, 'Crypto membership never invents a missing key');
    await session.installEpochKey(0, key);
    await session.retryMaterialization();
    assert.equal(session.status.canAuthor, true);
    await flush(); assert.equal(server.advertisements.length, 1);
  } finally { await controller.close(); await session.close(); await rootSession.close(); }
});

test('a real owned session, retained device identity and actual RTC opener are required', () => {
  assert.throws(() => participateApplication({}, { peers: {}, openDirectConnection: forbiddenDirect }), TypeError);
});

// One in-memory physical path per rendezvous channel. A black hole keeps both
// ends open and accepts sends, but silently delivers nothing: a dead UDP path.
function physicalPath() {
  const sides = [0, 1].map(() => ({ stop: new AbortController(), reliable: [], live: [], wake: [] }));
  let blackholed = false;
  const wake = side => { for (const resolve of side.wake.splice(0)) resolve(); };
  const end = (index, reason) => { const side = sides[index]; if (!side.stop.signal.aborted) side.stop.abort(reason); wake(side); };
  async function* frames(side, lane, signal) {
    while (!signal.aborted) {
      const frame = side[lane].shift();
      if (frame) { yield frame; continue; }
      await new Promise(resolve => { side.wake.push(resolve); signal.addEventListener('abort', resolve, { once: true }); });
    }
  }
  const end_ = index => {
    const local = sides[index], remote = sides[1 - index];
    const lifetime = signal => signal ? AbortSignal.any([local.stop.signal, signal]) : local.stop.signal;
    const deliver = (lane, frame) => { if (!blackholed && !remote.stop.signal.aborted) { remote[lane].push(frame.slice()); wake(remote); } };
    // Closing an end is local; the remote only learns it if the path still delivers.
    const close = async () => { end(index, Error('PATH_CLOSED')); if (!blackholed) end(1 - index, Error('PATH_CLOSED')); };
    return { signal: local.stop.signal, close,
      async send(frame, options = {}) { lifetime(options.signal).throwIfAborted(); deliver('reliable', frame); },
      frames: signal => frames(local, 'reliable', lifetime(signal)),
      live: { signal: local.stop.signal, close,
        async trySend(frame, options = {}) { lifetime(options.signal).throwIfAborted(); deliver('live', frame); return true; },
        frames: signal => frames(local, 'live', lifetime(signal)) } };
  };
  return { ends: [end_(0), end_(1)], blackhole() { blackholed = true; }, fail(index) { end(index, Error('WEBRTC_CONNECTION_FAILED')); } };
}
// Two in-memory WebSocket ends; the relay host pairs them by channel and lane.
function socketPair() {
  const ends = [0, 1].map(() => Object.assign(new EventTarget(), { readyState: 1, bufferedAmount: 0, binaryType: 'arraybuffer' }));
  ends.forEach((end, index) => {
    const other = ends[1 - index];
    end.send = data => { if (end.readyState !== 1) throw Error('closed'); const copy = data instanceof ArrayBuffer ? data.slice(0) : new Uint8Array(data).slice().buffer;
      queueMicrotask(() => { if (other.readyState === 1) other.dispatchEvent(Object.assign(new Event('message'), { data: copy })); }); };
    end.close = () => { for (const value of ends) if (value.readyState < 3) { value.readyState = 3; queueMicrotask(() => value.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' }))); } };
  });
  return ends;
}
function sharedHost(applicationId, { relays = false } = {}) {
  const relayPairs = new Map(), state = { udpBlocked: false };
  const advertised = new Map(), listeners = new Map(), watchers = new Map(), channels = new Map(), invitations = [];
  const route = channel => { let value = channels.get(channel); if (!value) channels.set(channel, value = { joined: [], path: physicalPath(), ready: Promise.withResolvers() }); return value; };
  const peersFor = identity => ({
    async application() { return { authority: null }; },
    watchDiscovery(_key, { signal }) {
      const queue = [{ type: 'ready' }], waiting = [];
      watchers.set(identity, () => { queue.push({ type: 'changed' }); for (const resolve of waiting.splice(0)) resolve(); });
      const notifications = { async *[Symbol.asyncIterator]() {
        while (!signal.aborted) { if (queue.length) { yield queue.shift(); continue; } await new Promise(resolve => { waiting.push(resolve); signal.addEventListener('abort', resolve, { once: true }); }); }
      } };
      return { ready: Promise.resolve(), notifications, close() {} };
    },
    listenInvitations(_key, { signal }) {
      const queue = [], waiting = [];
      listeners.set(identity, token => { queue.push(token); for (const resolve of waiting.splice(0)) resolve(); });
      const invitations = { async *[Symbol.asyncIterator]() {
        while (!signal.aborted) { if (queue.length) { yield queue.shift(); continue; } await new Promise(resolve => { waiting.push(resolve); signal.addEventListener('abort', resolve, { once: true }); }); }
      } };
      return { ready: Promise.resolve(), invitations, close() {} };
    },
    async discover() { return { applicationId, peers: [...advertised.values()].map(advertisement => ({ advertisement })) }; },
    async advertise(input) { const value = validatePeerAdvertisement(input); advertised.set(value.peerId, value); for (const [peer, notify] of watchers) if (peer !== identity) notify(); return { advertisement: value }; },
    async withdraw() {},
    async invite(target, token) { invitations.push({ target, ...token }); listeners.get(target)?.(token); },
    rendezvous(channel, peerId) {
      const value = route(channel); value.joined.push(peerId);
      if (value.joined.length === 2) value.ready.resolve();
      return { ready: value.ready.promise.then(() => ({ role: value.joined[0] === peerId ? 'offerer' : 'answerer' })), channel, close() {} };
    },
    relay(channel, peerId) {
      if (!relays) throw Object.assign(Error('This fixture has no relay'), { code: 'relay_unavailable' });
      let value = relayPairs.get(channel);
      if (!value) relayPairs.set(channel, value = { joined: [], ready: Promise.withResolvers(), lanes: { reliable: socketPair(), live: socketPair() } });
      const index = value.joined.push(peerId) - 1;
      if (value.joined.length === 2) value.ready.resolve();
      return { reliable: value.lanes.reliable[index], live: value.lanes.live[index], ready: value.ready.promise, close() { value.lanes.reliable[index].close(); value.lanes.live[index].close(); } };
    },
  });
  // UDP blocked: an RTC attempt never connects and simply waits for its timeout.
  const openDirectConnection = async ({ signaling, role, signal }) => {
    if (state.udpBlocked) await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    return route(signaling.channel).path.ends[role === 'offerer' ? 0 : 1];
  };
  return { peersFor, openDirectConnection, invitations, channels, relayPairs, state, deliver: (target, token) => listeners.get(target)(token) };
}
async function eventually(predicate, ms = 15_000) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw Error('PARTICIPATION_TEST_DEADLINE'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('a peer whose path died silently accepts the replacement its remote dials, instead of keeping the dead link', async () => {
  const devices = [await p.openApplicationDevice({ store: memoryStore(), create: true }), await p.openApplicationDevice({ store: memoryStore(), create: true })];
  const { logId, genesisBytes, casNodes, key } = await genesisForDevices(devices);
  const sessions = await Promise.all(devices.map(device => p.createApplicationSession({ device, genesis: genesisBytes, casNodes, epochKeys: new Map([[0, key]]),
    definition: p.defineApplication({ id: 'dead-path', version: '1', commands: {}, queries: {} }) })));
  const host = sharedHost(logId);
  const controllers = sessions.map(session => participateApplication(session, { peers: host.peersFor(session.identity.publicKey), directTimeoutMs: 500,
    openDirectConnection: host.openDirectConnection }));
  // Exactly one side dials: the lower signing identity.
  const dialer = sessions[0].identity.publicKey < sessions[1].identity.publicKey ? 0 : 1, zombie = 1 - dialer;
  try {
    await eventually(() => controllers.every(controller => controller.status.connectedPeers.length === 1));
    assert.equal(host.channels.size, 1);
    const [first] = host.channels.values(), revision = controllers[zombie].status.connectionRevision;
    // UDP is black-holed. Only the dialer's ICE notices; the other end stays open and silent.
    first.path.blackhole(); first.path.fail(first.joined[0] === sessions[dialer].identity.publicKey ? 0 : 1);
    await eventually(() => controllers[dialer].status.connectedPeers.length === 0);
    assert.equal(controllers[zombie].status.connectedPeers.length, 1, 'The silent end cannot observe the dead path by itself');
    await eventually(() => host.channels.size === 2 && controllers.every(controller => controller.status.connectedPeers.length === 1));
    assert.ok(controllers[zombie].status.connectionRevision > revision, 'The remote\'s new invitation replaced the dead link');
    const [, second] = host.channels.values();
    assert.equal(second.joined.length, 2, 'Both ends joined the replacement introduction');
    const operation = await sessions[dialer].submit({ operationId: 'after-replacement', updates: [{ topic: 'events', input: { eventTopic: 'replaced', payload: { ok: true } } }] });
    await operation.materialized();
    // A redelivered copy of the replacement's own hint cannot tear it down.
    const settled = controllers[zombie].status.connectionRevision, replayed = host.invitations.at(-1);
    host.deliver(replayed.target, { channel: replayed.channel, requesterPeerId: replayed.requesterPeerId }); await flush(); await flush();
    assert.equal(controllers[zombie].status.connectionRevision, settled); assert.equal(host.channels.size, 2);
    // Signed work authored after the fault replicates over the replacement link.
    const count = index => sessions[index].readEvents({ topics: ['replaced'] }).events.length;
    assert.equal(count(dialer), 1);
    await eventually(() => count(zombie) === 1);
  } finally { await Promise.allSettled(controllers.map(controller => controller.close())); await Promise.allSettled(sessions.map(session => session.close())); }
});

test('a relay link is promoted to direct after a network change, and a failed promotion keeps the relay', async () => {
  const devices = [await p.openApplicationDevice({ store: memoryStore(), create: true }), await p.openApplicationDevice({ store: memoryStore(), create: true })];
  const { logId, genesisBytes, casNodes, key } = await genesisForDevices(devices);
  const sessions = await Promise.all(devices.map(device => p.createApplicationSession({ device, genesis: genesisBytes, casNodes, epochKeys: new Map([[0, key]]),
    definition: p.defineApplication({ id: 'relay-promotion', version: '1', commands: {}, queries: {} }) })));
  const host = sharedHost(logId, { relays: true });
  host.state.udpBlocked = true;
  const controllers = sessions.map(session => participateApplication(session, { peers: host.peersFor(session.identity.publicKey), directTimeoutMs: 300,
    upgradeCooldownMs: 0, openDirectConnection: host.openDirectConnection }));
  // The side that observes the network change need not be the one that dials.
  const dialer = sessions[0].identity.publicKey < sessions[1].identity.publicKey ? 0 : 1, observer = 1 - dialer;
  const kinds = async () => (await Promise.all(controllers.map(controller => controller.diagnostics()))).map(links => links.map(link => link.kind).join());
  let maxLinks = 0; const stops = sessions.map(session => session.onStatus(status => { maxLinks = Math.max(maxLinks, status.connectedPeers); }));
  try {
    await eventually(() => controllers.every(controller => controller.status.connectedPeers.length === 1));
    assert.deepEqual(await kinds(), ['relay', 'relay']);
    // Owner attachments read the session itself: it reports the selected route
    // and fallback reason beside its own measured per-link counters.
    for (const session of sessions) {
      const [row, ...rest] = await session.diagnostics();
      assert.equal(rest.length, 0); assert.equal(row.kind, 'relay'); assert.ok(['direct_failed', 'direct_timeout'].includes(row.reason));
      assert.ok(Number.isSafeInteger(row.sentReliableBytes) && row.sentReliableBytes > 0); assert.equal(typeof row.connectionId, 'string');
    }
    // The Worker-owner composition: a page facade attached to the owner sees the same route and link totals.
    const ports = new MessageChannel(), owner = createApplicationOwner(sessions[0]); owner.attach(ports.port1);
    const facade = await connectApplicationOwner(ports.port2, { applicationId: sessions[0].applicationId, timeoutMs: 2000 });
    const inspector = createTransportDiagnostics(facade);
    try {
      const [link] = (await inspector.refresh()).connections;
      assert.equal(link.kind, 'relay'); assert.ok(link.reason === 'direct_failed' || link.reason === 'direct_timeout');
      assert.ok(link.sentBytes >= link.sentReliableBytes && link.sentReliableBytes > 0); assert.ok(link.receivedBytes > 0);
    } finally { inspector.close(); await facade.detach(); ports.port1.close(); ports.port2.close(); } // owner.close() would close the session itself.
    // UDP still blocked: the promotion fails and the working relay link stays.
    const revisions = controllers.map(controller => controller.status.connectionRevision);
    await controllers[observer].reconsiderConnections();
    assert.deepEqual(await kinds(), ['relay', 'relay']);
    assert.deepEqual(controllers.map(controller => controller.status.connectionRevision), revisions);
    assert.equal(controllers[observer].status.error, null);
    // UDP restored: the next network change promotes both ends to one direct link.
    host.state.udpBlocked = false;
    await controllers[observer].reconsiderConnections();
    let current; await eventually(() => { void kinds().then(value => { current = value; }); return current?.join() === 'direct,direct'; });
    assert.equal(maxLinks, 1, 'The relay link is retired before the direct link authenticates: never two links to one peer');
    const operation = await sessions[dialer].submit({ operationId: 'after-promotion', updates: [{ topic: 'events', input: { eventTopic: 'promoted', payload: { ok: true } } }] });
    await operation.materialized();
    const count = index => sessions[index].readEvents({ topics: ['promoted'] }).events.length;
    await eventually(() => count(dialer) === 1 && count(observer) === 1);
    const [direct] = await sessions[observer].diagnostics();
    assert.equal(direct.kind, 'direct'); assert.equal('reason' in direct, false);
    // Closing the controller hands the session back its own unannotated report.
    await controllers[observer].close();
    assert.equal(Object.hasOwn(sessions[observer], 'diagnostics'), false);
  } finally { stops.forEach(stop => stop()); await Promise.allSettled(controllers.map(controller => controller.close())); await Promise.allSettled(sessions.map(session => session.close())); }
});

test('a reloaded passive peer breaks the dialer zombie-link deadlock via its bounded one-shot fallback', async () => {
  const devices = [await p.openApplicationDevice({ store: memoryStore(), create: true }), await p.openApplicationDevice({ store: memoryStore(), create: true })];
  const { logId, genesisBytes, casNodes, key } = await genesisForDevices(devices);
  const sessions = await Promise.all(devices.map(device => p.createApplicationSession({ device, genesis: genesisBytes, casNodes, epochKeys: new Map([[0, key]]),
    definition: p.defineApplication({ id: 'passive-reload', version: '1', commands: {}, queries: {} }) })));
  const host = sharedHost(logId);
  const dialer = sessions[0].identity.publicKey < sessions[1].identity.publicKey ? 0 : 1, passive = 1 - dialer;
  const dialerController = participateApplication(sessions[dialer], { peers: host.peersFor(sessions[dialer].identity.publicKey), directTimeoutMs: 500,
    passiveDialDelayMs: 120, openDirectConnection: host.openDirectConnection });
  let passiveController = participateApplication(sessions[passive], { peers: host.peersFor(sessions[passive].identity.publicKey), directTimeoutMs: 500,
    passiveDialDelayMs: 120, openDirectConnection: host.openDirectConnection });
  try {
    await eventually(() => dialerController.status.connectedPeers.length === 1 && passiveController.status.connectedPeers.length === 1);
    assert.equal(host.channels.size, 1);
    const [first] = host.channels.values(), dialerRevision = dialerController.status.connectionRevision;
    // Black-hole the old path before tearing down the passive peer, simulating
    // a hard reload or crash where the dialer never receives a close frame.
    first.path.blackhole();
    await passiveController.close();
    assert.equal(dialerController.status.connectedPeers.length, 1, 'Dialer still believes its stale link is alive');
    // The passive peer reboots with the same identity and higher public key.
    passiveController = participateApplication(sessions[passive], { peers: host.peersFor(sessions[passive].identity.publicKey), directTimeoutMs: 500,
      passiveDialDelayMs: 120, openDirectConnection: host.openDirectConnection });
    await eventually(() => host.channels.size === 2 && dialerController.status.connectionRevision > dialerRevision &&
      dialerController.status.connectedPeers.length === 1 && passiveController.status.connectedPeers.length === 1, 5000);
    const op = await sessions[passive].submit({ operationId: 'after-passive-reload', updates: [{ topic: 'events', input: { eventTopic: 'reloaded', payload: { ok: true } } }] });
    await op.materialized();
    const count = index => sessions[index].readEvents({ topics: ['reloaded'] }).events.length;
    await eventually(() => count(passive) === 1 && count(dialer) === 1);
  } finally {
    await Promise.allSettled([dialerController.close(), passiveController.close()]);
    await Promise.allSettled(sessions.map(session => session.close()));
  }
});
