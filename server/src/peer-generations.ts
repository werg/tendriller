import {
  createPeerIdentity, exportPeerIdentity, importPeerIdentity, createGenerationRegistry, signApplicationDescriptor,
  signControlRevision, signTransitionRequest, participantGrant, controlParticipantGrant,
  validateApplicationDescription, applicationDescriptionDigest, verifyApplicationSchema,
  peerDigest, encodePeerValue, decodePeerValue, verifyAuthorityBundle,
  PEER_GENERATION_PROFILE, PEER_GENERATION_POLICY,
  type AuthorityBundle, type GenerationRegistry, type PeerIdentity, type BytesStore, type PeerGrant,
  type SignedApplicationDescriptor, type SignedControlRevision, type SignedTransitionRequest, type TransitionRequest,
  type ApplicationDescription, type SignedApplicationSchema,
  type PeerAuthority,
} from '@chronolog/peer-generation/control';
import { accountActive, pageAccessAllowed, currentPrincipal, type Principal } from './access';
import { selectedApplication } from './application';
import { HttpError } from './http';
import type { Tendril } from './tendril';
import { changeLifetime, hasResidentStorage } from './lifetime';

const CONFIG = 'peer_generation_configuration', ACCOUNTS = 'peer_generation_accounts', IDENTITY = 'peer-generation/identity';
const VALUE_LIMIT = 16 * 1024 * 1024;
const PUBLICATION_LIMIT = 256 * 1024;
interface Configuration {
  descriptor: SignedApplicationDescriptor; control: SignedControlRevision; fingerprint: string;
  definition: ApplicationDescription; schema: SignedApplicationSchema | null;
}
interface AccountBinding { publicKey: string; accountId: string }
interface HostState {
  pending: Promise<unknown>; store: BytesStore; guard?: () => void; check?: () => Promise<void>; pendingAccounts?: AccountBinding[]; pendingFingerprint?: { key: string; value: string };
  registry?: GenerationRegistry; signer?: PeerIdentity;
}
const hosts = new WeakMap<Tendril, HostState>();
function identity(t: Tendril, principal: Principal, ownerOnly = false): string {
  const current = currentPrincipal(t, principal), owner = t.db.get<string | null>('owner_account', null);
  if (!owner || !current || current.kind === 'page' && (current.role === 'display' || !current.accountId))
    throw new HttpError(403, 'forbidden', 'Peer controls require an authenticated account');
  const account = current.kind === 'agent' ? owner : current.accountId!;
  if (ownerOnly && account !== owner) throw new HttpError(403, 'forbidden', 'Only the application owner can administer hosted control authority');
  return account;
}
async function freshAccess(t: Tendril, principal: Principal): Promise<void> {
  const account = identity(t, principal);
  if (!await pageAccessAllowed(t) || !await accountActive(t, account)) throw new HttpError(403, 'forbidden');
  identity(t, principal);
}
function host(t: Tendril): HostState {
  let state = hosts.get(t);
  if (state) return state;
  state = { pending: Promise.resolve(), store: {
    async get(key) {
      const row = t.db.one<{ value: ArrayBuffer }>('SELECT value FROM participant_records WHERE key=?', key);
      return row ? new Uint8Array(row.value).slice() : null;
    },
    async put(key, value) {
      if (!key.startsWith('peer-generation/') || value.byteLength > VALUE_LIMIT)
        throw new HttpError(413, 'peer_control_storage_full', 'The bounded generation control store is full');
      const bytes = value.slice();
      await state!.check?.();
      t.transaction(() => {
        state!.guard?.();
        t.db.run('INSERT INTO participant_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, bytes.buffer);
        if (state!.pendingAccounts) t.db.set(ACCOUNTS, state!.pendingAccounts);
        if (state!.pendingFingerprint) t.db.set(state!.pendingFingerprint.key, state!.pendingFingerprint.value);
      });
    },
  } };
  hosts.set(t, state); return state;
}
function serial<T>(t: Tendril, work: (state: HostState) => Promise<T>): Promise<T> {
  const state = host(t), result = state.pending.then(() => work(state));
  state.pending = result.catch(() => {}); return result;
}
/** Claim release and the first durable control configuration cannot interleave. */
export function withUnconfiguredPeerApplication<T>(t: Tendril, work: () => Promise<T>): Promise<T> {
  return serial(t, async () => {
    if (t.db.get(CONFIG, null))
      throw new HttpError(409, 'peer_controls_require_owner', 'Signed peer control state must retain its owner account until explicitly deleted');
    return work();
  });
}
async function registry(t: Tendril, state: HostState): Promise<GenerationRegistry> {
  const configuration = t.db.get<Configuration | null>(CONFIG, null);
  if (!configuration) throw new HttpError(409, 'peer_application_unconfigured', 'Publish the signed peer application descriptor first');
  const bytes = await state.store.get(IDENTITY);
  if (!bytes) throw new HttpError(503, 'peer_control_state_missing', 'The pinned control identity is unavailable; recovery must preserve its original trust state');
  state.signer = await importPeerIdentity(decodePeerValue(bytes));
  if (state.signer.publicKey !== configuration.descriptor.payload.controlPublicKey) throw new HttpError(503, 'peer_control_state_mismatch');
  if (!state.registry) {
    state.registry = await createGenerationRegistry({ store: state.store, descriptor: configuration.descriptor,
      controls: [configuration.control], signer: state.signer, requireExisting: true });
  }
  return state.registry;
}
function object(value: unknown, fields: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !fields.includes(field)))
    throw new HttpError(400, 'bad_request', 'Unexpected peer control fields');
  return value as Record<string, any>;
}
async function publication(value: Record<string, any>) {
  try {
    const definition = validateApplicationDescription(value.definition), schema = value.schema ?? null;
    if (new TextEncoder().encode(JSON.stringify({ definition, schema })).byteLength > PUBLICATION_LIMIT)
      throw new HttpError(413, 'peer_publication_too_large', 'Published definition and signed schema are limited to 256 KiB');
    if ((definition.schema === null) !== (schema === null) || schema !== null && schema.payload?.program !== definition.schema)
      throw new HttpError(400, 'peer_schema_definition_mismatch', 'The signed genesis schema must match the published definition');
    const digest = await applicationDescriptionDigest(definition);
    return { definition, schema: schema as SignedApplicationSchema | null, digest,
      schemaDigest: schema === null ? null : await peerDigest(schema) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'peer_definition_invalid', error instanceof Error ? error.message : 'Invalid application definition');
  }
}
function accounts(value: unknown, defaultAccount?: string): AccountBinding[] {
  if (!Array.isArray(value) || value.length > 1024) throw new HttpError(400, 'bad_request', 'Expected bounded device/account bindings');
  const seen = new Set<string>();
  return value.map(input => {
    const row = object(input, ['publicKey', 'accountId']);
    const accountId = row.accountId ?? defaultAccount;
    if (typeof row.publicKey !== 'string' || !/^[0-9a-f]{64}$/.test(row.publicKey) || seen.has(row.publicKey) ||
        typeof accountId !== 'string' || !accountId.length || accountId.length > 200)
      throw new HttpError(400, 'bad_request', 'Invalid or duplicate device/account binding');
    seen.add(row.publicKey); return { publicKey: row.publicKey, accountId };
  });
}
function checkAccountAdmission(t: Tendril, bindings: readonly AccountBinding[]): void {
  const owner = t.db.get('owner_account', ''), unique = [...new Set(bindings.map(binding => binding.accountId))];
  for (const account of unique) {
    if (account !== owner && !t.db.one('SELECT 1 FROM guest_accounts WHERE account_id=? AND approved=1', account))
      throw new HttpError(403, 'forbidden', 'Every enrolled device must belong to an admitted account');
  }
}
async function checkAccounts(t: Tendril, bindings: readonly AccountBinding[]): Promise<void> {
  checkAccountAdmission(t, bindings);
  for (const account of new Set(bindings.map(binding => binding.accountId)))
    if (!await accountActive(t, account)) throw new HttpError(403, 'forbidden', 'An enrolled account is not active');
  checkAccountAdmission(t, bindings);
}
/** The hosted policy retains an explicit control-only participant, never a data peer. */
async function withControlParticipant(value: unknown, signer: PeerIdentity): Promise<PeerGrant[]> {
  if (!Array.isArray(value) || value.length > 1024) throw new HttpError(400, 'bad_request', 'Expected bounded device grants');
  const hosted = controlParticipantGrant(signer.publicKey), supplied = value.filter(grant => grant?.publicKey === signer.publicKey);
  if (supplied.length > 1 || supplied.length === 1 && await peerDigest(supplied[0]) !== await peerDigest(hosted))
    throw new HttpError(403, 'peer_host_control_grant_immutable', 'The hosted participant has fixed control-only rights');
  return [...value.filter(grant => grant?.publicKey !== signer.publicKey), hosted];
}
function authorizeRequester(t: Tendril, principal: Principal, request: SignedTransitionRequest): void {
  const account = identity(t, principal);
  if (!t.db.get<AccountBinding[]>(ACCOUNTS, []).some(binding => binding.accountId === account && binding.publicKey === request?.payload?.requester))
    throw new HttpError(403, 'peer_requester_account', 'The signed recovery requester is not enrolled to this account');
}
export function peerControlError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code.startsWith('PEER_')) {
    const status = /FORBIDDEN|SIGNATURE_INVALID|KEY_MISMATCH/.test(code) ? 403 : /STATE_MISSING/.test(code) ? 503
      : /CONFLICT|EXCLUDED|UNAVAILABLE|CHANGED|REQUIRED/.test(code) ? 409 : 400;
    throw new HttpError(status, code.toLowerCase(), code);
  }
  throw error;
}

export type PeerControlAction = 'read' | 'configure' | 'select' | 'administer' | 'definition';
/** Portable protocol dispatch; the HTTP transport owns bounded admission and framing. */
export async function exchangePeerControl(t: Tendril, principal: Principal, action: PeerControlAction, input?: unknown): Promise<unknown> {
  const ownerAction = action === 'administer';
  identity(t, principal, ownerAction || action === 'configure');
  return serial(t, async state => {
    try {
      identity(t, principal, ownerAction);
      if (action === 'read') {
        const bundle = await (await registry(t, state)).read();
        await freshAccess(t, principal); return bundle;
      }
      if (action === 'definition') {
        const configured = t.db.get<Configuration | null>(CONFIG, null);
        if (!configured) throw new HttpError(409, 'peer_application_unconfigured');
        if (!configured.definition || configured.schema === undefined) throw new HttpError(503, 'peer_publication_state_missing');
        let published;
        try {
          // Public immutable metadata remains verifiable without the private signer.
          // The retained signed genesis control authenticates its original descriptor.
          await verifyAuthorityBundle({ descriptor: configured.descriptor, controls: [configured.control], generations: [] });
          published = await publication({ ...configured.descriptor.payload, definition: configured.definition, schema: configured.schema });
          if (published.digest !== configured.descriptor.payload.definitionDigest || published.schemaDigest !== configured.descriptor.payload.schemaDigest)
            throw new Error('Retained metadata commitments differ from the signed descriptor');
          if (published.schema !== null) await verifyApplicationSchema(published.schema, configured.descriptor.payload);
        } catch {
          throw new HttpError(503, 'peer_definition_state_mismatch', 'Retained peer metadata does not match its signed authority');
        }
        await freshAccess(t, principal);
        return { descriptor: configured.descriptor, definition: published.definition, schema: published.schema };
      }
      if (action === 'configure') {
        const owner = identity(t, principal, true);
        const value = object(input, ['historyId', 'executionManifestDigest', 'definition', 'schema', 'schemaAdministrator', 'epoch', 'keyDigest', 'members']);
        const published = await publication(value);
        // Description schemas can contain fractional bounds; their portable digest
        // binds the complete canonical metadata without narrowing it to control integers.
        const fingerprint = await peerDigest({ ...value, definition: published.digest, schema: published.schemaDigest }), configured = t.db.get<Configuration | null>(CONFIG, null);
        if (configured) {
          if (configured.fingerprint !== fingerprint) throw new HttpError(409, 'peer_application_immutable', 'The application descriptor and initial policy are immutable');
          const bundle = await (await registry(t, state)).read(); await freshAccess(t, principal); identity(t, principal, true); return bundle;
        }
        const applicationId = selectedApplication(t).id;
        if (!/^[0-9a-f]{64}$/.test(applicationId)) throw new HttpError(400, 'peer_application_identity', 'peer-generation-v1 applications use a 32-byte lowercase hex identity');
        if (!Array.isArray(value.members) || !value.members.length || value.members.length > 1023)
          throw new HttpError(400, 'bad_request', 'Provide the initial device grants');
        const deviceGrants: PeerGrant[] = [], rawBindings = [];
        for (const member of value.members) {
          const explicit = member && typeof member === 'object' && 'grant' in member;
          const row = object(member, explicit ? ['grant', 'accountId'] : ['publicKey', 'administrator', 'publisher', 'dataRole', 'accountId']);
          const grant = 'grant' in row ? row.grant : participantGrant(row.publicKey, { administrator: row.administrator,
            publisher: row.publisher, dataRole: row.dataRole });
          deviceGrants.push(grant); rawBindings.push({ publicKey: grant?.publicKey, accountId: row.accountId ?? owner });
        }
        const bindings = accounts(rawBindings); await checkAccounts(t, bindings);
        const signer = await createPeerIdentity();
        const grants = await withControlParticipant(deviceGrants, signer);
        bindings.push({ publicKey: signer.publicKey, accountId: owner });
        const descriptor = await signApplicationDescriptor({ applicationId, historyId: value.historyId,
          profile: PEER_GENERATION_PROFILE, policy: PEER_GENERATION_POLICY, controlPublicKey: signer.publicKey,
          schemaAdministrator: value.schemaAdministrator, schemaDigest: published.schemaDigest, executionManifestDigest: value.executionManifestDigest, definitionDigest: published.digest }, signer);
        if (published.schema !== null) await verifyApplicationSchema(published.schema, descriptor.payload);
        const control = await signControlRevision({ applicationId, profile: PEER_GENERATION_PROFILE, policy: PEER_GENERATION_POLICY,
          revision: 0, previous: null, epoch: value.epoch, keyDigest: value.keyDigest, grants, recoveryFloor: null }, signer);
        const staged = new Map<string, Uint8Array>();
        const initial = await createGenerationRegistry({ descriptor, controls: [control], signer,
          store: { get: async key => staged.get(key) ?? null, put: async (key, bytes) => { staged.set(key, bytes.slice()); } } });
        staged.set(IDENTITY, encodePeerValue(await exportPeerIdentity(signer)));
        const bundle = await initial.read();
        // Durable control state outlives any coordinating peer or page publication.
        await changeLifetime(t, 'resident');
        await freshAccess(t, principal);
        await checkAccounts(t, bindings);
        t.transaction(() => {
          identity(t, principal, true);
          checkAccountAdmission(t, bindings);
          if (!hasResidentStorage(t)) throw new HttpError(409, 'peer_control_storage_unavailable');
          if (t.db.get(CONFIG, null)) throw new HttpError(409, 'peer_application_conflict');
          for (const [key, bytes] of staged) t.db.run('INSERT INTO participant_records(key,value) VALUES(?,?)', key, bytes.buffer);
          t.db.set(CONFIG, { descriptor, control, fingerprint, definition: published.definition, schema: published.schema }); t.db.set(ACCOUNTS, bindings);
        });
        return bundle;
      }
      if (action === 'select' || ownerAction) {
        const value = object(input, ownerAction ? ['transition', 'control'] : ['request', 'control']);
        const service = await registry(t, state), bundle = await service.read();
        let request: SignedTransitionRequest;
        if (ownerAction) {
          const transition = object(value.transition, ['transitionId', 'expectedGeneration', 'coordinator', 'controlRevision', 'reason', 'base']);
          request = await signTransitionRequest({ ...transition, applicationId: bundle.descriptor.payload.applicationId,
            profile: PEER_GENERATION_PROFILE, policy: PEER_GENERATION_POLICY, requester: state.signer!.publicKey } as TransitionRequest, state.signer!);
        } else request = value.request as SignedTransitionRequest;
        const authorize = () => { identity(t, principal, ownerAction); authorizeRequester(t, principal, request); };
        authorize();
        const fingerprint = await peerDigest([action, value]), fingerprintKey = `peer_generation_transition:${await peerDigest([request.payload.applicationId, request.payload.transitionId])}`;
        const previousFingerprint = t.db.get<string | null>(fingerprintKey, null);
        if (previousFingerprint !== null) {
          if (fingerprint !== previousFingerprint) throw new HttpError(409, 'peer_transition_id_reused', 'The transition identity already binds different controls or account bindings');
          const selected = await service.select(request); await freshAccess(t, principal); authorize(); return selected;
        }
        if (bundle.generations.some(generation => generation.payload.transition.payload.transitionId === request.payload.transitionId))
          throw new HttpError(503, 'peer_control_state_missing', 'The retained host transition identity is incomplete');
        let control: SignedControlRevision | undefined;
        let bindings: AccountBinding[] | undefined;
        let checkedBindings: AccountBinding[] = [];
        if (value.control !== undefined) {
          const change = object(value.control, ['epoch', 'keyDigest', 'grants', 'recoveryFloor', 'accounts']);
          const authority = await verifyAuthorityBundle(bundle);
          if (!authority.grant(request.payload.requester)?.administrator) throw new HttpError(403, 'peer_control_change_forbidden');
          const revision = request.payload.controlRevision;
          if (!Number.isSafeInteger(revision) || revision < 1 || revision > bundle.controls.length) throw new HttpError(409, 'peer_control_revision_mismatch');
          const previous = bundle.controls[revision - 1]!;
          bindings = t.db.get<AccountBinding[]>(ACCOUNTS, []);
          const requiredAccounts = new Set<string>();
          if (change.accounts !== undefined) {
            for (const binding of accounts(change.accounts)) {
              const enrolled = bindings.find(row => row.publicKey === binding.publicKey);
              if (enrolled && enrolled.accountId !== binding.accountId) throw new HttpError(409, 'peer_account_binding_immutable', 'A device key retains its original enrollment account');
              if (!enrolled) { bindings = [...bindings, binding]; requiredAccounts.add(binding.publicKey); }
            }
          }
          if (bindings.length > 1024) throw new HttpError(429, 'peer_account_binding_full');
          control = await signControlRevision({ applicationId: bundle.descriptor.payload.applicationId,
            profile: PEER_GENERATION_PROFILE, policy: PEER_GENERATION_POLICY, revision: previous.payload.revision + 1,
            previous: await peerDigest(previous), epoch: change.epoch, keyDigest: change.keyDigest,
            grants: await withControlParticipant(change.grants, state.signer!), recoveryFloor: change.recoveryFloor }, state.signer!);
          if (!control.payload.grants.every(grant => bindings!.some(binding => binding.publicKey === grant.publicKey)))
            throw new HttpError(400, 'peer_account_binding_required', 'Every granted device needs its authenticated account binding');
          for (const grant of control.payload.grants) {
            if (grant.reader || grant.writer || grant.coordinator || grant.recovery || grant.administrator || grant.publisher || grant.dataRole !== null)
              requiredAccounts.add(grant.publicKey);
          }
          // Historical bindings preserve enrollment identity and exact retries.
          // An inactive former participant must not prevent its own revocation;
          // new enrollments and devices retaining any rights still need access.
          checkedBindings = bindings.filter(binding => requiredAccounts.has(binding.publicKey));
          await checkAccounts(t, checkedBindings);
        }
        state.guard = () => { authorize(); checkAccountAdmission(t, checkedBindings); };
        state.check = async () => { await freshAccess(t, principal); await checkAccounts(t, checkedBindings); };
        state.pendingAccounts = bindings;
        state.pendingFingerprint = { key: fingerprintKey, value: fingerprint };
        try {
          const selected = await service.select(request, control ? { control } : {});
          authorize(); return selected;
        } finally { state.guard = undefined; state.check = undefined; state.pendingAccounts = undefined; state.pendingFingerprint = undefined; }
      }
      throw new HttpError(405, 'method_not_allowed');
    } catch (error) { return peerControlError(error); }
  });
}

/** Publication and generation controls share one authority snapshot and serialization owner. */
export function withPeerControlAuthority<T>(t: Tendril, principal: Principal, work: (scope: {
  authority: PeerAuthority;
  authorizeAuthor(publicKey: string): void;
  checkAccess(): Promise<void>;
}) => Promise<T>): Promise<T> {
  identity(t, principal);
  return serial(t, async state => {
    try {
      const authority = await verifyAuthorityBundle(await (await registry(t, state)).read());
      await freshAccess(t, principal);
      return await work({ authority,
        authorizeAuthor(publicKey) {
          const account = identity(t, principal);
          if (!t.db.get<AccountBinding[]>(ACCOUNTS, []).some(binding => binding.accountId === account && binding.publicKey === publicKey))
            throw new HttpError(403, 'peer_publisher_account', 'The signed publisher is not enrolled to this account');
        },
        checkAccess: () => freshAccess(t, principal),
      });
    } catch (error) { return peerControlError(error); }
  });
}
