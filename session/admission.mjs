// Chronolog v2 page genesis and host-attested device admission.
// The creator (a browser or native agent) creates the v2 GenesisBlock and epoch 0 key;
// every later device or agent proves its key to the host, receives a host-signed
// Ed25519 attestation (`signHostAttestationV2`), and an online administrator admits it
// atomically via `session.admitMember(...)` (which updates `$permissions` AND seals
// HPKE lockboxes into `$keys` in one public-control operation).
import {
  bytesToHex, createChainGenesis, createWrapKeyPair, decodeGenesisBlock, decodeRecord,
  encodeRecord, genesisChainId, hexToBytes, importWrapPrivateKey, signRecord,
  verifyHostAttestationV2, verifyRecord,
} from '@chronolog/peer-session';
import { authorityRecord, authorityRecordBytes } from '../contract/authority.mjs';

const WRAP_KEY = 'tendriller/admission/wrap-key';
const GENESIS = applicationId => `tendriller/admission/genesis/${applicationId}`;
const INVITE = applicationId => `tendriller/admission/invite/${applicationId}`;
const ENROLLMENT_REQUEST_DOMAIN = 'chronolog/enrollment-request/v2';
const HEX = /^[0-9a-f]{64}$/u;
const failure = (code, message = code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const decode = value => decodeRecord(authorityRecordBytes(value));
const record = value => authorityRecord(encodeRecord(value));
const codeOf = error => String(error?.code ?? error?.message ?? 'ADMISSION_FAILED');
const randomHex = bytes => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256Hex = async bytes => bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const conflict = error => error?.status === 409 || /CONFLICT|initialized/iu.test(codeOf(error));

/** The device's long-lived X25519 key-wrap key, kept beside its signer in the device store. */
export async function deviceWrapKey(store) {
  let saved = await store.get(WRAP_KEY);
  if (saved === null) {
    const pair = await createWrapKeyPair();
    await store.put(WRAP_KEY, encodeRecord(pair));
    saved = await store.get(WRAP_KEY);
  }
  const value = decodeRecord(saved);
  if (!HEX.test(value?.publicKey ?? '') || !(value.privateKey instanceof Uint8Array)) {
    throw failure('WRAP_KEY_INVALID', 'The retained key-wrap key is damaged; restore this device profile.');
  }
  return Object.freeze({ publicKey: value.publicKey, privateKey: await importWrapPrivateKey(value.privateKey) });
}

export const DEFAULT_OWNER_GRANT = Object.freeze({ reader: true, writer: true, administrator: true });
const ROLE_GRANTS = Object.freeze({
  reader: { reader: true, writer: false, administrator: false },
  writer: { reader: true, writer: true, administrator: false },
  admin: DEFAULT_OWNER_GRANT,
});

function policyGrant(input) {
  const value = typeof input === 'string' ? ROLE_GRANTS[input] : input;
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 ||
      !['reader', 'writer', 'administrator'].every(key => typeof value[key] === 'boolean') ||
      !value.reader && (value.writer || value.administrator)) {
    throw failure('ADMISSION_GRANT_INVALID', 'The owner-device grant is reader, writer or admin (or exactly {reader,writer,administrator} booleans).');
  }
  return { reader: value.reader, writer: value.writer, administrator: value.administrator };
}

/**
 * Create a Chronolog v2 GenesisBlock for a Tendriller page.
 * By default pins the host attestation key, owner admission accounts, and default owner-device
 * grant inside `$permissions.admission`. Pass `admission: null` or supply a custom
 * `topics.$permissions` reducer (e.g. `multisigMembers` or `openMembers`) to opt out of
 * host-attested admission completely.
 */
export async function createPageGenesis({
  identity, wrapKey, hostKey, accounts = [], mode = 'attested', ownerGrant = DEFAULT_OWNER_GRANT,
  admission = undefined, privateChain = true, imports, topics, finalitySchedule, frozenReducers, salt,
}) {
  const customPerms = Boolean(topics && Object.hasOwn(topics, '$permissions'));
  const hostAttested = admission !== null && !customPerms;
  if (!HEX.test(identity?.publicKey ?? '') || !HEX.test(wrapKey ?? '')) {
    throw failure('GENESIS_INPUT_INVALID');
  }
  if (hostAttested && !HEX.test(hostKey ?? '')) {
    throw failure('GENESIS_INPUT_INVALID');
  }
  const grant = hostAttested ? policyGrant(ownerGrant) : null;
  const created = await createChainGenesis({
    creator: {
      publicKey: identity.publicKey,
      wrapKey,
      reader: true,
      writer: true,
      administrator: true,
      publisher: true,
      finalizer: true,
    },
    privateChain,
    ...(hostAttested ? { hostPublicKey: hostKey } : {}),
    imports,
    topics,
    finalitySchedule,
    frozenReducers,
    salt,
  });
  if (!hostAttested) {
    return {
      chainId: created.chainId,
      genesis: created.genesis,
      genesisBytes: created.genesisBytes,
      casNodes: created.casNodes,
      epoch0Key: created.epoch0Key,
    };
  }
  // Embed full Tendriller admission policy into initial $permissions.admission and re-encode deterministically.
  const genesis = structuredClone(created.genesis);
  genesis.initialTopics.$permissions = {
    ...genesis.initialTopics.$permissions,
    admission: { hostKey, mode, accounts: [...accounts], grant, invites: [] },
  };
  const { encodeGenesisBlock } = await import('@chronolog/peer-session');
  const genesisBytes = encodeGenesisBlock(genesis);
  const chainId = bytesToHex(genesisChainId(genesisBytes));
  return {
    chainId,
    genesis,
    genesisBytes,
    casNodes: created.casNodes,
    epoch0Key: created.epoch0Key,
  };
}

/**
 * Open or initialize a page's Chronolog v2 genesis on the host.
 * Retains the generated genesis and epoch 0 key locally BEFORE posting to the host so
 * retries after an uncertain network reply resend the exact same bytes.
 */
export async function openPageGenesis({
  store, identity, wrapKey, peers, applicationId, create = true, ownerGrant, imports, topics, privateChain = true, finalitySchedule, signal,
}) {
  const readCachedIntent = async (...keys) => {
    for (const k of keys) {
      if (!k) continue;
      const raw = await store?.get(GENESIS(k));
      if (raw) {
        const parsed = decodeRecord(raw);
        if (parsed?.genesisBytes instanceof Uint8Array) return parsed;
      }
    }
    return null;
  };

  let metadata;
  try {
    metadata = await peers.application({ signal });
  } catch (error) {
    const cached = await readCachedIntent(applicationId, 'pending');
    if (cached && (!applicationId || cached.chainId === applicationId)) {
      return {
        chainId: cached.chainId,
        genesis: decodeGenesisBlock(cached.genesisBytes),
        genesisBytes: cached.genesisBytes,
        casNodes: cached.casNodes ?? [],
        publicOps: [],
        epoch0Key: cached.epoch0Key,
        created: false,
      };
    }
    throw error;
  }

  if (metadata.genesis !== null) {
    const genesisBytes = authorityRecordBytes(metadata.genesis, 1024 * 1024);
    const genesis = decodeGenesisBlock(genesisBytes);
    const chainId = bytesToHex(genesisChainId(genesisBytes));
    const synced = await peers.syncControl({}, { signal });
    const casNodes = (synced.casNodes ?? []).map(n => ({ hash: n.hash, bytes: hexToBytes(n.bytes), partition: 'public' }));
    const publicOps = (synced.publicOps ?? []).map(r => authorityRecordBytes(r, 256 * 1024));
    const intent = await readCachedIntent(chainId, applicationId, 'pending');
    const epoch0Key = intent?.chainId === chainId ? intent.epoch0Key : undefined;
    await store?.put(GENESIS(chainId), encodeRecord({
      chainId,
      genesisBytes,
      casNodes,
      ...(epoch0Key ? { epoch0Key } : {}),
    }));
    return { chainId, genesis, genesisBytes, casNodes, publicOps, epoch0Key, created: false };
  }

  if (!create) throw failure('PAGE_UNINITIALIZED', 'The page creator has not initialized its data yet.');
  const intentKey = GENESIS(applicationId ?? 'pending');
  let intent = await readCachedIntent(applicationId, 'pending');
  if (!intent) {
    intent = await createPageGenesis({
      identity,
      wrapKey: wrapKey.publicKey,
      hostKey: metadata.hostAttestationKey,
      accounts: metadata.admissionAccounts,
      ownerGrant,
      imports,
      topics,
      privateChain,
      finalitySchedule,
    });
    await store?.put(intentKey, encodeRecord(intent));
  }
  try {
    metadata = await peers.initialize({
      genesis: authorityRecord(intent.genesisBytes),
      casNodes: intent.casNodes.map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
    });
  } catch (error) {
    if (!conflict(error)) throw error;
    metadata = await peers.application({ signal });
  }
  const genesisBytes = authorityRecordBytes(metadata.genesis, 1024 * 1024);
  const genesis = decodeGenesisBlock(genesisBytes);
  const chainId = bytesToHex(genesisChainId(genesisBytes));
  const created = chainId === intent.chainId;
  if (!created) await store?.delete?.(intentKey);
  else {
    await store?.put(GENESIS(chainId), encodeRecord({
      chainId,
      genesisBytes,
      casNodes: intent.casNodes,
      ...(intent.epoch0Key ? { epoch0Key: intent.epoch0Key } : {}),
    }));
  }
  return {
    chainId,
    genesis,
    genesisBytes,
    casNodes: intent.casNodes,
    publicOps: [],
    epoch0Key: created ? intent.epoch0Key : undefined,
    created,
  };
}

/** Route owner extension calls by name across several extensions. */
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
    subscribe(listener) {
      const stops = extensions.map(extension => extension.subscribe?.(listener) ?? (() => {}));
      return () => { for (const stop of stops) stop(); };
    },
  });
}

function attestedAccountAuthorized(admission, payload) {
  const accounts = admission?.accounts ?? [];
  if (!accounts.length) return false;
  if (accounts.includes(payload.accountId)) return true;
  if (payload.email && accounts.includes(`email:${payload.email.toLowerCase()}`)) return true;
  return false;
}

/**
 * Unified Chronolog v2 admission controller for one open session (browser device or native agent).
 * Syncs public-control ops (`$permissions`, `$keys`, `$finality`, `$publications`) with the
 * blind host, submits host-attested enrollment requests when not yet admitted, and lets
 * administrators admit/remove/rotate members atomically via `session.admitMember` / `session.removeMember`.
 */
export function createAdmission(session, {
  peers, wrapKey, store, subject = 'device', now = () => Date.now(),
  memberIntervalMs = 0, waitingIntervalMs = 3_000, onEvent = () => {}, onEpochRotated = null,
} = {}) {
  const identity = session.device.identity;
  const applicationId = session.applicationId;
  const listeners = new Set();
  const lifetime = new AbortController();
  let attestation = null, invite = null, inviteLoaded = false, timer, running, again = false, closed = false;
  let wasMember = session.isMember(identity.publicKey);
  let known = new Set((session.permissions().members ?? []).map(m => m.publicKey));
  let seenPending = new Set();
  let notices = [], pending = [], lastError = null;
  let state = snapshot();

  function snapshot() {
    const perms = session.permissions();
    const keys = session.keysState();
    const admission = perms.admission ?? {};
    const members = (perms.members ?? []).map(m => Object.freeze({
      ...m,
      self: m.publicKey === identity.publicKey,
    }));
    const me = members.find(m => m.publicKey === identity.publicKey) ?? null;
    const hasKey = !session.genesis.privateChain || keys.currentEpoch < 0 || session.hasEpochKey(keys.currentEpoch);
    const phase = closed ? 'closed'
      : me === null ? (wasMember ? 'removed' : admission.mode === 'strict' ? 'waiting-approval' : 'waiting-admission')
        : !hasKey ? 'waiting-keys' : 'admitted';
    const invites = (admission.invites ?? []).map(item => Object.freeze({
      ...item,
      redemptions: item.redemptions ?? 0,
      expired: now() >= item.expiresAt,
    }));
    return Object.freeze({
      phase,
      publicKey: identity.publicKey,
      wrapKey: wrapKey.publicKey,
      subject,
      mode: admission.mode ?? 'attested',
      accounts: [...(admission.accounts ?? [])],
      ownerGrant: Object.freeze({ ...(admission.grant ?? DEFAULT_OWNER_GRANT) }),
      epoch: keys.currentEpoch,
      administrator: me?.administrator === true,
      canAdmit: me?.administrator === true && hasKey,
      members,
      pending: [...pending],
      invites,
      notices: [...notices],
      attestationExpiresAt: attestation?.payload.expiresAt ?? null,
      error: lastError,
    });
  }

  const emit = () => { state = snapshot(); for (const listener of listeners) { try { listener(state); } catch {} } };
  const notice = value => {
    const entry = Object.freeze({ id: randomHex(8), at: now(), ...value });
    notices = [...notices, entry].slice(-20);
    onEvent(entry);
  };

  async function loadInvite() {
    if (inviteLoaded) return;
    inviteLoaded = true;
    const saved = await store?.get(INVITE(applicationId));
    if (saved) invite = decodeRecord(saved);
  }

  async function syncWithHost() {
    const facts = await session.exportFacts();
    const synced = await peers.syncControl({
      publicOps: facts.publicOps.map(authorityRecord),
      casNodes: facts.casNodes.filter(n => n.partition === 'public').map(n => ({ hash: n.hash, bytes: bytesToHex(n.bytes) })),
      checkpoints: facts.checkpoints.map(cp => authorityRecord(encodeRecord(cp))),
    }, { signal: lifetime.signal });
    const incomingOps = (synced.publicOps ?? []).map(r => authorityRecordBytes(r, 256 * 1024));
    const incomingCas = (synced.casNodes ?? []).map(n => ({ hash: n.hash, bytes: hexToBytes(n.bytes), partition: 'public' }));
    const incomingCps = (synced.checkpoints ?? []).map(r => decodeRecord(authorityRecordBytes(r, 256 * 1024)));
    if (incomingOps.length || incomingCas.length || incomingCps.length) {
      await session.mergeFacts({
        publicOps: incomingOps,
        encryptedEnvelopes: [],
        casNodes: incomingCas,
        retentions: [],
        checkpoints: incomingCps,
      });
    }
    if (wrapKey?.privateKey && session.isReader(identity.publicKey)) {
      await session.unlockEpochsFromKeysTopic(wrapKey.privateKey, wrapKey.publicKey).catch(() => {});
    }
  }

  async function attest() {
    if (attestation !== null) {
      const { issuedAt, expiresAt } = attestation.payload;
      if (now() < issuedAt + (expiresAt - issuedAt) / 2) return;
    }
    await loadInvite();
    let result;
    if (subject === 'agent') {
      result = await peers.enrollAgent();
    } else {
      const challenge = await peers.challenge(identity.publicKey);
      const proof = await signRecord(ENROLLMENT_REQUEST_DOMAIN, {
        applicationId,
        publicKey: identity.publicKey,
        wrapKey: wrapKey.publicKey,
        challenge: challenge.challenge,
      }, identity);
      result = await peers.enroll(record(proof), invite ? { inviteId: invite.inviteId, secret: invite.secret } : undefined);
    }
    attestation = decode(result.attestation);
    const hostKey = session.permissions().admission?.hostKey;
    if (hostKey && !await verifyHostAttestationV2(attestation, hostKey)) {
      throw failure('ATTESTATION_SIGNATURE_INVALID');
    }
  }

  async function classify(item) {
    const value = decode(item);
    const perms = session.permissions();
    const hostKey = perms.admission?.hostKey;
    if (!hostKey || !await verifyHostAttestationV2(value, hostKey)) return null;
    const payload = value.payload;
    if (!payload || payload.applicationId !== applicationId || now() >= payload.expiresAt) return null;
    if (perms.members.some(m => m.publicKey === payload.publicKey)) return null;
    const removed = perms.admission?.removed ?? [];
    if (removed.includes(payload.publicKey)) {
      return { attestation: value, payload, via: null, reason: 'previously_removed', invite: null };
    }
    let via = null, reason = null;
    const invites = perms.admission?.invites ?? [];
    const matchedInvite = payload.inviteId ? invites.find(i => i.inviteId === payload.inviteId) : null;
    if (matchedInvite) {
      const maxRedemptions = matchedInvite.binding?.kind === 'open' ? 1
        : matchedInvite.binding?.kind === 'public' ? (matchedInvite.binding.max ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER;
      if (matchedInvite.revoked) reason = 'invite_revoked';
      else if (now() >= matchedInvite.expiresAt) reason = 'invite_expired';
      else if ((matchedInvite.redemptions ?? 0) >= maxRedemptions) reason = 'invite_already_redeemed';
      else if (matchedInvite.binding?.kind === 'email' && String(payload.email ?? '').toLowerCase() !== matchedInvite.binding.email) reason = 'invite_email_mismatch';
      else via = 'invited';
    } else if (attestedAccountAuthorized(perms.admission, payload)) {
      via = 'attested';
    } else {
      reason = 'account_not_authorized';
    }
    if ((perms.admission?.mode ?? 'attested') === 'strict' && via !== null) { reason = 'strict_mode'; via = null; }
    return { attestation: value, payload, via, reason, invite: matchedInvite };
  }

  async function adminDuties() {
    const result = await peers.admissions({ signal: lifetime.signal });
    const classified = [];
    for (const item of result.pending ?? []) {
      const entry = await classify(item).catch(() => null);
      if (entry) classified.push(entry);
    }
    pending = classified.filter(e => e.via === null).map(e => Object.freeze({
      publicKey: e.payload.publicKey,
      subject: e.payload.subject,
      label: e.payload.label,
      accountId: e.payload.accountId,
      email: e.payload.email,
      inviteId: e.payload.inviteId,
      issuedAt: e.payload.issuedAt,
      expiresAt: e.payload.expiresAt,
      reason: e.reason,
    }));
    for (const item of pending) {
      if (!seenPending.has(item.publicKey)) {
        seenPending.add(item.publicKey);
        notice({ kind: 'pending', publicKey: item.publicKey, label: item.label, subject: item.subject, reason: item.reason });
      }
    }
    let changed = false;
    const policy = session.permissions().admission ?? {};
    const grantDefault = policy.grant ?? DEFAULT_OWNER_GRANT;
    for (const entry of classified.filter(e => e.via !== null)) {
      if (session.isMember(entry.payload.publicKey)) continue;
      const roleGrant = entry.invite
        ? (ROLE_GRANTS[entry.invite.role] ?? ROLE_GRANTS.writer)
        : (entry.payload.subject === 'agent' ? { reader: true, writer: true, administrator: false } : grantDefault);
      await session.admitMember({
        publicKey: entry.payload.publicKey,
        wrapKey: entry.payload.wrapKey,
        ...roleGrant,
        attestation: entry.attestation,
      });
      if (entry.invite) {
        const cur = session.permissions().admission ?? {};
        const nextInvites = (cur.invites ?? []).map(i =>
          i.inviteId === entry.invite.inviteId ? { ...i, redemptions: (i.redemptions ?? 0) + 1 } : i);
        await session.submit({
          updates: [{ topic: '$permissions', input: { action: 'setAdmission', admission: { ...cur, invites: nextInvites } } }],
        });
      }
      notice({ kind: 'new-device', publicKey: entry.payload.publicKey, label: entry.payload.label, subject: entry.payload.subject, via: entry.via });
      changed = true;
    }

    // Org-group admission and departure automation (verified admin-signed policy + host-signed attestations/departures).
    if (typeof peers.groups === 'function') {
      const groupsData = await peers.groups({ signal: lifetime.signal }).catch(() => null);
      const permsNow = session.permissions();
      const hostKey = permsNow.admission?.hostKey;
      const groupPolicy = groupsData?.policy;
      let verifiedRules = [];
      if (groupPolicy && hostKey) {
        const signerKey = groupPolicy.signer;
        const isSignerAdmin = permsNow.members.some(m => m.publicKey === signerKey && m.administrator);
        if (isSignerAdmin && groupPolicy.payload?.applicationId === applicationId) {
          try {
            await verifyRecord('tendriller-group-policy-v1', groupPolicy, signerKey);
            if (Array.isArray(groupPolicy.payload.rules)) verifiedRules = groupPolicy.payload.rules;
          } catch {}
        }
      }
      if (hostKey && verifiedRules.length > 0) {
        const removedSet = new Set(permsNow.admission?.removed ?? []);
        for (const ga of groupsData?.group_attestations ?? []) {
          try {
            await verifyRecord('tendriller-group-attestation-v1', ga, hostKey);
          } catch { continue; }
          const gp = ga.payload;
          if (!gp || gp.applicationId !== applicationId || now() >= gp.expiresAt) continue;
          if (session.isMember(gp.publicKey) || removedSet.has(gp.publicKey)) continue;
          const rule = verifiedRules.find(r => r.ruleId === gp.ruleId && r.group === gp.group);
          if (!rule) continue;
          const roleGrant = ROLE_GRANTS[rule.role] ?? ROLE_GRANTS.writer;
          await session.admitMember({
            publicKey: gp.publicKey,
            wrapKey: gp.wrapKey,
            ...roleGrant,
          });
          notice({ kind: 'org-admitted', publicKey: gp.publicKey, group: gp.group, role: rule.role });
          changed = true;
        }
      }
      if (hostKey) {
        for (const dep of groupsData?.departures ?? []) {
          try {
            await verifyRecord('tendriller-org-departure-v1', dep, hostKey);
          } catch { continue; }
          const dp = dep.payload;
          if (!dp || dp.applicationId !== applicationId) continue;
          const curPerms = session.permissions();
          const member = curPerms.members.find(m => m.publicKey === dp.publicKey);
          // Guardrail: never auto-revoke self, an administrator, or an owner account.
          if (dp.publicKey === identity.publicKey || member?.administrator === true ||
              attestedAccountAuthorized(curPerms.admission, { accountId: dp.accountId })) {
            continue;
          }
          if (member) {
            await session.removeMember(dp.publicKey, { rotateEpoch: session.genesis.privateChain });
            const epoch = session.keysState().currentEpoch;
            notice({ kind: 'org-offboarded', publicKey: dp.publicKey, group: dp.group });
            if (typeof onEpochRotated === 'function') {
              try { await onEpochRotated({ epoch, reason: 'org-offboarded', publicKey: dp.publicKey }); } catch {}
            }
            changed = true;
          }
          await peers.ackDeparture?.(dp.publicKey, { signal: lifetime.signal }).catch(() => {});
        }
      }
    }
    if (changed) await syncWithHost();
  }

  function observeMembership() {
    const current = new Set((session.permissions().members ?? []).map(m => m.publicKey));
    for (const pk of current) if (!known.has(pk) && pk !== identity.publicKey) notice({ kind: 'new-device', publicKey: pk });
    for (const pk of known) if (!current.has(pk)) notice({ kind: 'removed', publicKey: pk, self: pk === identity.publicKey });
    known = current;
    if (current.has(identity.publicKey)) wasMember = true;
  }

  async function tick() {
    try {
      await syncWithHost();
      observeMembership();
      const me = session.isMember(identity.publicKey);
      const hasHostAdmission = Boolean(session.permissions().admission?.hostKey);
      if (!me) {
        if (!wasMember && hasHostAdmission) await attest();
      } else if (session.isAdministrator(identity.publicKey) && hasHostAdmission) {
        await adminDuties();
      }
      lastError = null;
    } catch (error) {
      if (!lifetime.signal.aborted) lastError = codeOf(error);
    }
    observeMembership();
    emit();
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (closed || !ms || ms <= 0) return;
    timer = setTimeout(() => { void refresh(); }, ms);
    timer.unref?.();
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

  const requireAdmin = () => {
    if (!session.isAdministrator(identity.publicKey)) {
      throw failure('ADMINISTRATOR_REQUIRED', 'Only an administrator device (or the owner’s agent) can do this.');
    }
  };

  async function administer(work) {
    await syncWithHost();
    requireAdmin();
    const res = await work();
    await syncWithHost();
    observeMembership();
    emit();
    return res;
  }

  const actions = {
    'admission.state': async () => state,
    'admission.refresh': async () => refresh(),
    async 'admission.approve'(publicKey, flags = {}) {
      return administer(async () => {
        const { pending: list } = await peers.admissions({ signal: lifetime.signal });
        const perms = session.permissions();
        for (const item of list ?? []) {
          const entry = await classify(item).catch(() => null);
          if (entry?.payload.publicKey !== publicKey) continue;
          const defaultGrant = attestedAccountAuthorized(perms.admission, entry.payload)
            ? (perms.admission?.grant ?? DEFAULT_OWNER_GRANT)
            : ROLE_GRANTS.writer;
          await session.admitMember({
            publicKey,
            wrapKey: entry.payload.wrapKey,
            reader: true,
            writer: flags.writer ?? defaultGrant.writer,
            administrator: flags.administrator ?? defaultGrant.administrator,
            attestation: entry.attestation,
          });
          return { approved: publicKey };
        }
        throw failure('ADMISSION_REQUEST_UNKNOWN', 'That device has no fresh, verified sign-in request; ask it to reload.');
      });
    },
    async 'admission.remove'(publicKey) {
      return administer(async () => {
        if (publicKey === identity.publicKey) throw failure('ADMISSION_SELF_REMOVAL', 'Remove this device from another administrator device.');
        await session.removeMember(publicKey, { rotateEpoch: session.genesis.privateChain });
        const cur = session.permissions().admission ?? {};
        const removed = [...new Set([...(cur.removed ?? []), publicKey])];
        await session.submit({
          updates: [{ topic: '$permissions', input: { action: 'setAdmission', admission: { ...cur, removed } } }],
        });
        const epoch = session.keysState().currentEpoch;
        if (typeof onEpochRotated === 'function') {
          try { await onEpochRotated({ epoch, reason: 'removed', publicKey }); } catch {}
        }
        return { removed: publicKey, epoch };
      });
    },
    async 'admission.mode'(mode) {
      if (mode !== 'attested' && mode !== 'strict') throw failure('ADMISSION_MODE_INVALID');
      return administer(async () => {
        const cur = session.permissions().admission ?? {};
        await session.submit({ updates: [{ topic: '$permissions', input: { action: 'setAdmission', admission: { ...cur, mode } } }] });
        return { mode };
      });
    },
    async 'admission.ownerGrant'(input) {
      const grant = policyGrant(input);
      return administer(async () => {
        const cur = session.permissions().admission ?? {};
        await session.submit({ updates: [{ topic: '$permissions', input: { action: 'setAdmission', admission: { ...cur, grant } } }] });
        return { ownerGrant: grant };
      });
    },
    async 'admission.pinHostKey'() {
      return administer(async () => {
        const metadata = await peers.application({ signal: lifetime.signal });
        if (!HEX.test(metadata.hostAttestationKey ?? '')) throw failure('attestation_unconfigured');
        const cur = session.permissions().admission ?? {};
        await session.submit({ updates: [{ topic: '$permissions', input: { action: 'setAdmission', admission: { ...cur, hostKey: metadata.hostAttestationKey } } }] });
        return { hostKey: metadata.hostAttestationKey };
      });
    },
    async 'admission.grant'(publicKey, flags = {}) {
      return administer(async () => {
        const existing = session.permissions().members.find(m => m.publicKey === publicKey);
        if (!existing) throw failure('MEMBER_UNKNOWN');
        await session.submit({
          updates: [{
            topic: '$permissions',
            input: {
              action: 'setMember',
              member: {
                ...existing,
                writer: flags.writer ?? existing.writer,
                administrator: flags.administrator ?? existing.administrator,
              },
            },
          }],
        });
        return { publicKey, writer: flags.writer ?? existing.writer, administrator: flags.administrator ?? existing.administrator };
      });
    },
    async 'admission.addKey'(publicKey, memberWrapKey = null, flags = {}) {
      if (!HEX.test(publicKey ?? '') || (memberWrapKey !== null && !HEX.test(memberWrapKey))) throw failure('MEMBER_KEY_INVALID');
      return administer(async () => {
        await session.admitMember({
          publicKey,
          ...(memberWrapKey ? { wrapKey: memberWrapKey } : {}),
          reader: true,
          writer: flags.writer !== false,
          administrator: flags.administrator === true,
        });
        return { publicKey };
      });
    },
    async 'admission.invite'({ binding, role, expiresInMs = 7 * 86_400_000 } = {}) {
      if (!['reader', 'writer', 'admin'].includes(role ?? (role = binding?.kind === 'public' ? 'reader' : 'writer'))) throw failure('INVITE_INVALID');
      const normalized = binding?.kind === 'email' ? { kind: 'email', email: String(binding.email ?? '').trim().toLowerCase() }
        : binding?.kind === 'open' ? { kind: 'open' } : binding?.kind === 'public' ? { kind: 'public', max: binding.max ?? null } : null;
      if (!normalized || !Number.isSafeInteger(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 90 * 86_400_000) throw failure('INVITE_INVALID');
      return administer(async () => {
        const secret = crypto.getRandomValues(new Uint8Array(32));
        const inviteId = randomHex(16);
        const entry = { inviteId, role, binding: normalized, expiresAt: now() + expiresInMs, secretDigest: await sha256Hex(secret), revoked: false, redemptions: 0 };
        const cur = session.permissions().admission ?? {};
        await session.submit({
          updates: [{ topic: '$permissions', input: { action: 'setAdmission', admission: { ...cur, invites: [...(cur.invites ?? []), entry] } } }],
        });
        return { inviteId, role, binding: normalized, expiresAt: entry.expiresAt, fragment: `invite=${inviteId}.${bytesToHex(secret)}` };
      });
    },
    async 'admission.revokeInvite'(inviteId) {
      return administer(async () => {
        const cur = session.permissions().admission ?? {};
        const invites = cur.invites ?? [];
        if (!invites.some(i => i.inviteId === inviteId)) throw failure('INVITE_UNKNOWN');
        await session.submit({
          updates: [{ topic: '$permissions', input: { action: 'setAdmission', admission: { ...cur, invites: invites.map(i => i.inviteId === inviteId ? { ...i, revoked: true } : i) } } }],
        });
        return { revoked: inviteId };
      });
    },
    async 'admission.setGroupPolicy'(pageId, rules) {
      return administer(async () => {
        if (typeof peers.setGroupPolicy !== 'function') throw failure('GROUPS_UNSUPPORTED');
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
    async 'admission.redeem'(fragment) {
      const match = /^(?:#?invite=)?([0-9a-f]{32})\.([0-9a-f]{64})$/u.exec(String(fragment ?? ''));
      if (!match) throw failure('INVITE_LINK_INVALID', 'This invite link is incomplete; ask for a new one.');
      invite = { inviteId: match[1], secret: match[2] };
      inviteLoaded = true;
      attestation = null;
      await store?.put(INVITE(applicationId), encodeRecord(invite));
      return refresh();
    },
  };

  const stopChanges = session.onChange(() => { observeMembership(); emit(); });
  void refresh();
  return Object.freeze({
    get state() { return state; },
    subscribe(listener) { listeners.add(listener); try { listener(state); } catch {} return () => listeners.delete(listener); },
    refresh,
    extensions: Object.freeze({
      async call(name, args) { const action = actions[name]; if (!action) throw failure('EXTENSION_UNKNOWN'); return action(...args); },
      subscribe(listener) { const wrapped = value => listener({ topic: 'admission', state: value }); listeners.add(wrapped); return () => listeners.delete(wrapped); },
    }),
    call: (name, ...args) => actions[name] ? actions[name](...args) : Promise.reject(failure('EXTENSION_UNKNOWN')),
    close() { if (closed) return; closed = true; clearTimeout(timer); stopChanges(); lifetime.abort(failure('ADMISSION_CLOSED')); listeners.clear(); },
  });
}
