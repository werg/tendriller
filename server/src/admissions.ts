/**
 * Host admission evidence: signed host attestations (pending admissions), invite
 * redemption bookkeeping and key-wrap mailboxes. The host signs only attestations;
 * members sign every membership revision and seal every epoch key themselves.
 */
import { signHostAttestation, encodeRecord, recordDigest, verifyRecord, bytesToHex, hexToBytes,
  type AuthorityBundle, type HostAttestation, type PageInvite, type SignedHostAttestation, type Signed } from '@chronolog/authority';
import { authorityRecord, type AuthorityRecord } from '../../contract/authority.mjs';
import { localAgentGrant } from './access';
import { selectedApplication } from './application';
import { requireHostAttestationIdentity } from './host-attestation';
import { HttpError } from './http';
import { notifyDiscoveryWatchers } from './discovery';
import { readAuthorityBundle, withAuthorityMutation } from './authority';
import { maybeSignGroupAttestation } from './groups/org-groups';
import type { Tendril } from './tendril';

export const ATTESTATION_TTL_MS = 60 * 60_000;
const PENDING_LIMIT = 64, WRAPS_PER_RECIPIENT = 4, WRAP_RECORD_BYTES = 1536 * 1024;

/** Host agent keys are base64url; Chronolog and attestations use lowercase hex. */
export function agentKeyHex(publicKey: string): string {
  const binary = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
  if (binary.length !== 32) throw new HttpError(400, 'invalid_public_key');
  return bytesToHex(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

const intendedOwner = (t: Tendril): string | null => t.db.get<string | null>('intended_owner', null)?.toLowerCase() ?? null;

/** Exactly the account principals the host requires in a genesis admission policy: the owner account and its attested address once claimed, else the intended owner address. */
export async function admissionAccounts(t: Tendril): Promise<string[]> {
  const owner = t.db.get<string | null>('owner_account', null), intended = intendedOwner(t);
  if (!owner) return intended ? [`email:${intended}`] : [];
  const email = await ownerAdmissionEmail(t, owner);
  return email ? [owner, `email:${email}`] : [owner];
}

/** The owner's attested address, resolved once per owner and retained locally so metadata reads stay free of account lookups. */
export async function ownerAdmissionEmail(t: Tendril, owner: string): Promise<string | null> {
  const cached = t.db.get<{ account: string; email: string | null } | null>('owner_admission_email', null);
  if (cached?.account === owner) return cached.email;
  const email = attestedEmail(t, await accountEmails(t, owner));
  t.transaction(() => { if (t.db.get<string | null>('owner_account', null) === owner) t.db.set('owner_admission_email', { account: owner, email }); });
  return email;
}

/** Every verified address of an account, lowercase; `primary` is the account's own email. */
export async function accountEmails(t: Tendril, accountId: string): Promise<{ primary: string | null; all: string[] }> {
  const rows = await t.env.ACCOUNTS.prepare(`SELECT lower(email) AS email, 1 AS primary_email FROM accounts WHERE id=? AND email IS NOT NULL
    UNION SELECT lower(e.email) AS email, 0 AS primary_email FROM identity_emails e JOIN identities i ON i.provider=e.provider AND i.subject=e.subject WHERE i.account_id=?`)
    .bind(accountId, accountId).all<{ email: string; primary_email: number }>();
  const all = [...new Set(rows.results.map(row => row.email))];
  return { primary: rows.results.find(row => row.primary_email === 1)?.email ?? null, all };
}

/** The attested address: an invite's bound email, else the intended owner address the account verified, else its primary email. */
function attestedEmail(t: Tendril, emails: { primary: string | null; all: string[] }, bound?: string): string | null {
  if (bound !== undefined) return bound;
  const intended = intendedOwner(t);
  return intended && emails.all.includes(intended) ? intended : emails.primary;
}

const randomHex = (bytes: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

async function signAttestation(t: Tendril, fields: Pick<HostAttestation, 'subject' | 'accountId' | 'email' | 'publicKey' | 'wrapKey' | 'label' | 'inviteId'>): Promise<SignedHostAttestation> {
  const host = await requireHostAttestationIdentity(t.env), now = BigInt(t.now());
  return signHostAttestation({ subject: fields.subject, pageId: t.tid, applicationId: selectedApplication(t).id, accountId: fields.accountId,
    email: fields.email, publicKey: fields.publicKey, wrapKey: fields.wrapKey, label: fields.label, inviteId: fields.inviteId,
    issuedAt: now, expiresAt: now + BigInt(ATTESTATION_TTL_MS), nonce: randomHex(32) }, host);
}

const members = (bundle: AuthorityBundle | null): Set<string> => new Set(bundle?.memberships.at(-1)!.payload.members.map(member => member.publicKey) ?? []);

/** Drop expired entries and keys the current head already admitted, then bound the list. Synchronous; call inside a transaction. */
export function prunePendingAdmissions(t: Tendril, bundle: AuthorityBundle | null): void {
  t.db.run('DELETE FROM admission_attestations WHERE expires_at<=?', t.now());
  for (const key of members(bundle)) t.db.run('DELETE FROM admission_attestations WHERE public_key=?', key);
  t.db.run(`DELETE FROM admission_attestations WHERE public_key NOT IN
    (SELECT public_key FROM admission_attestations ORDER BY issued_at DESC, public_key LIMIT ?)`, PENDING_LIMIT);
}

/** Retain an attestation in the pending list (one per key, newest wins) inside the caller's transaction. */
function retainAttestation(t: Tendril, signed: SignedHostAttestation, bundle: AuthorityBundle | null): void {
  const bytes = encodeRecord(signed);
  t.checkLocalStorage(bytes.byteLength);
  t.db.run(`INSERT INTO admission_attestations(public_key,record,issued_at,expires_at) VALUES(?,?,?,?)
    ON CONFLICT(public_key) DO UPDATE SET record=excluded.record,issued_at=excluded.issued_at,expires_at=excluded.expires_at`,
    signed.payload.publicKey, bytes.slice().buffer, Number(signed.payload.issuedAt), Number(signed.payload.expiresAt));
  prunePendingAdmissions(t, bundle);
  notifyDiscoveryWatchers(t);
}

export function dropPendingAdmission(t: Tendril, publicKey: string): void {
  t.db.run('DELETE FROM admission_attestations WHERE public_key=?', publicKey);
}

export function pendingAdmissions(t: Tendril, bundle: AuthorityBundle | null): AuthorityRecord[] {
  const admitted = members(bundle);
  return t.db.all<{ public_key: string; record: ArrayBuffer }>('SELECT public_key,record FROM admission_attestations WHERE expires_at>? ORDER BY issued_at, public_key', t.now())
    .filter(row => !admitted.has(row.public_key)).map(row => authorityRecord(new Uint8Array(row.record)));
}

export interface InviteRedemption { readonly inviteId: string; readonly secret: string }

/** Validate an invite against the stored head and the host redemption ledger. Returns the bound email when the binding is by email. */
async function checkInvite(t: Tendril, bundle: AuthorityBundle | null, input: InviteRedemption, accountId: string, emails: string[]): Promise<{ invite: PageInvite; email?: string }> {
  const invite = bundle?.memberships.at(-1)!.payload.invites.find(row => row.inviteId === input.inviteId);
  if (!invite) throw new HttpError(404, 'invite_unknown', 'This invitation is not part of the page’s current signed membership.');
  const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', hexToBytes(input.secret))));
  if (digest !== invite.secretDigest) throw new HttpError(403, 'invite_secret_invalid', 'The invitation link is incomplete or altered.');
  if (invite.revoked) throw new HttpError(410, 'invite_revoked', 'An administrator revoked this invitation.');
  if (invite.expiresAt <= BigInt(t.now())) throw new HttpError(410, 'invite_expired', 'This invitation has expired.');
  if (invite.binding.kind === 'email' && !emails.includes(invite.binding.email))
    throw new HttpError(403, 'invite_email_mismatch', 'This invitation is for another email address. Sign in with that address.');
  redemptionAllowed(t, invite, accountId);
  return { invite, ...(invite.binding.kind === 'email' ? { email: invite.binding.email } : {}) };
}

/** `open`/`email`: one account (the same account re-enrolls idempotently); `public`: up to `max` distinct accounts. */
function redemptionAllowed(t: Tendril, invite: PageInvite, accountId: string): void {
  const accounts = t.db.all<{ account_id: string }>('SELECT account_id FROM invite_redemptions WHERE invite_id=?', invite.inviteId).map(row => row.account_id);
  if (accounts.includes(accountId)) return;
  if (invite.binding.kind !== 'public' && accounts.length) throw new HttpError(409, 'invite_redeemed', 'This invitation was already used by another account.');
  if (invite.binding.kind === 'public' && invite.binding.max !== null && accounts.length >= invite.binding.max)
    throw new HttpError(409, 'invite_exhausted', 'This invitation has reached its member limit.');
}

/** Browser device evidence after a verified challenge and key proof. */
export async function attestDevice(t: Tendril, input: { accountId: string; publicKey: string; wrapKey: string; invite?: InviteRedemption; commit(): void }): Promise<SignedHostAttestation> {
  const bundle = await readAuthorityBundle(t), emails = await accountEmails(t, input.accountId);
  const checked = input.invite ? await checkInvite(t, bundle, input.invite, input.accountId, emails.all) : null;
  const signed = await signAttestation(t, { subject: 'device', accountId: input.accountId, email: attestedEmail(t, emails, checked?.email),
    publicKey: input.publicKey, wrapKey: input.wrapKey, label: 'Browser device', inviteId: checked?.invite.inviteId ?? null });
  t.transaction(() => {
    input.commit();
    if (checked) {
      redemptionAllowed(t, checked.invite, input.accountId);
      t.db.run(`INSERT INTO invite_redemptions(invite_id,account_id,public_key,redeemed_at) VALUES(?,?,?,?)
        ON CONFLICT(invite_id,account_id) DO UPDATE SET public_key=excluded.public_key`, checked.invite.inviteId, input.accountId, input.publicKey, t.now());
    }
    retainAttestation(t, signed, bundle);
  });
  await maybeSignGroupAttestation(t, { accountId: input.accountId, publicKey: input.publicKey, wrapKey: input.wrapKey }).catch(() => null);
  return signed;
}

/** Agent evidence for its registered signing and wrap keys, bound to the page owner (or the intended owner before claim). Caller serializes. */
export async function issueAgentAttestation(t: Tendril, agentId: string): Promise<SignedHostAttestation> {
  const grant = localAgentGrant(t, agentId);
  if (!grant) throw new HttpError(403, 'agent_grant_required');
  const owner = t.db.get<string | null>('owner_account', null);
  const email = owner ? await ownerAdmissionEmail(t, owner) : intendedOwner(t);
  const signed = await signAttestation(t, { subject: 'agent', accountId: owner ?? `pending:${t.tid}`, email,
    publicKey: agentKeyHex(grant.public_key), wrapKey: grant.wrap_key, label: `@${grant.handle}`, inviteId: null });
  const bundle = await readAuthorityBundle(t);
  t.transaction(() => {
    const current = localAgentGrant(t, agentId);
    if (!current || current.revision !== grant.revision) throw new HttpError(409, 'agent_grant_changed');
    retainAttestation(t, signed, bundle);
  });
  return signed;
}

/** Automatic agent attestation after a grant is created or changed. A host without an attestation key still grants. */
export async function attestGrantedAgent(t: Tendril, agentId: string): Promise<void> {
  try { await withAuthorityMutation(t, () => issueAgentAttestation(t, agentId)); }
  catch (error) {
    if (error instanceof HttpError && ['attestation_unconfigured', 'agent_grant_changed', 'agent_grant_required'].includes(error.code)) return;
    throw error;
  }
}

interface KeyWrapPayload {
  readonly applicationId: string; readonly descriptorId: string; readonly membershipId: string; readonly recipient: string;
  readonly wrapKey: string; readonly epochs: readonly number[]; readonly authority: AuthorityBundle; readonly encrypted: unknown;
}
const isHex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Accept a signed key wrap only from a current reader member to a current reader member at its signed wrap key. */
export async function storeKeyWrap(t: Tendril, bundle: AuthorityBundle, wrap: Signed<KeyWrapPayload>, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > WRAP_RECORD_BYTES) throw new HttpError(413, 'key_wrap_too_large');
  const payload = wrap.payload;
  if (!payload || typeof payload !== 'object' || Object.keys(payload).sort().join() !== 'applicationId,authority,descriptorId,encrypted,epochs,membershipId,recipient,wrapKey' ||
    !isHex(payload.recipient) || !isHex(payload.wrapKey) || !isHex(payload.descriptorId) || !isHex(payload.membershipId) ||
    !Array.isArray(payload.epochs) || !payload.epochs.length || payload.epochs.length > 4096 || payload.epochs.some(epoch => !Number.isSafeInteger(epoch) || epoch < 0))
    throw new HttpError(400, 'key_wrap_invalid');
  await verifyRecord('key-wrap', wrap);
  if (payload.applicationId !== selectedApplication(t).id || payload.descriptorId !== await recordDigest(bundle.descriptor)) throw new HttpError(409, 'key_wrap_scope_mismatch');
  const head = bundle.memberships.at(-1)!.payload.members;
  const sender = head.find(member => member.publicKey === wrap.signer), recipient = head.find(member => member.publicKey === payload.recipient);
  if (!sender?.reader || !recipient?.reader) throw new HttpError(403, 'key_wrap_member_required');
  if (recipient.wrapKey !== payload.wrapKey) throw new HttpError(409, 'key_wrap_recipient_mismatch');
  const maxEpoch = Math.max(...payload.epochs);
  t.transaction(() => {
    t.checkLocalStorage(bytes.byteLength);
    t.db.run(`INSERT INTO key_wraps(recipient,signer,max_epoch,record,stored_at) VALUES(?,?,?,?,?)
      ON CONFLICT(recipient,signer,max_epoch) DO UPDATE SET record=excluded.record,stored_at=excluded.stored_at`,
      payload.recipient, wrap.signer, maxEpoch, bytes.slice().buffer, t.now());
    t.db.run(`DELETE FROM key_wraps WHERE recipient=? AND rowid NOT IN
      (SELECT rowid FROM key_wraps WHERE recipient=? ORDER BY max_epoch DESC, stored_at DESC LIMIT ?)`, payload.recipient, payload.recipient, WRAPS_PER_RECIPIENT);
    notifyDiscoveryWatchers(t);
  });
}

/** Wraps addressed to keys that are no longer reader members are never delivered again. Synchronous. */
export function pruneKeyWraps(t: Tendril, bundle: AuthorityBundle): void {
  const readers = new Set(bundle.memberships.at(-1)!.payload.members.filter(member => member.reader).map(member => member.publicKey));
  for (const row of t.db.all<{ recipient: string }>('SELECT DISTINCT recipient FROM key_wraps')) if (!readers.has(row.recipient))
    t.db.run('DELETE FROM key_wraps WHERE recipient=?', row.recipient);
}

export function keyWraps(t: Tendril, recipient: string): AuthorityRecord[] {
  return t.db.all<{ record: ArrayBuffer }>('SELECT record FROM key_wraps WHERE recipient=? ORDER BY max_epoch DESC, stored_at DESC', recipient)
    .map(row => authorityRecord(new Uint8Array(row.record)));
}

/** Highest epoch covered by a stored wrap, per recipient. */
export function wrappedEpochs(t: Tendril): Record<string, number> {
  return Object.fromEntries(t.db.all<{ recipient: string; epoch: number }>('SELECT recipient, MAX(max_epoch) AS epoch FROM key_wraps GROUP BY recipient ORDER BY recipient')
    .map(row => [row.recipient, row.epoch]));
}
