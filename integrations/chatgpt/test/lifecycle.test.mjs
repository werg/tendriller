import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../../../contract/client.mjs';
import { createLifecycleService, signReviewedRelease } from '../lifecycle.mjs';

const appId = 'a'.repeat(64), publisher = 'b'.repeat(64), principal = { id: 'owner', issuer: 'https://accounts.example' };
const descriptor = { payload: { applicationId: appId, historyId: 'release-test', profile: 'peer-generation-v1',
  definitionDigest: 'c'.repeat(64), executionManifestDigest: 'd'.repeat(64) } };
const input = { applicationId: appId, operationId: 'release-1', entry: 'index.html', files: [
  { path: 'index.html', type: 'text/html', bytesBase64: Buffer.from('<h1>Kitchen</h1>').toString('base64') },
] };
function memoryStore() {
  let value = {};
  return { async read() { return structuredClone(value); }, async transaction(mutator) {
    const next = structuredClone(value), result = mutator(next); value = next; return structuredClone(result);
  } };
}
function fixture(options = {}) {
  const store = memoryStore(), calls = [], publications = new Map();
  const authority = { descriptor: descriptor.payload, control: { payload: { revision: 0 } } };
  const info = { application: { id: appId }, owner_account_id: 'owner' };
  let selected = null, loseResponse = false;
  const host = { info: async () => info, peers: {
    application: async () => ({ descriptor, controls: [{ payload: { grants: [{ publicKey: publisher, publisher: true }] } }] }),
    publication: async id => id ? publications.get(id) ?? null : selected,
    publish: async (signed, assets) => {
      calls.push({ signed, assets });
      selected = { publication: signed, version: signed.payload.revision + 1 }; publications.set(signed.id, selected);
      if (loseResponse) { loseResponse = false; throw Error('LOST_REPLY'); }
      return selected;
    },
  } };
  const peer = {
    verifyAuthorityBundle: async () => authority,
    verifyPublicationManifest: async signed => { if (signed.signature !== 'valid') throw Error('INVALID_SIGNATURE'); },
    authorizePublication: async (signed, _authority, previous) => {
      if (signed.payload.previous !== (previous?.id ?? null)) throw Error('STALE_PUBLICATION');
    },
  };
  const config = { store, applications: [{ id: appId, handle: { application: { id: appId }, api: 'https://tendriller.example/api/t/page', token: 'private' }, pinnedDescriptor: descriptor }],
    loadCore: async () => ({ createClient: () => host }), loadPeer: async () => peer,
    authorizePublication: async () => true, ...options };
  return { service: createLifecycleService(config), config, store, calls, host, peer, info, authority,
    loseNextResponse: () => { loseResponse = true; },
    signed: review => ({ id: 'e'.repeat(64), signature: 'valid', payload: { ...review.expected, author: publisher,
      operationId: review.operationId, entry: review.signingRequest.entry, files: review.signingRequest.files } }),
  };
}

test('release preparation returns a stable digest-bound unsigned publisher handoff', async () => {
  const f = fixture();
  const review = await f.service.preparePageRelease(principal, input);
  assert.equal(review.unsigned, true);
  assert.equal(review.status, 'awaiting_publisher_signature');
  assert.equal(review.signingRequest.files[0].size, 16);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.service.preparePageRelease(principal, input), review);
  await assert.rejects(f.service.preparePageRelease(principal, { ...input, files: [{ ...input.files[0], bytesBase64: Buffer.from('changed').toString('base64') }] }), { code: 'LIFECYCLE_REVIEW_CONFLICT' });
  const reopened = createLifecycleService(f.config);
  assert.deepEqual(await reopened.preparePageRelease(principal, input), review);
});

test('release rejects unsafe graphs, unclaimed pages and foreign application bindings', async () => {
  const f = fixture();
  for (const badPath of ['../signer', '.tendriller/key', '/absolute', '_tendril/x', 'node_modules/x', 'a\\b']) {
    await assert.rejects(f.service.preparePageRelease(principal, { ...input, files: [{ ...input.files[0], path: badPath }] }), { code: 'LIFECYCLE_PATH_INVALID' });
  }
  await assert.rejects(f.service.preparePageRelease(principal, { ...input, files: [{ ...input.files[0], bytesBase64: 'YQ' }] }), { code: 'LIFECYCLE_ASSET_INVALID' });
  f.info.owner_account_id = null;
  await assert.rejects(f.service.preparePageRelease(principal, input), { code: 'LIFECYCLE_OWNER_CLAIM_REQUIRED' });
  f.info.owner_account_id = 'owner'; f.info.application.id = '0'.repeat(64);
  await assert.rejects(f.service.preparePageRelease(principal, input), { code: 'LIFECYCLE_APPLICATION_SCOPE_MISMATCH' });
});

test('publishing needs trusted approval and exact reviewed signed graph, never model approval', async () => {
  const f = fixture({ authorizePublication: undefined });
  const review = await f.service.preparePageRelease(principal, input), signedPublication = f.signed(review);
  const publish = { reviewId: review.reviewId, reviewDigest: review.reviewDigest, signedPublication };
  await assert.rejects(f.service.publishPageRelease(principal, { ...publish, approved: true }), { code: 'LIFECYCLE_INPUT_INVALID' });
  await assert.rejects(f.service.publishPageRelease(principal, publish), { code: 'LIFECYCLE_PUBLICATION_APPROVAL_REQUIRED' });
  const enabled = createLifecycleService({ ...f.config, authorizePublication: async () => false });
  await assert.rejects(enabled.publishPageRelease(principal, publish), { code: 'LIFECYCLE_PUBLICATION_APPROVAL_REQUIRED' });
  assert.equal(f.calls.length, 0);
  const allowed = createLifecycleService({ ...f.config, authorizePublication: async (_account, approval) => approval.reviewDigest === review.reviewDigest });
  await assert.rejects(allowed.publishPageRelease({ id: 'other' }, publish), { code: 'LIFECYCLE_REVIEW_UNAVAILABLE' });
  await assert.rejects(allowed.publishPageRelease(principal, { ...publish, signedPublication: { ...signedPublication, payload: { ...signedPublication.payload, operationId: 'different' } } }), { code: 'LIFECYCLE_REVIEW_MISMATCH' });
  const receipt = await allowed.publishPageRelease(principal, publish);
  assert.equal(receipt.publication.id, signedPublication.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].assets[0].bytes, input.files[0].bytesBase64);
  assert.deepEqual(await allowed.publishPageRelease(principal, publish), receipt);
  assert.equal(f.calls.length, 1);
});

test('lost publication replies preserve exact signed retry bytes', async () => {
  const f = fixture(), review = await f.service.preparePageRelease(principal, input);
  const publish = { reviewId: review.reviewId, reviewDigest: review.reviewDigest, signedPublication: f.signed(review) };
  f.loseNextResponse();
  await assert.rejects(f.service.publishPageRelease(principal, publish), { code: 'LIFECYCLE_PUBLICATION_UNCERTAIN' });
  const receipt = await f.service.publishPageRelease(principal, publish);
  assert.equal(receipt.publication.id, publish.signedPublication.id);
  assert.deepEqual(f.calls[0], f.calls[1]);
});

test('concrete public SDK creation retains private handle and never claims or blindly recreates', async () => {
  const calls = [], store = memoryStore();
  const service = createLifecycleService({ store, loadCore: async () => core,
    creation: { origin: 'https://tendriller.example', ownerEmailForPrincipal: async account => {
      assert.equal(account.id, principal.id); return 'owner@example.com';
    }, fetch: async (url, options) => {
      calls.push({ url, options });
      if (String(url).endsWith('/api/service')) return Response.json({ contract: 3, core_release: '0.3.0-rc.10', limits: {} });
      return Response.json({ id: 'newpage', application: { id: appId }, page_url: 'https://newpage.pages.example/',
        api: 'https://tendriller.example/api/t/newpage', token: 'private-created-token' });
    } } });
  const result = await service.createTendril(principal, { requestId: 'create-once', name: 'Kitchen' });
  assert.equal(result.claimUrl, 'https://newpage.pages.example/');
  assert.equal(result.status, 'owner_claim_required');
  assert.equal(JSON.stringify(result).includes('private-created-token'), false);
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'Kitchen', owner: 'owner@example.com', lifetime: 'ad_hoc' });
  assert.equal(new Headers(calls[1].options.headers).has('Authorization'), false);
  assert.deepEqual(await service.createTendril(principal, { requestId: 'create-once', name: 'Kitchen' }), result);
  assert.equal(calls.length, 2);
  assert.equal(Object.values((await store.read()).chatgptLifecycle.creations)[0].handle.token, 'private-created-token');
  let sends = 0;
  const uncertain = createLifecycleService({ store: memoryStore(), loadCore: async () => ({
    describeService: async () => ({}), requireService() {}, createPage: async () => { sends++; throw Error('LOST_REPLY'); },
  }), creation: { origin: 'https://tendriller.example', ownerEmailForPrincipal: async () => 'owner@example.com' } });
  for (let i = 0; i < 2; i++) await assert.rejects(uncertain.createTendril(principal, { requestId: 'uncertain', name: 'Kitchen' }), { code: 'LIFECYCLE_CREATION_UNCERTAIN' });
  assert.equal(sends, 1);
});
