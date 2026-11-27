// An in-memory Chronolog v2 blind host for unit/integration tests of page admission.
// It attests account-bound key proofs (`signHostAttestationV2`), replays public-control
// ops (`$permissions`, `$keys`, `$finality`, `$publications`) via `TopicKernel({ blindHostMode: true })`,
// and never holds data keys or signs membership.
import {
  bytesToHex, createSigningIdentity, decodeLogGenesis, decodeRecord, decodeSignedOperation,
  encodeRecord, genesisLogId, hexToBytes, isControlTopic, recordDigest, signHostAttestationV2,
  verifyRecord, verifySignedOperation,
} from '@chronolog/peer-session';
import {
  ContentAddressedStore, MemoryBytesStore, TopicKernel, computeCasHash, decodeCasNode, hashCasNode, seedStandardModules,
} from '@chronolog/peer-session/kernel';
import { authorityRecord, authorityRecordBytes } from '../../../contract/authority.mjs';

const ENROLLMENT_REQUEST_DOMAIN = 'chronolog/enrollment-request/v2';
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const decode = value => decodeRecord(authorityRecordBytes(value));
const record = value => authorityRecord(encodeRecord(value));
const sha256 = async bytes => bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const inviteCapacity = invite => invite.binding?.kind === 'public' ? (invite.binding.max ?? Number.MAX_SAFE_INTEGER) : 1;

export async function createAdmissionHost({
  applicationId,
  configuration = null,
  owner = { accountId: 'acct_owner', email: 'owner@example.test' },
  now = () => Date.now(),
  windowMs = 3_600_000,
} = {}) {
  const host = await createSigningIdentity();
  const pinnedSelectionId = applicationId ?? null;
  const state = {
    applicationId: applicationId ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    selectionId: applicationId ?? null,
    genesis: null,
    genesisBytes: null,
    publicOps: new Map(), // opId -> { raw, kernelInput }
    publicCas: new Map(), // hash -> Uint8Array
    checkpoints: new Map(), // digest -> raw
    control: null,
    pending: new Map(),
    challenges: new Map(),
    redemptions: [],
    agents: new Map(),
    notified: 0,
  };
  const admissionAccounts = [owner.accountId, ...(owner.email ? [`email:${owner.email}`] : [])];

  async function replay() {
    if (!state.genesisBytes) { state.control = null; return null; }
    const cas = new ContentAddressedStore({ store: new MemoryBytesStore() });
    await seedStandardModules(cas);
    for (const [hash, bytes] of state.publicCas.entries()) {
      if (hashCasNode(bytes) === hash) { decodeCasNode(bytes); await cas.putRaw(hash, bytes, 'public'); }
      else await cas.put(bytes, [], 'public');
    }
    const kernel = new TopicKernel({ genesis: state.genesisBytes, cas, blindHostMode: true });
    const res = await kernel.materialize([...state.publicOps.values()].map(o => o.kernelInput));
    const topics = kernel.topics;
    state.control = {
      stateRoot: res.revision.stateRoot,
      historyDigest: res.revision.historyDigest,
      permissions: topics.$permissions ?? { members: [], admission: null },
      keys: topics.$keys ?? { currentEpoch: -1, epochs: {} },
    };
    return state.control;
  }

  const perms = () => state.control?.permissions ?? { members: [], admission: null };
  const isMember = publicKey => (perms().members ?? []).some(m => m.publicKey === publicKey);
  const metadata = () => ({
    selection: { id: pinnedSelectionId ?? state.applicationId },
    configuration,
    genesis: state.genesis,
    stateRoot: state.control?.stateRoot ?? null,
    historyDigest: state.control?.historyDigest ?? null,
    currentEpoch: state.control?.keys?.currentEpoch ?? -1,
    closedThroughMs: null,
    hostAttestationKey: host.publicKey,
    admissionAccounts,
  });

  const notify = () => { state.notified++; };
  let tail = Promise.resolve();
  const serial = work => { const task = tail.then(work); tail = task.catch(() => {}); return task; };

  const attest = async (payload) => {
    const time = now();
    const attestation = await signHostAttestationV2({
      pageId: 'abcdefghijkl',
      applicationId: state.applicationId,
      issuedAt: time,
      expiresAt: time + windowMs,
      nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      inviteId: null,
      ...payload,
    }, host);
    if (!isMember(payload.publicKey)) { state.pending.set(payload.publicKey, record(attestation)); notify(); }
    return { ...metadata(), attestation: record(attestation) };
  };

  async function redeem(invite, account, publicKey) {
    const value = (perms().admission?.invites ?? []).find(item => item.inviteId === invite.inviteId);
    if (!value) fail(404, 'invite_unknown');
    if (value.revoked) fail(410, 'invite_revoked');
    if (now() >= value.expiresAt) fail(410, 'invite_expired');
    if (await sha256(hexToBytes(invite.secret)) !== value.secretDigest) fail(403, 'invite_secret_invalid');
    if (value.binding.kind === 'email' && account.email !== value.binding.email) fail(403, 'invite_email_mismatch');
    const prior = state.redemptions.filter(item => item.inviteId === value.inviteId);
    const accounts = new Set(prior.map(item => item.accountId));
    if (!accounts.has(account.accountId) && accounts.size >= inviteCapacity(value)) {
      fail(409, value.binding.kind === 'public' ? 'invite_exhausted' : 'invite_redeemed');
    }
    state.redemptions.push({ inviteId: value.inviteId, accountId: account.accountId, publicKey });
  }

  function client(principal) {
    return Object.freeze({
      async application() { return metadata(); },
      async challenge(publicKey) {
        if (!principal.account) fail(403, 'browser_account_required');
        const challenge = crypto.randomUUID();
        state.challenges.set(challenge, { publicKey, accountId: principal.account.accountId });
        return { applicationId: state.applicationId, publicKey, challenge, expiresAt: now() + 300_000 };
      },
      async enroll(proof, invite) {
        if (!principal.account) fail(403, 'browser_account_required');
        const signed = decode(proof);
        await verifyRecord(ENROLLMENT_REQUEST_DOMAIN, signed);
        const challenge = state.challenges.get(signed.payload.challenge);
        if (!challenge || challenge.publicKey !== signed.payload.publicKey ||
            challenge.accountId !== principal.account.accountId || signed.payload.applicationId !== state.applicationId) {
          fail(403, 'enrollment_challenge_invalid');
        }
        state.challenges.delete(signed.payload.challenge);
        if (invite) await redeem(invite, principal.account, signed.payload.publicKey);
        return attest({
          subject: 'device',
          accountId: principal.account.accountId,
          email: principal.account.email ?? null,
          publicKey: signed.payload.publicKey,
          wrapKey: signed.payload.wrapKey,
          label: principal.label ?? 'Browser device',
          inviteId: invite?.inviteId ?? null,
        });
      },
      async enrollAgent() {
        const agent = principal.agent && state.agents.get(principal.agent.publicKey);
        if (!agent) fail(403, 'agent_grant_required');
        return attest({
          subject: 'agent',
          accountId: owner.accountId,
          email: owner.email ?? null,
          publicKey: agent.publicKey,
          wrapKey: agent.wrapKey,
          label: `@${agent.handle}`,
        });
      },
      initialize: ({ genesis, casNodes = [] }) => serial(async () => {
        const genesisBytes = authorityRecordBytes(genesis, 1024 * 1024);
        if (state.genesisBytes !== null) {
          if (bytesToHex(state.genesisBytes) === bytesToHex(genesisBytes)) return metadata();
          fail(409, 'application_initialized');
        }
        const parsed = decodeLogGenesis(genesisBytes);
        const logId = bytesToHex(genesisLogId(genesisBytes));
        const p = parsed.initialTopics.$permissions;
        const admins = (p?.members ?? []).filter(m => m.administrator && m.reader && m.writer);
        if (!admins.length || p?.admission?.hostKey !== host.publicKey ||
            !admissionAccounts.every(acc => (p?.admission?.accounts ?? []).includes(acc))) {
          fail(400, 'genesis_invalid');
        }
        if (principal.agent ? !admins.some(a => a.publicKey === principal.agent.publicKey) : principal.account?.accountId !== owner.accountId) {
          fail(403, 'owner_required');
        }
        for (const node of casNodes) {
          const bytes = hexToBytes(node.bytes);
          if (hashCasNode(bytes) !== node.hash && computeCasHash(bytes) !== node.hash) fail(400, 'cas_hash_mismatch');
          state.publicCas.set(node.hash, bytes);
        }
        state.applicationId = logId;
        state.genesisBytes = genesisBytes;
        state.genesis = genesis;
        await replay();
        notify();
        return metadata();
      }),
      syncControl: (input = {}) => serial(async () => {
        if (!state.genesisBytes) fail(409, 'application_uninitialized');
        let added = 0;
        for (const node of input.casNodes ?? []) {
          const bytes = hexToBytes(node.bytes);
          if (hashCasNode(bytes) !== node.hash && computeCasHash(bytes) !== node.hash) fail(400, 'cas_hash_mismatch');
          if (!state.publicCas.has(node.hash)) { state.publicCas.set(node.hash, bytes); added++; }
        }
        for (const opRec of input.publicOps ?? []) {
          const raw = authorityRecordBytes(opRec, 256 * 1024);
          const signed = decodeSignedOperation(raw);
          const { core, opId } = await verifySignedOperation(signed);
          if (bytesToHex(core.logId) !== state.applicationId) fail(400, 'operation_log_mismatch');
          if (core.visibility !== 'public' || core.updates.some(u => !isControlTopic(u.topic))) fail(400, 'control_topic_required');
          const opIdHex = bytesToHex(opId);
          if (!state.publicOps.has(opIdHex)) {
            state.publicOps.set(opIdHex, { raw, kernelInput: { opId, core } });
            added++;
          }
        }
        for (const cpRec of input.checkpoints ?? []) {
          const raw = authorityRecordBytes(cpRec, 256 * 1024);
          const digest = await recordDigest(decodeRecord(raw));
          if (!state.checkpoints.has(digest)) { state.checkpoints.set(digest, raw); added++; }
        }
        await replay();
        for (const pk of state.pending.keys()) if (isMember(pk)) state.pending.delete(pk);
        if (added > 0) notify();
        const knownOps = new Set(input.knownOpIds ?? []);
        const knownCas = new Set(input.knownCasHashes ?? []);
        return {
          ...metadata(),
          publicOps: [...state.publicOps.entries()].filter(([id]) => !knownOps.has(id)).map(([, v]) => authorityRecord(v.raw)),
          casNodes: [...state.publicCas.entries()].filter(([h]) => !knownCas.has(h)).map(([hash, bytes]) => ({ hash, bytes: bytesToHex(bytes) })),
          checkpoints: [...state.checkpoints.values()].map(raw => authorityRecord(raw)),
        };
      }),
      async admissions() {
        const time = now();
        const pending = [];
        for (const [pk, item] of state.pending) {
          if (decode(item).payload.expiresAt <= time || isMember(pk)) state.pending.delete(pk);
          else pending.push(item);
        }
        return { pending };
      },
    });
  }

  return Object.freeze({
    host,
    state,
    client,
    grantAgent({ publicKey, wrapKey, handle = 'agent' }) {
      state.agents.set(publicKey, { publicKey, wrapKey, handle });
      return client({ agent: { publicKey } }).enrollAgent();
    },
    forge: attest,
  });
}
