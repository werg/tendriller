import test from 'node:test';
import assert from 'node:assert/strict';
import * as peers from '../peers.mjs';
const { validatePeerBootstrap } = peers;

test('bootstrap supplies immutable bounded HTTPS introductions without credentials or route claims', () => {
  const input = { version: 2, endpoints: [{ url: 'https://PEER.example:443/introduce' }] };
  const hints = validatePeerBootstrap(input);
  assert.deepEqual(hints.endpoints, [{ url: 'https://peer.example/introduce' }]);
  input.endpoints[0].url = 'https://elsewhere.example/';
  assert.equal(hints.endpoints[0].url, 'https://peer.example/introduce');
  assert.throws(() => hints.endpoints.push({ url: 'https://elsewhere.example/' }), TypeError);
  assert.throws(() => { hints.endpoints[0].url = 'https://elsewhere.example/'; }, TypeError);
  for (const url of ['wss://peer.example/socket', 'http://peer.example/introduce', 'https://secret@peer.example/',
    'https://peer.example/#capability', 'https://peer.example/?token=secret'])
    assert.throws(() => validatePeerBootstrap({ version: 2, endpoints: [{ url }] }), { code: 'invalid_bootstrap' });
  for (const endpoints of [[{ url: 'https://peer.example/', route: 'direct' }],
    [{ url: 'https://peer.example/' }, { url: 'https://PEER.example:443/' }],
    Array.from({ length: 9 }, (_, i) => ({ url: `https://peer${i}.example/` }))])
    assert.throws(() => validatePeerBootstrap({ version: 2, endpoints }), { code: 'invalid_bootstrap' });
  assert.throws(() => validatePeerBootstrap({ version: 1, endpoints: [] }), { code: 'invalid_bootstrap' });
  for (const url of ['http://localhost/introduce', 'http://127.0.0.1/introduce', 'http://[::1]/introduce'])
    assert.equal(validatePeerBootstrap({ version: 2, endpoints: [{ url }] }).endpoints[0].url, url);
});

test('the host package exports introductions without a second application framing protocol', () => {
  for (const name of ['createPeerConnection','connectPeer','encodePeerFrame','decodePeerFrame','PEER_LIMITS']) assert.equal(peers[name], undefined);
  assert.equal(typeof peers.createPeerRendezvous, 'function');
});

test('the host control client refuses raw application data before HTTP and exposes no data/order actions', async () => {
  let requests = 0;
  const client = peers.createPeersClient({ base: 'https://host.test', request: async () => { requests++; } });
  for (const input of [{ facet: 'database', action: 'submit', payload: { program: 'not host data' } }, { record: '00', applicationData: [] }, { record: 'AA' }]) await assert.rejects(client.participant(input), { code: 'authority_record_invalid' });
  assert.equal(requests, 0);
  for (const name of ['submit', 'range', 'coverage', 'selectGeneration', 'administerGeneration']) assert.equal(client[name], undefined);
  assert.equal(typeof client.prepare, 'function'); assert.equal(typeof client.enroll, 'function'); assert.equal(client.grant, undefined);
  for (const name of ['enrollAgent', 'initialize', 'syncControl', 'admissions', 'publish', 'publication']) assert.equal(typeof client[name], 'function');
});
