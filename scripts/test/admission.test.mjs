// Chronolog v2 page genesis and admission flows over the admission wire contract, with real
// Chronolog v2 sessions, Ed25519 signatures, HPKE lockboxes, and a blind TopicKernel host.
// The host double never holds data keys and never signs membership.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToHex, createApplicationSession, createSigningIdentity, defineApplication, defineCommand,
  defineQuery, encodeSignedOperation, hexToBytes, openApplicationDevice, signOperationCore,
} from '@chronolog/peer-session';
import { createAdmission, openPageGenesis } from '../../session/admission.mjs';
import { authorityRecord } from '../../contract/authority.mjs';
import { createAdmissionHost } from './helpers/admission-host.mjs';

class MemoryStore {
  #map = new Map();
  async get(key) { return this.#map.get(key)?.slice() ?? null; }
  async put(key, value) { this.#map.set(key, value.slice()); }
  async delete(key) { this.#map.delete(key); }
  async initialize(entries) { for (const entry of entries) if (!this.#map.has(entry.key)) this.#map.set(entry.key, entry.value.slice()); }
}

const MESSAGE_REDUCER = `
export default {
  reduce(state, tx) {
    const list = Array.isArray(state) ? [...state] : [];
    list.push({ text: tx.payload, author: tx.author, opId: tx.opId });
    return { ok: true, state: list, events: [{ topic: 'message', payload: tx.payload }] };
  },
  query(state) { return Array.isArray(state) ? state : []; },
};
`;

const definition = defineApplication({
  id: 'admission-test',
  version: '1',
  commands: {
    say: defineCommand({
      description: 'Say',
      input: { type: 'string' },
      prepare: text => [{ topic: 'messages', input: text }],
    }),
  },
  queries: {
    messages: defineQuery({
      description: 'Messages',
      input: { type: 'null' },
      read: view => view.readEvents(),
    }),
  },
});

const imports = { 'app/messages': MESSAGE_REDUCER };
const topics = { messages: { module: 'app/messages' } };

const until = async (predicate, label, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

async function world({ owner } = {}) {
  const host = await createAdmissionHost({ ...(owner ? { owner } : {}) });
  const opened = [];
  async function participant({ principal, subject = 'device', create = true, signer, store = new MemoryStore(), ownerGrant } = {}) {
    const device = await openApplicationDevice({ store, create: true, ...(signer ? { managedSigner: signer } : {}) });
    const wrapKey = device.wrapKey;
    const peers = host.client(principal);
    const openedGenesis = await openPageGenesis({
      store: device.store,
      identity: device.identity,
      wrapKey,
      peers,
      applicationId: host.state.applicationId,
      create,
      imports,
      topics,
      ...(ownerGrant ? { ownerGrant } : {}),
    });
    const session = await createApplicationSession({
      device,
      definition,
      genesis: openedGenesis.genesisBytes,
      casNodes: openedGenesis.casNodes,
      publicOps: openedGenesis.publicOps,
      ...(openedGenesis.epoch0Key ? { epochKeys: new Map([[0, openedGenesis.epoch0Key]]) } : {}),
    });
    const admission = createAdmission(session, {
      peers,
      wrapKey,
      store: device.store,
      subject,
      memberIntervalMs: 50,
      waitingIntervalMs: 20,
    });
    const value = {
      device,
      session,
      admission,
      peers,
      created: openedGenesis.created,
      wrapKey,
      store,
      close: async () => { admission.close(); await session.close(); },
    };
    opened.push(value);
    return value;
  }
  const close = async () => { for (const value of opened.splice(0).reverse()) await value.close().catch(() => {}); };
  return { host, participant, close };
}

const owner = { account: { accountId: 'acct_owner', email: 'owner@example.test' } };
const relay = async (from, to) => {
  await to.session.mergeFacts(await from.session.exportFacts());
  await to.session.retryMaterialization();
};
const messages = async participant => (await participant.session.readEvents({ topics: ['message'] })).events.map(event => event.payload);

test('agent-first: the agent creates keys and imports data before any browser; the browser is auto-admitted and reads everything', async () => {
  const w = await world();
  try {
    const signer = await createSigningIdentity();
    const agent = await w.participant({ principal: { agent: { publicKey: signer.publicKey } }, subject: 'agent', signer });
    assert.equal(agent.created, true);
    assert.equal(agent.session.status.canAuthor, true);
    const perms = agent.session.permissions();
    assert.equal(perms.members[0].publicKey, signer.publicKey);
    assert.deepEqual(perms.admission.accounts, ['acct_owner', 'email:owner@example.test']);
    assert.deepEqual(perms.admission.grant, { reader: true, writer: true, administrator: true }, 'the signed genesis policy states the owner-device grant explicitly');
    assert.deepEqual(agent.admission.state.ownerGrant, { reader: true, writer: true, administrator: true });

    const imported = await agent.session.command('say', 'imported by the agent', { operationId: 'import-1' });
    await imported.materialized();

    const browser = await w.participant({ principal: owner });
    assert.equal(browser.created, false);
    assert.equal(browser.session.status.canAuthor, false);
    await until(() => browser.admission.state.phase === 'admitted', 'browser admitted');
    assert.equal(browser.session.status.canAuthor, true);
    const self = browser.session.member(browser.device.identity.publicKey);
    assert.deepEqual(
      { reader: self.reader, writer: self.writer, administrator: self.administrator, wrapKey: self.wrapKey },
      { reader: true, writer: true, administrator: true, wrapKey: browser.wrapKey.publicKey },
    );
    await until(() => agent.admission.state.notices.some(n => n.kind === 'new-device' && n.publicKey === browser.device.identity.publicKey), 'agent saw new device');
    await relay(agent, browser);
    assert.deepEqual(await messages(browser), ['imported by the agent']);

    // Offline Save on the admitted device needs no peer, agent or host.
    const offline = await browser.session.command('say', 'browser offline', { operationId: 'browser-1' });
    await offline.materialized();
    await relay(browser, agent);
    assert.deepEqual((await messages(agent)).sort(), ['browser offline', 'imported by the agent']);

    // Both devices list the same admitted members from signed state.
    assert.deepEqual(
      browser.admission.state.members.map(m => m.publicKey).sort(),
      agent.admission.state.members.map(m => m.publicKey).sort(),
    );
  } finally { await w.close(); }
});

test('browser-first: the owner browser creates; the agent is admitted from its signed host grant and picks up keys', async () => {
  const w = await world();
  try {
    const browser = await w.participant({ principal: owner });
    assert.equal(browser.created, true);
    assert.equal(browser.session.permissions().members[0].publicKey, browser.device.identity.publicKey);
    const note = await browser.session.command('say', 'browser first', { operationId: 'b-1' });
    await note.materialized();

    const signer = await createSigningIdentity(), store = new MemoryStore();
    const agentDevice = await openApplicationDevice({ store, create: true, managedSigner: signer });
    const agentWrap = agentDevice.wrapKey;
    await agentDevice.close();
    await w.host.grantAgent({ publicKey: signer.publicKey, wrapKey: agentWrap.publicKey, handle: 'atlas' });

    const agent = await w.participant({ principal: { agent: { publicKey: signer.publicKey } }, subject: 'agent', signer, store, create: false });
    await until(() => agent.admission.state.phase === 'admitted', 'agent admitted');
    // Agents admitted from a signed host grant keep editor rights; they never become administrators automatically.
    const agentGrant = agent.session.member(signer.publicKey);
    assert.deepEqual([agentGrant.reader, agentGrant.writer, agentGrant.administrator], [true, true, false]);
    await relay(browser, agent);
    assert.deepEqual(await messages(agent), ['browser first']);
  } finally { await w.close(); }
});

test('concurrent admission by two members is idempotent and converges on identical signed member sets', async () => {
  const w = await world();
  try {
    const first = await w.participant({ principal: owner });
    const second = await w.participant({ principal: owner });
    await until(() => second.admission.state.phase === 'admitted', 'second admitted');
    // Both members race to admit the third device.
    const third = await w.participant({ principal: owner });
    await Promise.all([first.admission.refresh(), second.admission.refresh()]);
    await until(() => third.admission.state.phase === 'admitted', 'third admitted');
    await Promise.all([first.admission.refresh(), second.admission.refresh(), third.admission.refresh()]);
    const expected = [first, second, third].map(p => p.device.identity.publicKey).sort();
    assert.deepEqual(w.host.state.control.permissions.members.map(m => m.publicKey).sort(), expected);
    for (const p of [first, second, third]) {
      assert.deepEqual(p.session.permissions().members.map(m => m.publicKey).sort(), expected);
    }
  } finally { await w.close(); }
});

test('with no key holder online the newcomer waits, retries and is admitted once a holder returns', async () => {
  const w = await world();
  try {
    const creator = await w.participant({ principal: owner });
    creator.admission.close(); // the only holder goes offline
    const newcomer = await w.participant({ principal: owner });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(newcomer.admission.state.phase, 'waiting-admission');
    assert.equal(newcomer.session.status.canAuthor, false);
    assert.ok(newcomer.admission.state.attestationExpiresAt > Date.now(), 'a fresh attestation is retained while waiting');
    const back = createAdmission(creator.session, { peers: creator.peers, wrapKey: creator.wrapKey, store: creator.store, memberIntervalMs: 50 });
    try { await until(() => newcomer.admission.state.phase === 'admitted', 'admitted after holder returned'); }
    finally { back.close(); }
  } finally { await w.close(); }
});

test('remove device writes a signed revocation and rotates; the removed device cannot read new data and is not auto-readmitted', async () => {
  const w = await world();
  try {
    // Owner devices join as editors on this page, so only the creator administers it.
    const admin = await w.participant({ principal: owner, ownerGrant: 'writer' });
    const kept = await w.participant({ principal: owner });
    const lost = await w.participant({ principal: owner });
    await until(() => kept.admission.state.phase === 'admitted' && lost.admission.state.phase === 'admitted', 'both admitted');
    assert.equal(kept.session.member(kept.device.identity.publicKey).administrator, false);
    await assert.rejects(kept.admission.call('admission.remove', lost.device.identity.publicKey), { code: 'ADMINISTRATOR_REQUIRED' });
    await assert.rejects(kept.admission.call('admission.ownerGrant', 'admin'), { code: 'ADMINISTRATOR_REQUIRED' });

    const result = await admin.admission.call('admission.remove', lost.device.identity.publicKey);
    assert.equal(result.epoch, 1);
    await until(() => kept.session.hasEpochKey(1), 'remaining member received the new epoch key');
    await until(() => lost.admission.state.phase === 'removed', 'removed device sees removal');
    assert.equal(lost.session.hasEpochKey(1), false);
    assert.equal(lost.session.status.canAuthor, false);

    const secret = await kept.session.command('say', 'after rotation', { operationId: 'k-1' });
    await secret.materialized();
    // It holds no new-epoch key, and as a non-member it cannot decrypt the new-epoch envelope.
    await lost.session.mergeFacts(await kept.session.exportFacts());
    await lost.session.retryMaterialization();
    assert.ok(!(await messages(lost)).includes('after rotation'));

    // Even a fresh host attestation for the removed key is never auto-admitted.
    await w.host.forge({ subject: 'device', accountId: 'acct_owner', email: 'owner@example.test', publicKey: lost.device.identity.publicKey, wrapKey: lost.wrapKey.publicKey, label: 'again' });
    await admin.admission.refresh();
    await kept.admission.refresh();
    assert.equal(admin.session.member(lost.device.identity.publicKey), null);
    assert.ok(admin.admission.state.pending.some(entry => entry.publicKey === lost.device.identity.publicKey && entry.reason === 'previously_removed'));
  } finally { await w.close(); }
});

test('strict mode keeps an attested device pending until an administrator approves it', async () => {
  const w = await world();
  try {
    const admin = await w.participant({ principal: owner });
    await admin.admission.call('admission.mode', 'strict');
    assert.equal(admin.session.permissions().admission.mode, 'strict');
    const phone = await w.participant({ principal: owner });
    await until(() => admin.admission.state.pending.some(entry => entry.publicKey === phone.device.identity.publicKey), 'admin sees pending device');
    await admin.admission.refresh();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(phone.admission.state.phase, 'waiting-approval');
    assert.equal(admin.session.member(phone.device.identity.publicKey), null);
    assert.ok(admin.admission.state.notices.some(n => n.kind === 'pending' && n.publicKey === phone.device.identity.publicKey));

    await admin.admission.call('admission.approve', phone.device.identity.publicKey);
    await until(() => phone.admission.state.phase === 'admitted', 'approved device admitted');
    // Without flags an approved owner-account device receives the policy grant, administrator included.
    assert.equal(admin.session.member(phone.device.identity.publicKey).administrator, true);

    // Flags still choose narrower rights, and another account's device is never an administrator by default.
    const tablet = await w.participant({ principal: owner });
    const guest = await w.participant({ principal: { account: { accountId: 'acct_guest', email: 'guest@example.test' } } });
    await until(() => [tablet, guest].every(item => admin.admission.state.pending.some(entry => entry.publicKey === item.device.identity.publicKey)), 'admin sees both pending');
    await admin.admission.call('admission.approve', tablet.device.identity.publicKey, { administrator: false });
    await admin.admission.call('admission.approve', guest.device.identity.publicKey);
    const tabletGrant = admin.session.member(tablet.device.identity.publicKey);
    const guestGrant = admin.session.member(guest.device.identity.publicKey);
    assert.deepEqual([tabletGrant.writer, tabletGrant.administrator, guestGrant.writer, guestGrant.administrator], [true, false, true, false]);
  } finally { await w.close(); }
});

test('owner-account devices admitted by attestation are administrators by default; the policy grant is configurable', async () => {
  const w = await world();
  try {
    const creator = await w.participant({ principal: owner });
    const laptop = await w.participant({ principal: owner });
    await until(() => laptop.admission.state.phase === 'admitted', 'laptop admitted');
    assert.equal(laptop.session.member(laptop.device.identity.publicKey).administrator, true);
    assert.equal(laptop.admission.state.administrator, true);

    // The attested administrator administers the page from its own device.
    await laptop.admission.call('admission.ownerGrant', 'writer');
    await until(() => creator.session.permissions().admission.grant.administrator === false, 'creator sees the narrowed grant');
    assert.deepEqual(laptop.session.permissions().admission.grant, { reader: true, writer: true, administrator: false });
    await assert.rejects(laptop.admission.call('admission.ownerGrant', 'owner'), { code: 'ADMISSION_GRANT_INVALID' });

    const phone = await w.participant({ principal: owner });
    await until(() => phone.admission.state.phase === 'admitted', 'phone admitted');
    await until(() => creator.session.member(phone.device.identity.publicKey) !== null, 'creator sees phone');
    const grant = creator.session.member(phone.device.identity.publicKey);
    assert.deepEqual([grant.reader, grant.writer, grant.administrator], [true, true, false]);
  } finally { await w.close(); }
});

test('the host cannot admit: it has no membership key, and its attestation of another account is never auto-admitted', async () => {
  const w = await world();
  try {
    const admin = await w.participant({ principal: owner });
    const intruder = await createSigningIdentity();
    // Even if the host signs a $permissions op with its own key, the deterministic $permissions
    // reducer rejects non-administrator authors!
    const forged = await signOperationCore({
      version: 1,
      logId: hexToBytes(admin.session.applicationId),
      author: hexToBytes(w.host.host.publicKey),
      authorTimestampMs: BigInt(Date.now() + 1000),
      operationId: 'forged-host-admit',
      nonce: crypto.getRandomValues(new Uint8Array(16)),
      visibility: 'public',
      updates: [{
        topic: '$permissions',
        input: {
          action: 'setMember',
          member: { publicKey: intruder.publicKey, wrapKey: 'ab'.repeat(32), reader: true, writer: true, administrator: true, publisher: false, finalizer: false },
        },
      }],
    }, w.host.host.privateKey);
    await w.host.client(owner).syncControl({ publicOps: [authorityRecord(encodeSignedOperation(forged))] });
    assert.equal(w.host.state.control.permissions.members.some(m => m.publicKey === intruder.publicKey), false);

    // A host-signed attestation without the owner account stays pending in attested mode.
    await w.host.forge({ subject: 'device', accountId: 'acct_stranger', email: 'stranger@example.test', publicKey: intruder.publicKey, wrapKey: 'cd'.repeat(32), label: 'stranger' });
    await admin.admission.refresh();
    assert.equal(admin.session.member(intruder.publicKey), null);
    assert.equal(admin.admission.state.pending.find(entry => entry.publicKey === intruder.publicKey)?.reason, 'account_not_authorized');

    // Strict mode: not even an owner-account attestation admits without approval.
    await admin.admission.call('admission.mode', 'strict');
    const other = await createSigningIdentity();
    await w.host.forge({ subject: 'device', accountId: 'acct_owner', email: 'owner@example.test', publicKey: other.publicKey, wrapKey: 'ef'.repeat(32), label: 'owner?' });
    await admin.admission.refresh();
    assert.equal(admin.session.member(other.publicKey), null);
  } finally { await w.close(); }
});

test('invites: email, single-use and public links admit with their role through the same attestation path', async () => {
  const w = await world();
  try {
    const admin = await w.participant({ principal: owner });
    const emailInvite = await admin.admission.call('admission.invite', { binding: { kind: 'email', email: 'Friend@Example.test' }, role: 'reader' });
    const openInvite = await admin.admission.call('admission.invite', { binding: { kind: 'open' }, role: 'writer' });
    const publicInvite = await admin.admission.call('admission.invite', { binding: { kind: 'public', max: 1 } });
    assert.equal(publicInvite.role, 'reader');
    assert.ok(!JSON.stringify(admin.session.permissions()).includes(openInvite.fragment.split('.')[1]), 'state holds only the secret digest');

    const friend = await w.participant({ principal: { account: { accountId: 'acct_friend', email: 'friend@example.test' } } });
    await friend.admission.call('admission.redeem', `#${emailInvite.fragment}`);
    await until(() => friend.admission.state.phase === 'admitted', 'email invitee admitted');
    await until(() => admin.session.member(friend.device.identity.publicKey) !== null, 'admin sees the email admission');
    const friendGrant = admin.session.member(friend.device.identity.publicKey);
    assert.deepEqual([friendGrant.reader, friendGrant.writer, friendGrant.administrator], [true, false, false]);

    const mallory = await w.participant({ principal: { account: { accountId: 'acct_mallory', email: 'mallory@example.test' } } });
    await mallory.admission.call('admission.redeem', emailInvite.fragment);
    assert.equal(mallory.admission.state.error, 'invite_email_mismatch');

    const a = await w.participant({ principal: { account: { accountId: 'acct_a', email: null } } });
    await a.admission.call('admission.redeem', openInvite.fragment);
    await until(() => a.admission.state.phase === 'admitted', 'open invitee admitted');
    await until(() => admin.session.member(a.device.identity.publicKey) !== null, 'admin sees the open admission');
    assert.equal(admin.session.member(a.device.identity.publicKey).writer, true);

    const b = await w.participant({ principal: { account: { accountId: 'acct_b', email: null } } });
    await b.admission.call('admission.redeem', openInvite.fragment);
    assert.equal(b.admission.state.error, 'invite_redeemed');

    // A misbehaving host's second redemption of a single-use invite is never auto-admitted.
    await w.host.forge({ subject: 'device', accountId: 'acct_b', email: null, publicKey: b.device.identity.publicKey, wrapKey: b.wrapKey.publicKey, label: 'double', inviteId: openInvite.inviteId });
    await admin.admission.refresh();
    assert.equal(admin.session.member(b.device.identity.publicKey), null);
    assert.equal(admin.admission.state.pending.find(entry => entry.publicKey === b.device.identity.publicKey)?.reason, 'invite_already_redeemed');
    assert.equal(admin.admission.state.invites.find(item => item.inviteId === openInvite.inviteId).redemptions, 1);

    const p1 = await w.participant({ principal: { account: { accountId: 'acct_p1', email: null } } });
    await p1.admission.call('admission.redeem', publicInvite.fragment);
    await until(() => p1.admission.state.phase === 'admitted', 'public invitee admitted');

    const p2 = await w.participant({ principal: { account: { accountId: 'acct_p2', email: null } } });
    await p2.admission.call('admission.redeem', publicInvite.fragment);
    assert.equal(p2.admission.state.error, 'invite_exhausted');

    await admin.admission.call('admission.revokeInvite', emailInvite.inviteId);
    const late = await w.participant({ principal: { account: { accountId: 'acct_friend', email: 'friend@example.test' } } });
    await late.admission.call('admission.redeem', emailInvite.fragment);
    assert.equal(late.admission.state.error, 'invite_revoked');
    await assert.rejects(friend.admission.call('admission.invite', { binding: { kind: 'open' } }), { code: 'ADMINISTRATOR_REQUIRED' });
  } finally { await w.close(); }
});

test('an unclaimed page pins the intended owner email and admits that account’s browser', async () => {
  const w = await world({ owner: { accountId: 'pending:abcdefghijkl', email: 'owner@example.test' } });
  try {
    const signer = await createSigningIdentity();
    const agent = await w.participant({ principal: { agent: { publicKey: signer.publicKey } }, subject: 'agent', signer });
    assert.ok(agent.session.permissions().admission.accounts.includes('email:owner@example.test'));
    const browser = await w.participant({ principal: { account: { accountId: 'acct_new_owner', email: 'owner@example.test' } } });
    await until(() => browser.admission.state.phase === 'admitted', 'owner by email admitted');
  } finally { await w.close(); }
});

test('createPageGenesis supports pluggable multisig and open authority modes without host attestation', async () => {
  const { createPageGenesis } = await import('../../session/admission.mjs');
  const creator = await createSigningIdentity();
  const peer2 = await createSigningIdentity();
  const wrap = await (await import('@chronolog/peer-session')).createWrapKeyPair();

  const ms = await createPageGenesis({
    identity: creator,
    wrapKey: wrap.publicKey,
    authority: { mode: 'multisig', signers: [peer2.publicKey], threshold: 2 },
  });
  assert.equal(ms.genesis.privateLog, true);
  assert.equal(ms.genesis.initialTopics.$reducers.topics.$permissions.export, 'multisigMembers');
  assert.equal(ms.genesis.initialTopics.$permissions.threshold, 2);
  assert.deepEqual(ms.genesis.initialTopics.$permissions.signers, [creator.publicKey, peer2.publicKey]);
  assert.equal(ms.genesis.initialTopics.$permissions.admission, null);

  const open = await createPageGenesis({
    identity: creator,
    wrapKey: wrap.publicKey,
    authority: { mode: 'open' },
  });
  assert.equal(open.genesis.privateLog, false);
  assert.equal(open.genesis.initialTopics.$reducers.topics.$permissions.export, 'openMembers');
  assert.equal(open.genesis.initialTopics.$permissions.openWrite, true);
  assert.equal(open.genesis.initialTopics.$permissions.admission, null);
});

test('admission surfaces a rejected notice when a pending attestation fails host-key verification', async () => {
  const w = await world();
  try {
    const admin = await w.participant({ principal: owner });
    const rogue = await createSigningIdentity();
    const rogueAtt = await (await import('@chronolog/authority')).signHostAttestationV2({
      subject: 'device',
      pageId: 'test',
      applicationId: admin.session.logId,
      accountId: 'acct_owner',
      email: 'owner@example.test',
      publicKey: rogue.publicKey,
      wrapKey: 'ab'.repeat(32),
      label: 'Bad-host device',
      inviteId: null,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      nonce: '00'.repeat(32),
    }, rogue);
    const { authorityRecord } = await import('../../contract/authority.mjs');
    const { encodeRecord } = await import('@chronolog/authority');
    w.host.state.pending.set(rogue.publicKey, authorityRecord(encodeRecord(rogueAtt)));
    await admin.admission.refresh();
    assert.ok(
      admin.admission.state.notices.some(n => n.kind === 'rejected' && n.publicKey === rogue.publicKey && n.reason === 'attestation_signature_invalid'),
      'rejected notice must surface host-key signature mismatch',
    );
  } finally { await w.close(); }
});
