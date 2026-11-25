import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as peer from '@chronolog/peer-session';
import * as authority from '@chronolog/authority';

// Retained browser identity, key and authority bootstrap (docs/tutorial/helpers/browser-bootstrap.mjs).
// This replaces the removed device-pairing/ordering-pause workflow. The helper is bundled with its
// public @tendriller/core imports mapped to this checkout's contract sources; the host is a scripted fetch.
const root = fileURLToPath(new URL('../../', import.meta.url));
const built = await build({ entryPoints: [root + 'docs/tutorial/helpers/browser-bootstrap.mjs'], bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'public-core', setup(builder) {
    builder.onResolve({ filter: /^@tendriller\/core\/peers$/ }, () => ({ path: root + 'contract/peers.mjs' }));
    builder.onResolve({ filter: /^@tendriller\/core\/authority$/ }, () => ({ path: root + 'contract/authority.mjs' }));
  } }] });
const { bootstrapBrowser } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const applicationId = '51'.repeat(32), pageUrl = 'https://aaaaaaaaaaaa.pages.example/s/test/';
const memoryStore = () => { const values = new Map(); return { values, async get(key) { return values.get(key)?.slice() ?? null; }, async put(key, value) { values.set(key, value.slice()); } }; };
const executionManifestDigest = peer.bytesToHex((await peer.executionManifestArtifacts(await peer.eventExecutionManifest())).executionManifestDigest);
const configuration = { applicationId, page_url: pageUrl, executionManifestDigest };
const intentKey = `starter/bootstrap/${applicationId}`;
const record = value => ({ record: Array.from(authority.encodeRecord(value), byte => byte.toString(16).padStart(2, '0')).join('') });
const decode = value => authority.decodeRecord(Uint8Array.from(value.record.match(/../g), byte => parseInt(byte, 16)));

// A scripted host. `existing` is the signed bundle the owner has already initialized, or null.
async function host({ existing = null, executionDigest = executionManifestDigest, loseEnrollReplies = 0, ownerSignedIn = true, store, authoritySigner } = {}) {
  const signer = authoritySigner ?? await authority.createSigningIdentity(), log = [], proofs = [], intentAtRequest = {};
  let lost = loseEnrollReplies, bundle = existing;
  const sign = async (rootPrincipal, members, epoch, epochKeyDigest, previous) => {
    const descriptor = previous?.descriptor ?? await authority.signAppDescriptor({ applicationId, rootPrincipal, authorityPublicKey: signer.publicKey,
      executionManifestDigest: executionDigest, finalityPolicy: { kind: 'none' } }, signer);
    const membership = await authority.signMembership({ applicationId, revision: previous?.memberships.length ?? 0, previous: previous ? await authority.recordDigest(previous.memberships.at(-1)) : null,
      authorTimeAfterMs: previous ? previous.memberships.at(-1).payload.authorTimeAfterMs + 1n : -1n, epoch, epochKeyDigest, members }, signer);
    return { descriptor, memberships: [...(previous?.memberships ?? []), membership] };
  };
  const member = (publicKey, administrator) => ({ publicKey, reader: true, writer: true, administrator, publisher: false, finalizer: false });
  const metadata = () => ({ selection: { id: applicationId }, configuration: null, publicationAuthority: null, authority: bundle ? record(bundle) : null });
  const respond = async (url, init) => {
    const path = new URL(url).pathname.replace(/^.*\/_tendril\//, ''), body = init?.body === undefined ? undefined : JSON.parse(init.body);
    log.push(path + (body?.action ? ':' + body.action : ''));
    if (path === 'application') return Response.json(metadata());
    if (path === 'peers/enrollment' && body.action === 'challenge')
      return Response.json({ applicationId, publicKey: body.publicKey, challenge: 'ab'.repeat(16), expiresAt: Date.now() + 60_000 });
    if (path === 'peers/enrollment' && body.action === 'enroll') {
      // The retained key must be durable before the first proof leaves this browser.
      intentAtRequest.beforeEnroll ??= store.values.has(intentKey);
      const proof = decode(body.proof); proofs.push(proof.payload);
      if (lost-- > 0) throw new TypeError('network reply lost');
      if (ownerSignedIn) bundle = bundle ?? await sign(proof.payload.publicKey, [member(proof.payload.publicKey, true)], proof.payload.epoch, proof.payload.epochKeyDigest);
      else bundle = null;
      if (bundle && !bundle.memberships.at(-1).payload.members.some(item => item.publicKey === proof.payload.publicKey))
        bundle = await sign(null, [...bundle.memberships.at(-1).payload.members, member(proof.payload.publicKey, false)], proof.payload.epoch, proof.payload.epochKeyDigest, bundle);
      return Response.json(metadata());
    }
    return Response.json({ error: { code: 'unexpected', message: 'unexpected ' + path } }, { status: 404 });
  };
  return { respond, log, proofs, intentAtRequest, signer, sign, member, get bundle() { return bundle; } };
}
async function open(t, { device, scripted, origin = new URL(pageUrl).origin, config = configuration }) {
  const originalFetch = globalThis.fetch, originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globalThis.fetch = scripted.respond; Object.defineProperty(globalThis, 'location', { value: { origin }, configurable: true });
  try { return await bootstrapBrowser({ configuration: config, device, signal: new AbortController().signal }); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else delete globalThis.location;
  }
}
const newDevice = async () => { const store = memoryStore(); return { store, device: await peer.openApplicationDevice({ store, create: true }) }; };

test('the first browser retains its data key before enrollment, becomes root, and reopens from storage without the host', async t => {
  const { store, device } = await newDevice(), scripted = await host({ store });
  const first = await open(t, { device, scripted });
  assert.equal(scripted.intentAtRequest.beforeEnroll, true, 'the epoch key is durable before the first signed proof is sent');
  assert.deepEqual(scripted.log, ['application', 'peers/enrollment:challenge', 'peers/enrollment:enroll']);
  assert.equal(first.authority.descriptor.rootPrincipal, device.identity.publicKey);
  const retained = authority.decodeRecord(store.values.get(intentKey));
  assert.equal(retained.publicKey, device.identity.publicKey);
  assert.deepEqual(first.authority.epochKey(0), retained.epochKey, 'the installed key is the retained one, not a regenerated key');
  assert.equal(scripted.proofs[0].epochKeyDigest, await authority.epochKeyCommitment(applicationId, 0, retained.epochKey));
  // The retained identity authors locally with no peer, finalizer or host involved.
  const session = await peer.createApplicationSession({ device, definition: peer.defineApplication({ id: 'bootstrap-fixture', version: '1', commands: {}, queries: {} }), authority: first.authority });
  try { assert.equal(session.status.canAuthor, true); } finally { await session.close(); }
  // Reload: a fresh device handle over the same storage opens cached authority with no host request.
  const reloaded = await peer.openApplicationDevice({ store });
  const requests = await host({ store });
  const again = await open(t, { device: reloaded, scripted: requests });
  assert.deepEqual(requests.log, [], 'retained devices open cached local state before any authority refresh');
  assert.equal(again.authority.descriptor.rootPrincipal, device.identity.publicKey);
  assert.deepEqual(again.authority.epochKey(0), retained.epochKey);
});

test('a lost enrollment reply resumes the original retained key; no replacement key or second proof identity is generated', async t => {
  const { store, device } = await newDevice(), scripted = await host({ store, loseEnrollReplies: 1 });
  await assert.rejects(open(t, { device, scripted }), /network reply lost/);
  const intent = store.values.get(intentKey).slice();
  assert.equal(authority.decodeRecord(intent).publicKey, device.identity.publicKey);
  assert.equal(await device.store.get(`authority/${applicationId}`), null, 'no authority was cached from an unacknowledged enrollment');
  const resumed = await open(t, { device, scripted });
  assert.deepEqual(store.values.get(intentKey), intent, 'the retained bootstrap record is unchanged');
  assert.equal(scripted.proofs.length, 2);
  assert.equal(scripted.proofs[0].epochKeyDigest, scripted.proofs[1].epochKeyDigest);
  assert.equal(scripted.proofs[0].publicKey, scripted.proofs[1].publicKey);
  assert.deepEqual(resumed.authority.epochKey(0), authority.decodeRecord(intent).epochKey);
});

test('an owner who has not signed in yields no cached authority and keeps the retained key for resumption', async t => {
  const { store, device } = await newDevice(), scripted = await host({ store, ownerSignedIn: false });
  await assert.rejects(open(t, { device, scripted }), /owner must sign in/);
  assert.ok(store.values.has(intentKey));
  const firstDigest = scripted.proofs[0].epochKeyDigest;
  const again = await host({ store, ownerSignedIn: false });
  await assert.rejects(open(t, { device, scripted: again }), /owner must sign in/);
  assert.equal(authority.decodeRecord(store.values.get(intentKey)).publicKey, device.identity.publicKey);
  assert.equal(again.proofs[0].epochKeyDigest, firstDigest, 'the resumed proof commits to the same retained key');
});

test('an additional device proves its own key against the existing membership and never invents a data key', async t => {
  const { store, device } = await newDevice(), owner = await authority.createSigningIdentity(), key = crypto.getRandomValues(new Uint8Array(32));
  const scripted = await host({ store });
  const existing = await scripted.sign(owner.publicKey, [scripted.member(owner.publicKey, true)], 0, await authority.epochKeyCommitment(applicationId, 0, key));
  const withExisting = await host({ existing, store, authoritySigner: scripted.signer });
  const opened = await open(t, { device, scripted: withExisting });
  assert.equal(store.values.has(intentKey), false, 'only the first root browser creates a retained key');
  assert.equal(withExisting.proofs[0].epochKeyDigest, existing.memberships.at(-1).payload.epochKeyDigest);
  assert.equal(opened.authority.epochKey(0), null, 'keys arrive only through explicit provisioning');
  assert.equal(opened.authority.grant(device.identity.publicKey)?.reader, true);
  const session = await peer.createApplicationSession({ device, definition: peer.defineApplication({ id: 'bootstrap-fixture', version: '1', commands: {}, queries: {} }), authority: opened.authority });
  try { assert.equal(session.status.canAuthor, false, 'authoring waits for provisioned keys'); } finally { await session.close(); }
});

test('a missing original root key fails closed and never generates a replacement', async t => {
  const { store, device } = await newDevice(), scripted = await host({ store });
  await open(t, { device, scripted });
  store.values.delete(intentKey);
  // Reopen over a store whose cached authority lacks the key (a device restored without its bootstrap record).
  const lacking = memoryStore(), restored = await peer.openApplicationDevice({ store: lacking, create: true });
  const bundle = await scripted.sign(restored.identity.publicKey, [scripted.member(restored.identity.publicKey, true)], 0, await authority.epochKeyCommitment(applicationId, 0, crypto.getRandomValues(new Uint8Array(32))));
  await authority.createAuthorityProvider({ store: restored.store, bundle });
  await assert.rejects(open(t, { device: restored, scripted: await host({ store: lacking }) }), { code: 'BOOTSTRAP_KEY_MISSING' });
  assert.equal(lacking.values.has(intentKey), false);
});

test('a retained bootstrap record for another identity is rejected', async t => {
  const { store, device } = await newDevice(), scripted = await host({ store });
  await open(t, { device, scripted });
  const other = await authority.createSigningIdentity(), lacking = memoryStore(), restored = await peer.openApplicationDevice({ store: lacking, create: true });
  const bundle = await scripted.sign(restored.identity.publicKey, [scripted.member(restored.identity.publicKey, true)], 0, await authority.epochKeyCommitment(applicationId, 0, crypto.getRandomValues(new Uint8Array(32))));
  await authority.createAuthorityProvider({ store: restored.store, bundle });
  lacking.values.set(intentKey, authority.encodeRecord({ publicKey: other.publicKey, epochKey: crypto.getRandomValues(new Uint8Array(32)) }));
  await assert.rejects(open(t, { device: restored, scripted: await host({ store: lacking }) }), /Bootstrap identity mismatch/);
});

test('origin substitution fails before any host request or retained write', async t => {
  const { store, device } = await newDevice(), scripted = await host({ store });
  await assert.rejects(open(t, { device, scripted, origin: 'https://wrong.pages.example' }), /authorized origin/);
  assert.deepEqual(scripted.log, []); assert.equal(store.values.has(intentKey), false);
});

test('a host returning another execution scope is never cached and a retained manifest mismatch fails offline', async t => {
  const { store, device } = await newDevice(), wrong = await host({ store, executionDigest: 'ee'.repeat(32) });
  await assert.rejects(open(t, { device, scripted: wrong }), /different application execution scope/);
  await assert.rejects(authority.createAuthorityProvider({ store: device.store, applicationId }), /AUTHORITY_CACHE_MISSING/, 'rejected authority is not cached');
  const good = await newDevice(), accepted = await host({ store: good.store });
  await open(t, { device: good.device, scripted: accepted });
  const offline = await host({ store: good.store });
  await assert.rejects(open(t, { device: good.device, scripted: offline, config: { ...configuration, executionManifestDigest: 'dd'.repeat(32) } }), /Retained execution manifest differs/);
  assert.deepEqual(offline.log, []);
});
