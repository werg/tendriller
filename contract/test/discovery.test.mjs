import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeersClient, validatePeerAdvertisement, PEER_DIRECTORY_LIMITS } from '../peers.mjs';
const advertisement = () => ({ peerId: 'peer-a', storageId: 'device-a', profiles: ['peer-generation-v1'],
  routes: [{ kind: 'rendezvous', channel: 'introductions-a' }], coordinatorEligible: true,
  recovery: { generation: 'g1', sequence: 18, root: 'ab'.repeat(32), controlRevision: 0, retainedAt: 10 } });

test('discovery hints are bounded, copied, immutable, and contain no credential or application data', () => {
  const input = advertisement(), value = validatePeerAdvertisement(input);
  input.routes[0].channel = 'changed';
  assert.equal(value.routes[0].channel, 'introductions-a');
  assert.throws(() => value.profiles.push('another'), TypeError);
  for (const patch of [{ command: 'sql' }, { coordinatorEligible: 'yes' }, { storageId: '' },
    { profiles: Array.from({ length: 9 }, (_, i) => `profile-${i}`) }, { recovery: { ...input.recovery, sequence: 1.5 } },
    { recovery: { ...input.recovery, root: 'invalid' } }, { routes: [{ kind: 'https', url: 'https://x.test/?secret=key' }] },
    { routes: [{ kind: 'https', url: 'http://x.test/' }] }, { routes: [{ kind: 'https', url: 'https://user:pass@x.test/' }] }])
    assert.throws(() => validatePeerAdvertisement({ ...advertisement(), ...patch }), { code: 'invalid_advertisement' });
});

test('directory SDK performs only explicit requests and validates server hints', async () => {
  const calls = [], ad = advertisement();
  const lease = { advertisement: ad, expiresAt: 120000, refreshAfter: 60000 };
  const client = createPeersClient({ base: 'https://host.test/api', request: async (path, options) => {
    calls.push({ path, options });
    return options?.method === 'PUT' ? lease : options?.method === 'DELETE' ? { withdrawn: 'peer-a' } : { applicationId: 'app', peers: [lease] };
  } });
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.advertise(ad), lease);
  assert.deepEqual(calls[0].options.body, { advertisement: ad, ttlMs: PEER_DIRECTORY_LIMITS.defaultTtlMs });
  assert.deepEqual((await client.discover()).peers, [lease]);
  await client.withdraw('peer-a');
  assert.deepEqual(calls.map(call => [call.path, call.options?.method]), [
    ['peers/directory', 'PUT'], ['peers/directory', undefined], ['peers/directory', 'DELETE'],
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
  const client = createPeersClient({ base: 'https://host.test/api', request: async () => { requests++; } });
  await assert.rejects(client.advertise(input), { code: 'invalid_advertisement' });
  assert.equal(requests, 0);
});
