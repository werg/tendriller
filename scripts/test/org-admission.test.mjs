import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as p from '@chronolog/peer-session';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { createAdmission, deviceWrapKey, openPageAuthority } from '../../session/admission.mjs';
import { authorityRecord, authorityRecordBytes } from '../../contract/authority.mjs';
import { pageConnectionCommands, pageConnectionQueries, rekeyAllPageConnections } from '../../docs/tutorial/shared/helpers/connections.mjs';
import { generateConnectionKey } from '../../contract/connections.mjs';

const definition = p.defineApplication({
  id: 'org-admission-test',
  version: '1',
  commands: pageConnectionCommands,
  queries: pageConnectionQueries,
});

function createInMemoryHost({ applicationId, executionManifestDigest, hostIdentity, ownerAccount }) {
  let bundle = null;
  let groupPolicy = null;
  const pending = new Map();
  const wraps = new Map();
  const groupAttestations = new Map();
  const departures = new Map();

  const encode = v => authorityRecord(p.encodeRecord(v));
  const decode = v => p.decodeRecord(authorityRecordBytes(v));

  const peersFor = accountId => ({
    async application() {
      return {
        selection: { id: applicationId },
        configuration: { executionManifestDigest, executionProfile: 'events-v1', publisherKeys: [] },
        authority: bundle ? encode(bundle) : null,
        hostAttestationKey: hostIdentity.publicKey,
        admissionAccounts: [ownerAccount],
      };
    },
    async initialize(rec) {
      bundle = decode(rec);
      return this.application();
    },
    async membership(rec) {
      bundle = decode(rec);
      return this.application();
    },
    async challenge(publicKey) {
      return { applicationId, publicKey, challenge: '11'.repeat(32), expiresAt: Date.now() + 60_000 };
    },
    async enroll(proofRec) {
      const proof = decode(proofRec);
      const now = BigInt(Date.now());
      const att = await p.signHostAttestation({
        subject: 'device',
        pageId: 'aaaaaaaaaaaa',
        applicationId,
        accountId,
        email: `${accountId}@acme.test`,
        publicKey: proof.payload.publicKey,
        wrapKey: proof.payload.wrapKey,
        label: `Device (${accountId})`,
        inviteId: null,
        issuedAt: now,
        expiresAt: now + 60_000n,
        nonce: p.bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      }, hostIdentity);
      pending.set(proof.payload.publicKey, att);
      if (accountId === 'alice_org') {
        const ga = await p.signRecord('tendriller-group-attestation-v1', {
          pageId: 'aaaaaaaaaaaa',
          applicationId,
          accountId,
          publicKey: proof.payload.publicKey,
          wrapKey: proof.payload.wrapKey,
          group: 'github-team:acme/eng',
          ruleId: 'r_eng',
          role: 'writer',
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }, hostIdentity);
        groupAttestations.set(proof.payload.publicKey, ga);
      }
      return { ...(await this.application()), attestation: encode(att) };
    },
    async admissions() {
      const members = new Set(bundle?.memberships.at(-1)?.payload.members.map(m => m.publicKey) ?? []);
      const pendingList = [...pending.values()].filter(a => !members.has(a.payload.publicKey)).map(encode);
      const wrapped = Object.fromEntries([...wraps.entries()].map(([k, v]) => [k, v.maxEpoch]));
      return { pending: pendingList, wrapped };
    },
    async wrap(rec) {
      const w = decode(rec);
      wraps.set(w.payload.recipient, { record: rec, maxEpoch: Math.max(...w.payload.epochs) });
      return { stored: true, wrapped: {} };
    },
    async wraps(recipient) {
      const entry = wraps.get(recipient);
      return { wraps: entry ? [entry.record] : [] };
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
        applicationId,
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

  const applicationId = '88'.repeat(32);
  const executionManifestDigest = p.bytesToHex((await p.executionManifestArtifacts(await p.eventExecutionManifest())).executionManifestDigest);
  const hostIdentity = await p.createSigningIdentity();
  const host = createInMemoryHost({ applicationId, executionManifestDigest, hostIdentity, ownerAccount: 'owner_acc' });

  // 1. Owner creates genesis page authority & signs group policy for github-team:acme/eng
  const ownerDev = await openNativeDevice({ path: join(dir, 'owner.sqlite'), create: true });
  const ownerWrap = await deviceWrapKey(ownerDev.store);
  const ownerPeers = host.peersFor('owner_acc');
  const { authority: ownerAuth } = await openPageAuthority({
    store: ownerDev.store, identity: ownerDev.identity, wrapKey: ownerWrap,
    peers: ownerPeers, applicationId, executionManifestDigest, create: true,
  });
  const ownerSession = await p.createApplicationSession({ device: ownerDev, definition, authority: ownerAuth });
  const ownerEvents = [];
  const rotatedEpochs = [];
  const ownerAdm = createAdmission(ownerSession, {
    peers: ownerPeers, wrapKey: ownerWrap, store: ownerDev.store,
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
  const { authority: aliceAuth } = await openPageAuthority({
    store: aliceDev.store, identity: aliceDev.identity, wrapKey: aliceWrap,
    peers: alicePeers, applicationId, executionManifestDigest, create: false,
  });
  const aliceSession = await p.createApplicationSession({ device: aliceDev, definition, authority: aliceAuth });
  const aliceAdm = createAdmission(aliceSession, { peers: alicePeers, wrapKey: aliceWrap, store: aliceDev.store });
  t.after(async () => { aliceAdm.close(); await aliceSession.close(); });

  await aliceAdm.refresh();
  assert.equal(aliceAdm.state.phase, 'waiting-admission');

  // Owner refreshes -> automatically verifies signed policy + companion host group attestation -> admits Alice & wraps epoch 0!
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
