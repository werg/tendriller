import {
  verifyAuthorityBundle, verifyEnrollmentRequest, recordDigest, encodeRecord, decodeRecord, equalRecord,
  validateApplicationDescription, applicationDescriptionDigest, validateFinalityPolicy,
  type AuthorityBundle, type FinalityPolicy, type MemberGrant, type SignedEnrollmentRequest, type PublicationAuthority, type Signed,
} from '@chronolog/authority';
import { authorityRecord, authorityRecordBytes, type AuthorityRecord, type HostAppConfig, type HostApplication } from '../../contract/authority.mjs';
import { currentPrincipal, freshPrincipal, pageAccessAllowed, localAgentGrant, requireAgentScope, type Principal } from './access';
import { admissionAccounts, agentKeyHex, attestDevice, issueAgentAttestation, keyWraps, pendingAdmissions, pruneKeyWraps, prunePendingAdmissions,
  storeKeyWrap, wrappedEpochs, type InviteRedemption } from './admissions';
import { notifyDiscoveryWatchers } from './discovery';
import { hostAttestationKey, loadHostAttestationIdentity } from './host-attestation';
import { selectedApplication } from './application';
import { HttpError, json, readJson } from './http';
import { pageUrl } from './urls';
import type { Tendril } from './tendril';

const CONFIG = 'application_configuration', BUNDLE = 'application_authority', CHALLENGES = 'application_enrollment_challenges';
/** True once the owner's agent has prepared this page's application (publisher policy saved). */
export const applicationPrepared = (t: Tendril): boolean => t.db.get(CONFIG, null) !== null;
interface Challenge { applicationId: string; publicKey: string; accountId: string; challenge: string; expiresAt: number }
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
  const account = current.kind === 'agent' ? owner ?? `pending:${t.tid}` : current.accountId!;
  if (ownerOnly && current.kind === 'page' && account !== owner) throw new HttpError(403, 'owner_required');
  const expires = t.expiresAt();
  if (expires !== null && expires <= t.now()) throw new HttpError(410, 'expired');
  return account;
}
export async function freshAuthorityAccess(t: Tendril, principal: Principal): Promise<void> {
  const account = authorityAccount(t, principal);
  if (!await freshPrincipal(t, principal) || !await pageAccessAllowed(t) || authorityAccount(t, principal) !== account) throw new HttpError(403, 'forbidden');
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
    publicationAuthority: publicationAuthority(t), authority: t.db.get(BUNDLE, null),
    hostAttestationKey: hostAttestationKey(t.env), admissionAccounts: await admissionAccounts(t) };
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
const ENROLLMENT_FIELDS = ['action', 'publicKey', 'proof', 'invite', 'bundle', 'wrap', 'recipient'];
const recordId = (value: unknown) => recordDigest(value);
/**
 * Host-side admission. The host verifies key proofs, signs host attestations
 * (evidence only), keeps invite and key-wrap bookkeeping, and stores member-signed
 * authority it has verified. It never signs descriptors or memberships.
 */
export async function handleEnrollment(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  if (principal.kind === 'page') {
    if (!principal.accountId || principal.role === 'display') throw new HttpError(403, 'browser_account_required');
    // The router forwards the served page origin (scheme, this page's host and any
    // local port). Browser admission must come from exactly that origin of this page.
    const served = req.headers.get('x-tendril-origin'), pageHost = new URL(pageUrl(t.env, t.tid, 'a'.repeat(26))).hostname;
    let servedHost: string | null = null; try { servedHost = served ? new URL(served).hostname : null; } catch {}
    if (!served || servedHost !== pageHost || req.headers.get('Origin') !== served) throw new HttpError(403, 'enrollment_origin_forbidden');
  }
  const input = object(await readJson(req, 2 * 1024 * 1024), ENROLLMENT_FIELDS);
  try { return await withAuthorityMutation(t, async () => {
    await freshAuthorityAccess(t, principal);
    const accountId = authorityAccount(t, principal), applicationId = selectedApplication(t).id;
    const browserOnly = () => { if (principal.kind !== 'page') throw new HttpError(403, 'browser_account_required'); };
    const fields = (...allowed: string[]) => { if (Object.keys(input).some(key => key !== 'action' && !allowed.includes(key))) throw new HttpError(400, 'bad_request'); };
    if (input.action === 'challenge') {
      browserOnly(); fields('publicKey');
      if (!t.db.get(CONFIG, null)) throw new HttpError(409, 'application_unprepared', UNPREPARED);
      if (!hex(input.publicKey)) throw new HttpError(400, 'device_key_invalid');
      const challenges = t.db.get<Challenge[]>(CHALLENGES, []).filter(row => row.expiresAt > t.now());
      const previous = challenges.find(row => row.accountId === accountId && row.publicKey === input.publicKey);
      if (previous) return json({ applicationId, publicKey: previous.publicKey, challenge: previous.challenge, expiresAt: previous.expiresAt });
      if (challenges.length >= 32) throw new HttpError(429, 'enrollment_challenges_full');
      const challenge: Challenge = { applicationId, publicKey: input.publicKey, accountId, challenge: crypto.randomUUID(), expiresAt: t.now() + 300_000 };
      t.db.set(CHALLENGES, [...challenges, challenge]);
      return json({ applicationId, publicKey: challenge.publicKey, challenge: challenge.challenge, expiresAt: challenge.expiresAt });
    }
    if (input.action === 'enroll') {
      browserOnly(); fields('proof', 'invite');
      if (!t.db.get(CONFIG, null)) throw new HttpError(409, 'application_unprepared', UNPREPARED);
      const proof = decodeRequestAuthorityRecord<SignedEnrollmentRequest>(input.proof, 16 * 1024);
      let invite: InviteRedemption | undefined;
      if (input.invite !== undefined) {
        const value = object(input.invite, ['inviteId', 'secret']);
        if (typeof value.inviteId !== 'string' || !/^[0-9a-f]{32}$/.test(value.inviteId) || !hex(value.secret)) throw new HttpError(400, 'invite_invalid');
        invite = { inviteId: value.inviteId, secret: value.secret };
      }
      await verifyEnrollmentRequest(proof);
      const request = proof.payload;
      if (proof.signer !== request.publicKey || !hex(request.wrapKey)) throw new HttpError(400, 'enrollment_proof_invalid');
      const matches = (row: Challenge) => row.challenge === request.challenge && row.accountId === accountId && row.publicKey === request.publicKey && row.applicationId === request.applicationId && row.expiresAt > t.now();
      if (request.applicationId !== applicationId || !t.db.get<Challenge[]>(CHALLENGES, []).some(matches)) throw new HttpError(403, 'enrollment_challenge_invalid');
      await freshAuthorityAccess(t, principal);
      const attestation = await attestDevice(t, { accountId, publicKey: request.publicKey, wrapKey: request.wrapKey, invite, commit() {
        authorityAccount(t, principal);
        if (!t.db.get<Challenge[]>(CHALLENGES, []).some(matches)) throw new HttpError(403, 'enrollment_challenge_invalid');
      } });
      return json({ ...await applicationMetadata(t), attestation: authorityRecord(encodeRecord(attestation)) });
    }
    if (input.action === 'enroll-agent') {
      fields();
      if (principal.kind !== 'agent') throw new HttpError(403, 'agent_required');
      const attestation = await issueAgentAttestation(t, principal.agentId);
      return json({ ...await applicationMetadata(t), attestation: authorityRecord(encodeRecord(attestation)) });
    }
    if (input.action === 'initialize') {
      fields('bundle');
      return json(await initializeAuthority(t, principal, decodeRequestAuthorityRecord<AuthorityBundle>(input.bundle)));
    }
    if (input.action === 'membership') {
      fields('bundle');
      const current = await readAuthorityBundle(t);
      if (current === null) throw new HttpError(409, 'application_uninitialized');
      const bundle = decodeRequestAuthorityRecord<AuthorityBundle>(input.bundle);
      if (!bundle.descriptor || !Array.isArray(bundle.memberships) || !bundle.memberships.length) throw new HttpError(400, 'membership_extension_required');
      if (await recordId(bundle.descriptor) !== await recordId(current.descriptor)) throw new HttpError(400, 'authority_descriptor_mismatch');
      const prefix = bundle.memberships.slice(0, -1);
      if (prefix.length > current.memberships.length) throw new HttpError(400, 'membership_extension_required');
      for (let index = 0; index < prefix.length; index++) if (await recordId(prefix[index]) !== await recordId(current.memberships[index])) throw new HttpError(409, 'membership_head_changed');
      if (prefix.length !== current.memberships.length) throw new HttpError(409, 'membership_head_changed');
      await verifyAuthorityBundle(bundle, current.descriptor);
      await freshAuthorityAccess(t, principal);
      t.transaction(() => {
        authorityAccount(t, principal);
        if (t.db.get(BUNDLE, null) === null || !equalRecord(decodeRecord(authorityRecordBytes(t.db.get(BUNDLE, null))), current)) throw new HttpError(409, 'membership_head_changed');
        storeAuthorityBundle(t, bundle); prunePendingAdmissions(t, bundle); pruneKeyWraps(t, bundle); notifyDiscoveryWatchers(t);
      });
      return json(await applicationMetadata(t));
    }
    if (input.action === 'admissions') {
      fields();
      const bundle = await readAuthorityBundle(t);
      return json({ pending: pendingAdmissions(t, bundle), wrapped: wrappedEpochs(t) });
    }
    if (input.action === 'wrap') {
      fields('wrap');
      const bundle = await readAuthorityBundle(t);
      if (bundle === null) throw new HttpError(409, 'application_uninitialized');
      const bytes = authorityRecordBytes(input.wrap, 2 * 1024 * 1024);
      const wrap = decodeRequestAuthorityRecord<Signed<any>>(input.wrap, 2 * 1024 * 1024);
      await freshAuthorityAccess(t, principal);
      await storeKeyWrap(t, bundle, wrap, bytes);
      return json({ stored: true, wrapped: wrappedEpochs(t) });
    }
    if (input.action === 'wraps') {
      fields('recipient');
      if (!hex(input.recipient)) throw new HttpError(400, 'recipient_invalid');
      return json({ wraps: keyWraps(t, input.recipient) });
    }
    throw new HttpError(400, 'enrollment_action_invalid');
  }); } catch (error) { return authorityError(error); }
}

/** Genesis is member-signed elsewhere; the host only checks it against the prepared configuration and its own policy pins. */
async function initializeAuthority(t: Tendril, principal: Principal, bundle: AuthorityBundle): Promise<HostApplication> {
  const config = t.db.get<HostAppConfig | null>(CONFIG, null);
  if (!config) throw new HttpError(409, 'application_unprepared', UNPREPARED);
  const stored = t.db.get<AuthorityRecord | null>(BUNDLE, null);
  if (stored !== null) {
    if (equalRecord(decodeRecord(authorityRecordBytes(stored)), bundle)) return applicationMetadata(t);
    throw new HttpError(409, 'application_initialized');
  }
  if (!bundle.descriptor || !Array.isArray(bundle.memberships) || bundle.memberships.length !== 1) throw new HttpError(400, 'authority_genesis_invalid');
  const descriptor = bundle.descriptor.payload, genesis = bundle.memberships[0].payload;
  const owner = t.db.get<string | null>('owner_account', null);
  if (principal.kind === 'agent') {
    requireAgentScope(principal, 'control:write');
    const grant = localAgentGrant(t, principal.agentId);
    if (!grant || agentKeyHex(grant.public_key) !== descriptor?.rootPrincipal) throw new HttpError(403, 'initializer_root_required');
  } else if (principal.role !== 'owner' || !owner || principal.accountId !== owner) throw new HttpError(403, 'owner_required');
  await verifyAuthorityBundle(bundle);
  const applicationId = selectedApplication(t).id;
  if (descriptor.applicationId !== applicationId) throw new HttpError(400, 'authority_application_mismatch');
  if (descriptor.executionManifestDigest !== config.executionManifestDigest) throw new HttpError(400, 'authority_manifest_mismatch');
  if (descriptor.authorityPublicKey !== descriptor.rootPrincipal) throw new HttpError(400, 'authority_root_mismatch');
  const requested = config.requestedFinality, policy = descriptor.finalityPolicy;
  const finality = requested === undefined ? policy.kind === 'none'
    : 'kind' in requested ? policy.kind === 'signed-frontier' && policy.signer === descriptor.rootPrincipal
    : equalRecord(decodeRecord<FinalityPolicy>(authorityRecordBytes(requested)), policy);
  if (!finality) throw new HttpError(400, 'authority_finality_mismatch');
  const hostKey = hostAttestationKey(t.env);
  if (!hostKey || !await loadHostAttestationIdentity(t.env)) throw new HttpError(503, 'attestation_unconfigured');
  if (genesis.admission.hostKey !== hostKey) throw new HttpError(400, 'admission_host_key_mismatch');
  const accounts = await admissionAccounts(t);
  if (!accounts.length || accounts.some(account => !genesis.admission.accounts.includes(account))) throw new HttpError(400, 'admission_accounts_mismatch');
  const root = genesis.members.find((member: MemberGrant) => member.publicKey === descriptor.rootPrincipal);
  if (!root?.reader || !root.writer || !root.administrator || root.wrapKey === null) throw new HttpError(400, 'authority_root_member_invalid');
  await freshAuthorityAccess(t, principal);
  t.transaction(() => {
    authorityAccount(t, principal);
    if (t.db.get(BUNDLE, null) !== null) throw new HttpError(409, 'application_initialized');
    storeAuthorityBundle(t, bundle); prunePendingAdmissions(t, bundle); notifyDiscoveryWatchers(t);
  });
  return applicationMetadata(t);
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
