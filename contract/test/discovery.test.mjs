import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeersClient, validatePeerAdvertisement, PEER_DIRECTORY_LIMITS, createParticipantResponse } from '../peers.mjs';
const advertisement = () => ({ peerId: 'peer-a', storageId: 'device-a',
  routes: [{ kind: 'rendezvous', channel: 'introductions-a' }] });

test('discovery hints are bounded, copied, immutable, and contain no credential or application data', () => {
  const input = advertisement(), value = validatePeerAdvertisement(input);
  input.routes[0].channel = 'changed';
  assert.equal(value.routes[0].channel, 'introductions-a');
  assert.throws(() => value.routes.push({ kind: 'invitation', peerId: 'another' }), TypeError);
  for (const patch of [{ command: 'sql' }, { coordinatorEligible: true }, { storageId: '' },
    { profiles: ['peer-generation-v1'] }, { recovery: { generation: 'g1', sequence: 1, root: 'ab'.repeat(32) } }, { routes: [{ kind: 'https', url: 'https://x.test/?secret=key' }] },
    { routes: [{ kind: 'https', url: 'http://x.test/' }] }, { routes: [{ kind: 'https', url: 'https://user:pass@x.test/' }] }])
    assert.throws(() => validatePeerAdvertisement({ ...advertisement(), ...patch }), { code: 'invalid_advertisement' });
});

test('directory SDK performs only explicit requests and validates server hints', async () => {
  const calls = [], ad = advertisement();
  const lease = { advertisement: ad, expiresAt: 120000, refreshAfter: 60000 };
  const client = createPeersClient({ base: 'https://host.test/api', applicationId: 'ab'.repeat(32), request: async (path, options) => {
    calls.push({ path, options });
    const action = options.body.action;
    return createParticipantResponse(options.body, action === 'advertise' ? lease : action === 'withdraw' ? { withdrawn: 'peer-a' } : { applicationId: 'ab'.repeat(32), peers: [lease] });
  } });
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.advertise(ad), lease);
  assert.deepEqual(calls[0].options.body.payload, { advertisement: ad, ttlMs: PEER_DIRECTORY_LIMITS.defaultTtlMs });
  assert.deepEqual((await client.discover()).peers, [lease]);
  await client.withdraw('peer-a');
  assert.deepEqual(calls.map(call => [call.path, call.options.body.facet, call.options.body.action]), [
    ['peers/participant', 'discovery', 'advertise'], ['peers/participant', 'discovery', 'read'], ['peers/participant', 'discovery', 'withdraw'],
  ]);
  await assert.rejects(client.advertise(ad, { ttlMs: 1 }), { code: 'invalid_advertisement' });
  assert.equal(calls.length, 3);
});

test('rejects routes exceeding the URL bound after normalization before advertising', async () => {
  const input = { ...advertisement(), routes: [{ kind: 'https', url: 'https://peer.test/' + 'é'.repeat(1000) }] };
  assert.ok(input.routes[0].url.length < 2048);
  assert.ok(new URL(input.routes[0].url).href.length > 2048);
  assert.ok(new TextEncoder().encode(JSON.stringify({ advertisement: input })).byteLength < PEER_DIRECTORY_LIMITS.advertisementBytes);
  assert.throws(() => validatePeerAdvertisement(input), { code: 'invalid_advertisement' });
  let requests = 0;
  const client = createPeersClient({ base: 'https://host.test/api', applicationId: 'ab'.repeat(32), request: async () => { requests++; } });
  await assert.rejects(client.advertise(input), { code: 'invalid_advertisement' });
  assert.equal(requests, 0);
});
