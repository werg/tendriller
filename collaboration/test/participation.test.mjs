import test from 'node:test';
import assert from 'node:assert/strict';
import { participateApplication, PEER_TRANSPORT_POLICY } from '../../session/participation.mjs';
import { validatePeerAdvertisement } from '../../contract/discovery.mjs';
import { p, memoryStore, authorityForDevices, createPhysicalSession } from './physical-fixture.mjs';
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
    const operation = await session.submit({ operationId: 'independent-local-write', program: p.program(p.emit('local', { stored: true })) });
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

test('real keyless-to-reader authority changes retry routing admission, without creating data keys or fetching app facts', async () => {
  const root = await p.openApplicationDevice({ store: memoryStore(), create: true });
  const recipient = await p.openApplicationDevice({ store: memoryStore(), create: true });
  const { authority, key } = await authorityForDevices([root]);
  const session = await p.createApplicationSession({ device: recipient, definition: p.defineApplication({ id: 'recipient-routing', version: '1', commands: {}, queries: {} }), authority });
  let admitted = false;
  const server = host({ fail: () => !admitted }), controller = participateApplication(session, { peers: server.peers, openDirectConnection: forbiddenDirect });
  try {
    await until(() => controller.status.error === 'advertise:routing_admission_unavailable'); await flush();
    assert.equal(session.status.canAuthor, false); assert.equal(session.authority.epochKey(0), null);
    const membership = await p.signMembership({ ...authority.memberships[0].payload, revision: 1, previous: await p.recordDigest(authority.memberships[0]), authorTimeAfterMs: 0n,
      members: [...authority.memberships[0].payload.members, { publicKey: recipient.identity.publicKey, reader: true, writer: true, administrator: false, publisher: false, finalizer: false }] }, root.identity);
    admitted = true;
    await session.mergeAuthority({ ...authority, memberships: [...authority.memberships, membership] });
    await until(() => server.advertisements.length === 1);
    assert.equal(server.advertisements[0].storageId, recipient.storageId);
    assert.equal(session.authority.epochKey(0), null, 'Crypto membership never invents a missing key');
    await session.authority.installEpochKey(0, key);
    assert.equal(session.status.canAuthor, true);
    await flush(); assert.equal(server.advertisements.length, 1);
  } finally { await controller.close(); await session.close(); await root.close(); }
});

test('a real owned session, retained device identity and actual RTC opener are required', () => {
  assert.throws(() => participateApplication({}, { peers: {}, openDirectConnection: forbiddenDirect }), TypeError);
});
