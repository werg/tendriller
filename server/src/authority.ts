import {
  signAppDescriptor, signMembership, verifyAuthorityBundle, verifyEnrollmentRequest, recordDigest, encodeRecord, decodeRecord,
  validateApplicationDescription, applicationDescriptionDigest, validateFinalityPolicy,
  type AuthorityBundle, type FinalityPolicy, type SignedEnrollmentRequest, type PublicationAuthority,
} from '@chronolog/authority';
import { authorityRecord, authorityRecordBytes, type HostAppConfig, type HostApplication } from '../../contract/authority.mjs';
import { currentPrincipal, freshPrincipal, pageAccessAllowed, accountActive, requireAgentScope, type Principal } from './access';
import { ensureAuthorityIdentity } from './authority-identity';
import { selectedApplication } from './application';
import { HttpError, json, readJson } from './http';
import { pageUrl } from './urls';
import type { Tendril } from './tendril';

const CONFIG = 'application_configuration', BUNDLE = 'application_authority', BINDINGS = 'application_device_accounts';
/** True once the owner's agent has prepared this page's application (publisher policy saved). */
export const applicationPrepared = (t: Tendril): boolean => t.db.get(CONFIG, null) !== null;
interface DeviceBinding { publicKey: string; accountId: string }
interface Challenge { applicationId: string; publicKey: string; accountId: string; challenge: string; expiresAt: number; consumed: boolean }
const tails = new WeakMap<Tendril, Promise<unknown>>();
/** Serializes host privileges, never application transactions or their order. */
const UNPREPARED = 'Prepare the application first: host.peers.prepare(configuration) posts the publisher policy to the application route. See /docs/BUILD_AN_APP.md.';
export function withAuthorityMutation<T>(t: Tendril, work: () => Promise<T>): Promise<T> {
  const result = (tails.get(t) ?? Promise.resolve()).then(work);
  tails.set(t, result.catch(() => undefined)); return result;
}
/** Decode only a caller-supplied control record. Stored/internal records retain
 * their original corruption failures; this is not a global codec/error catch. */
export function decodeRequestAuthorityRecord<T>(value: unknown, limit = 1024 * 1024): T {
  try {
    const record = decodeRecord<T>(authorityRecordBytes(value, limit));
    if (record === null || typeof record !== 'object' || Array.isArray(record) || record instanceof Uint8Array) throw new HttpError(400, 'authority_record_invalid');
    return record;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) throw new HttpError(400, 'authority_record_invalid');
    throw error;
  }
}
export function authorityError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code) throw new HttpError(/SIGNATURE|FORBIDDEN|REQUIRED/.test(code) ? 403 : /CONFLICT|MISMATCH|CHANGED/.test(code) ? 409 : 400, code.toLowerCase());
  throw error;
}
export function authorityAccount(t: Tendril, principal: Principal, ownerOnly = false): string {
  const current = currentPrincipal(t, principal), owner = t.db.get<string | null>('owner_account', null);
  if (!current || current.kind === 'page' && (current.role === 'display' || !current.accountId)) throw new HttpError(403, 'forbidden');
  const account = current.kind === 'agent' ? owner ?? `pending-page:${t.tid}` : current.accountId!;
  if (ownerOnly && current.kind === 'page' && account !== owner) throw new HttpError(403, 'owner_required');
  const expires = t.expiresAt();
  if (expires !== null && expires <= t.now()) throw new HttpError(410, 'expired');
  return account;
}
export async function freshAuthorityAccess(t: Tendril, principal: Principal): Promise<void> {
  const account = authorityAccount(t, principal);
  if (!await freshPrincipal(t, principal) || !await pageAccessAllowed(t) || authorityAccount(t, principal) !== account) throw new HttpError(403, 'forbidden');
}
export function adoptPreparedApplication(t: Tendril, accountId: string): void {
  if (t.db.get('owner_account', null)) throw new HttpError(409, 'already_claimed');
  const bindings = t.db.get<DeviceBinding[]>(BINDINGS, []);
  if (bindings.length) throw new HttpError(409, 'browser_owner_initialization_required');
  // Publishers are independent host credentials; no data device is adopted here.
  void accountId;
}
export function withUnconfiguredApplication<T>(t: Tendril, work: () => Promise<T>): Promise<T> {
  return withAuthorityMutation(t, async () => {
    if (t.db.get(BUNDLE, null)) throw new HttpError(409, 'application_authority_requires_owner');
    return work();
  });
}
export async function readAuthorityBundle(t: Tendril): Promise<AuthorityBundle | null> {
  return t.db.cachedAsync('authority:bundle', async () => {
    const record = t.db.get<unknown>(BUNDLE, null);
    if (record === null) return null;
    const bundle = decodeRecord<AuthorityBundle>(authorityRecordBytes(record));
    await verifyAuthorityBundle(bundle); return bundle;
  });
}
function storeAuthorityBundle(t: Tendril, bundle: AuthorityBundle): void {
  const bytes = encodeRecord(bundle);
  if (bytes.length > 1024 * 1024) throw new HttpError(413, 'authority_history_full');
  t.db.set(BUNDLE, authorityRecord(bytes));
}
export function publicationAuthority(t: Tendril): PublicationAuthority | null {
  return t.db.get<PublicationAuthority | null>('application_publication_authority', null);
}
export async function applicationMetadata(t: Tendril): Promise<HostApplication> {
  return { selection: selectedApplication(t), configuration: t.db.get<HostAppConfig | null>(CONFIG, null),
    publicationAuthority: publicationAuthority(t), authority: t.db.get(BUNDLE, null) };
}
function object(value: unknown, fields: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new HttpError(400, 'bad_request');
  return value as Record<string, any>;
}
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function prepareApplication(t: Tendril, principal: Principal, input: unknown): Promise<HostApplication> {
  authorityAccount(t, principal, true);
  if (principal.kind === 'agent') requireAgentScope(principal, 'control:write');
  return withAuthorityMutation(t, async () => {
    const value = object(input, ['executionManifestDigest', 'executionProfile', 'publisherKeys', 'requestedFinality', 'tools']);
    if (!hex(value.executionManifestDigest) || typeof value.executionProfile !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(value.executionProfile) ||
      !Array.isArray(value.publisherKeys) || !value.publisherKeys.length || value.publisherKeys.length > 32 || value.publisherKeys.some(key => !hex(key)) || new Set(value.publisherKeys).size !== value.publisherKeys.length)
      throw new HttpError(400, 'application_configuration_invalid');
    if (value.requestedFinality?.kind === 'browser-signed-frontier') object(value.requestedFinality, ['kind']);
    if (value.requestedFinality !== undefined && value.requestedFinality?.kind !== 'browser-signed-frontier') {
      validateFinalityPolicy(decodeRequestAuthorityRecord<FinalityPolicy>(value.requestedFinality, 64 * 1024));
    }
    if (value.tools !== undefined && (!value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools))) throw new HttpError(400, 'tool_declaration_invalid');
    if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024) throw new HttpError(413, 'application_configuration_too_large');
    const toolDigest = value.tools === undefined ? undefined : await applicationDescriptionDigest(validateApplicationDescription(value.tools));
    const fingerprint = await recordDigest({ ...value, ...(toolDigest === undefined ? {} : { tools: toolDigest }) }), existing = t.db.get<string | null>('application_configuration_digest', null);
    await freshAuthorityAccess(t, principal); authorityAccount(t, principal, true);
    if (existing !== null && existing !== fingerprint) throw new HttpError(409, 'application_configuration_immutable');
    if (existing === null) {
      const scope: PublicationAuthority = { applicationId: selectedApplication(t).id, executionManifestDigest: value.executionManifestDigest,
        grantId: fingerprint, publisherKeys: [...value.publisherKeys] };
      t.transaction(() => { authorityAccount(t, principal, true); t.db.set(CONFIG, value); t.db.set('application_configuration_digest', fingerprint); t.db.set('application_publication_authority', scope); });
    }
    return applicationMetadata(t);
  }).catch(authorityError);
}
/** Browser key proof enrolls identity only. Epoch keys are created/transferred on devices, never here. */
export async function handleEnrollment(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  if (principal.kind !== 'page' || !principal.accountId || principal.role === 'display') throw new HttpError(403, 'browser_account_required');
  const expectedOrigin = new URL(pageUrl(t.env, t.tid, 'a'.repeat(26))).origin;
  if (req.headers.get('Origin') !== expectedOrigin) throw new HttpError(403, 'enrollment_origin_forbidden');
  const input = object(await readJson(req, 2 * 1024 * 1024), ['action', 'publicKey', 'proof', 'bundle', 'requestId', 'expectedMembershipId', 'authorTimeAfterMs', 'grant']);
  try { return await withAuthorityMutation(t, async () => {
    await freshAuthorityAccess(t, principal);
    const accountId = authorityAccount(t, principal), applicationId = selectedApplication(t).id;
    if (!t.db.get(CONFIG, null)) throw new HttpError(409, 'application_unprepared', UNPREPARED);
    if (input.action === 'challenge') {
      if (!hex(input.publicKey)) throw new HttpError(400, 'device_key_invalid');
      const challenges = t.db.get<Challenge[]>('application_enrollment_challenges', []).filter(row => row.expiresAt > t.now());
      const previous = challenges.find(row => row.accountId === accountId && row.publicKey === input.publicKey);
      if (previous) return json({ applicationId, publicKey: previous.publicKey, challenge: previous.challenge, expiresAt: previous.expiresAt });
      if (challenges.length >= 32) throw new HttpError(429, 'enrollment_challenges_full');
      const challenge: Challenge = { applicationId, publicKey: input.publicKey, accountId, challenge: crypto.randomUUID(), expiresAt: t.now() + 300_000, consumed: false };
      t.db.set('application_enrollment_challenges', [...challenges, challenge]);
      return json({ applicationId, publicKey: challenge.publicKey, challenge: challenge.challenge, expiresAt: challenge.expiresAt });
    }
    if (input.action === 'enroll') {
      const proof = decodeRequestAuthorityRecord<SignedEnrollmentRequest>(input.proof, 16 * 1024);
      await verifyEnrollmentRequest(proof);
      const challenge = t.db.get<Challenge[]>('application_enrollment_challenges', []).find(row => row.challenge === proof.payload.challenge && row.accountId === accountId && row.publicKey === proof.payload.publicKey && row.applicationId === proof.payload.applicationId);
      if (!challenge || challenge.expiresAt <= t.now() || proof.payload.applicationId !== applicationId) throw new HttpError(403, 'enrollment_challenge_invalid');
      let bundle = await readAuthorityBundle(t);
      const initialized = bundle === null;
      const bindings = t.db.get<DeviceBinding[]>(BINDINGS, []), binding = bindings.find(row => row.publicKey === proof.payload.publicKey);
      if (binding && binding.accountId !== accountId) throw new HttpError(409, 'device_account_immutable');
      if (bundle === null) {
        if (proof.payload.epoch !== 0) throw new HttpError(400, 'initial_epoch_invalid');
        authorityAccount(t, principal, true);
        const signer = await ensureAuthorityIdentity(t), config = t.db.get<HostAppConfig>(CONFIG, null!);
        const finalityPolicy: FinalityPolicy = config.requestedFinality === undefined ? { kind: 'none' }
          : 'kind' in config.requestedFinality ? { kind: 'signed-frontier', signer: proof.payload.publicKey, scopes: [{ id: await recordDigest(['initial-scope', applicationId]), authorTimeAfterMs: -1n }] }
          : decodeRecord<FinalityPolicy>(authorityRecordBytes(config.requestedFinality));
        const descriptor = await signAppDescriptor({ applicationId, rootPrincipal: proof.payload.publicKey, authorityPublicKey: signer.publicKey, executionManifestDigest: config.executionManifestDigest, finalityPolicy }, signer);
        const membership = await signMembership({ applicationId, revision: 0, previous: null, authorTimeAfterMs: -1n, epoch: 0, epochKeyDigest: proof.payload.epochKeyDigest,
          members: [{ publicKey: proof.payload.publicKey, reader: true, writer: true, administrator: true, publisher: false, finalizer: finalityPolicy.kind === 'signed-frontier' && finalityPolicy.signer === proof.payload.publicKey || finalityPolicy.kind === 'fixed-validator' && finalityPolicy.validators.includes(proof.payload.publicKey) }] }, signer);
        bundle = { descriptor, memberships: [membership] }; await verifyAuthorityBundle(bundle);
      }
      if (!initialized && (proof.payload.epoch !== bundle.memberships.at(-1)!.payload.epoch || proof.payload.epochKeyDigest !== bundle.memberships.at(-1)!.payload.epochKeyDigest)) throw new HttpError(409, 'enrollment_epoch_changed');
      await freshAuthorityAccess(t, principal);
      t.transaction(() => {
        authorityAccount(t, principal);
        const latest = t.db.get<Challenge[]>('application_enrollment_challenges', []);
        const retained = latest.find(row => row.challenge === challenge.challenge);
        if (!retained || retained.expiresAt <= t.now()) throw new HttpError(403, 'enrollment_challenge_invalid');
        if (!binding) { if (bindings.length >= 1024) throw new HttpError(429, 'device_bindings_full'); t.db.set(BINDINGS, [...bindings, { publicKey: proof.payload.publicKey, accountId }]); }
        storeAuthorityBundle(t, bundle); t.db.set('application_enrollment_challenges', latest.map(row => row === retained ? { ...row, consumed: true } : row));
      });
      const member = bundle.memberships.at(-1)!.payload.members.find(row => row.publicKey === proof.payload.publicKey);
      return json({ ...await applicationMetadata(t), provisioningRequired: !initialized && (!member || member.reader) });
    }
    if (input.action === 'grant') {
      authorityAccount(t, principal, true);
      if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId) || !hex(input.expectedMembershipId) || typeof input.authorTimeAfterMs !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(input.authorTimeAfterMs)) throw new HttpError(400, 'membership_request_invalid');
      const grant = object(input.grant, ['publicKey', 'reader', 'writer', 'administrator', 'publisher', 'finalizer']);
      if (!hex(grant.publicKey) || ['reader', 'writer', 'administrator', 'publisher', 'finalizer'].some(flag => typeof grant[flag] !== 'boolean')) throw new HttpError(400, 'membership_grant_invalid');
      const fingerprint = await recordDigest(input), operation = `application_grant:${await recordDigest(input.requestId)}`;
      const retained = t.db.get<{ fingerprint: string; membershipId: string } | null>(operation, null);
      if (retained) {
        if (retained.fingerprint !== fingerprint) throw new HttpError(409, 'membership_request_id_reused');
        return json({ ...await applicationMetadata(t), grant: { requestId: input.requestId, membershipId: retained.membershipId } });
      }
      const bundle = await readAuthorityBundle(t);
      if (!bundle) throw new HttpError(409, 'application_uninitialized');
      const head = bundle.memberships.at(-1)!;
      if (await recordDigest(head) !== input.expectedMembershipId) throw new HttpError(409, 'membership_head_changed');
      const floor = BigInt(input.authorTimeAfterMs);
      if (floor <= head.payload.authorTimeAfterMs || floor > (1n << 63n) - 1n) throw new HttpError(400, 'membership_activation_invalid');
      const binding = t.db.get<DeviceBinding[]>(BINDINGS, []).find(row => row.publicKey === grant.publicKey);
      if (!binding) throw new HttpError(403, 'member_key_proof_required');
      const admitted = () => binding.accountId === accountId || !!t.db.one('SELECT 1 FROM guest_accounts WHERE account_id=? AND approved=1', binding.accountId);
      if (!admitted() || !await accountActive(t, binding.accountId)) throw new HttpError(403, 'member_account_inactive');
      const policy = bundle.descriptor.payload.finalityPolicy;
      if (grant.finalizer && !(policy.kind === 'signed-frontier' && policy.signer === grant.publicKey || policy.kind === 'fixed-validator' && policy.validators.includes(grant.publicKey))) throw new HttpError(403, 'finalizer_not_configured');
      const signer = await ensureAuthorityIdentity(t);
      const members = [...head.payload.members.filter(member => member.publicKey !== grant.publicKey), grant as unknown as typeof head.payload.members[number]];
      const membership = await signMembership({ ...head.payload, revision: head.payload.revision + 1, previous: input.expectedMembershipId, authorTimeAfterMs: floor, members }, signer);
      const updated: AuthorityBundle = { descriptor: bundle.descriptor, memberships: [...bundle.memberships, membership] };
      await verifyAuthorityBundle(updated);
      const membershipId = await recordDigest(membership);
      await freshAuthorityAccess(t, principal); authorityAccount(t, principal, true);
      t.transaction(() => {
        authorityAccount(t, principal, true); if (!admitted()) throw new HttpError(403, 'member_account_inactive');
        storeAuthorityBundle(t, updated); t.db.set(operation, { fingerprint, membershipId });
      });
      return json({ ...await applicationMetadata(t), grant: { requestId: input.requestId, membershipId } });
    }
    if (input.action === 'membership') {
      const current = await readAuthorityBundle(t);
      if (current === null) throw new HttpError(409, 'application_uninitialized');
      const bundle = decodeRequestAuthorityRecord<AuthorityBundle>(input.bundle);
      await verifyAuthorityBundle(bundle, current.descriptor);
      for (let index = 0; index < current.memberships.length; index++) if (await recordDigest(bundle.memberships[index]) !== await recordDigest(current.memberships[index])) throw new HttpError(409, 'membership_chain_conflict');
      if (bundle.memberships.length !== current.memberships.length + 1) throw new HttpError(400, 'membership_extension_required');
      const last = bundle.memberships.at(-1)!, bindings = t.db.get<DeviceBinding[]>(BINDINGS, []);
      if (!bindings.some(row => row.publicKey === last.signer && row.accountId === accountId) || !current.memberships.at(-1)!.payload.members.some(row => row.publicKey === last.signer && row.administrator)) throw new HttpError(403, 'membership_admin_required');
      for (const member of last.payload.members) if (!bindings.some(row => row.publicKey === member.publicKey)) throw new HttpError(403, 'member_key_proof_required');
      await freshAuthorityAccess(t, principal); storeAuthorityBundle(t, bundle);
      return json(await applicationMetadata(t));
    }
    throw new HttpError(400, 'enrollment_action_invalid');
  }); } catch (error) { return authorityError(error); }
}
export async function withPublicationAuthority<T>(t: Tendril, principal: Principal, work: (scope: { authority: PublicationAuthority; authorizeAuthor(publicKey: string): void; checkAccess(): Promise<void> }) => Promise<T>): Promise<T> {
  return withAuthorityMutation(t, async () => {
    await freshAuthorityAccess(t, principal);
    const authority = publicationAuthority(t);
    if (authority === null) throw new HttpError(409, 'application_unprepared', UNPREPARED);
    return work({ authority, authorizeAuthor(publicKey) {
      authorityAccount(t, principal, true);
      if (principal.kind === 'agent') requireAgentScope(principal, 'publication:write');
      if (!authority.publisherKeys.includes(publicKey)) throw new HttpError(403, 'publisher_key_required');
    }, checkAccess: () => freshAuthorityAccess(t, principal) });
  });
}
