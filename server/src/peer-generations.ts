import {
  createGenerationRegistry, signApplicationDescriptor,
  signControlRevision, signTransitionRequest, participantGrant, controlParticipantGrant,
  validateApplicationDescription, applicationDescriptionDigest, verifyApplicationSchema,
  peerDigest, verifyAuthorityBundle,
  PEER_GENERATION_PROFILE, PEER_GENERATION_POLICY,
  type AuthorityBundle, type GenerationRegistry, type PeerIdentity, type PeerStore, type PeerGrant,
  type SignedApplicationDescriptor, type SignedControlRevision, type SignedTransitionRequest, type TransitionRequest,
  type ApplicationDescription, type SignedApplicationSchema,
} from '@chronolog/peer-generation/control';
import { accountActive, pageAccessAllowed, currentPrincipal, type Principal } from './access';
import { selectedApplication } from './application';
import { HttpError, json, readJson } from './http';
import type { Tendril } from './tendril';
import { changeLifetime, hasResidentStorage } from './lifetime';
import { ensurePeerControlIdentity, loadPeerControlIdentity } from './peer-control-identity';

const CONFIG = 'peer_generation_configuration', ACCOUNTS = 'peer_generation_accounts';
const VALUE_LIMIT = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 4;
const PUBLICATION_LIMIT = 256 * 1024;
interface Configuration {
  descriptor: SignedApplicationDescriptor; control: SignedControlRevision; fingerprint: string;
  definition: ApplicationDescription; schema: SignedApplicationSchema | null;
}
interface AccountBinding { publicKey: string; accountId: string }
interface HostState {
  admitted: number; pending: Promise<unknown>; store: PeerStore; guard?: () => void; check?: () => Promise<void>; pendingAccounts?: AccountBinding[]; pendingFingerprint?: { key: string; value: string };
  registry?: GenerationRegistry; signer?: PeerIdentity;
}
const hosts = new WeakMap<Tendril, HostState>();
function identity(t: Tendril, principal: Principal, ownerOnly = false): string {
  const current = currentPrincipal(t, principal), owner = t.db.get<string | null>('owner_account', null);
  if (!owner || !current || current.kind === 'producer' || current.kind === 'page' && (current.role === 'display' || !current.accountId))
    throw new HttpError(403, 'forbidden', 'Peer controls require an authenticated account');
  const account = current.kind === 'agent' ? owner : current.accountId!;
  if (ownerOnly && account !== owner) throw new HttpError(403, 'forbidden', 'Only the application owner can administer hosted control authority');
  if (selectedApplication(t).kind !== 'peer') throw new HttpError(409, 'application_backend', 'Generation controls belong to a peer application');
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
  state = { admitted: 0, pending: Promise.resolve(), store: {
    async get(key) {
      const row = t.db.one<{ value: ArrayBuffer }>('SELECT value FROM membership_records WHERE key=?', key);
      return row ? new Uint8Array(row.value).slice() : null;
    },
    async put(key, value) {
      if (!key.startsWith('peer-generation/') || value.byteLength > VALUE_LIMIT)
        throw new HttpError(413, 'peer_control_storage_full', 'The bounded generation control store is full');
      const bytes = value.slice();
      await state!.check?.();
      t.transaction(() => {
        state!.guard?.();
        t.db.run('INSERT INTO membership_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, bytes.buffer);
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
async function registry(t: Tendril, state: HostState): Promise<GenerationRegistry> {
  const configuration = t.db.get<Configuration | null>(CONFIG, null);
  if (!configuration) throw new HttpError(409, 'peer_application_unconfigured', 'Publish the signed peer application descriptor first');
  const signer = await loadPeerControlIdentity(t);
  if (!signer) throw new HttpError(503, 'peer_control_state_missing', 'The pinned control identity is unavailable; recovery must preserve its original trust state');
  state.signer = signer;
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
function typedError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code.startsWith('PEER_')) {
    const status = /FORBIDDEN|SIGNATURE_INVALID|KEY_MISMATCH/.test(code) ? 403 : /STATE_MISSING/.test(code) ? 503
      : /CONFLICT|EXCLUDED|UNAVAILABLE|CHANGED|REQUIRED/.test(code) ? 409 : 400;
    throw new HttpError(status, code.toLowerCase(), code);
  }
  throw error;
}

/** Narrow governance service. Normal commands, outcomes and bodies never enter it. */
export async function handlePeerGenerations(t: Tendril, req: Request, path: string, principal: Principal): Promise<Response> {
  identity(t, principal, path === 'peers/administration' || path === 'peers/application' && req.method === 'PUT');
  const state = host(t);
  if (state.admitted >= MAX_PENDING_REQUESTS)
    throw new HttpError(429, 'peer_control_busy', 'Too many pending generation control requests');
  state.admitted++;
  try { return await processPeerGenerations(t, req, path, principal); }
  finally { state.admitted--; }
}
async function processPeerGenerations(t: Tendril, req: Request, path: string, principal: Principal): Promise<Response> {
  // Reserve admission before reading, but do not put a stalled body ahead of
  // complete operations in the serialized authority queue.
  const ownerAction = path === 'peers/administration';
  const input = req.method === 'PUT' || req.method === 'POST' ? await readJson(req, path === 'peers/application' ? 512 * 1024 : 4 * 1024 * 1024) : undefined;
  return serial(t, async state => {
    try {
      identity(t, principal, ownerAction);
      if (path === 'peers/application' && req.method === 'GET') {
        const bundle = await (await registry(t, state)).read();
        await freshAccess(t, principal); return json(bundle);
      }
      if (path === 'peers/definition' && req.method === 'GET') {
        const configured = t.db.get<Configuration | null>(CONFIG, null);
        if (!configured) throw new HttpError(409, 'peer_application_unconfigured');
        if (!configured.definition || configured.schema === undefined) throw new HttpError(503, 'peer_publication_state_missing');
        await freshAccess(t, principal);
        return json({ descriptor: configured.descriptor, definition: configured.definition, schema: configured.schema });
      }
      if (path === 'peers/application' && req.method === 'PUT') {
        const owner = identity(t, principal, true);
        const value = object(input, ['historyId', 'executionManifestDigest', 'definition', 'schema', 'schemaAdministrator', 'epoch', 'keyDigest', 'members']);
        const published = await publication(value);
        // Description schemas can contain fractional bounds; their portable digest
        // binds the complete canonical metadata without narrowing it to control integers.
        const fingerprint = await peerDigest({ ...value, definition: published.digest, schema: published.schemaDigest }), configured = t.db.get<Configuration | null>(CONFIG, null);
        if (configured) {
          if (configured.fingerprint !== fingerprint) throw new HttpError(409, 'peer_application_immutable', 'The application descriptor and initial policy are immutable');
          const bundle = await (await registry(t, state)).read(); await freshAccess(t, principal); identity(t, principal, true); return json(bundle);
        }
        if (t.db.get('membership_configuration', null)) throw new HttpError(409, 'peer_profile_conflict', 'This application already selected a different authenticated history profile');
        const applicationId = selectedApplication(t).id;
        if (!/^[0-9a-f]{64}$/.test(applicationId)) throw new HttpError(400, 'peer_application_identity', 'peer-generation-v1 applications use a 32-byte lowercase hex identity');
        if (!Array.isArray(value.members) || !value.members.length || value.members.length > 1023)
          throw new HttpError(400, 'bad_request', 'Provide the initial device grants');
        const deviceGrants: PeerGrant[] = [], rawBindings = [];
        for (const member of value.members) {
          const explicit = member && typeof member === 'object' && 'grant' in member;
          const row = object(member, explicit ? ['grant', 'accountId'] : ['publicKey', 'administrator', 'dataRole', 'accountId']);
          const grant = 'grant' in row ? row.grant : participantGrant(row.publicKey, { administrator: row.administrator, dataRole: row.dataRole });
          deviceGrants.push(grant); rawBindings.push({ publicKey: grant?.publicKey, accountId: row.accountId ?? owner });
        }
        const bindings = accounts(rawBindings); await checkAccounts(t, bindings);
        const signer = await ensurePeerControlIdentity(t);
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
          if (t.db.get('membership_configuration', null)) throw new HttpError(409, 'peer_profile_conflict');
          for (const [key, bytes] of staged) t.db.run('INSERT INTO membership_records(key,value) VALUES(?,?)', key, bytes.buffer);
          t.db.set(CONFIG, { descriptor, control, fingerprint, definition: published.definition, schema: published.schema }); t.db.set(ACCOUNTS, bindings);
        });
        return json(bundle);
      }
      if ((path === 'peers/generations' || ownerAction) && req.method === 'POST') {
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
        const fingerprint = await peerDigest([path, value]), fingerprintKey = `peer_generation_transition:${await peerDigest([request.payload.applicationId, request.payload.transitionId])}`;
        const previousFingerprint = t.db.get<string | null>(fingerprintKey, null);
        if (previousFingerprint !== null) {
          if (fingerprint !== previousFingerprint) throw new HttpError(409, 'peer_transition_id_reused', 'The transition identity already binds different controls or account bindings');
          const selected = await service.select(request); await freshAccess(t, principal); authorize(); return json(selected);
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
            if (grant.reader || grant.writer || grant.coordinator || grant.recovery || grant.administrator || grant.dataRole !== null)
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
          authorize(); return json(selected);
        } finally { state.guard = undefined; state.check = undefined; state.pendingAccounts = undefined; state.pendingFingerprint = undefined; }
      }
      throw new HttpError(405, 'method_not_allowed');
    } catch (error) { return typedError(error); }
  });
}
