import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as p from '@chronolog/peer-session';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function module(name) {
  const result = await build({ entryPoints: [root + 'docs/tutorial/' + name], bundle: true, write: false,
    platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'test-private-boundary', setup(builder) {
      builder.onResolve({ filter: /^\.\/local\.mjs$/ }, () => ({ path: 'private', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
        'export const readPrivate=()=>{throw Error("Supply retained test state")};export const savePrivate=readPrivate;' }));
      builder.onResolve({ filter: /^@tendriller\/core\/pairing$/ }, () => ({ path: root + 'contract/pairing.mjs' }));
    } }] });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const native = await module('pairing-native.mjs'), browser = await module('pairing-browser.mjs');

async function fixture() {
  const signer = await p.createPeerIdentity(), device = await p.createPeerIdentity(), target = await p.createPeerIdentity();
  const applicationId = '11'.repeat(32), descriptor = await p.signApplicationDescriptor({ applicationId,
    profile: 'peer-generation-v1', policy: 'eligible-members-v1', historyId: 'pairing-helper-history',
    controlPublicKey: signer.publicKey, schemaAdministrator: device.publicKey, schemaDigest: null,
    executionManifestDigest: '12'.repeat(32), definitionDigest: '13'.repeat(32) }, signer);
  const control = await p.signControlRevision({ applicationId, profile: 'peer-generation-v1', policy: 'eligible-members-v1',
    revision: 0, previous: null, epoch: 0, keyDigest: '14'.repeat(32), recoveryFloor: null,
    grants: [p.participantGrant(device.publicKey, { administrator: true }), p.controlParticipantGrant(signer.publicKey)] }, signer);
  const registry = await p.createGenerationRegistry({ descriptor, controls: [control], signer, store: new p.MemoryBytesStore() });
  const first = await registry.select(await p.signTransitionRequest({ applicationId, profile: 'peer-generation-v1', policy: 'eligible-members-v1',
    transitionId: 'first', expectedGeneration: null, requester: device.publicKey, coordinator: device.publicKey,
    controlRevision: 0, reason: 'create', base: null }, device));
  const base = { point: { generation: first.id, sequence: 0, root: await p.generationStartRoot(first) }, receipt: null, bridge: [] };
  const id = '21'.repeat(32), challenge = { version: 1, domain: 'tendriller-device-pairing-v1', pairingId: id,
    requestId: 'browser-retained', serviceOrigin: 'https://service.example', pageOrigin: 'https://aaaaaaaaaaaa.pages.example',
    applicationId, accountId: 'owner', publicKey: target.publicKey, rights: { reader: true, writer: true },
    expectedGeneration: first.id, controlRevision: 0, nonce: '22'.repeat(32), expiresAt: Date.now() + 600000 };
  let status = { pairingId: id, requestId: challenge.requestId, state: 'pending', challenge, expiresAt: challenge.expiresAt,
    reviewUrl: `${challenge.serviceOrigin}/pairings/aaaaaaaaaaaa/${id}`, nextAction: 'Review this exact proposal' };
  const records = new Map(), actions = []; let pause = null, closed = false, loseCommitReply = false, drift = false;
  const session = { deviceId: device.publicKey, signal: new AbortController().signal,
    orderingPause: async () => structuredClone(pause),
    async pauseOrdering(operationId) { assert.ok(records.has(`pairing-${id}-intent.json`)); actions.push('pause');
      pause ??= { operationId, generation: first.id, base }; return structuredClone(pause); },
    recoveryPoint: async () => drift ? { ...base, point: { ...base.point, sequence: 1 } } : structuredClone(base),
    async adopt(value) { await p.verifyAuthorityBundle(value, descriptor); actions.push('adopt'); },
    async resumeOrdering(operationId) { assert.equal(operationId, pause.operationId); actions.push('resume'); pause = null; },
  };
  const pairing = { applicationId, serviceOrigin: challenge.serviceOrigin, pageOrigin: challenge.pageOrigin, descriptor,
    signTransition: value => p.signTransitionRequest(value, device), authority: () => registry.read(),
    client: {
      pending: async () => ({ pairings: [structuredClone(status)] }),
      inspect: async pairingId => { assert.equal(pairingId, id); return structuredClone(status); },
      async prepare(pairingId, prepared) { assert.equal(pairingId, id); assert.ok(pause); actions.push('prepare');
        assert.deepEqual(records.get(`pairing-${id}-prepared.json`), prepared, 'the complete signed attempt is durable before the first proposal send');
        status = { ...status, prepared: structuredClone(prepared), preparedDigest: await p.peerDigest(prepared) }; return structuredClone(status); },
      async commit(pairingId, prepared) {
        assert.equal(pairingId, id); assert.ok(pause); assert.equal(status.state, 'approved');
        assert.ok(records.has(`pairing-${id}-commit.json`)); actions.push('commit');
        assert.equal(await p.peerDigest(prepared), status.preparedDigest);
        const verified = await p.verifyAuthorityBundle(await registry.read()), before = verified.control.payload;
        const signed = await p.signControlRevision({ applicationId, profile: 'peer-generation-v1', policy: 'eligible-members-v1',
          revision: before.revision + 1, previous: await p.peerDigest(verified.control), epoch: prepared.control.epoch,
          keyDigest: prepared.control.keyDigest, grants: prepared.control.grants, recoveryFloor: prepared.control.recoveryFloor }, signer);
        const generation = await registry.select(prepared.request, { control: signed });
        status = { ...status, state: 'committed', generation };
        if (loseCommitReply) throw Object.assign(Error('Response lost'), { code: 'NETWORK_UNCERTAIN' });
        return structuredClone(status);
      },
    },
  };
  const retain = async (name, value) => { const before = records.get(name); if (before) assert.deepEqual(before, value);
    actions.push('save:' + name.split('-').at(-1)); records.set(name, structuredClone(value)); return value; };
  const restore = async name => structuredClone(records.get(name) ?? null);
  const tick = () => native.advancePairing({ session, pairing, retain, restore });
  return { session, pairing, records, actions, tick, registry, target,
    get pause() { return pause; }, get status() { return status; }, set status(value) { status = value; },
    approve() { status = { ...status, state: 'approved' }; }, loseReply() { loseCommitReply = true; },
    drift() { drift = true; }, close() { closed = true; }, get closed() { return closed; } };
}

test('native preparation pauses ordering and retains the exact proposal before networking; owner approval is still required', async () => {
  const f = await fixture(); await f.tick();
  assert.deepEqual(f.actions.slice(0, 4), ['save:intent.json', 'pause', 'save:prepared.json', 'prepare']);
  assert.equal(f.actions.includes('commit'), false); assert.ok(f.pause); assert.equal(f.status.state, 'pending');
  const prepared = structuredClone(f.status.prepared);
  await f.tick(); assert.deepEqual(f.status.prepared, prepared);
  assert.equal(f.actions.filter(action => action === 'prepare').length, 1);
  assert.equal(f.actions.includes('resume'), false, 'waiting for review does not release its exact history fence');
});

test('a lost commit reply preserves the durable pause, then a fresh runner resolves the exact receipt without a second selection', async () => {
  const f = await fixture(); await f.tick(); f.approve(); f.loseReply();
  await assert.rejects(f.tick(), { code: 'NETWORK_UNCERTAIN' });
  assert.ok(f.pause); const prepared = structuredClone(f.status.prepared);
  // A different invocation has no in-memory request state. The pause/journal
  // and verified host receipt are the only continuity inputs.
  await f.tick();
  assert.equal(f.pause, null); assert.equal(f.actions.filter(action => action === 'commit').length, 1);
  assert.equal(f.actions.filter(action => action === 'resume').length, 1);
  assert.deepEqual(f.status.prepared, prepared);
  assert.equal((await f.registry.read()).generations.length, 2);
  assert.equal((await p.verifyAuthorityBundle(await f.registry.read())).grant(f.target.publicKey).administrator, false);
});

test('a transition receipt with unresolved reviewed account/control identity never releases ordering', async () => {
  const f = await fixture(); await f.tick(); f.approve(); f.loseReply();
  await assert.rejects(f.tick(), { code: 'NETWORK_UNCERTAIN' });
  f.status = { ...f.status, state: 'reconciliation_required' };
  await assert.rejects(f.tick(), { code: 'PAIRING_OUTCOME_UNCERTAIN' });
  assert.ok(f.pause); assert.equal(f.actions.includes('resume'), false);
});

test('changed prefixes and substituted origins fail closed without signing a replacement or releasing the pause', async () => {
  const f = await fixture(); await f.tick(); f.approve(); f.drift();
  await assert.rejects(f.tick(), { code: 'PAIRING_PREFIX_CHANGED' });
  assert.ok(f.pause); assert.equal(f.actions.includes('commit'), false); assert.equal(f.actions.includes('resume'), false);
  const other = await fixture(); other.status = { ...other.status, challenge: { ...other.status.challenge, serviceOrigin: 'https://other.example' } };
  await assert.rejects(other.tick(), { code: 'PAIRING_CONTEXT_MISMATCH' }); assert.equal(other.records.size, 0); assert.equal(other.pause, null);
});

test('fresh terminal denial releases only its original pause; unavailable or revoked outcomes keep it', async () => {
  const f = await fixture(); await f.tick(); f.status = { ...f.status, state: 'denied' }; await f.tick(); assert.equal(f.pause, null);
  const uncertain = await fixture(); await uncertain.tick(); uncertain.status = { ...uncertain.status, state: 'revoked' };
  await assert.rejects(uncertain.tick(), { code: 'PAIRING_ACCOUNT_REVOKED' }); assert.ok(uncertain.pause);
  uncertain.pairing.client.inspect = async () => { throw Error('offline'); };
  await assert.rejects(uncertain.tick(), /offline/); assert.ok(uncertain.pause);
});

test('revocation releases no pause until the server confirms expiry and fresh signed authority proves no original commit', async t => {
  const f = await fixture(); await f.tick(); f.approve();
  f.status = { ...f.status, state: 'revoked' };
  t.mock.timers.enable({ apis: ['Date'], now: f.status.expiresAt + 1 });
  await assert.rejects(f.tick(), { code: 'PAIRING_ACCOUNT_REVOKED' });
  assert.ok(f.pause, 'a local timer cannot resolve an uncertain or revoked host outcome');
  f.status = { ...f.status, state: 'expired' };
  const readAuthority = f.pairing.authority;
  f.pairing.authority = async () => { throw Error('authority unavailable'); };
  await assert.rejects(f.tick(), /authority unavailable/); assert.ok(f.pause);
  f.pairing.authority = readAuthority;
  await f.tick();
  assert.equal(f.pause, null); assert.equal(f.actions.filter(action => action === 'resume').length, 1);
  assert.equal(f.actions.includes('commit'), false); assert.equal((await f.registry.read()).generations.length, 1);
  assert.ok(f.records.has(`pairing-${f.status.pairingId}-prepared.json`), 'terminal recovery retains the original proposal');
});

test('an unretained native intent cannot pause ordering or reach proposal/commit', async () => {
  const f = await fixture();
  await assert.rejects(native.advancePairing({ session: f.session, pairing: f.pairing,
    retain: async () => {}, restore: async () => null }), { code: 'PAIRING_STORAGE_REQUIRED' });
  assert.equal(f.pause, null); assert.equal(f.actions.includes('prepare'), false); assert.equal(f.actions.includes('commit'), false);
});

test('the retained-owner processor serializes overlapping signed passes', async () => {
  const f = await fixture(), gate = Promise.withResolvers();
  f.pairing.client.pending = async () => { await gate.promise; return { pairings: [] }; };
  const process = native.createReviewedPairingProcessor({ session: f.session, pairing: f.pairing,
    store: { load: async name => f.records.get(name), save: async (name, value) => f.records.set(name, value) } });
  const first = process(), second = process(); assert.equal(first, second);
  gate.resolve(); assert.deepEqual(await first, []);

});

function browserFixture({ brokenStorage = false, wrongOrigin = false, failWorker = false } = {}) {
  const records = new Map(), messages = []; let workers = 0, gets = 0, state = 'pending';
  const expiresAt = Date.now() + 600000;
  const configuration = { applicationId: '31'.repeat(32), serviceOrigin: 'https://service.example', pageId: 'aaaaaaaaaaaa',
    page_url: 'https://aaaaaaaaaaaa.pages.example/s/test/' };
  const storage = { getItem: key => records.get(key) ?? null, setItem(key, value) { if (brokenStorage) throw Error('blocked'); records.set(key, value); } };
  const result = requestId => {
    const pairingId = '32'.repeat(32), c = { version: 1, domain: 'tendriller-device-pairing-v1', pairingId, requestId,
      serviceOrigin: wrongOrigin ? 'https://wrong.example' : configuration.serviceOrigin, pageOrigin: new URL(configuration.page_url).origin,
      applicationId: configuration.applicationId, accountId: 'owner', publicKey: '33'.repeat(32), rights: { reader: true, writer: true },
      expectedGeneration: '34'.repeat(32), controlRevision: 0, nonce: '35'.repeat(32), expiresAt };
    return { pairingId, requestId, state, challenge: c, expiresAt: c.expiresAt,
      reviewUrl: configuration.serviceOrigin + `/pairings/${configuration.pageId}/${pairingId}`, nextAction: 'Review' };
  };
  const make = () => browser.createBrowserPairing({ configuration, profileId: 'browser-profile', storage,
    locks: { request: (_name, _options, work) => work() },
    workerUrl: 'https://aaaaaaaaaaaa.pages.example/pairing-worker.mjs',
    createWorker() {
      workers++; assert.equal(records.size, 1, 'the public request is durable before constructing the Worker');
      const worker = new EventTarget(); worker.terminate = () => {};
      worker.postMessage = data => { messages.push(data); queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', {
        data: { protocol: data.protocol, id: data.id, ...(failWorker ? { error: { code: 'OFFLINE', message: 'Resume original' } } : { status: result(data.requestId) }) } }))); };
      return worker;
    }, fetch: async () => { gets++; const retained = JSON.parse([...records.values()][0]); return Response.json(result(retained.requestId)); },
  });
  return { make, records, messages, get workers() { return workers; }, get gets() { return gets; }, set state(value) { state = value; } };
}

test('browser request survives reload with the same public reference and never exports a private key', async () => {
  const f = browserFixture(), first = await f.make().request(), retained = JSON.parse([...f.records.values()][0]);
  assert.equal(retained.requestId, first.requestId); assert.equal(retained.publicKey, first.challenge.publicKey);
  const second = await f.make().request(); assert.equal(second.requestId, first.requestId);
  assert.equal(f.messages[1].publicKey, retained.publicKey); assert.equal(f.gets, 0, 'no autonomous status polling');
  assert.equal([...f.records.values()][0].includes('privateKey'), false);
  await f.make().refresh(); assert.equal(f.gets, 1);
});

test('browser storage failure causes no Worker or host request, and origin substitution cannot rewrite retained identity', async () => {
  const blocked = browserFixture({ brokenStorage: true }); await assert.rejects(blocked.make().request(), { code: 'PAIRING_STORAGE_REQUIRED' });
  assert.equal(blocked.workers, 0); assert.equal(blocked.gets, 0);
  const substituted = browserFixture({ wrongOrigin: true }); await assert.rejects(substituted.make().request(), { code: 'PAIRING_SCOPE_MISMATCH' });
  assert.equal(JSON.parse([...substituted.records.values()][0]).pairingId, undefined);
});

test('browser lost reply retains its original request, and replacement review is explicit and terminal-only', async () => {
  const lost = browserFixture({ failWorker: true }); await assert.rejects(lost.make().request(), { code: 'OFFLINE' });
  const before = JSON.parse([...lost.records.values()][0]).requestId;
  await assert.rejects(lost.make().request(), { code: 'OFFLINE' }); assert.equal(lost.messages[1].requestId, before);
  const f = browserFixture(); const first = await f.make().request();
  await assert.rejects(f.make().request({ newReview: true }), { code: 'PAIRING_STILL_PENDING' }); assert.equal(f.workers, 1);
  f.state = 'expired'; const second = await f.make().request({ newReview: true });
  assert.notEqual(second.requestId, first.requestId); assert.equal(f.messages[1].publicKey, first.challenge.publicKey);
  assert.equal(JSON.parse([...f.records.values()][0]).history[0].pairingId, first.pairingId);
  await assert.rejects(f.make().prepare('aa'.repeat(32)), { code: 'PAIRING_KEY_CHANGED' });
});
