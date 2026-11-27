/**
 * Host admission evidence: signed Ed25519 host attestations (`signHostAttestationV2`,
 * verifiable inside the `chronolog/permissions` standard reducer) and invite
 * redemption bookkeeping. The host never signs permissions or sees epoch keys;
 * key lockboxes live directly in the `$keys` public-control topic.
 */
import { bytesToHex, encodeRecord, hexToBytes, type EventPayload } from '@chronolog/authority';
import { authorityRecord, type AuthorityRecord } from '../../contract/authority.mjs';
import { localAgentGrant } from './access';
import { selectedApplication } from './application';
import { requireHostAttestationIdentity, signHostAttestationV2 } from './host-attestation';
import { HttpError } from './http';
import { notifyDiscoveryWatchers } from './discovery';
import { activeLogId, readControlState, withAuthorityMutation, type ControlInvite, type MaterializedControlState } from './authority';
import { maybeSignGroupAttestation } from './groups/org-groups';
import type { Tendril } from './tendril';

export const ATTESTATION_TTL_MS = 60 * 60_000;
const PENDING_LIMIT = 64;

export interface HostAttestationV2Payload {
  readonly subject: 'device' | 'agent';
  readonly pageId: string;
  readonly applicationId: string;
  readonly accountId: string;
  readonly email: string | null;
  readonly publicKey: string;
  readonly wrapKey: string;
  readonly label: string;
  readonly inviteId: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

export interface SignedHostAttestationV2 {
  readonly payload: HostAttestationV2Payload;
  readonly signature: string;
}

/** Host agent keys are base64url; Chronolog and attestations use lowercase hex. */
export function agentKeyHex(publicKey: string): string {
  const binary = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
  if (binary.length !== 32) throw new HttpError(400, 'invalid_public_key');
  return bytesToHex(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

const intendedOwner = (t: Tendril): string | null => t.db.get<string | null>('intended_owner', null)?.toLowerCase() ?? null;

/** Account principals the host requires in a genesis admission policy. */
export async function admissionAccounts(t: Tendril): Promise<string[]> {
  const owner = t.db.get<string | null>('owner_account', null), intended = intendedOwner(t);
  if (!owner) return intended ? [`email:${intended}`] : [];
  const email = await ownerAdmissionEmail(t, owner);
  return email ? [owner, `email:${email}`] : [owner];
}

export async function ownerAdmissionEmail(t: Tendril, owner: string): Promise<string | null> {
  const cached = t.db.get<{ account: string; email: string | null } | null>('owner_admission_email', null);
  if (cached?.account === owner) return cached.email;
  const email = attestedEmail(t, await accountEmails(t, owner));
  t.transaction(() => { if (t.db.get<string | null>('owner_account', null) === owner) t.db.set('owner_admission_email', { account: owner, email }); });
  return email;
}

export async function accountEmails(t: Tendril, accountId: string): Promise<{ primary: string | null; all: string[] }> {
  const rows = await t.env.ACCOUNTS.prepare(`SELECT lower(email) AS email, 1 AS primary_email FROM accounts WHERE id=? AND email IS NOT NULL
    UNION SELECT lower(e.email) AS email, 0 AS primary_email FROM identity_emails e JOIN identities i ON i.provider=e.provider AND i.subject=e.subject WHERE i.account_id=?`)
    .bind(accountId, accountId).all<{ email: string; primary_email: number }>();
  const all = [...new Set(rows.results.map(row => row.email))];
  return { primary: rows.results.find(row => row.primary_email === 1)?.email ?? null, all };
}

function attestedEmail(t: Tendril, emails: { primary: string | null; all: string[] }, bound?: string): string | null {
  if (bound !== undefined) return bound;
  const intended = intendedOwner(t);
  return intended && emails.all.includes(intended) ? intended : emails.primary;
}

const randomHex = (bytes: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

async function signAttestation(
  t: Tendril,
  fields: Pick<HostAttestationV2Payload, 'subject' | 'accountId' | 'email' | 'publicKey' | 'wrapKey' | 'label' | 'inviteId'>,
): Promise<SignedHostAttestationV2> {
  const host = await requireHostAttestationIdentity(t.env);
  const now = t.now();
  const payload: HostAttestationV2Payload = {
    subject: fields.subject,
    pageId: t.tid,
    applicationId: activeLogId(t),
    accountId: fields.accountId,
    email: fields.email,
    publicKey: fields.publicKey,
    wrapKey: fields.wrapKey,
    label: fields.label,
    inviteId: fields.inviteId,
    issuedAt: now,
    expiresAt: now + ATTESTATION_TTL_MS,
    nonce: randomHex(32),
  };
  return signHostAttestationV2(payload as unknown as EventPayload, host) as unknown as Promise<SignedHostAttestationV2>;
}

const membersOf = (state: MaterializedControlState | null): Set<string> =>
  new Set(state?.permissions.members.map(m => m.publicKey) ?? []);

/** Drop expired entries and keys already admitted in `$permissions`. Synchronous; call inside a transaction. */
export function prunePendingAdmissions(t: Tendril, state: MaterializedControlState | null): void {
  t.db.run('DELETE FROM admission_attestations WHERE expires_at<=?', t.now());
  for (const key of membersOf(state)) t.db.run('DELETE FROM admission_attestations WHERE public_key=?', key);
  t.db.run(`DELETE FROM admission_attestations WHERE public_key NOT IN
    (SELECT public_key FROM admission_attestations ORDER BY issued_at DESC, public_key LIMIT ?)`, PENDING_LIMIT);
}

function retainAttestation(t: Tendril, signed: SignedHostAttestationV2, state: MaterializedControlState | null): void {
  const bytes = encodeRecord(signed);
  t.checkLocalStorage(bytes.byteLength);
  t.db.run(`INSERT INTO admission_attestations(public_key,record,issued_at,expires_at) VALUES(?,?,?,?)
    ON CONFLICT(public_key) DO UPDATE SET record=excluded.record,issued_at=excluded.issued_at,expires_at=excluded.expires_at`,
    signed.payload.publicKey, bytes.slice().buffer, signed.payload.issuedAt, signed.payload.expiresAt);
  prunePendingAdmissions(t, state);
  notifyDiscoveryWatchers(t);
}

export function dropPendingAdmission(t: Tendril, publicKey: string): void {
  t.db.run('DELETE FROM admission_attestations WHERE public_key=?', publicKey);
}

export function pendingAdmissions(t: Tendril, state: MaterializedControlState | null): AuthorityRecord[] {
  const admitted = membersOf(state);
  return t.db.all<{ public_key: string; record: ArrayBuffer }>('SELECT public_key,record FROM admission_attestations WHERE expires_at>? ORDER BY issued_at, public_key', t.now())
    .filter(row => !admitted.has(row.public_key))
    .map(row => authorityRecord(new Uint8Array(row.record)));
}

export interface InviteRedemption { readonly inviteId: string; readonly secret: string }

async function checkInvite(
  t: Tendril,
  state: MaterializedControlState | null,
  input: InviteRedemption,
  accountId: string,
  emails: string[],
): Promise<{ invite: ControlInvite; email?: string }> {
  const invite = state?.permissions.admission?.invites?.find(row => row.inviteId === input.inviteId);
  if (!invite) throw new HttpError(404, 'invite_unknown', 'This invitation is not part of the page’s current signed permissions.');
  const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', hexToBytes(input.secret))));
  if (digest !== invite.secretDigest) throw new HttpError(403, 'invite_secret_invalid', 'The invitation link is incomplete or altered.');
  if (invite.revoked) throw new HttpError(410, 'invite_revoked', 'An administrator revoked this invitation.');
  if (invite.expiresAt <= t.now()) throw new HttpError(410, 'invite_expired', 'This invitation has expired.');
  if (invite.binding.kind === 'email' && !emails.includes(invite.binding.email)) {
    throw new HttpError(403, 'invite_email_mismatch', 'This invitation is for another email address. Sign in with that address.');
  }
  redemptionAllowed(t, invite, accountId);
  return { invite, ...(invite.binding.kind === 'email' ? { email: invite.binding.email } : {}) };
}

function redemptionAllowed(t: Tendril, invite: ControlInvite, accountId: string): void {
  const accounts = t.db.all<{ account_id: string }>('SELECT account_id FROM invite_redemptions WHERE invite_id=?', invite.inviteId).map(row => row.account_id);
  if (accounts.includes(accountId)) return;
  if (invite.binding.kind !== 'public' && accounts.length) throw new HttpError(409, 'invite_redeemed', 'This invitation was already used by another account.');
  if (invite.binding.kind === 'public' && invite.binding.max !== null && accounts.length >= invite.binding.max) {
    throw new HttpError(409, 'invite_exhausted', 'This invitation has reached its member limit.');
  }
}

export async function attestDevice(
  t: Tendril,
  input: { accountId: string; publicKey: string; wrapKey: string; invite?: InviteRedemption; commit(): void },
): Promise<SignedHostAttestationV2> {
  const state = await readControlState(t);
  const emails = await accountEmails(t, input.accountId);
  const checked = input.invite ? await checkInvite(t, state, input.invite, input.accountId, emails.all) : null;
  const signed = await signAttestation(t, {
    subject: 'device',
    accountId: input.accountId,
    email: attestedEmail(t, emails, checked?.email),
    publicKey: input.publicKey,
    wrapKey: input.wrapKey,
    label: 'Browser device',
    inviteId: checked?.invite.inviteId ?? null,
  });
  t.transaction(() => {
    input.commit();
    if (checked) {
      redemptionAllowed(t, checked.invite, input.accountId);
      t.db.run(`INSERT INTO invite_redemptions(invite_id,account_id,public_key,redeemed_at) VALUES(?,?,?,?)
        ON CONFLICT(invite_id,account_id) DO UPDATE SET public_key=excluded.public_key`,
        checked.invite.inviteId, input.accountId, input.publicKey, t.now());
    }
    retainAttestation(t, signed, state);
  });
  await maybeSignGroupAttestation(t, { accountId: input.accountId, publicKey: input.publicKey, wrapKey: input.wrapKey }).catch(() => null);
  return signed;
}

export async function issueAgentAttestation(t: Tendril, agentId: string): Promise<SignedHostAttestationV2> {
  const grant = localAgentGrant(t, agentId);
  if (!grant) throw new HttpError(403, 'agent_grant_required');
  const owner = t.db.get<string | null>('owner_account', null);
  const email = owner ? await ownerAdmissionEmail(t, owner) : intendedOwner(t);
  const signed = await signAttestation(t, {
    subject: 'agent',
    accountId: owner ?? `pending:${t.tid}`,
    email,
    publicKey: agentKeyHex(grant.public_key),
    wrapKey: grant.wrap_key,
    label: `@${grant.handle}`,
    inviteId: null,
  });
  const state = await readControlState(t);
  t.transaction(() => {
    const current = localAgentGrant(t, agentId);
    if (!current || current.revision !== grant.revision) throw new HttpError(409, 'agent_grant_changed');
    retainAttestation(t, signed, state);
  });
  return signed;
}

export async function attestGrantedAgent(t: Tendril, agentId: string): Promise<void> {
  try { await withAuthorityMutation(t, () => issueAgentAttestation(t, agentId)); }
  catch (error) {
    if (error instanceof HttpError && ['attestation_unconfigured', 'agent_grant_changed', 'agent_grant_required'].includes(error.code)) return;
    throw error;
  }
}
