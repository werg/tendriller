import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createApplicationSession, openApplicationDevice,
} from '@chronolog/peer-session';
import { MemoryBytesStore } from '@chronolog/peer-session/kernel';
import { createAdmission, createPageGenesis, deviceWrapKey, openPageGenesis } from '../../session/admission.mjs';
import { authorityRecord } from '../../contract/authority.mjs';
import {
  approveMultisig, approveMultisigAndSeal, blockAuthor, describeGovernance,
  proposeMultisig, setOpenAccess, unblockAuthor, verificationCode,
} from '../../docs/tutorial/shared/helpers/governance.mjs';
import { runSessionCommand } from '../../tools/cli/lib/session.mjs';

function noopPeers() {
  return {
    async syncControl() { return { publicOps: [], casNodes: [], checkpoints: [] }; },
    async admissions() { return { pending: [] }; },
    async challenge() { throw new Error('Anonymous openMembers visitor must not call host challenge'); },
    async enroll() { throw new Error('Anonymous openMembers visitor must not call host enroll'); },
  };
}

test('openMembers read-only and open-write pages admit anonymous browsers immediately with accurate security posture', async () => {
  const adminDevice = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const visitorDevice = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const adminWrap = await deviceWrapKey(adminDevice.store);
  const visitorWrap = await deviceWrapKey(visitorDevice.store);

  const created = await createPageGenesis({
    identity: adminDevice.identity,
    wrapKey: adminWrap.publicKey,
    authority: { mode: 'open', openRead: true, openWrite: false },
    topics: { board: { module: 'chronolog/sql' } },
  });
  assert.equal(created.genesis.privateLog, false);

  const adminSession = await createApplicationSession({
    device: adminDevice,
    genesis: created.genesisBytes,
    casNodes: created.casNodes,
  });
  const visitorSession = await createApplicationSession({
    device: visitorDevice,
    genesis: created.genesisBytes,
    casNodes: created.casNodes,
  });

  const admission = createAdmission(visitorSession, {
    peers: noopPeers(),
    wrapKey: visitorWrap,
    store: visitorDevice.store,
  });
  try {
    const st = await admission.refresh();
    assert.equal(st.phase, 'admitted');
    assert.equal(st.authorityMode, 'open');
    assert.equal(st.privateLog, false);
    assert.equal(st.openRead, true);
    assert.equal(st.openWrite, false);
    assert.equal(st.canRead, true);
    assert.equal(st.canWrite, false);
    assert.equal(st.administrator, false);

    const gov = describeGovernance(visitorSession);
    assert.equal(gov.mode, 'open');
    assert.equal(gov.deviatesFromDefaultPrivacy, true);
    assert.equal(gov.tone, 'info');
    assert.equal(gov.badge, 'Public · Read-only');

    // Admin switches to openWrite: true via helper and syncs facts to visitor.
    await setOpenAccess(adminSession, { openRead: true, openWrite: true, operationId: 'open-write-on' });
    const facts = await adminSession.exportFacts();
    await visitorSession.mergeFacts(facts);

    const st2 = await admission.refresh();
    assert.equal(st2.openWrite, true);
    assert.equal(st2.canWrite, true);
    const gov2 = describeGovernance(visitorSession);
    assert.equal(gov2.tone, 'warn');
    assert.equal(gov2.badge, 'Public · Open contributions');

    // CLI permissions set-open toggles back to read-only.
    const cliRes = await runSessionCommand(
      { session: adminSession },
      'permissions',
      ['set-open', JSON.stringify({ openRead: true, openWrite: false })],
      { operation: 'cli-open-ro', wait: 'materialized' },
    );
    assert.equal(cliRes.materialized?.outcome, 'accepted');
    await visitorSession.mergeFacts(await adminSession.exportFacts());
    assert.equal((await admission.refresh()).openWrite, false);
  } finally {
    admission.close();
    await adminSession.close();
    await visitorSession.close();
    await adminDevice.close();
    await visitorDevice.close();
  }
});

test('multisigMembers 2-of-2 governance requires second signer approval via helper and CLI', async () => {
  const signerA = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const signerB = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const newcomer = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const wrapA = await deviceWrapKey(signerA.store);
  const wrapB = await deviceWrapKey(signerB.store);
  const wrapNew = await deviceWrapKey(newcomer.store);

  const created = await createPageGenesis({
    identity: signerA.identity,
    wrapKey: wrapA.publicKey,
    authority: { mode: 'multisig', signers: [signerA.identity.publicKey, signerB.identity.publicKey], threshold: 2 },
    privateLog: false,
  });

  const sessionA = await createApplicationSession({ device: signerA, genesis: created.genesisBytes, casNodes: created.casNodes });
  const sessionB = await createApplicationSession({ device: signerB, genesis: created.genesisBytes, casNodes: created.casNodes });
  try {
    const gov = describeGovernance(sessionA);
    assert.equal(gov.mode, 'multisig');
    assert.equal(gov.threshold, 2);
    assert.equal(gov.signerCount, 2);
    assert.equal(gov.deviatesFromDefaultPrivacy, true);

    await proposeMultisig(sessionA, {
      proposalId: 'add-newcomer',
      kind: 'setMember',
      member: {
        publicKey: newcomer.identity.publicKey,
        wrapKey: wrapNew.publicKey,
        reader: true,
        writer: true,
        administrator: false,
        publisher: false,
        finalizer: false,
      },
    }, { operationId: 'ms-prop-1' });

    // Before second approval, newcomer is not a member yet.
    assert.equal(sessionA.isWriter(newcomer.identity.publicKey), false);
    assert.equal(describeGovernance(sessionA).pendingProposals, 1);

    await sessionB.mergeFacts(await sessionA.exportFacts());
    const approved = await runSessionCommand(
      { session: sessionB },
      'permissions',
      ['multisig-approve', 'add-newcomer'],
      { operation: 'ms-approve-1', wait: 'materialized' },
    );
    assert.equal(approved.materialized?.outcome, 'accepted');
    await sessionA.mergeFacts(await sessionB.exportFacts());

    assert.equal(sessionA.isWriter(newcomer.identity.publicKey), true);
    assert.equal(sessionB.isWriter(newcomer.identity.publicKey), true);
    assert.equal(describeGovernance(sessionA).pendingProposals, 0);

    // Deterministic 6-digit out-of-band verification code matches across peers
    const code1 = await verificationCode(created.logId, newcomer.identity.publicKey, wrapB.publicKey);
    const code2 = await verificationCode(created.logId, newcomer.identity.publicKey, wrapB.publicKey);
    assert.match(code1, /^\d{3}-\d{3}$/);
    assert.equal(code1, code2);
    assert.equal(typeof approveMultisigAndSeal, 'function');
  } finally {
    await sessionA.close();
    await sessionB.close();
    await signerA.close();
    await signerB.close();
    await newcomer.close();
  }
});

test('openPageGenesis reopens cached initialized genesis offline without touching host, and governance surfaces Hosted MCP + blockedAuthors', async () => {
  const dev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const spammer = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const wrap = await deviceWrapKey(dev.store);
  const appId = 'ab'.repeat(32);

  // 1. First open initializes genesis against mock host
  let storedGenesis = null;
  let appCalls = 0;
  const peers = {
    async application() {
      appCalls++;
      return {
        selection: { id: appId },
        genesis: storedGenesis,
        hostAttestationKey: '11'.repeat(32),
        admissionAccounts: ['acct_1'],
      };
    },
    async initialize({ genesis }) {
      storedGenesis = genesis;
      return { selection: { id: appId }, genesis, hostAttestationKey: '11'.repeat(32), admissionAccounts: ['acct_1'] };
    },
    async syncControl() { return { publicOps: [], casNodes: [], checkpoints: [] }; },
  };
  const first = await openPageGenesis({
    store: dev.store,
    identity: dev.identity,
    wrapKey: wrap,
    peers,
    applicationId: appId,
    authority: { mode: 'open', openRead: true, openWrite: true },
    topics: { db: { module: 'chronolog/sql' } },
  });
  assert.equal(first.created, true);
  assert.equal(appCalls, 1);

  // 2. Reopening uses local cache IMMEDIATELY without invoking peers.application() even when offline!
  const offlinePeers = {
    async application() { throw new Error('MUST_NOT_HIT_NETWORK_WHEN_CACHED'); },
    async syncControl() { throw new Error('MUST_NOT_HIT_NETWORK_WHEN_CACHED'); },
  };
  const cached = await openPageGenesis({
    store: dev.store,
    identity: dev.identity,
    wrapKey: wrap,
    peers: offlinePeers,
    applicationId: appId,
  });
  assert.equal(cached.fromCache, true);
  assert.equal(cached.logId, first.logId);

  // 3. Moderation (blockAuthor / unblockAuthor) + Hosted MCP honest badge
  const session = await createApplicationSession({ device: dev, genesis: first.genesisBytes, casNodes: first.casNodes });
  try {
    await blockAuthor(session, spammer.identity.publicKey, { reason: 'spam', operationId: 'blk-1' });
    assert.deepEqual(describeGovernance(session).blockedAuthors, [spammer.identity.publicKey]);
    assert.match(describeGovernance(session).title, /1 blocked key/);
    await unblockAuthor(session, spammer.identity.publicKey, { operationId: 'unblk-1' });
    assert.deepEqual(describeGovernance(session).blockedAuthors, []);

    // Private E2EE page with Hosted MCP active surfaces explicit security notice
    const privDev = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    const privWrap = await deviceWrapKey(privDev.store);
    const privCreated = await createPageGenesis({
      identity: privDev.identity,
      wrapKey: privWrap.publicKey,
      hostKey: '11'.repeat(32),
      accounts: ['acct_1'],
      privateLog: true,
    });
    const privSession = await createApplicationSession({
      device: privDev,
      genesis: privCreated.genesisBytes,
      casNodes: privCreated.casNodes,
      epochKeys: new Map([[0, privCreated.epoch0Key]]),
    });
    try {
      const normal = describeGovernance(privSession, { hostedMcpCount: 0 });
      assert.equal(normal.deviatesFromDefaultPrivacy, false);
      const hosted = describeGovernance(privSession, { hostedMcpCount: 1 });
      assert.equal(hosted.hostedMcpActive, true);
      assert.equal(hosted.deviatesFromDefaultPrivacy, true);
      assert.match(hosted.securityNote, /RAM during OAuth \/mcp requests/);
    } finally {
      await privSession.close();
      await privDev.close();
    }
  } finally {
    await session.close();
    await dev.close();
    await spammer.close();
  }
});
