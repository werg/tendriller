import { notifySetupChanged } from './setup-watch';
import { peerDigest, type PeerAuthority, type SignedGeneration, type SignedTransitionRequest, type PeerGrant } from '@chronolog/peer-generation/control';
import { DEVICE_PAIRING_DOMAIN, DEVICE_PAIRING_LIMITS as LIMITS, pairingProofBytes, validateDevicePairingChallenge,
  verifyDevicePairingProof, type DevicePairingChallenge, type DevicePairingStatus, type DevicePairingPrepared } from '../../contract/pairing.mjs';
import { accountActive, currentPrincipal, freshPrincipal, pageAccessAllowed, requireAgentScope, type Principal } from './access';
import { selectedApplication } from './application';
import type { Env } from './env';
import { HttpError, json, readJson } from './http';
import { sha256Hex } from './ids';
import { exchangePeerControl, peerControlSelectionMatches, withPeerPairingAuthority } from './peer-generations';
import { requireWritesOpen } from './service-state';
import type { Tendril } from './tendril';
import { publicBase } from './urls';

const HEX = /^[0-9a-f]{64}$/;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const REVIEW_DOMAIN = 'tendriller-device-pairing-review-v1';
type StoredState = 'challenge' | 'pending' | 'approved' | 'committing' | 'committed' | 'denied';
interface PairingRecord {
  challenge: DevicePairingChallenge; digest: string; inputDigest: string; createdAt: number;
  state: StoredState; attempts: number; proof?: string;
  reviewedAccount?: string; reviewedDigest?: string;
  csrf?: { hash: string; session: string; expiresAt: number; digest: string };
  prepared?: DevicePairingPrepared; preparedDigest?: string; generation?: SignedGeneration;
}
interface StoredRow { id: string; account_id: string; created_at: number; expires_at: number; status: string; data: string }
const unavailable = () => new HttpError(503, 'pairing_storage_unavailable', 'Pairing state is unavailable. Preserve the original device and request; ask the operator to reconcile storage.');
function object(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new HttpError(400, 'invalid_pairing', 'Unexpected pairing fields');
  return value as Record<string, any>;
}
function pairingId(value: unknown): string {
  if (typeof value !== 'string' || !HEX.test(value)) throw new HttpError(400, 'invalid_pairing', 'A pairing identity is required');
  return value;
}
function read(t: Tendril, id: string): PairingRecord | null {
  let row: StoredRow | null;
  try { row = t.db.one<StoredRow>('SELECT * FROM device_pairings WHERE id=?', id); }
  catch { throw unavailable(); }
  if (!row) return null;
  try {
    const record = JSON.parse(row.data) as PairingRecord;
    validateDevicePairingChallenge(record.challenge);
    if (record.challenge.pairingId !== id || record.challenge.accountId !== row.account_id || record.createdAt !== row.created_at ||
      record.challenge.expiresAt !== row.expires_at || record.state !== row.status || typeof record.digest !== 'string' || !HEX.test(record.digest) ||
      typeof record.inputDigest !== 'string' || !HEX.test(record.inputDigest) ||
      !Number.isSafeInteger(record.attempts) || record.attempts < 0 || record.attempts > LIMITS.invalidProofs ||
      !['challenge', 'pending', 'approved', 'committing', 'committed', 'denied'].includes(record.state) ||
      (record.prepared === undefined) !== (record.preparedDigest === undefined) ||
      record.preparedDigest !== undefined && (typeof record.preparedDigest !== 'string' || !HEX.test(record.preparedDigest)) ||
      ['approved', 'committing', 'committed'].includes(record.state) && (!record.prepared || !record.reviewedDigest || !record.reviewedAccount)) throw new Error();
    if (record.prepared) {
      object(record.prepared, ['request', 'control']);
      if (!record.prepared.request?.payload || !record.prepared.control) throw new Error();
    }
    return record;
  } catch { throw unavailable(); }
}
async function verified(t: Tendril, id: string): Promise<PairingRecord> {
  const record = read(t, id);
  if (!record) throw new HttpError(404, 'pairing_not_found', 'Keep the original request ID; no replacement request was created.');
  if (record.digest !== await sha256Hex(pairingProofBytes(record.challenge)) || record.challenge.applicationId !== selectedApplication(t).id ||
      record.challenge.serviceOrigin !== publicBase(t.env) || record.challenge.pageOrigin !== new URL(t.mainPageUrl()).origin) throw unavailable();
  try {
    if (record.prepared && record.preparedDigest !== await peerDigest(record.prepared) ||
        record.reviewedDigest !== undefined && (!record.prepared || typeof record.reviewedAccount !== 'string' ||
          record.reviewedDigest !== await reviewDigest(record))) throw unavailable();
    if (record.prepared && (!record.proof || !await verifyDevicePairingProof(record.challenge, record.proof))) throw unavailable();
  } catch { throw new HttpError(503, 'pairing_reconciliation_required', nextActions.reconciliation_required); }
  return record;
}
const reviewDigest = (record: PairingRecord) => peerDigest([REVIEW_DOMAIN, record.digest, record.preparedDigest ?? null]);
function save(t: Tendril, record: PairingRecord): void {
  const data = JSON.stringify(record), previous = t.db.one<{ n: number }>('SELECT length(data) AS n FROM device_pairings WHERE id=?', record.challenge.pairingId)?.n ?? 0;
  const used = t.db.one<{ n: number }>('SELECT COALESCE(SUM(length(data)),0) AS n FROM device_pairings')!.n;
  if (used - previous + new TextEncoder().encode(data).byteLength > MAX_LEDGER_BYTES)
    throw new HttpError(429, 'pairing_ledger_full', 'Retained pairing outcomes are full. Inspect existing requests; operator reconciliation is required before creating more.');
  t.db.run(`INSERT INTO device_pairings(id,account_id,created_at,expires_at,status,data) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data`, record.challenge.pairingId,
  record.challenge.accountId, record.createdAt, record.challenge.expiresAt, record.state, data);
}
function account(t: Tendril, principal: Principal): string {
  const current = currentPrincipal(t, principal), owner = t.db.get<string | null>('owner_account', null);
  if (!current || !owner || current.kind === 'page' && (!current.accountId || current.role === 'display'))
    throw new HttpError(403, 'pairing_account_required', 'Sign in to this page before pairing a device.');
  return current.kind === 'agent' ? owner : current.accountId!;
}
function admitted(t: Tendril, id: string): void {
  if (id !== t.db.get('owner_account', null) && !t.db.one('SELECT 1 FROM guest_accounts WHERE account_id=? AND approved=1', id))
    throw new HttpError(403, 'pairing_account_revoked', 'The account no longer has access to this application.');
}
async function fresh(t: Tendril, principal: Principal): Promise<string> {
  const id = account(t, principal);
  if (!await pageAccessAllowed(t) || !await accountActive(t, id) || !await freshPrincipal(t, principal)) throw new HttpError(403, 'pairing_account_revoked');
  if (account(t, principal) !== id) throw new HttpError(403, 'pairing_account_revoked');
  admitted(t, id); return id;
}
function scope(t: Tendril, req: Request, principal: Principal, record: PairingRecord): void {
  const id = account(t, principal);
  if (principal.kind === 'page' && (record.challenge.accountId !== id || req.headers.get('x-tendril-origin') !== record.challenge.pageOrigin))
    throw new HttpError(403, 'pairing_scope_mismatch');
  if (principal.kind === 'agent') requireAgentScope(principal, 'control:write');
}
const grantFor = (c: DevicePairingChallenge): PeerGrant => ({ publicKey: c.publicKey, reader: true, writer: c.rights.writer,
  coordinator: false, recovery: false, administrator: false, publisher: false, dataRole: 'member' });
const nextActions: Record<DevicePairingStatus['state'], string> = {
  challenge: 'Prove possession with the retained browser device.', pending: 'Keep the authorized native participant running; it stages the member-only grant and this browser is added automatically.',
  approved: 'Keep the authorized native participant running to commit the approved grant.', committing: 'Inspect this same request and retry its retained signed transition; do not prepare another transition.',
  committed: 'Connect the retained device through its normal peer session, then verify an application query before showing connected.',
  expired: 'This request expired. Keep the same device and start a new request.',
  denied: 'The request was rejected. No device grant was created by this request.', stale: 'Authority changed. Keep the same device and request a new proposal.',
  revoked: 'The account or device grant was revoked. This request cannot restore it.',
  reconciliation_required: 'Preserve the request and signed attempt. Ask the operator to reconcile the retained authority; do not create a replacement.',
};
async function status(t: Tendril, record: PairingRecord, authority: PeerAuthority, native = false): Promise<DevicePairingStatus> {
  const c = record.challenge;
  let state: DevicePairingStatus['state'] = record.state, generation: SignedGeneration | undefined;
  if (record.prepared) {
    generation = authority.bundle.generations.find(row => row.payload.transition.payload.transitionId === `pair-${c.pairingId}`);
    if (generation && (await peerDigest(generation.payload.transition) !== await peerDigest(record.prepared.request) ||
      !await peerControlSelectionMatches(t, record.prepared))) state = 'reconciliation_required';
    else if (generation) {
      // A generation for this exact transition is either the reviewed commit or the
      // native administrator selecting the same exact staged proposal itself.
      const grant = authority.grant(c.publicKey);
      state = grant?.reader && (!c.rights.writer || grant.writer) ? 'committed' : 'revoked';
    } else if (record.state === 'committed') state = 'reconciliation_required';
  } else if (record.state === 'committing' || record.state === 'committed') state = 'reconciliation_required';
  if (!['committed', 'revoked', 'denied', 'reconciliation_required'].includes(state)) {
    if (c.expiresAt <= t.now()) state = 'expired';
    else if (authority.current?.id !== c.expectedGeneration || authority.control.payload.revision !== c.controlRevision) state = 'stale';
  }
  // Expiry is terminal only after this serialized authority snapshot found no
  // accepted transition. A revoked guest must not hide that evidence forever
  // and strand the native coordinator's retained ordering pause.
  if (!['denied', 'expired', 'reconciliation_required'].includes(state)) {
    if (!await accountActive(t, c.accountId) || c.accountId !== t.db.get('owner_account', null) &&
      !t.db.one('SELECT 1 FROM guest_accounts WHERE account_id=? AND approved=1', c.accountId)) state = 'revoked';
  }
  return { pairingId: c.pairingId, requestId: c.requestId, state, challenge: c, expiresAt: c.expiresAt,
    reviewUrl: `${c.serviceOrigin}/pairings/${t.tid}/${c.pairingId}`,
    nextAction: state === 'pending' && !record.prepared ? 'Keep the authorized native participant running to prepare the exact signed proposal; approval is automatic.' : nextActions[state],
    ...(record.preparedDigest ? { preparedDigest: record.preparedDigest } : {}),
    ...(generation ? { generation } : {}), ...(native && record.prepared ? { prepared: record.prepared } : {}) };
}
function requireOpen(record: PairingRecord, result: DevicePairingStatus, states: readonly string[]): void {
  if (!states.includes(result.state)) throw new HttpError(409, `pairing_${result.state}`, result.nextAction);
  if (record.challenge.expiresAt <= 0) throw unavailable();
}
async function challenge(t: Tendril, req: Request, principal: Principal, input: Record<string, any>, authority: PeerAuthority): Promise<DevicePairingStatus> {
  if (principal.kind !== 'page') throw new HttpError(403, 'pairing_browser_required');
  const value = object(input, ['action', 'requestId', 'publicKey', 'rights']), rights = object(value.rights, ['reader', 'writer']);
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.requestId) ||
      typeof value.publicKey !== 'string' || !HEX.test(value.publicKey) || rights.reader !== true || typeof rights.writer !== 'boolean')
    throw new HttpError(400, 'invalid_pairing');
  const accountId = await fresh(t, principal), pageOrigin = req.headers.get('x-tendril-origin');
  if (pageOrigin !== new URL(t.mainPageUrl()).origin) throw new HttpError(403, 'pairing_scope_mismatch');
  const applicationId = selectedApplication(t).id, serviceOrigin = publicBase(t.env);
  const id = await peerDigest([DEVICE_PAIRING_DOMAIN, serviceOrigin, applicationId, accountId, value.requestId]);
  const inputDigest = await peerDigest([pageOrigin, value.publicKey, rights]);
  const old = read(t, id);
  if (old) {
    if (old.inputDigest !== inputDigest) throw new HttpError(409, 'pairing_request_conflict', 'This retained request ID already names a different device or rights.');
    return status(t, await verified(t, id), authority);
  }
  if (!authority.current) throw new HttpError(409, 'pairing_generation_required', 'Configure and select the initial application generation before requesting pairing.');
  if (authority.grant(value.publicKey)) throw new HttpError(409, 'pairing_device_known', 'This device already has retained authority. Inspect its session or use a separately reviewed authority change.');
  const bindings = t.db.get<{ publicKey: string; accountId: string }[]>('peer_generation_accounts', []), binding = bindings.find(row => row.publicKey === value.publicKey);
  if (binding && binding.accountId !== accountId) throw new HttpError(409, 'peer_account_binding_immutable', 'This device key retains its original enrollment account.');
  if (!binding && bindings.length >= 1024) throw new HttpError(429, 'peer_account_binding_full', 'The retained device/account binding capacity is full.');
  const now = t.now();
  const pending = t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM device_pairings WHERE account_id=? AND expires_at>? AND status IN ('challenge','pending','approved','committing')", accountId, now)!.n;
  const retained = t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM device_pairings')!.n;
  const recent = t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM device_pairings WHERE account_id=? AND created_at>?', accountId, now - 60_000)!.n;
  if (pending >= LIMITS.pendingPerAccount || retained >= LIMITS.retainedPerApplication)
    throw new HttpError(429, 'pairing_ledger_full', 'Inspect existing requests before starting more; unresolved and completed identities are retained.');
  if (recent >= LIMITS.challengesPerMinute) throw new HttpError(429, 'pairing_rate_limited', 'Wait before starting another pairing request; retrying the same ID remains available.');
  const c = validateDevicePairingChallenge({ version: 1, domain: DEVICE_PAIRING_DOMAIN, pairingId: id, requestId: value.requestId,
    serviceOrigin, pageOrigin, applicationId, accountId, publicKey: value.publicKey, rights: { reader: true, writer: rights.writer },
    expectedGeneration: authority.current.id, controlRevision: authority.control.payload.revision,
    nonce: await sha256Hex(crypto.getRandomValues(new Uint8Array(32))), expiresAt: now + LIMITS.lifetimeMs });
  const record: PairingRecord = { challenge: c, digest: await sha256Hex(pairingProofBytes(c)), inputDigest, createdAt: now, state: 'challenge', attempts: 0 };
  await fresh(t, principal);
  t.transaction(() => { account(t, principal); admitted(t, accountId); save(t, record); });
  return status(t, record, authority);
}
async function prove(t: Tendril, req: Request, principal: Principal, input: Record<string, any>, authority: PeerAuthority): Promise<DevicePairingStatus> {
  if (principal.kind !== 'page') throw new HttpError(403, 'pairing_browser_required');
  object(input, ['action', 'pairingId', 'signature']);
  const record = await verified(t, pairingId(input.pairingId));
  scope(t, req, principal, record); await fresh(t, principal);
  const current = await status(t, record, authority);
  if (record.proof && record.proof === input.signature) return current;
  requireOpen(record, current, ['challenge']);
  const valid = await verifyDevicePairingProof(record.challenge, input.signature);
  await fresh(t, principal); scope(t, req, principal, record);
  if (record.challenge.expiresAt <= t.now()) throw new HttpError(409, 'pairing_expired');
  if (!valid) {
    record.attempts++;
    if (record.attempts >= LIMITS.invalidProofs) record.state = 'denied';
    t.transaction(() => save(t, record));
    throw new HttpError(403, 'pairing_proof_invalid', 'The proof does not match this exact request and retained device.');
  }
  record.proof = input.signature; record.state = 'pending';
  t.transaction(() => { save(t, record); notifySetupChanged(t); });
  return status(t, record, authority);
}
async function validateProposal(record: PairingRecord, authority: PeerAuthority, request: SignedTransitionRequest, rawControl: unknown): Promise<void> {
  const c = record.challenge, change = object(rawControl, ['epoch', 'keyDigest', 'grants', 'recoveryFloor', 'accounts']);
  const p = request?.payload, current = authority.current!, before = authority.control.payload;
  if (!p || p.applicationId !== c.applicationId || p.transitionId !== `pair-${c.pairingId}` || p.reason !== 'control-change' ||
    p.expectedGeneration !== c.expectedGeneration || p.controlRevision !== c.controlRevision + 1 ||
    p.coordinator !== current.payload.coordinator || p.base?.point.generation !== current.id ||
    !authority.grant(p.requester)?.administrator || change.epoch !== before.epoch || change.keyDigest !== before.keyDigest ||
    await peerDigest(change.recoveryFloor) !== await peerDigest(before.recoveryFloor))
    throw new HttpError(409, 'pairing_transition_mismatch', 'The signed transition must preserve the reviewed generation, coordinator and retained prefix.');
  if (!Array.isArray(change.grants) || change.grants.length !== before.grants.length + 1 || authority.grant(c.publicKey))
    throw new HttpError(409, 'pairing_grant_mismatch');
  const expected = [...before.grants, grantFor(c)].sort((a, b) => a.publicKey.localeCompare(b.publicKey));
  const actual = [...change.grants].sort((a, b) => String(a?.publicKey).localeCompare(String(b?.publicKey)));
  if (await peerDigest(actual) !== await peerDigest(expected) || await peerDigest(change.accounts) !== await peerDigest([{ publicKey: c.publicKey, accountId: c.accountId }]))
    throw new HttpError(409, 'pairing_grant_mismatch', 'Only the exact reviewed reader/writer grant and account binding may be added.');
}
function nativeProposal(principal: Principal, input: Record<string, any>): { id: string; prepared: DevicePairingPrepared } {
  if (principal.kind !== 'agent') throw new HttpError(403, 'pairing_native_required');
  requireAgentScope(principal, 'control:write'); object(input, ['action', 'pairingId', 'request', 'control']);
  return { id: pairingId(input.pairingId), prepared: { request: input.request, control: input.control } };
}
/** Retain the complete verified signed attempt before the owner can approve it. */
async function prepare(t: Tendril, req: Request, principal: Principal, input: Record<string, any>): Promise<DevicePairingStatus> {
  const { id, prepared } = nativeProposal(principal, input), preparedDigest = await peerDigest(prepared);
  const prior = await withPeerPairingAuthority(t, async authority => {
    const record = await verified(t, id); scope(t, req, principal, record); await fresh(t, principal);
    if (record.preparedDigest) {
      if (record.preparedDigest !== preparedDigest) throw new HttpError(409, 'pairing_transition_conflict');
      return status(t, record, authority, true);
    }
    requireOpen(record, await status(t, record, authority), ['pending']);
    return null;
  });
  if (prior) return prior;
  let retained: PairingRecord | undefined, retainedJson: string | undefined;
  const guard = () => {
    const record = read(t, id);
    if (!record || !['pending', 'approved'].includes(record.state) || record.preparedDigest !== preparedDigest ||
      JSON.stringify(record.prepared) !== retainedJson || record.challenge.expiresAt <= t.now())
      throw new HttpError(409, 'pairing_proposal_changed');
    account(t, principal); admitted(t, record.challenge.accountId);
  };
  await exchangePeerControl(t, principal, 'select', prepared, {
    prepareOnly: true,
    async prepare(authority, request, rawControl) {
      const record = await verified(t, id); scope(t, req, principal, record); await fresh(t, principal);
      requireOpen(record, await status(t, record, authority), ['pending']);
      if (!record.proof || !await verifyDevicePairingProof(record.challenge, record.proof)) throw new HttpError(403, 'pairing_proof_required');
      if (record.preparedDigest && record.preparedDigest !== preparedDigest) throw new HttpError(409, 'pairing_transition_conflict');
      await validateProposal(record, authority, request, rawControl);
      const owner = t.db.get<string | null>('owner_account', null);
      if (!owner) throw new HttpError(403, 'pairing_account_required');
      record.prepared = prepared; record.preparedDigest = preparedDigest; delete record.csrf;
      // Every admitted account (the signed-in owner or an admitted guest) pairs in
      // one go once the native administrator stages the verified member-only grant.
      record.state = 'approved';
      record.reviewedAccount = owner;
      record.reviewedDigest = await reviewDigest(record);
      await fresh(t, principal);
      if (!await accountActive(t, record.challenge.accountId)) throw new HttpError(403, 'pairing_account_revoked');
      t.transaction(() => {
        account(t, principal); admitted(t, record.challenge.accountId);
        if (owner !== t.db.get('owner_account', null)) throw new HttpError(403, 'pairing_owner_required');
        save(t, record); notifySetupChanged(t);
      });
      retained = record; retainedJson = JSON.stringify(record.prepared); guard();
    },
    async check() {
      guard(); await fresh(t, principal);
      if (!await accountActive(t, retained!.challenge.accountId)) throw new HttpError(403, 'pairing_account_revoked');
      guard();
    }, guard,
  });
  return withPeerPairingAuthority(t, async authority => {
    const record = await verified(t, id), result = await status(t, record, authority, true);
    await fresh(t, principal); return result;
  });
}
async function commit(t: Tendril, req: Request, principal: Principal, input: Record<string, any>): Promise<DevicePairingStatus> {
  const { id, prepared } = nativeProposal(principal, input);
  const preparedDigest = await peerDigest(prepared);
  // An accepted transition remains inspectable after expiry or later revocation.
  const prior = await withPeerPairingAuthority(t, async authority => {
    const record = await verified(t, id); scope(t, req, principal, record); await fresh(t, principal);
    if (!record.preparedDigest) throw new HttpError(409, 'pairing_proposal_required', 'Prepare the exact signed proposal before committing.');
    if (record.preparedDigest !== preparedDigest) throw new HttpError(409, 'pairing_transition_conflict');
    const value = await status(t, record, authority, true);
    if (value.generation && value.state !== 'reconciliation_required' && record.reviewedDigest) {
      await fresh(t, principal);
      // Direct native selection is derived from verified authority, not an owner review.
      // Keep the original pending record valid; never invent review fields.
      record.state = 'committed'; record.generation = value.generation;
      t.transaction(() => { account(t, principal); save(t, record); });
    }
    return value.generation ? value : null;
  });
  if (prior) return prior;
  let approved: PairingRecord | undefined, approvedDigest: string | undefined, retainedJson: string | undefined;
  const guard = () => {
    const record = read(t, id), owner = t.db.get('owner_account', null);
    if (!record || record.state !== 'committing' || record.preparedDigest !== preparedDigest ||
      record.reviewedDigest !== approvedDigest || record.reviewedAccount !== owner || JSON.stringify(record.prepared) !== retainedJson ||
      record.digest !== approved?.digest || record.proof !== approved?.proof || record.challenge.expiresAt <= t.now())
      throw new HttpError(409, 'pairing_approval_changed', 'Approval expired, was rejected, or changed before the transition committed.');
    account(t, principal); admitted(t, record.challenge.accountId);
  };
  const check = async () => {
    guard(); await fresh(t, principal);
    if (!await accountActive(t, approved!.challenge.accountId)) throw new HttpError(403, 'pairing_account_revoked');
    guard();
  };
  await exchangePeerControl(t, principal, 'select', prepared, {
    async prepare(authority, request, rawControl) {
      const record = await verified(t, id); scope(t, req, principal, record); await fresh(t, principal);
      requireOpen(record, await status(t, record, authority), ['approved', 'committing']);
      if (record.reviewedDigest !== await reviewDigest(record) || record.reviewedAccount !== t.db.get('owner_account', null) ||
        !record.proof || !await verifyDevicePairingProof(record.challenge, record.proof)) throw new HttpError(403, 'pairing_review_required');
      if (record.preparedDigest !== preparedDigest) throw new HttpError(409, 'pairing_transition_conflict');
      await validateProposal(record, authority, request, rawControl);
      const c = record.challenge;
      record.state = 'committing'; delete record.csrf;
      approved = record; approvedDigest = record.reviewedDigest; retainedJson = JSON.stringify(record.prepared);
      await fresh(t, principal);
      if (!await accountActive(t, c.accountId)) throw new HttpError(403, 'pairing_account_revoked');
      t.transaction(() => { account(t, principal); admitted(t, c.accountId); save(t, record); });
      guard();
    }, check, guard,
  });
  return withPeerPairingAuthority(t, async authority => {
    const record = await verified(t, id), result = await status(t, record, authority, true);
    await fresh(t, principal);
    if (result.generation && result.state !== 'reconciliation_required') {
      record.state = 'committed'; record.generation = result.generation;
      t.transaction(() => { save(t, record); notifySetupChanged(t); });
    }
    return result;
  });
}

const pending = new WeakMap<Tendril, number>();
export async function handleDevicePairing(t: Tendril, req: Request, url: URL, principal: Principal): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  if ((pending.get(t) ?? 0) >= 8) throw new HttpError(429, 'pairing_busy', 'Pairing has bounded in-flight work. Inspect the same request shortly.');
  pending.set(t, (pending.get(t) ?? 0) + 1);
  try {
    await fresh(t, principal);
    if (req.method === 'POST') {
      await requireWritesOpen(t.env);
      const input = object(await readJson(req, principal.kind === 'agent' ? LIMITS.commitBytes : LIMITS.requestBytes), ['action', 'pairingId', 'request', 'control', 'requestId', 'publicKey', 'rights', 'signature']);
      if (input.action === 'prepare') return json(await prepare(t, req, principal, input));
      if (input.action === 'commit') return json(await commit(t, req, principal, input));
      return withPeerPairingAuthority(t, async authority => {
        if (input.action === 'challenge') return json(await challenge(t, req, principal, input, authority));
        if (input.action === 'prove') return json(await prove(t, req, principal, input, authority));
        throw new HttpError(400, 'invalid_pairing');
      });
    }
    return withPeerPairingAuthority(t, async authority => {
      if (url.searchParams.has('pairingId')) {
        const record = await verified(t, pairingId(url.searchParams.get('pairingId')));
        scope(t, req, principal, record);
        const result = await status(t, record, authority, principal.kind === 'agent');
        await fresh(t, principal); scope(t, req, principal, record); return json(result);
      }
      if (principal.kind !== 'agent') throw new HttpError(400, 'pairing_identity_required');
      requireAgentScope(principal, 'control:write');
      let rows: { id: string }[];
      try {
        rows = t.db.all<{ id: string }>(`SELECT id FROM device_pairings WHERE status='committing' OR
          (status IN ('pending','approved') AND expires_at>? AND json_extract(data,'$.challenge.expectedGeneration')=?)
          ORDER BY CASE WHEN json_extract(data,'$.challenge.expectedGeneration')=? THEN 0 ELSE 1 END, created_at DESC LIMIT ?`,
        t.now(), authority.current?.id ?? '', authority.current?.id ?? '', LIMITS.retainedPerApplication);
      } catch { throw unavailable(); }
      const pairings = [];
      // A lost final acknowledgement may leave a completed row marked committing.
      // Filter authoritative outcomes before the public limit so those rows cannot starve new proposals.
      for (const row of rows) {
        const result = await status(t, await verified(t, row.id), authority, true);
        if (['pending', 'approved', 'committing', 'reconciliation_required'].includes(result.state)) pairings.push(result);
        if (pairings.length === LIMITS.pendingPerAccount) break;
      }
      await fresh(t, principal); return json({ pairings });
    });
  } finally { pending.set(t, (pending.get(t) ?? 1) - 1); }
}

/** Legacy review links (from older app kits) only return the browser to its page. */
export async function routeDevicePairingReview(req: Request, env: Env, url: URL): Promise<Response> {
  const match = /^\/pairings\/([a-z2-7]{12})\/([0-9a-f]{64})$/.exec(url.pathname);
  if (!match) throw new HttpError(404, 'not_found');
  if (req.method !== 'GET') throw new HttpError(410, 'pairing_review_removed', 'Browser access is approved automatically; there is nothing to review.');
  const headers = new Headers({ 'x-tendril-id': match[1], 'x-pairing-id': match[2] });
  // The page that asked may name where to continue. The Durable Object accepts
  // it only on that request's exact page origin.
  const returnTo = url.searchParams.get('return_to');
  if (returnTo !== null) {
    if ([...url.searchParams.keys()].length !== 1 || returnTo.length > 2048) throw new HttpError(400, 'invalid_pairing_review');
    headers.set('x-review-return', returnTo);
  } else if (url.search) throw new HttpError(400, 'invalid_pairing_review');
  return env.TENDRIL.get(env.TENDRIL.idFromName(match[1])).fetch(new Request('https://tendril.internal/pairing-review', {
    method: 'GET', headers, signal: req.signal, redirect: 'manual',
  }));
}
/**
 * Browser enrollment has no manual review step: the server approves a verified
 * member-only grant when the native participant stages it. Older app kits may
 * still send the browser here; return it to the page that asked.
 */
export async function reviewDevicePairing(t: Tendril, req: Request): Promise<Response> {
  if (req.method !== 'GET') throw new HttpError(410, 'pairing_review_removed', 'Browser access is approved automatically; there is nothing to review.');
  const record = await verified(t, pairingId(req.headers.get('x-pairing-id')));
  const target = returnTarget(req, record.challenge) ?? new URL(record.challenge.pageOrigin);
  return new Response(null, { status: 303, headers: { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' } });
}
/** Only the exact page origin that created this request may receive the browser back. */
function returnTarget(req: Request, c: DevicePairingChallenge): URL | null {
  const raw = req.headers.get('x-review-return');
  if (raw === null) return null;
  let target: URL;
  try { target = new URL(raw); } catch { throw new HttpError(400, 'invalid_pairing_review', 'The return address must be this page.'); }
  if (target.protocol !== new URL(c.pageOrigin).protocol || target.origin !== c.pageOrigin || target.username || target.password || target.href.length > 2048)
    throw new HttpError(400, 'invalid_pairing_review', 'The return address must be the page that requested this device.');
  return target;
}
