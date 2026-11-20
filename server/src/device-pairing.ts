import { peerDigest, type PeerAuthority, type SignedGeneration, type PeerGrant } from '@chronolog/peer-generation/control';
import { DEVICE_PAIRING_DOMAIN, DEVICE_PAIRING_LIMITS as LIMITS, pairingProofBytes, validateDevicePairingChallenge,
  verifyDevicePairingProof, type DevicePairingChallenge, type DevicePairingStatus, type DevicePairingPrepared } from '../../contract/pairing.mjs';
import { accountActive, currentPrincipal, pageAccessAllowed, requireAgentScope, type Principal } from './access';
import { serviceSession } from './accounts/auth';
import { servicePage } from './accounts/ui';
import { selectedApplication } from './application';
import type { Env } from './env';
import { HttpError, json, readBody, readJson } from './http';
import { safeEqual, sha256Hex } from './ids';
import { exchangePeerControl, withPeerPairingAuthority } from './peer-generations';
import { requireWritesOpen } from './service-state';
import type { Tendril } from './tendril';
import { publicBase } from './urls';

const HEX = /^[0-9a-f]{64}$/;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
type StoredState = 'challenge' | 'pending' | 'approved' | 'committing' | 'committed' | 'denied';
interface PairingRecord {
  challenge: DevicePairingChallenge; digest: string; inputDigest: string; createdAt: number;
  state: StoredState; attempts: number; proof?: string;
  reviewedAccount?: string; reviewedDigest?: string;
  csrf?: { hash: string; session: string; expiresAt: number };
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
      record.challenge.expiresAt !== row.expires_at || record.state !== row.status || !HEX.test(record.digest) || !HEX.test(record.inputDigest) ||
      !Number.isSafeInteger(record.attempts) || record.attempts < 0 || record.attempts > LIMITS.invalidProofs ||
      !['challenge', 'pending', 'approved', 'committing', 'committed', 'denied'].includes(record.state)) throw new Error();
    return record;
  } catch { throw unavailable(); }
}
async function verified(t: Tendril, id: string): Promise<PairingRecord> {
  const record = read(t, id);
  if (!record) throw new HttpError(404, 'pairing_not_found', 'Keep the original request ID; no replacement request was created.');
  if (record.digest !== await sha256Hex(pairingProofBytes(record.challenge)) || record.challenge.applicationId !== selectedApplication(t).id ||
      record.challenge.serviceOrigin !== publicBase(t.env) || record.challenge.pageOrigin !== new URL(t.mainPageUrl()).origin) throw unavailable();
  if (record.prepared && (!record.preparedDigest || !HEX.test(record.preparedDigest) || await peerDigest(record.prepared) !== record.preparedDigest) ||
      record.preparedDigest && !record.prepared || ['approved', 'committing', 'committed'].includes(record.state) &&
      (record.reviewedDigest !== record.digest || typeof record.reviewedAccount !== 'string' || !record.proof))
    throw new HttpError(503, 'pairing_reconciliation_required', nextActions.reconciliation_required);
  return record;
}
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
  if (!await pageAccessAllowed(t) || !await accountActive(t, id)) throw new HttpError(403, 'pairing_account_revoked');
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
    if (generation && await peerDigest(generation.payload.transition) !== await peerDigest(record.prepared.request)) state = 'reconciliation_required';
    else if (generation) {
      const grant = authority.grant(c.publicKey);
      state = grant?.reader && (!c.rights.writer || grant.writer) ? 'committed' : 'revoked';
    } else if (record.state === 'committed') state = 'reconciliation_required';
  } else if (record.state === 'committing' || record.state === 'committed') state = 'reconciliation_required';
  if (!['committed', 'revoked', 'denied', 'reconciliation_required'].includes(state)) {
    if (c.expiresAt <= t.now()) state = 'expired';
    else if (authority.current?.id !== c.expectedGeneration || authority.control.payload.revision !== c.controlRevision) state = 'stale';
  }
  if (!['denied', 'reconciliation_required'].includes(state)) {
    if (!await accountActive(t, c.accountId) || c.accountId !== t.db.get('owner_account', null) &&
      !t.db.one('SELECT 1 FROM guest_accounts WHERE account_id=? AND approved=1', c.accountId)) state = 'revoked';
  }
  return { pairingId: c.pairingId, requestId: c.requestId, state, challenge: c, expiresAt: c.expiresAt,
    reviewUrl: `${c.serviceOrigin}/pairings/${t.tid}/${c.pairingId}`, nextAction: nextActions[state],
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
  t.transaction(() => save(t, record));
  return status(t, record, authority);
}
async function commit(t: Tendril, req: Request, principal: Principal, input: Record<string, any>): Promise<DevicePairingStatus> {
  if (principal.kind !== 'agent') throw new HttpError(403, 'pairing_native_required');
  requireAgentScope(principal, 'control:write'); object(input, ['action', 'pairingId', 'request', 'control']);
  const id = pairingId(input.pairingId), prepared: DevicePairingPrepared = { request: input.request, control: input.control };
  const preparedDigest = await peerDigest(prepared);
  // An accepted transition remains inspectable after expiry or later revocation.
  const prior = await withPeerPairingAuthority(t, async authority => {
    const record = await verified(t, id); scope(t, req, principal, record); await fresh(t, principal);
    if (record.preparedDigest && record.preparedDigest !== preparedDigest) throw new HttpError(409, 'pairing_transition_conflict');
    const value = await status(t, record, authority, true);
    return value.generation ? value : null;
  });
  if (prior) return prior;
  let approved: PairingRecord | undefined;
  const guard = () => {
    const record = read(t, id), owner = t.db.get('owner_account', null);
    if (!record || record.state !== 'committing' || record.preparedDigest !== preparedDigest ||
      record.reviewedDigest !== record.digest || record.reviewedAccount !== owner || record.challenge.expiresAt <= t.now())
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
      if (record.reviewedDigest !== record.digest || record.reviewedAccount !== t.db.get('owner_account', null) ||
        !record.proof || !await verifyDevicePairingProof(record.challenge, record.proof)) throw new HttpError(403, 'pairing_review_required');
      if (record.preparedDigest && record.preparedDigest !== preparedDigest) throw new HttpError(409, 'pairing_transition_conflict');
      const c = record.challenge, change = object(rawControl, ['epoch', 'keyDigest', 'grants', 'recoveryFloor', 'accounts']);
      const p = request?.payload, current = authority.current!, before = authority.control.payload;
      if (!p || p.applicationId !== c.applicationId || p.transitionId !== `pair-${id}` || p.reason !== 'control-change' ||
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
      record.prepared = prepared; record.preparedDigest = preparedDigest; record.state = 'committing'; delete record.csrf;
      approved = record;
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
      t.transaction(() => save(t, record));
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
      const rows = t.db.all<{ id: string }>(`SELECT id FROM device_pairings WHERE status='committing' OR
        (status='approved' AND expires_at>? AND json_extract(data,'$.challenge.expectedGeneration')=?)
        ORDER BY CASE WHEN json_extract(data,'$.challenge.expectedGeneration')=? THEN 0 ELSE 1 END, created_at DESC LIMIT 20`,
      t.now(), authority.current?.id ?? '', authority.current?.id ?? '');
      const pairings = [];
      for (const row of rows) pairings.push(await status(t, await verified(t, row.id), authority, true));
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
    return Response.redirect(`${publicBase(env)}/auth?return_to=${encodeURIComponent(url.pathname)}`, 303);
  }
  if (!(await env.ACCOUNT_RATE.limit({ key: `pairing-review:${session.accountId}` })).success) throw new HttpError(429, 'rate_limited');
  const raw = /(?:^|;\s*)__Host-tendriller=([^;]+)/.exec(req.headers.get('Cookie') ?? '')![1];
  const headers = new Headers({ 'x-tendril-id': match[1], 'x-pairing-id': match[2], 'x-account-id': session.accountId,
    'x-review-session': await sha256Hex(raw), 'x-review-origin': url.origin });
  if (req.headers.has('Content-Type')) headers.set('Content-Type', req.headers.get('Content-Type')!);
  return env.TENDRIL.get(env.TENDRIL.idFromName(match[1])).fetch(new Request('https://tendril.internal/pairing-review', {
    method: req.method, headers, ...(req.method === 'POST' ? { body: req.body } : {}), signal: req.signal,
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
    let result = await status(t, record, authority), csrf: string | undefined;
    if (form) {
      await requireWritesOpen(t.env);
      const tokenHash = await sha256Hex(form.get('csrf') ?? '');
      if (!record.csrf || record.csrf.session !== owner.session || record.csrf.expiresAt <= t.now() ||
        !safeEqual(record.csrf.hash, tokenHash) || form.get('digest') !== record.digest || !['approve', 'deny'].includes(form.get('action') ?? ''))
        throw new HttpError(403, 'pairing_review_stale', 'This review form is expired or already used. Open the review URL again.');
      requireOpen(record, result, ['pending', 'approved', 'committing']);
      if (!record.proof || !await verifyDevicePairingProof(record.challenge, record.proof)) throw unavailable();
      await reviewOwner(t, req);
      if (record.challenge.expiresAt <= t.now()) throw new HttpError(409, 'pairing_expired');
      record.state = form.get('action') === 'deny' ? 'denied' : record.prepared ? 'committing' : 'approved';
      record.reviewedAccount = owner.id; record.reviewedDigest = record.digest; delete record.csrf;
      t.transaction(() => { if (owner.id !== t.db.get('owner_account', null)) throw new HttpError(403, 'pairing_owner_required'); save(t, record); });
      result = await status(t, record, authority);
    } else if (['pending', 'approved', 'committing'].includes(result.state)) {
      await requireWritesOpen(t.env);
      csrf = crypto.randomUUID() + crypto.randomUUID();
      record.csrf = { hash: await sha256Hex(csrf), session: owner.session, expiresAt: Math.min(record.challenge.expiresAt, t.now() + 120_000) };
      await reviewOwner(t, req);
      t.transaction(() => save(t, record));
    }
    const c = record.challenge, formHtml = csrf ? `<form method="post"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="digest" value="${record.digest}"><div class="actions"><button name="action" value="approve">Approve this device</button><button class="secondary" name="action" value="deny">Reject request</button></div></form>` : '';
    const response = servicePage('Review browser device', `<h1>Review browser device</h1><p>Approve only the device you just requested. This adds its reviewed reader${c.rights.writer ? ' and writer' : ''} access when the authorized native participant commits it.</p><section class="card"><h2>Exact request</h2><dl><dt>Application</dt><dd><code>${escape(c.applicationId)}</code></dd><dt>Account</dt><dd><code>${escape(c.accountId)}</code></dd><dt>Device fingerprint</dt><dd><code>${c.publicKey.match(/.{1,8}/g)!.join(' ')}</code></dd><dt>Rights</dt><dd>Read${c.rights.writer ? ' and write' : ' only'}; no coordination, recovery, administration or publishing</dd><dt>Page origin</dt><dd><code>${escape(c.pageOrigin)}</code></dd><dt>Service origin</dt><dd><code>${escape(c.serviceOrigin)}</code></dd><dt>Expires</dt><dd>${escape(new Date(c.expiresAt).toISOString())}</dd><dt>Request</dt><dd><code>${escape(c.requestId)}</code></dd></dl></section><p class="notice" role="status"><strong>${escape(result.state)}</strong>: ${escape(result.nextAction)}</p>${formHtml}<p><a href="${escape(result.reviewUrl)}">Refresh request status</a></p>`);
    response.headers.set('Content-Security-Policy', response.headers.get('Content-Security-Policy') + "; frame-ancestors 'none'");
    response.headers.set('X-Frame-Options', 'DENY'); return response;
  });
}
