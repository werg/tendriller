import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVICE_PAIRING_DOMAIN, pairingProofBytes, signDevicePairingChallenge, verifyDevicePairingProof,
  createDevicePairingClient } from '../pairing.mjs';
async function createPeerIdentity() {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  return { publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'), privateKey: keys.privateKey };
}
const challengeFor = publicKey => ({ version: 1, domain: DEVICE_PAIRING_DOMAIN, pairingId: 'ab'.repeat(32), requestId: 'retained-request',
  serviceOrigin: 'https://example.com', pageOrigin: 'https://page.example.net', applicationId: 'cd'.repeat(32), accountId: 'account-one',
  publicKey, rights: { reader: true, writer: true }, expectedGeneration: 'ef'.repeat(32), controlRevision: 1, nonce: '01'.repeat(32), expiresAt: 1800000000000 });

test('device proof binds every challenge field and the exact retained identity', async () => {
  const identity = await createPeerIdentity(), other = await createPeerIdentity(), challenge = challengeFor(identity.publicKey);
  const signature = await signDevicePairingChallenge(challenge, identity);
  assert.equal(await verifyDevicePairingProof(challenge, signature), true);
  assert.equal(await verifyDevicePairingProof({ ...challenge, publicKey: other.publicKey }, signature), false);
  for (const [key, value] of Object.entries({ pairingId: '12'.repeat(32), requestId: 'different', serviceOrigin: 'https://elsewhere.example',
    pageOrigin: 'https://elsewhere.example.net', applicationId: '23'.repeat(32), accountId: 'account-two',
    rights: { reader: true, writer: false }, expectedGeneration: '34'.repeat(32), controlRevision: 2, nonce: '45'.repeat(32), expiresAt: challenge.expiresAt + 1 }))
    assert.equal(await verifyDevicePairingProof({ ...challenge, [key]: value }, signature), false, key);
  await assert.rejects(signDevicePairingChallenge(challenge, other), /retained device/);
  assert.equal(await verifyDevicePairingProof(challenge, '00'), false);
});

test('proof canonicalization ignores object insertion order and refuses extra rights or fields', () => {
  const challenge = challengeFor('aa'.repeat(32));
  assert.deepEqual(pairingProofBytes(challenge), pairingProofBytes(Object.fromEntries(Object.entries(challenge).reverse())));
  for (const invalid of [{ ...challenge, rights: { ...challenge.rights, administrator: true } }, { ...challenge, owner: true },
    { ...challenge, serviceOrigin: 'https://example.com/path' }, { ...challenge, version: 2 }, { ...challenge, domain: 'different' }])
    assert.throws(() => pairingProofBytes(invalid), /Invalid bounded/);
  for (const key of ['pairingId', 'applicationId', 'publicKey', 'expectedGeneration', 'nonce'])
    assert.throws(() => pairingProofBytes({ ...challenge, [key]: [challenge[key]] }), /Invalid bounded/, key);
});

test('pairing client pins request identity, does not redirect credentials, and retains caller-signed attempts', async () => {
  const challenge = challengeFor('aa'.repeat(32)), calls = [];
  const client = createDevicePairingClient({ url: challenge.pageOrigin + '/_tendril/peers/pairing', headers: { 'X-Test': 'one' },
    fetch: async (url, init) => { calls.push({ url, init }); return Response.json({ pairingId: challenge.pairingId, challenge }); } });
  assert.deepEqual((await client.challenge({ requestId: challenge.requestId, publicKey: challenge.publicKey, rights: challenge.rights })).challenge, challenge);
  assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.cache, 'no-store');
  await client.inspect(challenge.pairingId);
  assert.equal(new URL(calls[1].url).searchParams.get('pairingId'), challenge.pairingId);
  assert.equal(calls[1].init.method, 'GET');
  const prepared = { request: { payload: { transitionId: 'retained' }, signature: 'signed' }, control: { epoch: 0 } };
  await client.prepare(challenge.pairingId, prepared);
  assert.deepEqual(JSON.parse(calls[2].init.body), { action: 'prepare', pairingId: challenge.pairingId, ...prepared });
  await client.commit(challenge.pairingId, prepared);
  assert.deepEqual(JSON.parse(calls[3].init.body), { action: 'commit', pairingId: challenge.pairingId, ...prepared });
  await assert.rejects(client.challenge({ requestId: 'substituted', publicKey: challenge.publicKey, rights: challenge.rights }), /does not match/);
  assert.throws(() => createDevicePairingClient({ url: 'https://secret@example.com/pairing' }), /exact pairing endpoint/);
});

test('an unreadable or refused response exposes a typed uncertain outcome without retrying', async () => {
  let calls = 0;
  const client = createDevicePairingClient({ url: 'https://example.com/pairing', fetch: async () => { calls++; return new Response('truncated'); } });
  await assert.rejects(client.inspect('aa'.repeat(32)), { code: 'pairing_response_unavailable' });
  assert.equal(calls, 1);
  const denied = createDevicePairingClient({ url: 'https://example.com/pairing', fetch: async () => Response.json({ error: { code: 'pairing_expired', message: 'Expired' } }, { status: 409 }) });
  await assert.rejects(denied.inspect('aa'.repeat(32)), { code: 'pairing_expired', status: 409 });
});
