import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as p from '@chronolog/peer-session';
import { ContentAddressedStore, MemoryBytesStore, TopicKernel, computeCasHash, decodeCasNode, hashCasNode, seedStandardModules } from '@chronolog/peer-session/kernel';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { createAdmission, deviceWrapKey, openPageGenesis } from '../../session/admission.mjs';
import { authorityRecord, authorityRecordBytes } from '../../contract/authority.mjs';
import { pageConnectionCommands, pageConnectionQueries, rekeyAllPageConnections } from '../../docs/tutorial/shared/helpers/connections.mjs';
import { generateConnectionKey } from '../../contract/connections.mjs';

const CONNECTION_REDUCER = `
export default {
  reduce(state, tx) {
    const map = state && typeof state === 'object' ? { ...state } : {};
    const payload = tx.payload ?? {};
    if (!payload.connectionKey) delete map[payload.connectionId];
    else map[payload.connectionId] = { ...payload, updatedBy: tx.author };
    return { ok: true, state: map, events: [{ topic: 'connections/page-key', payload }] };
  },
  query(state) { return state ?? {}; },
};
`;

const definition = p.defineApplication({
  id: 'org-admission-test',
  version: '1',
  commands: pageConnectionCommands,
  queries: pageConnectionQueries,
});

const imports = { 'app/connections': CONNECTION_REDUCER };
const topics = { 'connections/page-key': { module: 'app/connections' } };

function createInMemoryHost({ hostIdentity, ownerAccount }) {
  let chainId = '88'.repeat(32);
  let genesis = null;
  let genesisBytes = null;
  let groupPolicy = null;
  let controlPerms = { members: [], admission: null };
  const publicOps = new Map();
  const publicCas = new Map();
  const pending = new Map();
  const groupAttestations = new Map();
  const departures = new Map();

  const encode = v => authorityRecord(p.encodeRecord(v));
  const decode = v => p.decodeRecord(authorityRecordBytes(v));

  async function replay() {
    if (!genesisBytes) return;
    const cas = new ContentAddressedStore({ store: new MemoryBytesStore() });
    await seedStandardModules(cas);
    for (const [hash, bytes] of publicCas.entries()) {
      if (hashCasNode(bytes) === hash) { decodeCasNode(bytes); await cas.putRaw(hash, bytes, 'public'); }
      else await cas.put(bytes, [], 'public');
    }
    const kernel = new TopicKernel({ genesis: genesisBytes, cas, blindHostMode: true });
    await kernel.materialize([...publicOps.values()].map(o => o.kernelInput));
    controlPerms = kernel.topics.$permissions ?? { members: [], admission: null };
  }

  const isMember = pk => (controlPerms.members ?? []).some(m => m.publicKey === pk);

  const metadata = () => ({
    selection: { id: chainId },
    configuration: null,
    genesis,
    hostAttestationKey: hostIdentity.publicKey,
    admissionAccounts: [ownerAccount],
  });

  const peersFor = accountId => ({
    async application() { return metadata(); },
    async initialize({ genesis: rec, casNodes = [] }) {
      genesisBytes = authorityRecordBytes(rec, 1024 * 1024);
      genesis = rec;
      chainId = p.bytesToHex(p.genesisChainId(genesisBytes));
      for (const n of casNodes) {
        const bytes = p.hexToBytes(n.bytes);
        if (computeCasHash(bytes) !== n.hash) throw new Error('cas_hash_mismatch');
        publicCas.set(n.hash, bytes);
      }
      await replay();
      return metadata();
    },
    async syncControl(input = {}) {
      for (const n of input.casNodes ?? []) {
        const bytes = p.hexToBytes(n.bytes);
        publicCas.set(n.hash, bytes);
      }
      for (const opRec of input.publicOps ?? []) {
        const raw = authorityRecordBytes(opRec, 256 * 1024);
        const signed = p.decodeSignedOperation(raw);
        const { core, opId } = await p.verifySignedOperation(signed);
        publicOps.set(p.bytesToHex(opId), { raw, kernelInput: { opId, core } });
      }
      await replay();
      for (const pk of pending.keys()) if (isMember(pk)) pending.delete(pk);
      return {
        ...metadata(),
        publicOps: [...publicOps.values()].map(v => authorityRecord(v.raw)),
        casNodes: [...publicCas.entries()].map(([hash, bytes]) => ({ hash, bytes: p.bytesToHex(bytes) })),
        checkpoints: [],
      };
    },
    async challenge(publicKey) {
      return { applicationId: chainId, publicKey, challenge: '11'.repeat(32), expiresAt: Date.now() + 60_000 };
    },
    async enroll(proofRec) {
      const proof = decode(proofRec);
      const now = Date.now();
      const att = await p.signHostAttestationV2({
        subject: 'device',
        pageId: 'aaaaaaaaaaaa',
        applicationId: chainId,
        accountId,
        email: `${accountId}@acme.test`,
        publicKey: proof.payload.publicKey,
        wrapKey: proof.payload.wrapKey,
        label: `Device (${accountId})`,
        inviteId: null,
        issuedAt: now,
        expiresAt: now + 60_000,
        nonce: p.bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      }, hostIdentity);
      pending.set(proof.payload.publicKey, att);
      if (accountId === 'alice_org') {
        const ga = await p.signRecord('tendriller-group-attestation-v1', {
          pageId: 'aaaaaaaaaaaa',
          applicationId: chainId,
          accountId,
          publicKey: proof.payload.publicKey,
          wrapKey: proof.payload.wrapKey,
          group: 'github-team:acme/eng',
          ruleId: 'r_eng',
          role: 'writer',
          issuedAt: now,
          expiresAt: now + 60_000,
        }, hostIdentity);
        groupAttestations.set(proof.payload.publicKey, ga);
      }
      return { ...metadata(), attestation: encode(att) };
    },
    async admissions() {
      const pendingList = [...pending.values()].filter(a => !isMember(a.payload.publicKey)).map(encode);
      return { pending: pendingList };
    },
    async groups() {
      return {
        policy: groupPolicy,
        group_attestations: [...groupAttestations.values()],
        departures: [...departures.values()],
      };
    },
    async setGroupPolicy(signed) {
      groupPolicy = signed;
      return { policy: signed };
    },
    async ackDeparture(publicKey) {
      departures.delete(publicKey);
      return { cleared: true };
    },
  });

  return {
    peersFor,
    async emitDeparture(accountId, publicKey, group = 'github-team:acme/eng') {
      const dep = await p.signRecord('tendriller-org-departure-v1', {
        pageId: 'aaaaaaaaaaaa',
        applicationId: chainId,
        accountId,
        publicKey,
        group,
        ruleId: 'r_eng',
        observedAbsentAt: Date.now(),
      }, hostIdentity);
      departures.set(publicKey, dep);
      return dep;
    },
    get remainingDepartures() { return departures.size; },
  };
}

test('createAdmission seamlessly admits org members via admin-signed group policy and seamlessly revokes + rotates keys on host-signed departure', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'org-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const hostIdentity = await p.createSigningIdentity();
  const host = createInMemoryHost({ hostIdentity, ownerAccount: 'owner_acc' });

  // 1. Owner creates genesis page authority & signs group policy for github-team:acme/eng
  const ownerDev = await openNativeDevice({ path: join(dir, 'owner.sqlite'), create: true });
  const ownerWrap = await deviceWrapKey(ownerDev.store);
  const ownerPeers = host.peersFor('owner_acc');
  const ownerGenesis = await openPageGenesis({
    store: ownerDev.store,
    identity: ownerDev.identity,
    wrapKey: ownerWrap,
    peers: ownerPeers,
    imports,
    topics,
    create: true,
  });
  const ownerSession = await p.createApplicationSession({
    device: ownerDev,
    definition,
    genesis: ownerGenesis.genesisBytes,
    casNodes: ownerGenesis.casNodes,
    publicOps: ownerGenesis.publicOps,
    epochKeys: new Map([[0, ownerGenesis.epoch0Key]]),
  });
  const ownerEvents = [];
  const rotatedEpochs = [];
  const ownerAdm = createAdmission(ownerSession, {
    peers: ownerPeers,
    wrapKey: ownerWrap,
    store: ownerDev.store,
    onEvent: ev => ownerEvents.push(ev),
    onEpochRotated: info => rotatedEpochs.push(info),
  });
  t.after(async () => { ownerAdm.close(); await ownerSession.close(); });

  await ownerAdm.call('admission.setGroupPolicy', 'aaaaaaaaaaaa', [
    { ruleId: 'r_eng', group: 'github-team:acme/eng', role: 'writer' },
  ]);

  // 2. Alice (verified org member) opens page & enrolls device
  const aliceDev = await openNativeDevice({ path: join(dir, 'alice.sqlite'), create: true });
  const aliceWrap = await deviceWrapKey(aliceDev.store);
  const alicePeers = host.peersFor('alice_org');
  const aliceGenesis = await openPageGenesis({
    store: aliceDev.store,
    identity: aliceDev.identity,
    wrapKey: aliceWrap,
    peers: alicePeers,
    create: false,
  });
  const aliceSession = await p.createApplicationSession({
    device: aliceDev,
    definition,
    genesis: aliceGenesis.genesisBytes,
    casNodes: aliceGenesis.casNodes,
    publicOps: aliceGenesis.publicOps,
  });
  const aliceAdm = createAdmission(aliceSession, { peers: alicePeers, wrapKey: aliceWrap, store: aliceDev.store });
  t.after(async () => { aliceAdm.close(); await aliceSession.close(); });

  await aliceAdm.refresh();
  assert.equal(aliceAdm.state.phase, 'waiting-admission');

  // Owner refreshes -> automatically verifies signed policy + companion host group attestation -> admits Alice & seals epoch 0 lockbox!
  await ownerAdm.refresh();
  assert.ok(ownerEvents.some(e => e.kind === 'org-admitted' && e.publicKey === aliceDev.identity.publicKey));
  await aliceAdm.refresh();
  assert.equal(aliceAdm.state.phase, 'admitted');
  assert.equal(aliceAdm.state.epoch, 0);

  // Store a page-custody Tier B K_conn in Chronolog and verify rekeyAllPageConnections rotates it cleanly
  const initialKConn = generateConnectionKey();
  const connId = `oc_${'a'.repeat(26)}`;
  const op = await ownerSession.command('setPageConnectionKey', {
    connectionId: connId, provider: 'github', connectionKey: initialKConn, epoch: 0,
  });
  await op.materialized({ signal: AbortSignal.timeout(5000) });

  // 3. Alice leaves github-team:acme/eng -> host emits signed departure -> owner automatically revokes & rotates to epoch 1!
  await host.emitDeparture('alice_org', aliceDev.identity.publicKey);
  await ownerAdm.refresh();
  assert.equal(ownerAdm.state.epoch, 1, 'Epoch key rotated automatically on org departure');
  assert.equal(ownerAdm.state.members.some(m => m.publicKey === aliceDev.identity.publicKey), false);
  assert.equal(host.remainingDepartures, 0, 'Departure acknowledged after Chronolog revocation');
  assert.ok(ownerEvents.some(e => e.kind === 'org-offboarded' && e.publicKey === aliceDev.identity.publicKey));
  assert.equal(rotatedEpochs.length, 1, 'onEpochRotated hook fired automatically on org departure');
  assert.equal(rotatedEpochs[0].epoch, 1);
  assert.equal(rotatedEpochs[0].reason, 'org-offboarded');

  // Verify guardrail: a forged/host departure targeting the page owner is REFUSED
  await host.emitDeparture('owner_acc', ownerDev.identity.publicKey);
  await ownerAdm.refresh();
  assert.equal(ownerAdm.state.epoch, 1, 'Guardrail refuses to auto-revoke owner');
  assert.equal(ownerAdm.state.members.some(m => m.publicKey === ownerDev.identity.publicKey), true);

  // Rekey page-custody K_conn under new epoch 1
  const rekeyCalls = [];
  const rotated = await rekeyAllPageConnections({
    session: ownerSession,
    runtime: { identity: { base: 'https://demo.test/' } },
    epoch: 1,
    fetch: async (url, init) => {
      rekeyCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ rekeyed: true }), { status: 200 });
    },
  });
  assert.deepEqual(rotated, [connId]);
  assert.equal(rekeyCalls[0].body.old_key, initialKConn);
  assert.notEqual(rekeyCalls[0].body.new_key, initialKConn);
  const { value: afterRekey } = await ownerSession.query('pageConnectionKeys', null);
  assert.equal(afterRekey.keys[0].connectionKey, rekeyCalls[0].body.new_key);
  assert.equal(afterRekey.keys[0].epoch, 1);
});
