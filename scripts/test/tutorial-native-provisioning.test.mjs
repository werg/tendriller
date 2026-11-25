import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as peer from '@chronolog/peer-session';
import * as authority from '@chronolog/authority';

// Optional native participant provisioning for one workspace page (docs/tutorial/shared/helpers/page-provisioning.mjs
// and shared/native-page.mjs). The workspace's shared signer is the page device identity; nothing here creates an
// application root, membership, epoch key or schema. Account-bound enrollment proof, recipient-bound key
// provisioning, the explicit `initialized.json` marker and cached-first opening are checked with the real
// peer-session, authority and record helpers; the retained device store and the host are fakes.
// This is a unit-level contract check of the helpers, not qualification of the native packages.
const root = fileURLToPath(new URL('../../', import.meta.url));
// The helpers import the public core package by name; bundle them with that name mapped to this checkout's
// contract sources, and fake only the RTC/setup modules the native page composes.
const fakes = {
  '@tendriller/core/native-rtc': `export const participateNativeApplication=(session,options)=>globalThis.__native.participate(session,options);`,
  '@tendriller/core/setup': `export const watchApplicationSetup=()=>({close(){}});`,
};
const bundle = async entry => {
  const built = await build({ entryPoints: [root + entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'core', setup(builder) {
    builder.onResolve({ filter: /^@tendriller\/core\/(native-rtc|setup)$/ }, args => ({ path: args.path, namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: fakes[args.path], loader: 'js' }));
    builder.onResolve({ filter: /^@tendriller\/core\/authority$/ }, () => ({ path: root + 'contract/authority.mjs' }));
  } }] });
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
};
const { provisionPage } = await bundle('docs/tutorial/shared/helpers/page-provisioning.mjs');
const { openNativePage } = await bundle('docs/tutorial/shared/native-page.mjs');
const applicationId = '61'.repeat(32);
const definition = peer.defineApplication({ id: 'native-provisioning-fixture', version: '1', commands: {}, queries: {} });
const memoryStore = () => { const values = new Map(); return { values, async get(key) { return values.get(key)?.slice() ?? null; }, async put(key, value) { values.set(key, value.slice()); } }; };
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g), byte => parseInt(byte, 16));
const member = (publicKey, { administrator = false } = {}) => ({ publicKey, reader: true, writer: true, administrator, publisher: false, finalizer: false });
const executionManifestDigest = peer.bytesToHex((await peer.executionManifestArtifacts(await peer.eventExecutionManifest())).executionManifestDigest);

/** One browser-owner authority with the page's native device optionally listed as a (keyless) member. */
async function ownerAuthority(nativeKey, rootPublicKey, forApplication = applicationId) {
  const signer = await authority.createSigningIdentity(), key = crypto.getRandomValues(new Uint8Array(32));
  const rootKey = rootPublicKey ?? (await authority.createSigningIdentity()).publicKey;
  const descriptor = await authority.signAppDescriptor({ applicationId: forApplication, rootPrincipal: rootKey, authorityPublicKey: signer.publicKey, executionManifestDigest, finalityPolicy: { kind: 'none' } }, signer);
  const membership = await authority.signMembership({ applicationId: forApplication, revision: 0, previous: null, authorTimeAfterMs: -1n, epoch: 0,
    epochKeyDigest: await authority.epochKeyCommitment(forApplication, 0, key),
    members: [member(rootKey, { administrator: true }), ...(nativeKey ? [member(nativeKey)] : [])] }, signer);
  return { bundle: { descriptor, memberships: [membership] }, key };
}

/** The page context `tendril agent run` / the starter's root commands hand a page helper. */
async function harness(t, { hostAuthority = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'page-provisioning-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = memoryStore(), counts = { devices: 0, deviceCloses: 0 }, events = [], control = { inUse: false, failMarkerOnce: false, failClose: false };
  const probe = await peer.openApplicationDevice({ store, create: true }), { publicKey, privateKey } = probe.identity; await probe.close();
  const state = { hostAuthority }, privateState = new Map();
  const context = { page: { applicationId, slug: 'notes' }, signer: { publicKey, privateKey }, signal: undefined,
    host: { peers: { application: async () => ({ selection: { id: applicationId },
      authority: state.hostAuthority ? { record: hex(authority.encodeRecord(state.hostAuthority)) } : null, publicationAuthority: null }) } },
    readPrivate: async (name, optional) => { if (privateState.has(name)) return structuredClone(privateState.get(name)); if (optional) return null; throw Object.assign(Error('missing ' + name), { code: 'ENOENT' }); },
    savePrivate: async (name, value) => {
      if (name === 'initialized.json' && control.failMarkerOnce) { control.failMarkerOnce = false; throw Error('marker write reply uncertain'); }
      events.push('save:' + name); privateState.set(name, structuredClone(value)); return value;
    },
    openDevice: async ({ create = false } = {}) => {
      // An owner that holds the page store (the running agent program) refuses a second opener, like the real device lease.
      if (control.inUse) throw Object.assign(Error('BYTES_STORE_IN_USE'), { code: 'BYTES_STORE_IN_USE' });
      counts.devices++; events.push('device-open'); const device = await peer.openApplicationDevice({ store, ...(create ? { create: true } : {}) });
      return { ...device, async close() { counts.deviceCloses++; events.push('device-close'); if (control.failClose) throw Error('device close failed'); return device.close?.(); } };
    } };
  const file = async (name, value) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value)); return path; };
  return { context, state, counts, store, privateState, file, publicKey, events, control, privateStateKeys: async () => [...privateState.keys()], provision: (action, argument) => provisionPage(context, action, argument) };
}

test('sign-enrollment signs only an exact challenge for this page and shared signer, retains the original proof and exposes no private key', async t => {
  const h = await harness(t), challenge = { applicationId, publicKey: h.publicKey, challenge: 'cd'.repeat(16), expiresAt: Date.now() + 60_000 };
  await assert.rejects(h.provision('sign-enrollment', await h.file('c0.json', challenge)), /first authorized browser must initialize/);
  const owner = await ownerAuthority(h.publicKey); h.state.hostAuthority = owner.bundle;
  const proof = await h.provision('sign-enrollment', await h.file('challenge.json', challenge));
  const signed = authority.decodeRecord(unhex(proof.record));
  assert.equal(signed.signer, h.publicKey);
  assert.deepEqual({ ...signed.payload }, { applicationId, publicKey: h.publicKey, challenge: challenge.challenge, epoch: 0, epochKeyDigest: owner.bundle.memberships.at(-1).payload.epochKeyDigest });
  assert.equal(JSON.stringify(proof).includes('privateKey'), false);
  for (const wrong of [{ ...challenge, applicationId: 'ee'.repeat(32) }, { ...challenge, publicKey: 'ab'.repeat(32) }])
    await assert.rejects(h.provision('sign-enrollment', await h.file('wrong.json', wrong)), /another page\/shared signer/);
  // An uncertain reply must resume the original epoch-bound proof, not sign another one.
  h.state.hostAuthority = (await ownerAuthority(h.publicKey)).bundle;
  assert.deepEqual(await h.provision('sign-enrollment', await h.file('again.json', challenge)), proof);
  assert.equal(h.counts.devices, 0, 'signing a challenge opens no page device');
});

test('provisioning requires the first browser to initialize authority and never accepts another application scope', async t => {
  const missing = await harness(t);
  await assert.rejects(missing.provision('provisioning-request'), /first authorized browser must initialize/);
  assert.equal(missing.counts.deviceCloses, missing.counts.devices);
  await assert.rejects(authority.createAuthorityProvider({ store: missing.store, applicationId }), /AUTHORITY_CACHE_MISSING/, 'nothing is cached from a missing authority');
  const foreign = await ownerAuthority(undefined, undefined, 'ff'.repeat(32));
  const wrong = await harness(t, { hostAuthority: foreign.bundle });
  await assert.rejects(wrong.provision('provisioning-request'), /Page authority scope mismatch/);
  assert.equal(wrong.counts.deviceCloses, wrong.counts.devices);
  assert.equal(await wrong.context.readPrivate('provisioning-request.json', true), null);
  assert.equal(await wrong.context.readPrivate('initialized.json', true), null);
});

test('request and import transfer keys only to the explicitly granted recipient, mark the page provisioned and persist across reopen', async t => {
  const h = await harness(t), ownerDevice = await peer.openApplicationDevice({ store: memoryStore(), create: true });
  const owner = await ownerAuthority(h.publicKey, ownerDevice.identity.publicKey);
  h.state.hostAuthority = owner.bundle;
  const request = await h.provision('provisioning-request');
  assert.deepEqual(await h.provision('provisioning-request'), request, 'a retained request is resumed, never replaced');
  const signedRequest = authority.decodeRecord(unhex(request.record));
  assert.equal(signedRequest.payload.recipient, h.publicKey); assert.equal(signedRequest.payload.applicationId, applicationId);
  // Authority is cached on the page device and it holds no data key yet.
  const cached = await authority.createAuthorityProvider({ store: h.store, applicationId });
  assert.equal(cached.grant(h.publicKey)?.reader, true); assert.equal(cached.epochKey(0), null);
  assert.equal(await h.context.readPrivate('initialized.json', true), null, 'a request alone never marks the page provisioned');
  // The browser owner (root, holding the key) exports a package bound to that exact request.
  const ownerSession = await peer.createApplicationSession({ device: ownerDevice, definition, authority: owner.bundle, epochKeys: new Map([[0, owner.key]]) });
  let packageText;
  try { packageText = hex(authority.encodeRecord(await ownerSession.provisioning.exportProvisioning(signedRequest))); } finally { await ownerSession.close(); }
  // A damaged package is rejected, leaves the device keyless and writes no provisioned marker.
  const damaged = packageText.slice(0, -4) + (packageText.endsWith('0000') ? 'ffff' : '0000');
  await assert.rejects(h.provision('import-provisioning', await h.file('damaged.json', { record: damaged })));
  assert.equal((await authority.createAuthorityProvider({ store: h.store, applicationId })).epochKey(0), null);
  assert.equal(await h.context.readPrivate('initialized.json', true), null);
  assert.equal(h.counts.deviceCloses, h.counts.devices, 'failed import releases the retained device');
  const imported = await h.provision('import-provisioning', await h.file('package.json', { record: packageText }));
  assert.equal(imported.provisioned, true); assert.equal(imported.publicKey, h.publicKey); assert.match(imported.next, /Browser authoring never waited/);
  assert.deepEqual(await h.context.readPrivate('initialized.json'), { applicationId, publicKey: h.publicKey, executionManifestDigest, provisioned: true });
  const provisioned = await authority.createAuthorityProvider({ store: h.store, applicationId });
  assert.deepEqual(provisioned.epochKey(0), owner.key, 'the granted key survives reopening from the device store alone');
  assert.equal(h.counts.deviceCloses, h.counts.devices);
  // A page can be reopened locally from cached authority: the session only needs stored authority and its granted key.
  const device = await h.context.openDevice();
  const reopened = await peer.createApplicationSession({ device, definition, authority: provisioned });
  assert.equal(reopened.identity.publicKey, h.publicKey);
  assert.equal(reopened.status.canAuthor, true, 'cached authority and its granted key are sufficient to author locally');
  await reopened.close();
});

test('the native page owner opens only a provisioned page from cached state and closes participation before the owner exactly once', async t => {
  const h = await harness(t), order = [];
  globalThis.__native = { participate: (session, options) => ({ session, options, status: { phase: 'closed', connectedPeers: [] }, onStatus: () => () => {}, async close() { order.push('participation'); } }) };
  t.after(() => { delete globalThis.__native; });
  // An uninitialized or merely prepared page never starts a native owner and opens no device.
  await assert.rejects(openNativePage(h.context, { definition }), error => error.code === 'native_page_provisioning_required');
  assert.equal(h.counts.devices, 0);
  const owner = await ownerAuthority(h.publicKey);
  await authority.createAuthorityProvider({ store: h.store, bundle: owner.bundle, epochKeys: new Map([[0, owner.key]]) });
  await h.context.savePrivate('initialized.json', { applicationId, publicKey: h.publicKey, executionManifestDigest, provisioned: true });
  await h.context.savePrivate('host-configuration.json', { executionManifestDigest });
  const opened = await openNativePage(h.context, { definition });
  assert.equal(opened.session.identity.publicKey, h.publicKey);
  assert.equal(opened.session.status.canAuthor, true);
  assert.equal(opened.participation.options.peers, h.context.host.peers, 'introductions use the host peers client, not a second backend');
  await opened.close(); await opened.close();
  assert.deepEqual(order, ['participation']);
  // A marker for another signer is refused rather than adopted.
  await h.context.savePrivate('initialized.json', { applicationId, publicKey: 'ab'.repeat(32), executionManifestDigest, provisioned: true });
  await assert.rejects(openNativePage(h.context, { definition }), error => error.code === 'native_page_provisioning_required');
});

/** A request, the owner's wrapped package for it and the page's provisioning harness, ready to import. */
async function readyToImport(t) {
  const h = await harness(t), ownerDevice = await peer.openApplicationDevice({ store: memoryStore(), create: true });
  const owner = await ownerAuthority(h.publicKey, ownerDevice.identity.publicKey);
  h.state.hostAuthority = owner.bundle;
  const signedRequest = authority.decodeRecord(unhex((await h.provision('provisioning-request')).record));
  const ownerSession = await peer.createApplicationSession({ device: ownerDevice, definition, authority: owner.bundle, epochKeys: new Map([[0, owner.key]]) });
  let packageText;
  try { packageText = hex(authority.encodeRecord(await ownerSession.provisioning.exportProvisioning(signedRequest))); } finally { await ownerSession.close(); }
  return { h, owner, packagePath: await h.file('package.json', { record: packageText }) };
}

test('the provisioned marker follows the verified import, the awaited device close and a durable release proof', async t => {
  const { h, packagePath } = await readyToImport(t);
  h.events.length = 0;
  const first = await h.provision('import-provisioning', packagePath);
  const at = name => h.events.findIndex(event => event === name || event.startsWith(name));
  assert.ok(at('save:provisioning-receipt-') >= 0, 'the verified import leaves a durable import receipt');
  assert.ok(at('save:provisioning-receipt-') < at('device-close'), 'the import is proven before the lease is released');
  assert.ok(at('save:provisioning-released-') > at('device-close'), 'the release proof is written only after the awaited close');
  assert.ok(at('save:initialized.json') > at('save:provisioning-released-'), 'the marker the agent watches follows the release proof');
  const names = await h.privateStateKeys();
  const imported = await h.context.readPrivate(names.find(name => name.startsWith('provisioning-receipt-')));
  assert.deepEqual(Object.keys(imported).sort(), ['applicationId', 'epoch', 'executionManifestDigest', 'kind', 'packageDigest', 'publicKey', 'schemaVersion']);
  assert.equal(imported.kind, 'imported'); assert.equal(imported.applicationId, applicationId); assert.equal(imported.publicKey, h.publicKey); assert.equal(imported.schemaVersion, 1);
  assert.match(imported.packageDigest, /^[a-f0-9]{64}$/);
  const released = await h.context.readPrivate(names.find(name => name.startsWith('provisioning-released-')));
  assert.equal(released.kind, 'released'); assert.equal(released.packageDigest, imported.packageDigest);
  assert.equal(JSON.stringify([imported, released]).includes('privateKey'), false);
  assert.deepEqual(await h.context.readPrivate('initialized.json'), { applicationId, publicKey: h.publicKey, executionManifestDigest, provisioned: true });
  assert.equal(first.provisioned, true);
});

test('an exact repeat while the agent owns the page store returns the receipt without opening the store; a different package fails explicitly', async t => {
  const { h, packagePath } = await readyToImport(t);
  const first = await h.provision('import-provisioning', packagePath);
  const opened = h.counts.devices, marker = structuredClone(await h.context.readPrivate('initialized.json'));
  h.control.inUse = true; // the agent program now owns the store and publishes nothing from here
  assert.deepEqual(await h.provision('import-provisioning', packagePath), first, 'the exact repeat returns the same successful result');
  assert.equal(h.counts.devices, opened, 'the exact repeat opened no page store');
  // A fresh, different package never steals the active owner's store and changes nothing.
  const keys = (await h.privateStateKeys()).slice();
  await assert.rejects(h.provision('import-provisioning', await h.file('other.json', { record: 'ab'.repeat(16) })),
    error => error.code === 'page_store_in_use' && /nothing was changed/.test(error.message) && error.cause?.code === 'BYTES_STORE_IN_USE');
  assert.deepEqual(await h.context.readPrivate('initialized.json'), marker);
  assert.equal((await h.privateStateKeys()).filter(name => name.startsWith('provisioning-receipt-') || name.startsWith('provisioning-released-')).length, 2, 'no receipt exists for the refused package');
  assert.deepEqual((await h.privateStateKeys()).filter(name => !keys.includes(name)).filter(name => name.startsWith('provisioning-receipt-')), []);
});

test('a receipt persisted before an uncertain marker write completes the marker from the receipt without a second import', async t => {
  const { h, packagePath } = await readyToImport(t);
  h.control.failMarkerOnce = true;
  await assert.rejects(h.provision('import-provisioning', packagePath), /marker write reply uncertain/);
  assert.equal(await h.context.readPrivate('initialized.json', true), null);
  assert.equal((await h.privateStateKeys()).filter(name => name.startsWith('provisioning-released-')).length, 1, 'the release proof was already durable, so the marker needs no reopen');
  const opened = h.counts.devices; h.control.inUse = true; // even with the store now owned elsewhere
  const retried = await h.provision('import-provisioning', packagePath);
  assert.equal(retried.provisioned, true); assert.equal(h.counts.devices, opened, 'no import and no store open');
  assert.deepEqual(await h.context.readPrivate('initialized.json'), { applicationId, publicKey: h.publicKey, executionManifestDigest, provisioned: true });
});

test('an import receipt is not release proof: after a failed close nothing is claimed while the store is held, and recovery follows the actual release', async t => {
  const { h, packagePath } = await readyToImport(t);
  h.control.failClose = true;
  await assert.rejects(h.provision('import-provisioning', packagePath), /device close failed/);
  const proofs = async prefix => (await h.privateStateKeys()).filter(name => name.startsWith(prefix));
  assert.equal((await proofs('provisioning-receipt-')).length, 1, 'the import itself is durably proven');
  assert.equal((await proofs('provisioning-released-')).length, 0, 'no release proof exists for a close that failed');
  assert.equal(await h.context.readPrivate('initialized.json', true), null, 'the marker never precedes a proven release');
  // The importer (or the agent) may still hold the store: the exact retry fails closed and claims nothing.
  h.control.failClose = false; h.control.inUse = true;
  await assert.rejects(h.provision('import-provisioning', packagePath), error => error.code === 'provisioning_release_uncertain' && /release[\s\S]*not proven/.test(error.message) && error.cause?.code === 'BYTES_STORE_IN_USE');
  assert.equal((await proofs('provisioning-released-')).length, 0);
  assert.equal(await h.context.readPrivate('initialized.json', true), null, 'no result or marker claim while the lease may be held');
  // After the actual release, one exclusive cached-device acquisition validates cached authority and keys and closes: no reimport.
  h.control.inUse = false; h.events.length = 0; const opened = h.counts.devices;
  const recovered = await h.provision('import-provisioning', packagePath);
  assert.equal(recovered.provisioned, true);
  assert.equal(h.counts.devices, opened + 1, 'exactly one cached-device acquisition');
  assert.deepEqual(h.events.map(event => event.replace(/-[a-f0-9]{64}\.json$/, '-<digest>.json')), ['device-open', 'device-close', 'save:provisioning-released-<digest>.json', 'save:initialized.json'],
    'validate-and-close, then the release proof, then the marker: no import and no new receipt');
  assert.deepEqual(await h.context.readPrivate('initialized.json'), { applicationId, publicKey: h.publicKey, executionManifestDigest, provisioned: true });
  // With the release now proven, an exact repeat while the agent owns the store opens nothing.
  h.control.inUse = true; const settled = h.counts.devices;
  assert.deepEqual(await h.provision('import-provisioning', packagePath), recovered);
  assert.equal(h.counts.devices, settled);
});

test('recovery refuses a cached device that does not match the import receipt and a failing recovery close publishes nothing', async t => {
  const { h, packagePath } = await readyToImport(t);
  h.control.failClose = true;
  await assert.rejects(h.provision('import-provisioning', packagePath), /device close failed/);
  // A recovery close that fails again proves nothing.
  await assert.rejects(h.provision('import-provisioning', packagePath), /device close failed/);
  assert.equal((await h.privateStateKeys()).filter(name => name.startsWith('provisioning-released-')).length, 0);
  assert.equal(await h.context.readPrivate('initialized.json', true), null);
  h.control.failClose = false;
  const name = (await h.privateStateKeys()).find(key => key.startsWith('provisioning-receipt-'));
  h.privateState.set(name, { ...h.privateState.get(name), executionManifestDigest: 'ee'.repeat(32) });
  await assert.rejects(h.provision('import-provisioning', packagePath), /does not match the verified import receipt/);
  assert.equal((await h.privateStateKeys()).filter(key => key.startsWith('provisioning-released-')).length, 0);
  assert.equal(await h.context.readPrivate('initialized.json', true), null);
});

test('a receipt for another signer or a conflicting marker is refused rather than trusted', async t => {
  const { h, packagePath } = await readyToImport(t);
  await h.provision('import-provisioning', packagePath);
  const name = (await h.privateStateKeys()).find(key => key.startsWith('provisioning-released-'));
  h.privateState.set(name, { ...h.privateState.get(name), publicKey: 'ab'.repeat(32) });
  await assert.rejects(h.provision('import-provisioning', packagePath), /another page, shared signer or package/);
  h.privateState.set(name, { ...h.privateState.get(name), publicKey: h.publicKey });
  h.privateState.set('initialized.json', { applicationId, publicKey: 'cd'.repeat(32), executionManifestDigest, provisioned: true });
  await assert.rejects(h.provision('import-provisioning', packagePath), /Retained initialized marker belongs to another/);
});
