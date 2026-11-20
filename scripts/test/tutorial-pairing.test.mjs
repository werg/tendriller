import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as p from '@chronolog/peer-session';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function modules(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tutorial-pairing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['pairing-native.mjs', 'pairing-browser.mjs'])
    await copyFile(join(root, 'docs/tutorial', name), join(directory, name));
  for (const [scope, name, source] of [['@tendriller', 'core', 'dist/sdk'], ['@chronolog', 'peer-session', 'node_modules/@chronolog/peer-session']]) {
    await mkdir(join(directory, 'node_modules', scope), { recursive: true });
    await symlink(resolve(root, source), join(directory, 'node_modules', scope, name));
  }
  return { native: await import(pathToFileURL(join(directory, 'pairing-native.mjs')).href),
    browser: await import(pathToFileURL(join(directory, 'pairing-browser.mjs')).href) };
}
async function fixture(t) {
  const { native } = await modules(t), identity = await p.createPeerIdentity(), device = await p.createPeerIdentity(), signer = await p.createPeerIdentity();
  const applicationId = 'ab'.repeat(32);
  const descriptor = await p.signApplicationDescriptor({ applicationId, historyId: 'pairing-starter',
    profile: 'peer-generation-v1', policy: 'eligible-members-v1', controlPublicKey: signer.publicKey,
    schemaAdministrator: identity.publicKey, definitionDigest: 'cd'.repeat(32), executionManifestDigest: 'ef'.repeat(32), schemaDigest: null }, signer);
  const control = await p.signControlRevision({ applicationId, profile: descriptor.payload.profile, policy: descriptor.payload.policy,
    revision: 0, previous: null, epoch: 0, keyDigest: '12'.repeat(32), recoveryFloor: null,
    grants: [p.participantGrant(identity.publicKey, { administrator: true, publisher: true })] }, signer);
  const registry = await p.createGenerationRegistry({ store: new p.MemoryBytesStore(), descriptor, controls: [control], signer });
  const generation = await registry.select(await p.signTransitionRequest({ applicationId, profile: descriptor.payload.profile,
    policy: descriptor.payload.policy, transitionId: 'initial', expectedGeneration: null, coordinator: identity.publicKey,
    requester: identity.publicKey, controlRevision: 0, reason: 'create', base: null }, identity));
  const challenge = { version: 1, domain: 'tendriller-device-pairing-v1', pairingId: '34'.repeat(32), requestId: 'retained-browser',
    serviceOrigin: 'https://service.example.test', pageOrigin: 'https://page.example.test', applicationId, accountId: 'owner',
    publicKey: device.publicKey, rights: { reader: true, writer: true }, expectedGeneration: generation.id,
    controlRevision: 0, nonce: '56'.repeat(32), expiresAt: Date.now() + 60_000 };
  const status = { pairingId: challenge.pairingId, state: 'approved', challenge };
  const records = new Map(), sent = [], counts = { saved: 0, recovery: 0 };
  const options = { handle: { api: challenge.serviceOrigin + '/api/t/page', token: 'private-host-token',
    page_url: challenge.pageOrigin + '/s/code/', application: { id: applicationId } }, identity, descriptor,
    host: { peers: { application: () => registry.read() } }, session: { async recoveryPoint() {
      counts.recovery++; return { point: { generation: generation.id, sequence: 0, root: await p.generationStartRoot(generation) }, receipt: null, bridge: [] };
    } }, store: { load: async name => structuredClone(records.get(name)), save: async (name, value) => {
      counts.saved++; assert(!records.has(name)); records.set(name, structuredClone(value));
    } }, client: { pending: async () => ({ pairings: [status] }), commit: async (id, prepared) => {
      assert.deepEqual(prepared, records.get(`pairing-${id}.json`), 'Signed intent must be retained before first send');
      sent.push(structuredClone(prepared)); return { pairingId: id, state: 'committed' };
    } } };
  return { native, options, status, records, sent, counts };
}

test('reviewed native pairing saves exact signed inputs and adds only the proved account and narrow grant', async t => {
  const f = await fixture(t), process = f.native.createReviewedPairingProcessor(f.options);
  const result = await process(); assert.equal(result[0].state, 'committed');
  const { request, control } = f.sent[0], c = f.status.challenge;
  assert.equal(request.payload.transitionId, 'pair-' + c.pairingId);
  assert.equal(request.payload.expectedGeneration, c.expectedGeneration);
  assert.deepEqual(control.grants.at(-1), { publicKey: c.publicKey, reader: true, writer: true,
    administrator: false, publisher: false, coordinator: false, recovery: false, dataRole: 'member' });
  assert.deepEqual(control.accounts, [{ publicKey: c.publicKey, accountId: 'owner' }]);
  assert.equal(f.counts.saved, 1);
});

test('lost pairing reply and native restart resend the retained signed attempt without selecting a new prefix', async t => {
  const f = await fixture(t), commit = f.options.client.commit;
  f.options.client.commit = async (...args) => { await commit(...args); throw Error('Lost response after acceptance'); };
  await assert.rejects(f.native.createReviewedPairingProcessor(f.options)(), /Lost response/);
  const original = structuredClone(f.sent[0]); f.status.state = 'committing';
  f.options.client.commit = commit;
  f.options.session.recoveryPoint = () => { throw Error('Must reuse the original prefix'); };
  const reopened = f.native.createReviewedPairingProcessor(f.options);
  await reopened(); assert.deepEqual(f.sent[1], original); assert.equal(f.counts.saved, 1);
  f.status.state = 'revoked';
  assert.equal((await reopened())[0].state, 'revoked'); assert.equal(f.sent.length, 2, 'No revoked enrollment is replayed');
});

test('unretained, uncertain and stale pairing inputs cannot reach a signed commit', async t => {
  const f = await fixture(t);
  f.options.store.save = async () => {};
  await assert.rejects(f.native.createReviewedPairingProcessor(f.options)(), /not durably retained/);
  assert.equal(f.sent.length, 0);
  f.status.state = 'committing';
  await assert.rejects(f.native.createReviewedPairingProcessor(f.options)(), /local intent is missing/);
  f.status.state = 'approved'; f.status.challenge.expectedGeneration = '78'.repeat(32);
  assert.deepEqual(await f.native.createReviewedPairingProcessor(f.options)(), []);
  assert.equal(f.sent.length, 0);
});

test('one native owner serializes overlapping pairing passes and drains polling before shutdown', async t => {
  const f = await fixture(t), gate = Promise.withResolvers();
  f.options.client.pending = async () => { await gate.promise; return { pairings: [] }; };
  const process = f.native.createReviewedPairingProcessor(f.options);
  const first = process(), second = process(); assert.equal(first, second);
  gate.resolve(); await first;
  let stopped = false;
  const loop = f.native.startReviewedPairingLoop(({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { stopped = true; resolve([]); }, { once: true });
  }), { intervalMs: 1 });
  await loop.close(); assert.equal(stopped, true);
});

test('browser pairing persists before proof, resumes after reload, and refuses key replacement', async t => {
  const { browser } = await modules(t), values = new Map(), requests = [];
  const configuration = { applicationId: 'ab'.repeat(32), page_url: 'https://page.example.test/s/code/', serviceOrigin: 'https://service.example.test' };
  const publicKey = 'cd'.repeat(32), pairingId = 'ef'.repeat(32);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  class PublicProofWorker {
    postMessage(input) {
      assert.equal(JSON.parse([...values.values()][0]).requestId, input.requestId, 'Intent must precede the Worker request');
      assert.deepEqual(Object.keys(input).sort(), ['action', 'publicKey', 'requestId']); requests.push(input);
      const challenge = { version: 1, domain: 'tendriller-device-pairing-v1', pairingId, requestId: input.requestId,
        serviceOrigin: configuration.serviceOrigin, pageOrigin: new URL(configuration.page_url).origin,
        applicationId: configuration.applicationId, accountId: 'owner', publicKey, rights: { reader: true, writer: true },
        expectedGeneration: '12'.repeat(32), controlRevision: 0, nonce: '34'.repeat(32), expiresAt: Date.now() + 60_000 };
      queueMicrotask(() => this.onmessage({ data: { ok: true, status: { pairingId, challenge, state: 'pending',
        reviewUrl: configuration.serviceOrigin + '/pairings/page/' + pairingId } } }));
    }
    terminate() {}
  }
  const options = { configuration, storage, locks: { request: (_name, work) => work() }, WorkerClass: PublicProofWorker };
  await browser.createBrowserPairing(options).prepare(publicKey);
  const reopened = browser.createBrowserPairing(options);
  await reopened.prepare(publicKey);
  assert.deepEqual(requests[0], requests[1]); assert.equal(reopened.retained().pairingId, pairingId);
  await assert.rejects(reopened.prepare('56'.repeat(32)), /original browser device/);
  assert.equal(requests.length, 2);
  storage.setItem = () => { throw Error('Storage full'); }; values.clear();
  await assert.rejects(browser.createBrowserPairing(options).prepare(publicKey), /Storage full/);
  assert.equal(requests.length, 2, 'Storage failure causes no proof or network request');
});
