import { notifySetupChanged } from './setup-watch';
import { peerDigest, type PeerAuthority, type SignedGeneration, type SignedTransitionRequest, type PeerGrant } from '@chronolog/peer-generation/control';
import { DEVICE_PAIRING_DOMAIN, DEVICE_PAIRING_LIMITS as LIMITS, pairingProofBytes, validateDevicePairingChallenge,
  verifyDevicePairingProof, type DevicePairingChallenge, type DevicePairingStatus, type DevicePairingPrepared } from '../../contract/pairing.mjs';
import { accountActive, currentPrincipal, freshPrincipal, pageAccessAllowed, requireAgentScope, type Principal } from './access';
import { serviceSession } from './accounts/auth';
import { servicePage } from './accounts/ui';
import { selectedApplication } from './application';
import type { Env } from './env';
import { HttpError, json, readBody, readJson } from './http';
import { safeEqual, sha256Hex } from './ids';
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
  challenge: 'Prove possession with the retained browser device.', pending: 'Open the review URL and ask the application owner to review this exact device.',
  approved: 'Keep the authorized native participant running to commit the reviewed grant.', committing: 'Inspect this same request and retry its retained signed transition; do not prepare another transition.',
  committed: 'Connect the retained device through its normal peer session, then verify an application query before showing connected.',
  expired: 'This request expired. Keep the same device; explicitly start a new request and obtain a new review.',
  denied: 'The request was rejected. No device grant was created by this request.', stale: 'Authority changed. Keep the same device and explicitly request a newly reviewed proposal.',
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
    nextAction: state === 'pending' && !record.prepared ? 'Keep the authorized native participant running to prepare the exact signed proposal before owner review.' : nextActions[state],
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
    if (!record || record.state !== 'pending' || record.preparedDigest !== preparedDigest ||
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
      record.prepared = prepared; record.preparedDigest = preparedDigest; delete record.csrf;
      await fresh(t, principal);
      if (!await accountActive(t, record.challenge.accountId)) throw new HttpError(403, 'pairing_account_revoked');
      t.transaction(() => { account(t, principal); admitted(t, record.challenge.accountId); save(t, record); });
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
    if (!record.preparedDigest) throw new HttpError(409, 'pairing_proposal_required', 'Prepare the exact signed proposal and obtain its owner review before committing.');
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

/** Review lives on the service origin, outside application-authored scripts and frames. */
export async function routeDevicePairingReview(req: Request, env: Env, url: URL): Promise<Response> {
  const match = /^\/pairings\/([a-z2-7]{12})\/([0-9a-f]{64})$/.exec(url.pathname);
  if (!match) throw new HttpError(404, 'not_found');
  if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  if (req.method === 'POST' && req.headers.get('Origin') !== publicBase(env)) throw new HttpError(403, 'bad_origin');
  const session = await serviceSession(req, env);
  if (!session) {
    if (req.method === 'POST') throw new HttpError(401, 'unauthorized', 'Sign in again before reviewing this device.');
    return Response.redirect(`${publicBase(env)}/auth?return_to=${encodeURIComponent(url.pathname + url.search)}`, 303);
  }
  if (!(await env.ACCOUNT_RATE.limit({ key: `pairing-review:${session.accountId}` })).success) throw new HttpError(429, 'rate_limited');
  const raw = /(?:^|;\s*)__Host-tendriller=([^;]+)/.exec(req.headers.get('Cookie') ?? '')![1];
  const headers = new Headers({ 'x-tendril-id': match[1], 'x-pairing-id': match[2], 'x-account-id': session.accountId,
    'x-review-session': await sha256Hex(raw), 'x-review-origin': url.origin });
  if (req.headers.has('Content-Type')) headers.set('Content-Type', req.headers.get('Content-Type')!);
  // The page that asked for review may name where to continue. The Durable
  // Object accepts it only on that request's exact page origin.
  const returnTo = url.searchParams.get('return_to');
  if (returnTo !== null) {
    if ([...url.searchParams.keys()].length !== 1 || returnTo.length > 2048) throw new HttpError(400, 'invalid_pairing_review');
    headers.set('x-review-return', returnTo);
  } else if (url.search) throw new HttpError(400, 'invalid_pairing_review');
  return env.TENDRIL.get(env.TENDRIL.idFromName(match[1])).fetch(new Request('https://tendril.internal/pairing-review', {
    method: req.method, headers, ...(req.method === 'POST' ? { body: req.body } : {}), signal: req.signal,
    // The return to the requesting page is the browser's navigation, never followed here.
    redirect: 'manual',
  }));
}
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
async function reviewOwner(t: Tendril, req: Request): Promise<{ id: string; session: string }> {
  const id = req.headers.get('x-account-id'), session = req.headers.get('x-review-session');
  if (!id || id !== t.db.get('owner_account', null) || !session || !HEX.test(session) || req.headers.get('x-review-origin') !== publicBase(t.env))
    throw new HttpError(403, 'pairing_owner_required', 'The application owner must review this device on the service origin.');
  if (!await pageAccessAllowed(t) || !await t.env.ACCOUNTS.prepare(`SELECT 1 FROM sessions s JOIN accounts a ON a.id=s.account_id
    WHERE s.hash=? AND s.account_id=? AND s.expires_at>? AND a.suspended_at IS NULL AND a.deleting_at IS NULL`).bind(session, id, t.now()).first() || id !== t.db.get('owner_account', null))
    throw new HttpError(403, 'pairing_owner_required');
  return { id, session };
}
export async function reviewDevicePairing(t: Tendril, req: Request): Promise<Response> {
  const id = pairingId(req.headers.get('x-pairing-id'));
  await reviewOwner(t, req);
  const form = req.method === 'POST' ? new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096))) : null;
  if (form && ([...form.keys()].some(key => !['csrf', 'digest', 'action'].includes(key)) || [...form.keys()].length !== 3)) throw new HttpError(400, 'invalid_pairing_review');
  return withPeerPairingAuthority(t, async authority => {
    const owner = await reviewOwner(t, req), record = await verified(t, id);
    // Refuse a foreign return address before issuing or consuming any form.
    const target = returnTarget(req, record.challenge);
    let result = await status(t, record, authority), csrf: string | undefined;
    const digest = await reviewDigest(record);
    if (form) {
      await requireWritesOpen(t.env);
      const tokenHash = await sha256Hex(form.get('csrf') ?? '');
      if (!record.prepared || !record.csrf || record.csrf.session !== owner.session || record.csrf.expiresAt <= t.now() ||
        record.csrf.digest !== digest || !safeEqual(record.csrf.hash, tokenHash) || form.get('digest') !== digest ||
        !['approve', 'deny'].includes(form.get('action') ?? ''))
        throw new HttpError(403, 'pairing_review_stale', 'This review form is expired or already used. Open the review URL again.');
      requireOpen(record, result, ['pending', 'approved', 'committing']);
      if (!record.proof || !await verifyDevicePairingProof(record.challenge, record.proof)) throw unavailable();
      await reviewOwner(t, req);
      if (record.challenge.expiresAt <= t.now()) throw new HttpError(409, 'pairing_expired');
      record.state = form.get('action') === 'deny' ? 'denied' : record.state === 'committing' ? 'committing' : 'approved';
      record.reviewedAccount = owner.id; record.reviewedDigest = digest; delete record.csrf;
      t.transaction(() => { if (owner.id !== t.db.get('owner_account', null)) throw new HttpError(403, 'pairing_owner_required'); save(t, record); notifySetupChanged(t); });
      result = await status(t, record, authority);
    } else if (record.prepared && ['pending', 'approved', 'committing'].includes(result.state)) {
      await requireWritesOpen(t.env);
      csrf = crypto.randomUUID() + crypto.randomUUID();
      record.csrf = { hash: await sha256Hex(csrf), session: owner.session, digest, expiresAt: Math.min(record.challenge.expiresAt, t.now() + 120_000) };
      await reviewOwner(t, req);
      t.transaction(() => save(t, record));
    }
    if (form && target) {
      // One tap continues on the page that asked. Approval itself stays here.
      return new Response(null, { status: 303, headers: { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' } });
    }
    return reviewPage(t, record, result, owner.id, digest, csrf, target);
  });
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
function reviewPage(t: Tendril, record: PairingRecord, result: DevicePairingStatus, ownerId: string, digest: string, csrf: string | undefined, target: URL | null): Response {
  const c = record.challenge, name = escape(t.db.get<string>('name', 'Tendril')), own = c.accountId === ownerId;
  const back = target ? `?return_to=${encodeURIComponent(target.href)}` : '';
  const rights = c.rights.writer ? 'read and change' : 'read';
  const fingerprint = c.publicKey.match(/.{1,8}/g)!.join(' ');
  const formHtml = csrf && !(target && ['approved', 'committing', 'committed'].includes(result.state)) ? `<form method="post" action="${escape(result.reviewUrl + back)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="digest" value="${digest}"><div class="actions"><button id="pairing-approve" class="big" name="action" value="approve">Approve this device</button><button id="pairing-deny" class="secondary" name="action" value="deny">Reject request</button></div></form>` : '';
  const proposal = record.prepared?.request.payload;
  const proposalHtml = proposal ? `<section id="pairing-proposal" class="card"><h2>Exact signed proposal</h2><p>This proposal preserves the existing grants and adds only the device and account shown above. Its complete signed transition and control are retained unchanged through approval and commit.</p><dl><dt>Proposal digest</dt><dd><code>${record.preparedDigest}</code></dd><dt>Current generation</dt><dd><code>${escape(proposal.expectedGeneration!)}</code></dd><dt>Next control revision</dt><dd>${proposal.controlRevision}</dd><dt>Native signer</dt><dd><code>${escape(proposal.requester)}</code></dd><dt>Coordinator</dt><dd><code>${escape(proposal.coordinator)}</code></dd><dt>History checkpoint</dt><dd>Sequence ${proposal.base!.point.sequence} in <code>${escape(proposal.base!.point.generation)}</code>, root <code>${escape(proposal.base!.point.root)}</code></dd></dl><details><summary>Complete signed transition, grants and account bindings</summary><pre>${escape(JSON.stringify(record.prepared, null, 2))}</pre></details></section>` : '<section id="pairing-proposal" class="card"><h2>Waiting for the native participant</h2><p>The exact signed proposal must be prepared before this device can be approved. Keep the native participant running; this page refreshes by itself.</p></section>';
  const details = `<details id="pairing-details"><summary>Technical details</summary><section class="card"><h2>Exact request</h2><dl><dt>Application</dt><dd><code>${escape(c.applicationId)}</code></dd><dt>Account</dt><dd><code>${escape(c.accountId)}</code></dd><dt>Device fingerprint</dt><dd id="pairing-fingerprint"><code>${fingerprint}</code></dd><dt>Rights</dt><dd>Read${c.rights.writer ? ' and write' : ' only'}; member data role; no coordination, recovery, administration or publishing</dd><dt>Page origin</dt><dd><code>${escape(c.pageOrigin)}</code></dd><dt>Service origin</dt><dd><code>${escape(c.serviceOrigin)}</code></dd><dt>Expires</dt><dd>${escape(new Date(c.expiresAt).toISOString())}</dd><dt>Request</dt><dd><code>${escape(c.requestId)}</code></dd></dl></section>${proposalHtml}</details>`;
  const waiting = !record.prepared && ['challenge', 'pending'].includes(result.state);
  const done = ['approved', 'committing', 'committed'].includes(result.state);
  const lead = waiting ? `<p class="lead">Getting the request ready. This takes a few seconds while ${name} prepares it.</p>`
    : done && target ? `<p class="lead">This browser is approved for <strong>${name}</strong>. Returning to the app…</p>`
    : csrf ? `<p class="lead">${own ? `You opened <strong>${name}</strong> in a browser it does not know yet.` : `An account you admitted asks to open <strong>${name}</strong> in a new browser.`} Approving lets that browser ${rights} the app's data with its own key, which never leaves it. It cannot publish code or administer the app.</p>`
    : done ? `<p class="lead">This browser is approved for <strong>${name}</strong>.${target ? ' Returning to the app…' : ' Go back to the app; it continues by itself.'}</p>`
    : `<p class="lead">${escape(result.nextAction)}</p>`;
  const returnLink = target && (!csrf || done) ? `<p><a class="button${done ? '' : ' secondary'}" id="pairing-return" href="${escape(target.href)}">Return to ${name}</a></p>` : '';
  const refresh = waiting ? `<meta http-equiv="refresh" content="2">` : done && target ? `<meta http-equiv="refresh" content="1;url=${escape(target.href)}">` : '';
  const response = servicePage('Review browser device', `${refresh}<style>.pairing-review dd{margin-inline-start:0;margin-bottom:.8rem;overflow-wrap:anywhere}.pairing-review pre{white-space:pre-wrap;overflow-wrap:anywhere}.pairing-review .card{margin:1rem 0}.pairing-review .lead{font-size:1.1rem}.pairing-review button.big{font-size:1.1rem;padding:.9rem 1.4rem}.pairing-review summary{cursor:pointer;margin-top:1.5rem}.pairing-review .device{font-size:.9rem}</style><div class="pairing-review"><h1>${own ? `Add this browser to ${name}?` : `Admit a browser to ${name}?`}</h1>${lead}${formHtml}${returnLink}<p class="device muted">Device <code>${fingerprint.slice(0, 17)}…</code> · from <code>${escape(c.pageOrigin)}</code></p>${formHtml ? '' : `<p id="pairing-state" class="notice" role="status"><strong>${escape(result.state)}</strong>: ${escape(result.nextAction)}</p>`}${formHtml ? details.replace('<summary>Technical details</summary>', `<summary>Technical details</summary><p id="pairing-state" role="status"><strong>${escape(result.state)}</strong>: ${escape(result.nextAction)}</p>`) : details}</div>`);
  const policy = response.headers.get('Content-Security-Policy')!;
  // A completed form redirects to the requesting page; CSP form-action also governs that redirect.
  response.headers.set('Content-Security-Policy', (target ? policy.replace("form-action 'self'", `form-action 'self' ${c.pageOrigin}`) : policy) + "; frame-ancestors 'none'");
  response.headers.set('X-Frame-Options', 'DENY'); return response;
}
