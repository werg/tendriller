// Page key creation and admission. The creator (a browser or a native agent)
// generates the page's descriptor, genesis membership and first epoch key; every
// later device or agent is admitted into signed membership by an online member,
// which then wraps the epoch keys to the newcomer's signed wrap key. The host only
// attests account-bound key proofs and carries signed records: it never signs
// membership and never sees an epoch key.
import {
  createAuthorityProvider, createWrapKeyPair, importWrapPrivateKey, signAppDescriptor, signMembership,
  signEnrollmentRequest, signRecord, verifyRecord, verifyAuthorityBundle, verifyHostAttestation, attestedAccountAuthorized, attestedGrant, inviteAdmits,
  inviteCapacity, inviteGrant, inviteRedemptions, epochKeyCommitment, encodeRecord, decodeRecord, recordDigest, bytesToHex,
} from '@chronolog/peer-session';
import { authorityRecord, authorityRecordBytes } from '../contract/authority.mjs';

const WRAP_KEY = 'tendriller/admission/wrap-key';
const GENESIS = applicationId => `tendriller/admission/genesis/${applicationId}`;
const ROTATION = (applicationId, epoch) => `tendriller/admission/rotation/${applicationId}/${epoch}`;
const INVITE = applicationId => `tendriller/admission/invite/${applicationId}`;
const HEX = /^[0-9a-f]{64}$/u;
const failure = (code, message = code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const decode = value => decodeRecord(authorityRecordBytes(value));
const record = value => authorityRecord(encodeRecord(value));
const codeOf = error => String(error?.code ?? error?.message ?? 'ADMISSION_FAILED');
const randomHex = bytes => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256Hex = async bytes => bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const conflict = error => error?.status === 409 || /HEAD_CHANGED|CHAIN_CONFLICT|CHAIN_FORK|initialized/iu.test(codeOf(error));

/** The device's long-lived key-wrap key, kept beside its signer in the device store and never exported. */
export async function deviceWrapKey(store) {
  let saved = await store.get(WRAP_KEY);
  if (saved === null) {
    const pair = await createWrapKeyPair();
    await store.put(WRAP_KEY, encodeRecord(pair));
    saved = await store.get(WRAP_KEY);
  }
  const value = decodeRecord(saved);
  if (!HEX.test(value?.publicKey ?? '') || !(value.privateKey instanceof Uint8Array)) throw failure('WRAP_KEY_INVALID', 'The retained key-wrap key is damaged; restore this device profile.');
  return Object.freeze({ publicKey: value.publicKey, privateKey: await importWrapPrivateKey(value.privateKey) });
}

/** Default policy grant for owner-account devices admitted by host attestation: full members, administrators included. */
export const DEFAULT_OWNER_GRANT = Object.freeze({ reader: true, writer: true, administrator: true });
const ROLE_GRANTS = Object.freeze({ reader: { reader: true, writer: false, administrator: false }, writer: { reader: true, writer: true, administrator: false }, admin: DEFAULT_OWNER_GRANT });
function policyGrant(input) {
  const value = typeof input === 'string' ? ROLE_GRANTS[input] : input;
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || !['reader', 'writer', 'administrator'].every(key => typeof value[key] === 'boolean') || !value.reader && (value.writer || value.administrator))
    throw failure('ADMISSION_GRANT_INVALID', 'The owner-device grant is reader, writer or admin (or exactly {reader,writer,administrator} booleans).');
  return { reader: value.reader, writer: value.writer, administrator: value.administrator };
}

const memberGrant = (publicKey, wrapKey, flags) => ({ publicKey, wrapKey, reader: !!flags.reader, writer: !!flags.writer,
  administrator: !!flags.administrator, publisher: !!flags.publisher, finalizer: !!flags.finalizer });

/**
 * Sign a page's descriptor and genesis membership as its creator. The creator is the
 * root principal and descriptor authority, an administrator, and the only member.
 */
export async function createPageGenesis({ applicationId, identity, wrapKey, configuration, hostKey, accounts, mode = 'attested', ownerGrant = DEFAULT_OWNER_GRANT }) {
  const grant = policyGrant(ownerGrant);
  if (!HEX.test(applicationId ?? '') || !HEX.test(hostKey ?? '') || !HEX.test(wrapKey ?? '')) throw failure('GENESIS_INPUT_INVALID');
  if (!Array.isArray(accounts) || !accounts.length) throw failure('GENESIS_OWNER_REQUIRED', 'The host did not name the page owner account to pin in the admission policy.');
  const requested = configuration.requestedFinality;
  const finalityPolicy = requested === undefined ? { kind: 'none' }
    : requested.kind === 'browser-signed-frontier' ? { kind: 'signed-frontier', signer: identity.publicKey, scopes: [{ id: await recordDigest(['initial-scope', applicationId]), authorTimeAfterMs: -1n }] }
      : decode(requested);
  const finalizer = finalityPolicy.kind === 'signed-frontier' ? finalityPolicy.signer === identity.publicKey : finalityPolicy.kind === 'fixed-validator' && finalityPolicy.validators.includes(identity.publicKey);
  const epochKey = crypto.getRandomValues(new Uint8Array(32));
  const descriptor = await signAppDescriptor({ applicationId, rootPrincipal: identity.publicKey, authorityPublicKey: identity.publicKey,
    executionManifestDigest: configuration.executionManifestDigest, finalityPolicy }, identity);
  const membership = await signMembership({ applicationId, revision: 0, previous: null, authorTimeAfterMs: -1n, epoch: 0,
    epochKeyDigest: await epochKeyCommitment(applicationId, 0, epochKey),
    members: [memberGrant(identity.publicKey, wrapKey, { reader: true, writer: true, administrator: true, finalizer })],
    admission: { mode, hostKey, accounts: [...accounts], grant }, admitted: [], invites: [] }, identity);
  const bundle = { descriptor, memberships: [membership] };
  await verifyAuthorityBundle(bundle);
  return { bundle, epochKey };
}

/**
 * Open this device's verified page authority. A cached provider opens without the
 * network. Otherwise, an uninitialized page is created by this device (`create`),
 * retaining the exact genesis and key before sending it; an initialized page is
 * pinned from the host so the device can request admission.
 */
export async function openPageAuthority({ store, identity, wrapKey, peers, applicationId, executionManifestDigest, create = true, ownerGrant, signal }) {
  try { return { authority: await createAuthorityProvider({ store, applicationId }), created: false }; }
  catch (error) { if (codeOf(error) !== 'AUTHORITY_CACHE_MISSING') throw error; }
  let metadata = await peers.application({ signal });
  const configuration = metadata.configuration;
  if (!configuration) throw failure('application_unprepared', 'The page has no prepared application yet; its agent must run init and deploy.');
  if (configuration.executionManifestDigest !== executionManifestDigest) throw failure('APPLICATION_SCOPE_MISMATCH', 'This publication executes a different application than the page prepared.');
  const savedIntent = await store.get(GENESIS(applicationId));
  let intent = savedIntent === null ? null : decodeRecord(savedIntent);
  if (metadata.authority === null) {
    if (!create) throw failure('PAGE_UNINITIALIZED', 'The page creator has not initialized its data yet.');
    if (intent === null) {
      // Keep the exact genesis and its key BEFORE sending; an uncertain reply resends these bytes.
      intent = await createPageGenesis({ applicationId, identity, wrapKey: wrapKey.publicKey, configuration, hostKey: metadata.hostAttestationKey, accounts: metadata.admissionAccounts, ...(ownerGrant === undefined ? {} : { ownerGrant }) });
      await store.put(GENESIS(applicationId), encodeRecord(intent));
    }
    try { metadata = await peers.initialize(record(intent.bundle)); }
    catch (error) {
      if (!conflict(error)) throw error;
      metadata = await peers.application({ signal });
    }
  }
  const bundle = decode(metadata.authority);
  await verifyAuthorityBundle(bundle);
  if (bundle.descriptor.payload.applicationId !== applicationId || bundle.descriptor.payload.executionManifestDigest !== executionManifestDigest) throw failure('APPLICATION_SCOPE_MISMATCH');
  if (bundle.memberships.at(-1).payload.admission.hostKey !== metadata.hostAttestationKey && bundle.memberships.length === 1) throw failure('ATTESTATION_KEY_MISMATCH', 'The page pins a different host attestation key than this host publishes.');
  const authority = await createAuthorityProvider({ store, bundle });
  if (intent !== null) {
    if (await recordDigest(intent.bundle.descriptor) === await recordDigest(bundle.descriptor)) {
      await authority.installEpochKey(0, intent.epochKey);
      return { authority, created: true };
    }
    // Another creator initialized first; this device's unsent genesis is discarded.
    await store.delete?.(GENESIS(applicationId));
  }
  return { authority, created: false };
}

function describeMembers(authority, self) {
  const bundle = authority.bundle(), evidence = new Map();
  for (const signed of bundle.memberships) for (const admission of signed.payload.admitted)
    evidence.set(admission.publicKey, { via: admission.via, subject: admission.attestation.payload.subject, label: admission.attestation.payload.label,
      accountId: admission.attestation.payload.accountId, email: admission.attestation.payload.email, inviteId: admission.attestation.payload.inviteId,
      admittedBy: signed.signer, revision: signed.payload.revision, activation: signed.payload.authorTimeAfterMs });
  const root = bundle.descriptor.payload.rootPrincipal;
  return authority.currentMembership.members.map(member => Object.freeze({ publicKey: member.publicKey, self: member.publicKey === self,
    reader: member.reader, writer: member.writer, administrator: member.administrator, wrapKey: member.wrapKey,
    ...(member.publicKey === root ? { via: 'creator', subject: 'creator', label: 'Page creator' } : evidence.get(member.publicKey) ?? { via: 'administrator', subject: 'key', label: 'Granted key' }) }));
}

/** Route owner extension calls by name to several extensions (for example admission plus an app's own). */
export function composeOwnerExtensions(...extensions) {
  return Object.freeze({
    async call(name, args, context) {
      let last;
      for (const extension of extensions) {
        try { return await extension.call(name, args, context); }
        catch (error) { if (codeOf(error) !== 'EXTENSION_UNKNOWN') throw error; last = error; }
      }
      throw last ?? failure('EXTENSION_UNKNOWN');
    },
    subscribe(listener) { const stops = extensions.map(extension => extension.subscribe?.(listener) ?? (() => {})); return () => { for (const stop of stops) stop(); }; },
  });
}

/**
 * The single admission mechanism for one open session. A newcomer obtains a host
 * attestation (owner sign-in, or invite redemption) and waits, retrying, until an
 * online member admits it and wraps its keys. A member verifies pending attestations
 * against signed state, admits eligible ones (attested mode), keeps every reader's
 * keys wrapped, and offers administrator actions. Returns an owner extension.
 */
export function createAdmission(session, { peers, wrapKey, store, subject = 'device', label = subject === 'agent' ? 'Agent' : 'Browser device',
  now = () => Date.now(), memberIntervalMs = 0, waitingIntervalMs = 3_000, onEvent = () => {}, onEpochRotated = null } = {}) {
  const authority = session.authority, identity = session.device.identity, applicationId = session.applicationId;
  const listeners = new Set(), lifetime = new AbortController();
  // A key that was ever a member and is not now was removed; it never re-requests admission by itself.
  const everMember = () => authority.bundle().memberships.some(item => item.payload.members.some(member => member.publicKey === identity.publicKey));
  let attestation = null, invite, inviteLoaded = false, timer, running, again = false, closed = false, wasMember = everMember();
  let known = new Set(authority.currentMembership.members.map(member => member.publicKey)), notices = [], pending = [], wrapped = {}, lastError = null, hostKey = authority.currentMembership.admission.hostKey;
  let state = snapshot();
  function snapshot() {
    const me = authority.grant(identity.publicKey), head = authority.currentMembership, hasKey = authority.epochKey(head.epoch) !== null;
    const phase = closed ? 'closed' : me === null ? (wasMember ? 'removed' : head.admission.mode === 'strict' ? 'waiting-approval' : 'waiting-admission') : !hasKey ? 'waiting-keys' : 'admitted';
    const members = describeMembers(authority, identity.publicKey);
    const invites = head.invites.map(item => Object.freeze({ ...item, redemptions: inviteRedemptions(authority.bundle().memberships, item.inviteId), capacity: item.binding.kind === 'public' ? item.binding.max : 1,
      expired: BigInt(now()) >= item.expiresAt }));
    return Object.freeze({ phase, publicKey: identity.publicKey, wrapKey: wrapKey.publicKey, subject, mode: head.admission.mode, accounts: [...head.admission.accounts], ownerGrant: Object.freeze({ ...head.admission.grant }),
      epoch: head.epoch, revision: head.revision, administrator: me?.administrator === true, canAdmit: me?.reader === true && hasKey,
      members, pending: [...pending], invites, notices: [...notices], attestationExpiresAt: attestation?.payload.expiresAt ?? null, error: lastError });
  }
  const emit = () => { state = snapshot(); for (const listener of listeners) { try { listener(state); } catch {} } };
  const notice = value => {
    const entry = Object.freeze({ id: randomHex(8), at: now(), ...value });
    notices = [...notices, entry].slice(-20); onEvent(entry);
  };
  async function loadInvite() {
    if (inviteLoaded) return; inviteLoaded = true;
    const saved = await store?.get(INVITE(applicationId)); if (saved) invite = decodeRecord(saved);
  }
  async function refreshAuthority() {
    const metadata = await peers.application({ signal: lifetime.signal });
    if (metadata.hostAttestationKey) hostKey = metadata.hostAttestationKey;
    if (metadata.authority) await session.mergeAuthority(decode(metadata.authority));
  }
  async function attest() {
    if (attestation !== null) {
      const { issuedAt, expiresAt } = attestation.payload;
      if (BigInt(now()) < issuedAt + (expiresAt - issuedAt) / 2n) return;
    }
    await loadInvite();
    let result;
    if (subject === 'agent') result = await peers.enrollAgent({ signal: lifetime.signal });
    else {
      const challenge = await peers.challenge(identity.publicKey);
      const proof = await signEnrollmentRequest({ applicationId, publicKey: identity.publicKey, wrapKey: wrapKey.publicKey, challenge: challenge.challenge }, identity);
      result = await peers.enroll(record(proof), invite ? { inviteId: invite.inviteId, secret: invite.secret } : undefined);
    }
    attestation = decode(result.attestation);
    await verifyHostAttestation(attestation, { hostKey: authority.currentMembership.admission.hostKey, applicationId });
    if (attestation.payload.publicKey !== identity.publicKey || attestation.payload.wrapKey !== wrapKey.publicKey) throw failure('ATTESTATION_SUBJECT_MISMATCH');
  }
  async function receiveKeys() {
    const { wraps } = await peers.wraps(identity.publicKey);
    for (const item of wraps ?? []) {
      try { await session.provisioning.unwrapKeys(decode(item), wrapKey.privateKey); } catch { /* A stale or foreign wrap is skipped; another member re-wraps. */ }
      if (authority.epochKey(authority.currentMembership.epoch) !== null) return;
    }
  }
  /** Verify one pending host attestation against signed state; classify how it could be admitted. */
  async function classify(item, chain) {
    const value = decode(item), head = authority.currentMembership;
    const payload = await verifyHostAttestation(value, { hostKey: head.admission.hostKey, applicationId });
    if (head.members.some(member => member.publicKey === payload.publicKey)) return null;
    const time = BigInt(now()), everMember = chain.some(signed => signed.payload.members.some(member => member.publicKey === payload.publicKey));
    const used = chain.some(signed => signed.payload.admitted.some(entry => entry.attestation.payload.nonce === payload.nonce));
    if (used || time >= payload.expiresAt) return null;
    let via = null, reason;
    const invited = payload.inviteId === null ? undefined : head.invites.find(entry => entry.inviteId === payload.inviteId);
    if (payload.inviteId !== null) {
      if (!inviteAdmits(invited, payload, time)) reason = 'invite_invalid';
      else if (inviteRedemptions(chain, invited.inviteId) >= inviteCapacity(invited)) reason = 'invite_already_redeemed';
      else via = 'invited';
    } else if (attestedAccountAuthorized(head.admission, payload)) via = 'attested';
    else reason = 'account_not_authorized';
    if (everMember) { via = null; reason = 'previously_removed'; }
    if (head.admission.mode === 'strict' && via !== null) { reason = 'strict_mode'; via = null; }
    return { attestation: value, payload, via, reason, invite: invited };
  }
  function grantFor(entry, override) {
    if (override) return override;
    if (entry.via === 'invited' || entry.invite) return inviteGrant(entry.invite.role);
    // Attested owner-account devices receive exactly the signed policy grant (administrator included); agent keys never administrator.
    return attestedGrant(authority.currentMembership.admission, entry.payload);
  }
  /** Append one admin-or-member-signed revision and publish it; only a host-accepted revision is merged locally. */
  async function extend(change, { rotateTo } = {}) {
    const bundle = authority.bundle(), head = bundle.memberships.at(-1);
    const floor = [BigInt(now()), head.payload.authorTimeAfterMs + 1n, ...(change.floor ?? [])].reduce((a, b) => a > b ? a : b);
    const { floor: _, ...fields } = change;
    const signed = await signMembership({ ...head.payload, admitted: [], ...fields, revision: head.payload.revision + 1, previous: await recordDigest(head), authorTimeAfterMs: floor }, identity);
    const next = { descriptor: bundle.descriptor, memberships: [...bundle.memberships, signed] };
    await verifyAuthorityBundle(next);
    if (rotateTo) await store.put(ROTATION(applicationId, signed.payload.epoch), encodeRecord({ digest: await recordDigest(signed), key: rotateTo }));
    try { await peers.membership(record(next)); }
    catch (error) { if (rotateTo) await store.delete?.(ROTATION(applicationId, signed.payload.epoch)); throw error; }
    await session.mergeAuthority(next);
    if (rotateTo) { await authority.installEpochKey(signed.payload.epoch, rotateTo); await store.delete?.(ROTATION(applicationId, signed.payload.epoch)); }
    return signed;
  }
  async function admit(entries, via, override) {
    const head = authority.currentMembership;
    const usable = entries.filter(entry => entry.payload.expiresAt > BigInt(now()) + 1000n);
    if (!usable.length) return null;
    const signed = await extend({ floor: usable.map(entry => entry.payload.issuedAt),
      members: [...head.members, ...usable.map(entry => memberGrant(entry.payload.publicKey, entry.payload.wrapKey, { ...grantFor(entry, override) }))],
      admitted: usable.map(entry => ({ publicKey: entry.payload.publicKey, via: via ?? entry.via, attestation: entry.attestation })) });
    await wrapAll();
    return signed;
  }
  async function wrapAll(force = false) {
    const head = authority.currentMembership;
    for (const member of head.members) {
      if (member.publicKey === identity.publicKey || !member.reader || member.wrapKey === null) continue;
      if (!force && (wrapped[member.publicKey] ?? -1) >= head.epoch) continue;
      await peers.wrap(record(await session.provisioning.wrapKeys(member.publicKey)));
      wrapped = { ...wrapped, [member.publicKey]: head.epoch };
    }
  }
  async function resumeRotation() {
    const head = authority.currentMembership;
    if (authority.epochKey(head.epoch) !== null) return;
    const saved = await store?.get(ROTATION(applicationId, head.epoch));
    if (saved === null || saved === undefined) return;
    const intent = decodeRecord(saved);
    if (intent.digest === authority.currentMembershipId) await authority.installEpochKey(head.epoch, intent.key);
  }
  async function memberDuties() {
    const result = await peers.admissions({ signal: lifetime.signal });
    wrapped = result.wrapped ?? {};
    const chain = authority.bundle().memberships, classified = [];
    for (const item of result.pending ?? []) { try { const entry = await classify(item, chain); if (entry) classified.push(entry); } catch { /* Forged, expired or foreign attestations never admit. */ } }
    const before = new Set(pending.map(entry => entry.publicKey));
    pending = classified.filter(entry => entry.via === null).map(entry => Object.freeze({ publicKey: entry.payload.publicKey, subject: entry.payload.subject, label: entry.payload.label,
      accountId: entry.payload.accountId, email: entry.payload.email, inviteId: entry.payload.inviteId, issuedAt: entry.payload.issuedAt, expiresAt: entry.payload.expiresAt, reason: entry.reason }));
    for (const entry of pending) if (!before.has(entry.publicKey)) notice({ kind: 'pending', publicKey: entry.publicKey, label: entry.label, subject: entry.subject, accountId: entry.accountId, reason: entry.reason });
    const eligible = classified.filter(entry => entry.via !== null);
    // One revision admits every eligible newcomer; concurrent members converge on the host-accepted head.
    if (eligible.length) {
      const capacity = new Map(), chosen = [];
      for (const entry of eligible) {
        if (entry.via === 'invited') {
          const used = (capacity.get(entry.invite.inviteId) ?? inviteRedemptions(chain, entry.invite.inviteId)) + 1;
          if (used > inviteCapacity(entry.invite)) continue; capacity.set(entry.invite.inviteId, used);
        }
        chosen.push(entry);
      }
      try { await admit(chosen); } catch (error) { if (!conflict(error)) throw error; again = true; }
    }
    await wrapAll();
    // Seamless org/group admission & seamless org-departure key rotation (administrators only).
    if (authority.grant(identity.publicKey)?.administrator && typeof peers.groups === 'function') {
      await processOrgGroups(classified, chain);
    }
  }
  async function processOrgGroups(classified, chain) {
    let groupState;
    try { groupState = await peers.groups({ signal: lifetime.signal }); }
    catch { return; }
    const head = authority.currentMembership;
    const bundle = authority.bundle();
    const rootPrincipal = bundle.descriptor.payload.rootPrincipal;

    // 1. Seamless org join: verify admin-signed policy + companion host-signed group attestation.
    const signedPolicy = groupState?.policy;
    if (signedPolicy && Array.isArray(groupState?.group_attestations) && groupState.group_attestations.length > 0) {
      let policyValid = false;
      try {
        await verifyRecord('tendriller-group-policy-v1', signedPolicy);
        const signerMember = head.members.find(m => m.publicKey === signedPolicy.signer);
        policyValid = Boolean(signerMember?.administrator && signedPolicy.payload?.applicationId === applicationId);
      } catch { policyValid = false; }
      if (policyValid) {
        const ruleById = new Map((signedPolicy.payload.rules ?? []).map(r => [r.ruleId, r]));
        const gaByKey = new Map();
        for (const ga of groupState.group_attestations) {
          try {
            await verifyRecord('tendriller-group-attestation-v1', ga);
            if (ga.signer !== head.admission.hostKey) continue;
            if (ga.payload?.applicationId !== applicationId || ga.payload.expiresAt <= now()) continue;
            gaByKey.set(ga.payload.publicKey, ga);
          } catch { /* ignore invalid attestation */ }
        }
        for (const entry of classified) {
          if (entry.via !== null || entry.reason === 'previously_removed') continue;
          const ga = gaByKey.get(entry.payload.publicKey);
          if (!ga || ga.payload.accountId !== entry.payload.accountId || ga.payload.wrapKey !== entry.payload.wrapKey) continue;
          const rule = ruleById.get(ga.payload.ruleId);
          if (!rule || rule.group.toLowerCase() !== String(ga.payload.group).toLowerCase()) continue;
          const grant = ROLE_GRANTS[rule.role];
          if (!grant) continue;
          try {
            await admit([entry], 'approved', grant);
            notice({ kind: 'org-admitted', publicKey: entry.payload.publicKey, group: rule.group, role: rule.role });
          } catch (error) {
            if (!conflict(error)) throw error;
            again = true;
          }
        }
      }
    }

    // 2. Seamless org offboarding: automatically revoke & rotate epoch key on verified host departure attestation.
    if (Array.isArray(groupState?.departures) && groupState.departures.length > 0) {
      const admittedEvidence = new Map();
      for (const m of chain) {
        for (const a of m.payload.admitted) admittedEvidence.set(a.publicKey, a);
      }
      for (const dep of groupState.departures) {
        try {
          await verifyRecord('tendriller-org-departure-v1', dep);
        } catch { continue; }
        if (dep.signer !== head.admission.hostKey || dep.payload?.applicationId !== applicationId) continue;
        const targetKey = dep.payload.publicKey;
        if (!targetKey || targetKey === identity.publicKey || targetKey === rootPrincipal) continue;
        const currentHead = authority.currentMembership;
        if (!currentHead.members.some(m => m.publicKey === targetKey)) {
          await peers.ackDeparture?.(targetKey, { signal: lifetime.signal }).catch(() => {});
          continue;
        }
        // Guardrail: never auto-revoke owner-account devices or individually invited devices.
        const ev = admittedEvidence.get(targetKey);
        if (!ev || ev.attestation.payload.inviteId !== null || attestedAccountAuthorized(currentHead.admission, ev.attestation.payload)) {
          continue;
        }
        const nextEpoch = Math.max(...authority.bundle().memberships.map(item => item.payload.epoch)) + 1;
        const nextKey = crypto.getRandomValues(new Uint8Array(32));
        try {
          await extend({
            members: currentHead.members.filter(m => m.publicKey !== targetKey),
            epoch: nextEpoch,
            epochKeyDigest: await epochKeyCommitment(applicationId, nextEpoch, nextKey),
          }, { rotateTo: nextKey });
          await wrapAll(true);
          if (typeof onEpochRotated === 'function') {
            try { await onEpochRotated({ epoch: nextEpoch, reason: 'org-offboarded', publicKey: targetKey, group: dep.payload.group }); } catch { /* best-effort K_conn rekey */ }
          }
          await peers.ackDeparture?.(targetKey, { signal: lifetime.signal }).catch(() => {});
          notice({ kind: 'org-offboarded', publicKey: targetKey, group: dep.payload.group, epoch: nextEpoch });
        } catch (error) {
          if (!conflict(error)) throw error;
          again = true;
        }
      }
    }
  }
  function observeMembership() {
    const current = new Set(authority.currentMembership.members.map(member => member.publicKey));
    for (const member of describeMembers(authority, identity.publicKey)) if (!known.has(member.publicKey) && !member.self) notice({ kind: 'new-device', publicKey: member.publicKey, label: member.label, subject: member.subject, accountId: member.accountId ?? null, via: member.via });
    for (const publicKey of known) if (!current.has(publicKey)) notice({ kind: 'removed', publicKey, self: publicKey === identity.publicKey });
    known = current;
    if (current.has(identity.publicKey) || everMember()) wasMember = true;
  }
  async function tick() {
    try {
      await refreshAuthority(); observeMembership(); await resumeRotation();
      const me = authority.grant(identity.publicKey), head = authority.currentMembership;
      if (me === null) { if (!wasMember) await attest(); }
      else if (authority.epochKey(head.epoch) === null) await receiveKeys();
      if (authority.grant(identity.publicKey)?.reader && authority.epochKey(authority.currentMembership.epoch) !== null) await memberDuties();
      lastError = null;
    } catch (error) { if (!lifetime.signal.aborted) lastError = codeOf(error); }
    observeMembership(); emit();
  }
  function schedule(ms) {
    clearTimeout(timer); if (closed || !ms || ms <= 0) return;
    timer = setTimeout(() => { void refresh(); }, ms); timer.unref?.();
  }
  function refresh() {
    if (closed) return Promise.resolve(state);
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await tick(); } while (again && !closed);
      const waiting = state.phase !== 'admitted';
      schedule(lastError ? Math.min(30_000, waitingIntervalMs * 4) : waiting ? waitingIntervalMs : memberIntervalMs);
      return state;
    })().finally(() => { running = undefined; });
    return running;
  }
  const requireAdmin = () => { if (!authority.grant(identity.publicKey)?.administrator || authority.epochKey(authority.currentMembership.epoch) === null) throw failure('ADMINISTRATOR_REQUIRED', 'Only an administrator device (or the owner’s agent) can do this.'); };
  async function administer(work) {
    await refreshAuthority(); requireAdmin();
    const result = await work(); observeMembership(); emit(); void refresh(); return result;
  }
  const actions = {
    'admission.state': async () => state,
    'admission.refresh': async () => refresh(),
    async 'admission.approve'(publicKey, flags = {}) {
      return administer(async () => {
        const { pending: list } = await peers.admissions({ signal: lifetime.signal }), chain = authority.bundle().memberships;
        for (const item of list ?? []) {
          const entry = await classify(item, chain).catch(() => null);
          if (entry?.payload.publicKey !== publicKey) continue;
          // Without flags: an invite keeps its role, an owner-account device gets the policy grant (agents: without administrator), a guest is an editor.
          const policy = authority.currentMembership.admission, owner = !entry.invite && attestedAccountAuthorized(policy, entry.payload);
          const grant = entry.invite && flags.writer === undefined && flags.administrator === undefined ? inviteGrant(entry.invite.role)
            : { reader: true, writer: flags.writer ?? (flags.administrator === true || policy.grant.writer), administrator: flags.administrator ?? (owner && attestedGrant(policy, entry.payload).administrator) };
          await admit([entry], 'approved', grant); return { approved: publicKey };
        }
        throw failure('ADMISSION_REQUEST_UNKNOWN', 'That device has no fresh, verified sign-in request; ask it to reload.');
      });
    },
    async 'admission.remove'(publicKey) {
      return administer(async () => {
        const head = authority.currentMembership;
        if (publicKey === identity.publicKey) throw failure('ADMISSION_SELF_REMOVAL', 'Remove this device from another administrator device.');
        if (!head.members.some(member => member.publicKey === publicKey)) throw failure('MEMBER_UNKNOWN');
        const epoch = Math.max(...authority.bundle().memberships.map(item => item.payload.epoch)) + 1, key = crypto.getRandomValues(new Uint8Array(32));
        // The new epoch key is wrapped only to the remaining members.
        await extend({ members: head.members.filter(member => member.publicKey !== publicKey), epoch, epochKeyDigest: await epochKeyCommitment(applicationId, epoch, key) }, { rotateTo: key });
        await wrapAll(true);
        if (typeof onEpochRotated === 'function') {
          try { await onEpochRotated({ epoch, reason: 'removed', publicKey }); } catch { /* best-effort K_conn rekey */ }
        }
        return { removed: publicKey, epoch };
      });
    },
    async 'admission.mode'(mode) {
      if (mode !== 'attested' && mode !== 'strict') throw failure('ADMISSION_MODE_INVALID');
      return administer(async () => { const head = authority.currentMembership; if (head.admission.mode !== mode) await extend({ admission: { ...head.admission, mode } }); return { mode }; });
    },
    /** Administrator change of the signed grant owner-account devices receive on attested (and default approved) admission. */
    async 'admission.ownerGrant'(input) {
      const grant = policyGrant(input);
      return administer(async () => {
        const head = authority.currentMembership, current = head.admission.grant;
        if (current.reader !== grant.reader || current.writer !== grant.writer || current.administrator !== grant.administrator) await extend({ admission: { ...head.admission, grant } });
        return { ownerGrant: grant };
      });
    },
    /** After an operator rotates the host attestation key: pin the key this host now publishes. */
    async 'admission.pinHostKey'() {
      return administer(async () => {
        const metadata = await peers.application({ signal: lifetime.signal }), head = authority.currentMembership;
        if (!HEX.test(metadata.hostAttestationKey ?? '')) throw failure('attestation_unconfigured', 'This host publishes no attestation key.');
        if (head.admission.hostKey !== metadata.hostAttestationKey) await extend({ admission: { ...head.admission, hostKey: metadata.hostAttestationKey } });
        return { hostKey: metadata.hostAttestationKey };
      });
    },
    async 'admission.grant'(publicKey, flags = {}) {
      return administer(async () => {
        const head = authority.currentMembership, member = head.members.find(item => item.publicKey === publicKey);
        if (!member) throw failure('MEMBER_UNKNOWN');
        const next = { ...member, writer: flags.writer ?? member.writer, administrator: flags.administrator ?? member.administrator };
        if (next.writer !== member.writer || next.administrator !== member.administrator) await extend({ members: head.members.map(item => item.publicKey === publicKey ? next : item) });
        return { publicKey, writer: next.writer, administrator: next.administrator };
      });
    },
    /** Administrator grant of a key that no host attests (for example an owner-created hosted MCP identity). */
    async 'admission.addKey'(publicKey, wrapKey = null, flags = {}) {
      if (!HEX.test(publicKey ?? '') || wrapKey !== null && !HEX.test(wrapKey)) throw failure('MEMBER_KEY_INVALID');
      return administer(async () => {
        const head = authority.currentMembership;
        if (!head.members.some(member => member.publicKey === publicKey))
          await extend({ members: [...head.members, memberGrant(publicKey, wrapKey, { reader: true, writer: flags.writer !== false, administrator: false })] });
        return { publicKey };
      });
    },
    async 'admission.invite'({ binding, role, expiresInMs = 7 * 86_400_000 } = {}) {
      if (!['reader', 'writer', 'admin'].includes(role ?? (role = binding?.kind === 'public' ? 'reader' : 'writer'))) throw failure('INVITE_INVALID');
      const normalized = binding?.kind === 'email' ? { kind: 'email', email: String(binding.email ?? '').trim().toLowerCase() }
        : binding?.kind === 'open' ? { kind: 'open' } : binding?.kind === 'public' ? { kind: 'public', max: binding.max ?? null } : null;
      if (!normalized || !Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 90 * 86_400_000) throw failure('INVITE_INVALID');
      return administer(async () => {
        const secret = crypto.getRandomValues(new Uint8Array(32)), inviteId = randomHex(16), head = authority.currentMembership;
        const invite = { inviteId, role, binding: normalized, expiresAt: BigInt(now() + expiresInMs), secretDigest: await sha256Hex(secret), revoked: false };
        await extend({ invites: [...head.invites, invite] });
        // The secret is returned once to the inviter and carried only in the link fragment.
        return { inviteId, role, binding: normalized, expiresAt: invite.expiresAt, fragment: `invite=${inviteId}.${bytesToHex(secret)}` };
      });
    },
    async 'admission.revokeInvite'(inviteId) {
      return administer(async () => {
        const head = authority.currentMembership;
        if (!head.invites.some(item => item.inviteId === inviteId)) throw failure('INVITE_UNKNOWN');
        await extend({ invites: head.invites.map(item => item.inviteId === inviteId ? { ...item, revoked: true } : item) });
        return { revoked: inviteId };
      });
    },
    async 'admission.setGroupPolicy'(pageId, rules) {
      return administer(async () => {
        if (typeof peers.setGroupPolicy !== 'function') throw failure('GROUPS_UNSUPPORTED', 'Host peer client does not support group policies.');
        const current = await peers.groups?.({ signal: lifetime.signal }).catch(() => null);
        const nextRevision = (current?.policy?.payload?.revision ?? -1) + 1;
        const signed = await signRecord('tendriller-group-policy-v1', {
          pageId,
          applicationId,
          revision: nextRevision,
          rules,
          updatedAt: now(),
        }, identity);
        await peers.setGroupPolicy(signed, { signal: lifetime.signal });
        return { policy: signed };
      });
    },
    async 'admission.groups'() {
      if (typeof peers.groups !== 'function') return { policy: null, group_attestations: [], departures: [] };
      return peers.groups({ signal: lifetime.signal });
    },
    /** A newcomer presents an invite from its link fragment; the secret goes only to this page's host. */
    async 'admission.redeem'(fragment) {
      const match = /^(?:#?invite=)?([0-9a-f]{32})\.([0-9a-f]{64})$/u.exec(String(fragment ?? ''));
      if (!match) throw failure('INVITE_LINK_INVALID', 'This invite link is incomplete; ask for a new one.');
      invite = { inviteId: match[1], secret: match[2] }; inviteLoaded = true; attestation = null;
      await store?.put(INVITE(applicationId), encodeRecord(invite));
      return refresh();
    },
  };
  const stopAuthority = authority.subscribe(() => { observeMembership(); emit(); });
  void refresh();
  return Object.freeze({
    get state() { return state; },
    subscribe(listener) { listeners.add(listener); try { listener(state); } catch {} return () => listeners.delete(listener); },
    refresh,
    /** Owner extension for `createApplicationOwner(session, { extensions })`. */
    extensions: Object.freeze({
      async call(name, args) { const action = actions[name]; if (!action) throw failure('EXTENSION_UNKNOWN'); return action(...args); },
      subscribe(listener) { const wrapped = value => listener({ topic: 'admission', state: value }); listeners.add(wrapped); return () => listeners.delete(wrapped); },
    }),
    call: (name, ...args) => actions[name] ? actions[name](...args) : Promise.reject(failure('EXTENSION_UNKNOWN')),
    close() { if (closed) return; closed = true; clearTimeout(timer); stopAuthority(); lifetime.abort(failure('ADMISSION_CLOSED')); listeners.clear(); },
  });
}
