// An in-memory host that follows the page admission wire contract
// (docs/SESSION_BOOTSTRAP.md#admission-wire-contract): it attests account-bound key
// proofs, carries signed records and verifies them, and never signs membership.
import { createSigningIdentity, signHostAttestation, verifyAuthorityBundle, verifyEnrollmentRequest, verifyRecord, decodeRecord, encodeRecord, recordDigest, bytesToHex, inviteCapacity } from '@chronolog/peer-session';
import { authorityRecord, authorityRecordBytes } from '../../../contract/authority.mjs';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const decode = value => decodeRecord(authorityRecordBytes(value));
const record = value => authorityRecord(encodeRecord(value));
const sha256 = async bytes => bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

export async function createAdmissionHost({ applicationId, configuration, owner = { accountId: 'acct_owner', email: 'owner@example.test' }, now = () => Date.now(), windowMs = 3_600_000 }) {
  const host = await createSigningIdentity();
  const state = { authority: null, pending: new Map(), wraps: new Map(), challenges: new Map(), redemptions: [], agents: new Map(), notified: 0 };
  const admissionAccounts = [owner.accountId, ...(owner.email ? [`email:${owner.email}`] : [])];
  const metadata = () => ({ selection: { id: applicationId }, configuration, publicationAuthority: null, authority: state.authority, hostAttestationKey: host.publicKey, admissionAccounts });
  const bundle = () => state.authority === null ? null : decode(state.authority);
  const head = () => bundle()?.memberships.at(-1).payload ?? null;
  const isMember = publicKey => head()?.members.some(member => member.publicKey === publicKey) ?? false;
  const notify = () => { state.notified++; };
  // Like the page Durable Object, host privileges are serialized; signed records decide.
  let tail = Promise.resolve();
  const serial = work => { const task = tail.then(work); tail = task.catch(() => {}); return task; };
  const attest = async (payload) => {
    const time = BigInt(now()), attestation = await signHostAttestation({ pageId: 'abcdefghijkl', applicationId, issuedAt: time, expiresAt: time + BigInt(windowMs), nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), inviteId: null, ...payload }, host);
    if (!isMember(payload.publicKey)) { state.pending.set(payload.publicKey, record(attestation)); notify(); }
    return { ...metadata(), attestation: record(attestation) };
  };
  async function redeem(invite, account, publicKey) {
    const value = head()?.invites.find(item => item.inviteId === invite.inviteId);
    if (!value) fail(404, 'invite_unknown');
    if (value.revoked) fail(410, 'invite_revoked');
    if (BigInt(now()) >= value.expiresAt) fail(410, 'invite_expired');
    if (await sha256(Uint8Array.from(invite.secret.match(/../g), byte => parseInt(byte, 16))) !== value.secretDigest) fail(403, 'invite_secret_invalid');
    if (value.binding.kind === 'email' && account.email !== value.binding.email) fail(403, 'invite_email_mismatch');
    const prior = state.redemptions.filter(item => item.inviteId === value.inviteId), accounts = new Set(prior.map(item => item.accountId));
    if (!accounts.has(account.accountId) && accounts.size >= inviteCapacity(value)) fail(409, value.binding.kind === 'public' ? 'invite_exhausted' : 'invite_redeemed');
    state.redemptions.push({ inviteId: value.inviteId, accountId: account.accountId, publicKey });
  }
  /** A page principal: `{ account }` for a signed-in browser, `{ agent }` for a granted agent. */
  function client(principal) {
    return Object.freeze({
      async application() { return metadata(); },
      async challenge(publicKey) {
        if (!principal.account) fail(403, 'browser_account_required');
        const challenge = crypto.randomUUID(); state.challenges.set(challenge, { publicKey, accountId: principal.account.accountId });
        return { applicationId, publicKey, challenge, expiresAt: now() + 300_000 };
      },
      async enroll(proof, invite) {
        if (!principal.account) fail(403, 'browser_account_required');
        const signed = decode(proof); await verifyEnrollmentRequest(signed);
        const challenge = state.challenges.get(signed.payload.challenge);
        if (!challenge || challenge.publicKey !== signed.payload.publicKey || challenge.accountId !== principal.account.accountId || signed.payload.applicationId !== applicationId) fail(403, 'enrollment_challenge_invalid');
        state.challenges.delete(signed.payload.challenge);
        if (invite) await redeem(invite, principal.account, signed.payload.publicKey);
        return attest({ subject: 'device', accountId: principal.account.accountId, email: principal.account.email ?? null, publicKey: signed.payload.publicKey, wrapKey: signed.payload.wrapKey, label: principal.label ?? 'Browser device', inviteId: invite?.inviteId ?? null });
      },
      async enrollAgent() {
        const agent = principal.agent && state.agents.get(principal.agent.publicKey);
        if (!agent) fail(403, 'agent_grant_required');
        return attest({ subject: 'agent', accountId: owner.accountId, email: owner.email ?? null, publicKey: agent.publicKey, wrapKey: agent.wrapKey, label: `@${agent.handle}` });
      },
      initialize: value => serial(async () => {
        if (state.authority !== null) { if (JSON.stringify(value) === JSON.stringify(state.authority)) return metadata(); fail(409, 'application_initialized'); }
        const proposed = decode(value); await verifyAuthorityBundle(proposed);
        const descriptor = proposed.descriptor.payload, genesis = proposed.memberships[0].payload;
        if (proposed.memberships.length !== 1 || descriptor.authorityPublicKey !== descriptor.rootPrincipal || genesis.admission.hostKey !== host.publicKey || !admissionAccounts.every(account => genesis.admission.accounts.includes(account))) fail(400, 'genesis_invalid');
        if (principal.agent ? principal.agent.publicKey !== descriptor.rootPrincipal : principal.account?.accountId !== owner.accountId) fail(403, 'owner_required');
        state.authority = value; notify(); return metadata();
      }),
      membership: value => serial(async () => {
        const current = bundle(); if (!current) fail(409, 'application_uninitialized');
        const proposed = decode(value);
        await verifyAuthorityBundle(proposed, current.descriptor).catch(error => fail(403, String(error.code ?? error.message).toLowerCase()));
        if (proposed.memberships.length !== current.memberships.length + 1) fail(400, 'membership_extension_required');
        for (let index = 0; index < current.memberships.length; index++) if (await recordDigest(proposed.memberships[index]) !== await recordDigest(current.memberships[index])) fail(409, 'membership_head_changed');
        state.authority = value;
        for (const publicKey of state.pending.keys()) if (isMember(publicKey)) state.pending.delete(publicKey);
        notify(); return metadata();
      }),
      async admissions() {
        const time = BigInt(now()), pending = [];
        for (const [publicKey, item] of state.pending) { if (decode(item).payload.expiresAt <= time || isMember(publicKey)) state.pending.delete(publicKey); else pending.push(item); }
        const wrapped = {};
        for (const [recipient, list] of state.wraps) wrapped[recipient] = Math.max(...list.map(item => Math.max(...decode(item).payload.epochs)));
        return { pending, wrapped };
      },
      async wrap(value) {
        const signed = decode(value); await verifyRecord('key-wrap', signed);
        if (!isMember(signed.signer) || !isMember(signed.payload.recipient)) fail(403, 'key_wrap_member_required');
        const list = [...(state.wraps.get(signed.payload.recipient) ?? []), value].slice(-4); state.wraps.set(signed.payload.recipient, list); notify();
        return { ok: true };
      },
      async wraps(recipient) { return { wraps: [...(state.wraps.get(recipient) ?? [])].reverse() }; },
    });
  }
  return Object.freeze({ host, state, client,
    grantAgent({ publicKey, wrapKey, handle = 'agent' }) { state.agents.set(publicKey, { publicKey, wrapKey, handle }); return client({ agent: { publicKey } }).enrollAgent(); },
    /** A compromised host may sign any attestation it likes; members still decide. */
    forge: attest });
}
