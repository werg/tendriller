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

test('portable peer admission includes database opening without granting it to the host', () => {
  const request = { facet: 'database', action: 'open' };
  assert.equal(peers.participantAccepts(peers.PEER_PARTICIPANT_POLICY, request), true);
  assert.equal(peers.participantAccepts(peers.CONTROL_PARTICIPANT_POLICY, request), false);
});
