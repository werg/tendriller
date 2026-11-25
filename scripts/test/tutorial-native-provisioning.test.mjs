import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as peer from '@chronolog/peer-session';
import * as authority from '@chronolog/authority';

// Optional native participant bootstrap (docs/tutorial/helpers/native-session.mjs). Replaces the
// removed native pairing runner: explicit device creation, account-bound enrollment proof, recipient-bound
// provisioning, cached-first opening and owned shutdown. The retained device store, the supervisor/RTC
// owner modules and the host are fakes; peer-session, authority and the core record helpers are the real ones.
// This is a unit-level contract check of the helper, not qualification of the native packages.
const root = fileURLToPath(new URL('../../', import.meta.url));
const fakes = {
  '@chronolog/peer-session/native': `export async function openNativeDevice(options){return globalThis.__native.openDevice(options);}`,
  '@chronolog/peer-session/browser': `export const connectApplicationOwner=async()=>{throw Error('MUST_NOT_ATTACH_IN_THIS_TEST');};`,
  '@chronolog/peer-session/worker': `export const createApplicationOwner=session=>({session});`,
  '@tendriller/core/native-owner': `export const createNativeAttachmentKey=()=>globalThis.__native.attachmentKey();
export const createNativeSessionSupervisor=options=>globalThis.__native.supervise(options);
export const attachNativeSession=async()=>{throw Error('MUST_NOT_ATTACH_IN_THIS_TEST');};`,
  '@tendriller/core/native-rtc': `export const participateNativeApplication=(session,options)=>globalThis.__native.participate(session,options);`,
};
const core = { peers: 'peers', authority: 'authority', setup: 'setup', assistant: 'assistant', limits: 'limits', 'transport-diagnostics': '../session/transport-diagnostics' };
const built = await build({ entryPoints: [root + 'docs/tutorial/helpers/native-session.mjs'], bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'native-fakes', setup(builder) {
    builder.onResolve({ filter: /^@chronolog\/peer-session\/(native|browser|worker)$|^@tendriller\/core\/(native-owner|native-rtc)$/ }, args => ({ path: args.path, namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: fakes[args.path], loader: 'js' }));
    builder.onResolve({ filter: /^@tendriller\/core\/([\w-]+)$/ }, args => {
      const name = core[args.path.split('/').at(-1)]; if (!name) return { errors: [{ text: 'Unmapped core import ' + args.path }] };
      return { path: root + 'contract/' + name + '.mjs' };
    });
  } }] });
const { createNativeBootstrap } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const applicationId = '61'.repeat(32);
const definition = peer.defineApplication({ id: 'native-bootstrap-fixture', version: '1', commands: {}, queries: {} });
const memoryStore = () => { const values = new Map(); return { values, async get(key) { return values.get(key)?.slice() ?? null; }, async put(key, value) { values.set(key, value.slice()); } }; };
const record = value => authority.encodeRecord(value);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g), byte => parseInt(byte, 16));
const member = (publicKey, { administrator = false, writer = true } = {}) => ({ publicKey, reader: true, writer, administrator, publisher: false, finalizer: false });
const executionManifestDigest = peer.bytesToHex((await peer.executionManifestArtifacts(await peer.eventExecutionManifest())).executionManifestDigest);

/** One browser-owner authority with the native device optionally listed as a (keyless) member. */
async function ownerAuthority(nativeKey, rootPublicKey) {
  const signer = await authority.createSigningIdentity(), key = crypto.getRandomValues(new Uint8Array(32));
  const root = rootPublicKey ?? (await authority.createSigningIdentity()).publicKey;
  const descriptor = await authority.signAppDescriptor({ applicationId, rootPrincipal: root, authorityPublicKey: signer.publicKey, executionManifestDigest, finalityPolicy: { kind: 'none' } }, signer);
  const membership = await authority.signMembership({ applicationId, revision: 0, previous: null, authorTimeAfterMs: -1n, epoch: 0,
    epochKeyDigest: await authority.epochKeyCommitment(applicationId, 0, key),
    members: [member(root, { administrator: true }), ...(nativeKey ? [member(nativeKey)] : [])] }, signer);
  return { bundle: { descriptor, memberships: [membership] }, key, signer };
}

async function harness(t, { hostAuthority = null, otherApplication = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-bootstrap-')), stores = new Map(), counts = { devices: 0, deviceCloses: 0, supervised: [], participations: [], order: [], keys: 0 };
  t.after(() => rm(directory, { recursive: true, force: true }));
  globalThis.__native = {
    async openDevice({ path, create }) {
      const store = stores.get(path) ?? stores.set(path, memoryStore()).get(path);
      counts.devices++; const device = await peer.openApplicationDevice({ store, ...(create ? { create: true } : {}) });
      return { ...device, async close() { counts.deviceCloses++; return device.close?.(); } };
    },
    attachmentKey: () => 'attachment-key-' + ++counts.keys,
    async supervise(options) {
      const record = { options, closes: 0 }; counts.supervised.push(record);
      record.owner = await options.openOwner({ signal: options.signal, profileId: options.profileId });
      return { ownerInstanceId: 'fixture-owner', async close() { record.closes++; counts.order.push('supervisor'); } };
    },
    participate(session, options) {
      const controller = { session, options, closes: 0, status: { phase: 'closed', connectedPeers: [] }, onStatus: () => () => {}, async close() { this.closes++; counts.order.push('participation'); } };
      counts.participations.push(controller); return controller;
    },
  };
  t.after(() => { delete globalThis.__native; });
  const state = { hostAuthority }, privateState = new Map(), peers = { application: async () => ({ selection: { id: applicationId }, authority: state.hostAuthority ? { record: hex(record(state.hostAuthority)) } : null, publicationAuthority: null }),
    publication: async () => null };
  const local = { privateDirectory: pathToFileURL(directory + '/p/'),
    readPrivate: async (name, optional) => { if (privateState.has(name)) return structuredClone(privateState.get(name)); if (optional) return null; throw Object.assign(Error('missing ' + name), { code: 'ENOENT' }); },
    savePrivate: async (name, value) => { privateState.set(name, structuredClone(value)); return value; },
    project: async () => ({ handle: { application: { id: otherApplication ? 'ff'.repeat(32) : applicationId } }, host: { peers } }) };
  const bootstrap = createNativeBootstrap({ definition, local });
  const devicePath = directory + '/p/device.sqlite', file = async (name, value) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value)); return path; };
  return { bootstrap, state, counts, stores, privateState, devicePath, directory, file, local,
    store: () => stores.get(devicePath) };
}
const silently = async work => { const log = console.log; console.log = () => {}; try { return await work(); } finally { console.log = log; } };

test('init-device creates only a retained signing identity: no root, membership, descriptor or epoch key', async t => {
  const h = await harness(t);
  const first = await h.bootstrap.main(['init-device']);
  assert.match(first.publicKey, /^[a-f0-9]{64}$/);
  assert.match(first.next, /account-bound challenge/);
  assert.equal(JSON.stringify(first).includes('privateKey'), false);
  await assert.rejects(authority.createAuthorityProvider({ store: h.store(), applicationId }), /AUTHORITY_CACHE_MISSING/);
  assert.equal([...h.store().values.keys()].some(key => /^(authority|starter\/bootstrap)/.test(key)), false);
  // Re-running resumes the same retained identity and closes every device handle it opened.
  const again = await h.bootstrap.main(['init-device']);
  assert.equal(again.publicKey, first.publicKey);
  assert.equal(h.counts.deviceCloses, h.counts.devices);
  await assert.rejects(h.bootstrap.main(['init-device', '../escape']), /explicit retained native profile name/);
});

test('sign-enrollment signs only an exact account-bound challenge for this retained key and exposes no private key', async t => {
  const h = await harness(t), { publicKey } = await h.bootstrap.main(['init-device']);
  const owner = await ownerAuthority(publicKey); h.state.hostAuthority = owner.bundle;
  const challenge = { applicationId, publicKey, challenge: 'cd'.repeat(16), expiresAt: Date.now() + 60_000 };
  const proof = await h.bootstrap.main(['sign-enrollment', await h.file('challenge.json', challenge)]);
  const signed = authority.decodeRecord(unhex(proof.record));
  assert.equal(signed.signer, publicKey);
  assert.deepEqual({ ...signed.payload }, { applicationId, publicKey, challenge: challenge.challenge, epoch: 0, epochKeyDigest: owner.bundle.memberships.at(-1).payload.epochKeyDigest });
  assert.equal(JSON.stringify(proof).includes('privateKey'), false);
  for (const wrong of [{ ...challenge, applicationId: 'ee'.repeat(32) }, { ...challenge, publicKey: 'ab'.repeat(32) }])
    await assert.rejects(h.bootstrap.main(['sign-enrollment', await h.file('wrong.json', wrong)]), /another application\/key/);
  assert.equal(h.counts.deviceCloses, h.counts.devices, 'a refused challenge still releases the retained device');
});

test('provisioning requires the owner browser to initialize authority first and never accepts another application scope', async t => {
  const missing = await harness(t); await missing.bootstrap.main(['init-device']);
  await assert.rejects(missing.bootstrap.main(['provisioning-request']), /first owner browser must initialize/);
  assert.equal(missing.counts.deviceCloses, missing.counts.devices);
  await assert.rejects(authority.createAuthorityProvider({ store: missing.store(), applicationId }), /AUTHORITY_CACHE_MISSING/, 'nothing is cached from a missing authority');
  const foreign = await ownerAuthority();
  const wrong = await harness(t, { hostAuthority: foreign.bundle, otherApplication: true }); await wrong.bootstrap.main(['init-device']);
  await assert.rejects(wrong.bootstrap.main(['provisioning-request']), /Application scope mismatch/);
  assert.equal(wrong.counts.deviceCloses, wrong.counts.devices);
});

test('provisioning request and import transfer keys only to the explicitly granted recipient and persist across reopen', async t => {
  const h = await harness(t), { publicKey } = await h.bootstrap.main(['init-device']);
  const ownerDevice = await peer.openApplicationDevice({ store: memoryStore(), create: true });
  const owner = await ownerAuthority(publicKey, ownerDevice.identity.publicKey);
  h.state.hostAuthority = owner.bundle;
  const request = await h.bootstrap.main(['provisioning-request']);
  const signedRequest = authority.decodeRecord(unhex(request.record));
  assert.equal(signedRequest.payload.recipient, publicKey); assert.equal(signedRequest.payload.applicationId, applicationId);
  // Authority is now cached on the device and the native device holds no data key yet.
  const cached = await authority.createAuthorityProvider({ store: h.store(), applicationId });
  assert.equal(cached.grant(publicKey)?.reader, true); assert.equal(cached.epochKey(0), null);
  // The browser owner (root, holding the key) exports a package bound to that exact request.
  const ownerSession = await peer.createApplicationSession({ device: ownerDevice, definition, authority: owner.bundle, epochKeys: new Map([[0, owner.key]]) });
  let packageText;
  try { packageText = hex(record(await ownerSession.provisioning.exportProvisioning(signedRequest))); } finally { await ownerSession.close(); }
  // A damaged package is rejected and leaves the device keyless.
  const damaged = packageText.slice(0, -4) + (packageText.endsWith('0000') ? 'ffff' : '0000');
  await assert.rejects(h.bootstrap.main(['import-provisioning', await h.file('damaged.json', { record: damaged })]));
  assert.equal((await authority.createAuthorityProvider({ store: h.store(), applicationId })).epochKey(0), null);
  assert.equal(h.counts.deviceCloses, h.counts.devices, 'failed import releases the retained device');
  const imported = await h.bootstrap.main(['import-provisioning', await h.file('package.json', { record: packageText })]);
  assert.equal(imported.imported, true); assert.match(imported.next, /Browser edits do not require this process/);
  const provisioned = await authority.createAuthorityProvider({ store: h.store(), applicationId });
  assert.deepEqual(provisioned.epochKey(0), owner.key, 'the granted key survives reopening from the device store alone');
  assert.equal(h.counts.deviceCloses, h.counts.devices);
});

test('run opens cached state, stores one attachment credential, and closes the supervisor then participation exactly once', async t => {
  const h = await harness(t), { publicKey } = await h.bootstrap.main(['init-device']);
  const owner = await ownerAuthority(publicKey);
  await authority.createAuthorityProvider({ store: h.store(), bundle: owner.bundle, epochKeys: new Map([[0, owner.key]]) });
  const opened = await h.bootstrap.openSession({});
  assert.equal(opened.session.identity.publicKey, publicKey);
  assert.equal(opened.session.status.canAuthor, true, 'cached authority and its granted key are sufficient to author locally');
  assert.equal(h.counts.supervised.length, 1);
  const supervised = h.counts.supervised[0].options;
  assert.equal(supervised.profileId, `${applicationId}:main`);
  assert.deepEqual(supervised.bindings.map(binding => binding.id), ['terminal']);
  assert.equal(h.privateState.get('native-attachment-main.json').token, supervised.bindings[0].token);
  assert.equal(h.counts.participations.length, 1);
  assert.equal(h.counts.participations[0].options.peers, (await h.local.project()).host.peers, 'introductions use the host peers client, not a second backend');
  await opened.close();
  assert.deepEqual(h.counts.order, ['supervisor', 'participation']);
  assert.equal(h.counts.supervised[0].closes, 1); assert.equal(h.counts.participations[0].closes, 1);
  // A second run reuses the same credential rather than minting another.
  await (await h.bootstrap.openSession({})).close();
  assert.equal(h.counts.keys, 1); assert.equal(h.privateState.get('native-attachment-main.json').token, 'attachment-key-1');
});

test('an uninitialized application never starts a native owner or a credential-bearing supervisor session', async t => {
  const h = await harness(t); await h.bootstrap.main(['init-device']);
  await assert.rejects(h.bootstrap.openSession({}), /first owner browser must initialize/);
  assert.equal(h.counts.participations.length, 0);
  assert.equal(h.counts.deviceCloses, h.counts.devices, 'the failed owner open releases its retained device');
});
