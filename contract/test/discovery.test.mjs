import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeersClient, validatePeerAdvertisement, PEER_DIRECTORY_LIMITS, validatePeerAdvertisementPresence, validatePeerDirectory } from '../peers.mjs';
const advertisement = () => ({ peerId: 'peer-a', storageId: 'device-a',
  routes: [{ kind: 'rendezvous', channel: 'introductions-a' }] });

test('discovery hints are bounded, copied, immutable, and contain no credential or application data', () => {
  const input = advertisement(), value = validatePeerAdvertisement(input);
  input.routes[0].channel = 'changed';
  assert.equal(value.routes[0].channel, 'introductions-a');
  assert.throws(() => value.routes.push({ kind: 'invitation', peerId: 'another' }), TypeError);
  for (const patch of [{ command: 'sql' }, { writerEligible: true }, { storageId: '' },
    { executionProfiles: ['unknown'] }, { applicationState: { revision: 'ab'.repeat(32) } }, { routes: [{ kind: 'https', url: 'https://x.test/?secret=key' }] },
    { routes: [{ kind: 'https', url: 'http://x.test/' }] }, { routes: [{ kind: 'https', url: 'https://user:pass@x.test/' }] }])
    assert.throws(() => validatePeerAdvertisement({ ...advertisement(), ...patch }), { code: 'invalid_advertisement' });
});

test('directory SDK performs only explicit requests and validates server hints', async () => {
  const calls = [], ad = advertisement();
  const presence = { advertisement: ad };
  const client = createPeersClient({ base: 'https://host.test/api', applicationId: 'ab'.repeat(32), request: async (path, options) => {
    calls.push({ path, options });
    const action = options.body.action;
    return action === 'advertise' ? presence : action === 'withdraw' ? { withdrawn: 'peer-a' } : { applicationId: 'ab'.repeat(32), peers: [presence] };
  } });
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.advertise(ad), presence);
  assert.deepEqual(calls[0].options.body, { action: 'advertise', advertisement: ad });
  assert.deepEqual((await client.discover()).peers, [presence]);
  await client.withdraw('peer-a');
  assert.deepEqual(calls.map(call => [call.path, call.options.body.action]), [
    ['peers/discovery', 'advertise'], ['peers/discovery', 'read'], ['peers/discovery', 'withdraw'],
  ]);
  assert.throws(() => validatePeerAdvertisementPresence({ ...presence, expiresAt: 120000, refreshAfter: 60000 }), { code: 'invalid_advertisement' });
  assert.throws(() => validatePeerDirectory({ applicationId: 'app', peers: [{ ...presence, expiresAt: 1 }] }), { code: 'invalid_advertisement' });
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
