/**
 * Chronolog v2 Blind Host Control Engine inside the Tendril Durable Object.
 *
 * The host stores ONLY:
 * - canonical LogGenesis (`v2_genesis`)
 * - verified public-control SignedOperations (`v2_public_ops`, strictly `$*` topics)
 * - verified public CAS nodes (`v2_public_cas`, e.g. `$reducers` ES Modules)
 * - verified finality checkpoints (`v2_checkpoints`)
 *
 * It runs `TopicKernel({ blindHostMode: true })` over ONLY public-control operations
 * to derive `$permissions`, `$keys`, `$finality`, and `$publications` — bit-for-bit
 * identical to full replicas, without ever seeing encrypted application data or epoch keys.
 */
import quickJsWasm from '@jitl/quickjs-ng-wasmfile-release-sync/wasm';
import {
  bytesToHex, computeIncludedSetDigest, decodeRecord, encodeRecord, parseFinalitySchedule, policyScopeId, recordDigest,
  signFinalityCheckpoint, validateApplicationDescription, applicationDescriptionDigest, verifyFinalityV2, verifyRecord,
  type FinalityCheckpoint, type FinalityInclusionV2, type FinalityPolicyV2, type Signed,
} from '@chronolog/authority';
import {
  computeCasHash, ContentAddressedStore, decodeCasNode, decodeEncryptedEnvelope, decodeLogGenesis, decodeSignedOperation,
  encryptedEnvelopeDigest, genesisLogId, hashCasNode, isControlTopic, MemoryBytesStore, seedStandardModules, TopicKernel,
  verifySignedOperation, type LogGenesis, type KernelOperationInput, type SignedOperation,
} from '@chronolog/peer-session/kernel';
import {
  authorityRecord, authorityRecordBytes, type AuthorityRecord, type HostAppConfig, type HostApplication,
} from '../../contract/authority.mjs';
import { currentPrincipal, freshPrincipal, pageAccessAllowed, localAgentGrant, requireAgentScope, type Principal } from './access';
import {
  admissionAccounts, agentKeyHex, attestDevice, issueAgentAttestation, pendingAdmissions,
  prunePendingAdmissions, type InviteRedemption,
} from './admissions';
import { notifyDiscoveryWatchers } from './discovery';
import { notifyMcpSyncWatchers } from './publication-watch';
import { hostAttestationKey, loadHostAttestationIdentity } from './host-attestation';
import { selectedApplication } from './application';
import { HttpError, json, readJson } from './http';
import { pageHostForLabel, pageUrl } from './urls';
import { isActiveCustomDomainForPage } from './custom-domains';
import { isActiveSubdomainForPage } from './subdomains';
import type { Tendril } from './tendril';

const CONFIG = 'application_configuration';
const GENESIS_KEY = 'v2_genesis';
const CHALLENGES = 'application_enrollment_challenges';
const MAX_PUBLIC_OPS = 2048;
const MAX_PUBLIC_CAS_NODES = 1024;
const MAX_PUBLIC_CAS_BYTES = 512 * 1024;
const MAX_PUBLIC_CAS_TOTAL = 8 * 1024 * 1024;
const MAX_CHECKPOINTS = 256;
const MAX_MAILBOX_ITEMS = 4096;
const MAX_MAILBOX_ITEM_BYTES = 256 * 1024;
const MAX_MAILBOX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_MAILBOX_CAS_ITEMS = 2048;
const MAX_MAILBOX_CAS_TOTAL_BYTES = 16 * 1024 * 1024;

export const ENROLLMENT_REQUEST_DOMAIN = 'chronolog/enrollment-request/v2';

export interface EnrollmentRequestPayload {
  readonly applicationId: string;
  readonly publicKey: string;
  readonly wrapKey: string;
  readonly challenge: string;
}

export interface ControlMember {
  readonly publicKey: string;
  readonly wrapKey?: string;
  readonly reader: boolean;
  readonly writer: boolean;
  readonly administrator: boolean;
  readonly publisher: boolean;
  readonly finalizer: boolean;
}

export interface ControlInvite {
  readonly inviteId: string;
  readonly role: 'reader' | 'writer' | 'admin';
  readonly binding: { readonly kind: 'email'; readonly email: string } | { readonly kind: 'open' } | { readonly kind: 'public'; readonly max: number | null };
  readonly expiresAt: number;
  readonly secretDigest: string;
  readonly revoked: boolean;
}

export interface ControlAdmissionPolicy {
  readonly hostKey?: string;
  readonly mode?: 'attested' | 'strict';
  readonly accounts?: readonly string[];
  readonly grant?: { readonly reader: boolean; readonly writer: boolean; readonly administrator: boolean };
  readonly invites?: readonly ControlInvite[];
}

export interface ControlReleaseFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly type: string;
}

export interface ControlRelease {
  readonly revision: number;
  readonly opId: string;
  readonly author: string;
  readonly timestampMs: number;
  readonly entry: string;
  readonly files: readonly ControlReleaseFile[];
}

export interface MaterializedControlState {
  readonly logId: string;
  readonly genesis: LogGenesis;
  readonly genesisBytes: Uint8Array;
  readonly stateRoot: string;
  readonly historyDigest: string;
  readonly permissions: {
    readonly members: readonly ControlMember[];
    readonly readers: ReadonlySet<string>;
    readonly writers: ReadonlySet<string>;
    readonly administrators: ReadonlySet<string>;
    readonly publishers: ReadonlySet<string>;
    readonly openReaders: boolean;
    readonly openWriters: boolean;
    readonly blockedAuthors: ReadonlySet<string>;
    readonly admission: ControlAdmissionPolicy | null;
  };
  readonly keys: {
    readonly currentEpoch: number;
    readonly epochs: Readonly<Record<string, {
      readonly epoch: number;
      readonly keyCommitment: string;
      readonly boxes: Readonly<Record<string, { readonly encapsulatedKey: string; readonly ciphertext: string }>>;
    }>>;
  };
  readonly finality: {
    readonly schedule: readonly { readonly effectiveAfterMs: number; readonly policy: FinalityPolicyV2 }[];
  };
  readonly publications: {
    readonly revision: number;
    readonly current: ControlRelease | null;
    readonly history: readonly { readonly revision: number; readonly opId: string; readonly author: string; readonly entry: string }[];
  };
  readonly finalizedPublications: {
    readonly revision: number;
    readonly current: ControlRelease | null;
  } | null;
  readonly hasActiveFinality: boolean;
  readonly closedThroughMs: bigint | null;
  readonly everMembers: ReadonlySet<string>;
  readonly referencedCasHashes: ReadonlySet<string>;
}

const CAS_URI_RE = /^cas:sha256-([0-9a-f]{64})$/u;
const HEX64_RE = /^[0-9a-f]{64}$/u;

function collectCasRefsFromValue(value: unknown, casMap: Map<string, Uint8Array>, out: Set<string>, depth = 0): void {
  if (depth > 32 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const uriMatch = CAS_URI_RE.exec(value);
    if (uriMatch) { out.add(uriMatch[1]!); return; }
    if (HEX64_RE.test(value) && casMap.has(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCasRefsFromValue(item, casMap, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectCasRefsFromValue(v, casMap, out, depth + 1);
    }
  }
}

/**
 * Computes the exact set of public CAS hashes reachable from genesis, public control ops,
 * and materialized public control topic states (excluding internal `seenOps` blobs).
 */
export function collectReferencedPublicCasHashes(
  genesis: unknown,
  publicOps: readonly KernelOperationInput[],
  topics: Record<string, unknown>,
  casMap: Map<string, Uint8Array>,
): Set<string> {
  const roots = new Set<string>();
  collectCasRefsFromValue(genesis, casMap, roots);
  for (const op of publicOps) collectCasRefsFromValue(op.core.updates, casMap, roots);
  collectCasRefsFromValue(topics, casMap, roots);

  const reachable = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const hash = queue.pop()!;
    if (reachable.has(hash)) continue;
    const raw = casMap.get(hash);
    if (!raw) continue;
    reachable.add(hash);
    try {
      const decoded = decodeCasNode(raw);
      for (const link of decoded.links ?? []) {
        if (typeof link === 'string' && !reachable.has(link) && casMap.has(link)) queue.push(link);
      }
    } catch { /* raw unframed module blob has no child links */ }
  }
  return reachable;
}

/** True once the page has either prepared configuration or an initialized v2 genesis. */
export const applicationPrepared = (t: Tendril): boolean =>
  t.db.get(CONFIG, null) !== null || t.db.get(GENESIS_KEY, null) !== null;

interface Challenge { applicationId: string; publicKey: string; accountId: string; challenge: string; expiresAt: number }
const tails = new WeakMap<Tendril, Promise<unknown>>();
const UNPREPARED = 'Prepare or initialize the application first. See /docs/BUILD_AN_APP.md.';

/** Serializes host control mutations, never application transactions or their order. */
export function withAuthorityMutation<T>(t: Tendril, work: () => Promise<T>): Promise<T> {
  const result = (tails.get(t) ?? Promise.resolve()).then(work);
  tails.set(t, result.catch(() => undefined));
  return result;
}

export function decodeRequestAuthorityRecord<T>(value: unknown, limit = 1024 * 1024): T {
  try {
    const record = decodeRecord<T>(authorityRecordBytes(value, limit));
    if (record === null || typeof record !== 'object' || Array.isArray(record) || record instanceof Uint8Array) {
      throw new HttpError(400, 'authority_record_invalid');
    }
    return record;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) throw new HttpError(400, 'authority_record_invalid');
    throw error;
  }
}

export function authorityError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code) {
    throw new HttpError(/SIGNATURE|FORBIDDEN|REQUIRED|DENIED/.test(code) ? 403 : /CONFLICT|MISMATCH|CHANGED/.test(code) ? 409 : 400, code.toLowerCase());
  }
  throw error;
}

export function authorityAccount(t: Tendril, principal: Principal, ownerOnly = false): string {
  const current = currentPrincipal(t, principal), owner = t.db.get<string | null>('owner_account', null);
  if (!current) throw new HttpError(403, 'forbidden');
  if (current.kind === 'page' && current.openPublic === true) {
    if (ownerOnly || !t.db.get<boolean>('v2_open_readers', false)) throw new HttpError(403, 'forbidden');
    const expires = t.expiresAt();
    if (expires !== null && expires <= t.now()) throw new HttpError(410, 'expired');
    return `public:${current.linkId}`;
  }
  if (current.kind === 'page' && (current.role === 'display' || !current.accountId)) throw new HttpError(403, 'forbidden');
  const account = current.kind === 'agent' ? owner ?? `pending:${t.tid}` : current.accountId!;
  if (ownerOnly && current.kind === 'page' && account !== owner) throw new HttpError(403, 'owner_required');
  const expires = t.expiresAt();
  if (expires !== null && expires <= t.now()) throw new HttpError(410, 'expired');
  return account;
}

export async function freshAuthorityAccess(t: Tendril, principal: Principal): Promise<void> {
  const account = authorityAccount(t, principal);
  if (!await freshPrincipal(t, principal) || !await pageAccessAllowed(t) || authorityAccount(t, principal) !== account) {
    throw new HttpError(403, 'forbidden');
  }
}

export function withUnconfiguredApplication<T>(t: Tendril, work: () => Promise<T>): Promise<T> {
  return withAuthorityMutation(t, async () => {
    if (t.db.get(GENESIS_KEY, null)) throw new HttpError(409, 'application_authority_requires_owner');
    return work();
  });
}

function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value.slice() : new Uint8Array(value).slice();
}

export function readStoredGenesisBytes(t: Tendril): Uint8Array | null {
  const rec = t.db.get<AuthorityRecord | null>(GENESIS_KEY, null);
  return rec ? authorityRecordBytes(rec, 1024 * 1024) : null;
}

/** Active Chronolog v2 logId once genesis is initialized, falling back to pre-genesis page application ID. */
export function activeLogId(t: Tendril): string {
  const genesisBytes = readStoredGenesisBytes(t);
  return genesisBytes ? bytesToHex(genesisLogId(genesisBytes)) : selectedApplication(t).id;
}

export function listPublicOpRows(t: Tendril): Array<{ op_id: string; author: string; author_ts: number; raw: Uint8Array }> {
  return t.db.all<{ op_id: string; author: string; author_ts: number; raw: ArrayBuffer | Uint8Array }>(
    'SELECT op_id, author, author_ts, raw FROM v2_public_ops ORDER BY author_ts, author, op_id',
  ).map(row => ({ ...row, raw: asBytes(row.raw) }));
}

export function listMailboxEnvelopeRows(t: Tendril): Array<{ digest: string; epoch: number; author: string; raw: Uint8Array }> {
  return t.db.all<{ digest: string; epoch: number; author: string; raw: ArrayBuffer }>(
    'SELECT digest, epoch, author, raw FROM v2_mailbox_envelopes ORDER BY stored_at ASC',
  ).map(r => ({ digest: r.digest, epoch: r.epoch, author: r.author, raw: new Uint8Array(r.raw) }));
}

export function listMailboxPublicOpRows(t: Tendril): Array<{ op_id: string; author: string; raw: Uint8Array }> {
  return t.db.all<{ op_id: string; author: string; raw: ArrayBuffer }>(
    'SELECT op_id, author, raw FROM v2_mailbox_ops ORDER BY author_ts ASC, op_id ASC',
  ).map(r => ({ op_id: r.op_id, author: r.author, raw: new Uint8Array(r.raw) }));
}

export function listMailboxPublicCasRows(t: Tendril): Array<{ hash: string; bytes: Uint8Array }> {
  return t.db.all<{ hash: string; bytes: ArrayBuffer }>(
    "SELECT hash, bytes FROM v2_mailbox_cas WHERE partition = 'public' ORDER BY stored_at ASC",
  ).map(r => ({ hash: r.hash, bytes: new Uint8Array(r.bytes) }));
}

export function listPublicCasRows(t: Tendril): Array<{ hash: string; bytes: Uint8Array }> {
  return t.db.all<{ hash: string; bytes: ArrayBuffer | Uint8Array }>(
    'SELECT hash, bytes FROM v2_public_cas ORDER BY hash',
  ).map(row => ({ hash: row.hash, bytes: asBytes(row.bytes) }));
}

export function listCheckpointRows(t: Tendril): Array<{ scope_id: string; closed_through: number; raw: Uint8Array }> {
  return t.db.all<{ scope_id: string; closed_through: number; raw: ArrayBuffer | Uint8Array }>(
    'SELECT scope_id, closed_through, raw FROM v2_checkpoints ORDER BY closed_through, scope_id',
  ).map(row => ({ ...row, raw: asBytes(row.raw) }));
}

/** Verify and parse a single public-control SignedOperation for `logId`. */
export async function verifyPublicControlOp(
  rawBytes: Uint8Array,
  expectedLogId: string,
): Promise<{ opId: string; author: string; authorTimestampMs: bigint; signed: SignedOperation; kernelInput: KernelOperationInput }> {
  const signed = decodeSignedOperation(rawBytes);
  const { core, opId } = await verifySignedOperation(signed);
  const logIdHex = bytesToHex(core.logId);
  if (logIdHex !== expectedLogId) throw new HttpError(400, 'operation_log_mismatch', 'Operation logId does not match this page');
  if (core.visibility !== 'public') throw new HttpError(400, 'public_control_required', 'Blind host only accepts public control operations');
  if (!core.updates.length || core.updates.some(u => !isControlTopic(u.topic))) {
    throw new HttpError(400, 'control_topic_required', 'Blind host only accepts operations targeting $* control topics');
  }
  const opIdHex = bytesToHex(opId);
  const authorHex = bytesToHex(core.author);
  return {
    opId: opIdHex,
    author: authorHex,
    authorTimestampMs: core.authorTimestampMs,
    signed,
    kernelInput: { opId, core },
  };
}

/**
 * Pure deterministic blind-host materialization of a genesis + public CAS + public ops + checkpoints.
 * Used both for cached reads and candidate validation before committing new ops/publications.
 */
export async function replayBlindHostControl(input: {
  genesisBytes: Uint8Array;
  publicCas: readonly { hash: string; bytes: Uint8Array }[];
  publicOps: readonly KernelOperationInput[];
  checkpoints: readonly FinalityCheckpoint[];
}): Promise<MaterializedControlState> {
  const genesis = decodeLogGenesis(input.genesisBytes);
  const logId = bytesToHex(genesisLogId(input.genesisBytes));
  const cas = new ContentAddressedStore({ store: new MemoryBytesStore() });
  await seedStandardModules(cas);
  for (const node of input.publicCas) {
    if (hashCasNode(node.bytes) === node.hash) {
      decodeCasNode(node.bytes);
      await cas.putRaw(node.hash, node.bytes, 'public');
    } else {
      await cas.put(node.bytes, [], 'public');
    }
  }

  const kernel = new TopicKernel({
    genesis,
    cas,
    blindHostMode: true,
    wasmModule: quickJsWasm,
  });

  // Evaluate initial readers via $permissions.query() before replaying ops so revocations are detected
  // regardless of the $permissions reducer's internal state schema!
  const evaluatePermissions = async (k: TopicKernel): Promise<MaterializedControlState['permissions']> => {
    const parseKeyList = (val: unknown): { keys: Set<string>; open: boolean } => {
      const keys = new Set<string>();
      let open = false;
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item === '*') open = true;
          else if (typeof item === 'string') keys.add(item);
        }
      }
      return { keys, open };
    };
    const parseMembers = (val: unknown): ControlMember[] =>
      Array.isArray(val)
        ? val.filter((m): m is ControlMember => m !== null && typeof m === 'object' && typeof (m as ControlMember).publicKey === 'string')
        : [];

    try {
      const summary = await k.query('$permissions', { summary: true });
      if (
        summary !== null && typeof summary === 'object' && !Array.isArray(summary) &&
        Array.isArray((summary as Record<string, unknown>).administrators) &&
        Array.isArray((summary as Record<string, unknown>).readers)
      ) {
        const s = summary as Record<string, unknown>;
        const readers = parseKeyList(s.readers);
        const writers = parseKeyList(s.writers);
        const admins = parseKeyList(s.administrators);
        const pubs = parseKeyList(s.publishers);
        const blocked = parseKeyList(s.blockedAuthors);
        const admission = (s.admission !== null && typeof s.admission === 'object' && !Array.isArray(s.admission))
          ? s.admission as ControlAdmissionPolicy
          : null;
        return {
          members: parseMembers(s.members),
          readers: readers.keys,
          writers: writers.keys,
          administrators: admins.keys,
          publishers: pubs.keys,
          openReaders: s.openReaders === true || readers.open,
          openWriters: s.openWriters === true || writers.open,
          blockedAuthors: blocked.keys,
          admission,
        };
      }
      const [rRaw, wRaw, aRaw, pRaw, mRaw, admRaw, blkRaw] = await Promise.all([
        k.query('$permissions', { list: 'readers' }).catch(() => null),
        k.query('$permissions', { list: 'writers' }).catch(() => null),
        k.query('$permissions', { list: 'administrators' }).catch(() => null),
        k.query('$permissions', { list: 'publishers' }).catch(() => null),
        k.query('$permissions', { list: 'members' }).catch(() => null),
        k.query('$permissions', { admission: true }).catch(() => null),
        k.query('$permissions', { list: 'blockedAuthors' }).catch(() => null),
      ]);
      if (Array.isArray(rRaw) || Array.isArray(wRaw) || Array.isArray(aRaw)) {
        const readers = parseKeyList(rRaw);
        const writers = parseKeyList(wRaw);
        const admins = parseKeyList(aRaw);
        const pubs = parseKeyList(pRaw);
        const blocked = parseKeyList(blkRaw);
        const admission = (admRaw !== null && typeof admRaw === 'object' && !Array.isArray(admRaw))
          ? admRaw as ControlAdmissionPolicy
          : null;
        return {
          members: parseMembers(mRaw),
          readers: readers.keys,
          writers: writers.keys,
          administrators: admins.keys,
          publishers: pubs.keys,
          openReaders: readers.open,
          openWriters: writers.open,
          blockedAuthors: blocked.keys,
          admission,
        };
      }
    } catch {
      // Fall back to raw topic inspection below
    }

    const raw = k.topic('$permissions') as { members?: ControlMember[]; admission?: ControlAdmissionPolicy | null } | null;
    const members = parseMembers(raw?.members);
    return {
      members,
      readers: new Set(members.filter(m => m.reader).map(m => m.publicKey)),
      writers: new Set(members.filter(m => m.writer || m.administrator).map(m => m.publicKey)),
      administrators: new Set(members.filter(m => m.administrator).map(m => m.publicKey)),
      publishers: new Set(members.filter(m => m.publisher || m.administrator).map(m => m.publicKey)),
      openReaders: false,
      openWriters: false,
      blockedAuthors: new Set(),
      admission: raw?.admission ?? null,
    };
  };

  const everMembers = new Set<string>();
  const initialPerms = await evaluatePermissions(kernel);
  for (const pk of initialPerms.readers) everMembers.add(pk);
  for (const m of initialPerms.members) everMembers.add(m.publicKey);

  const materialized = await kernel.materialize(input.publicOps);
  const permissions = await evaluatePermissions(kernel);
  for (const pk of permissions.readers) everMembers.add(pk);
  for (const m of permissions.members) everMembers.add(m.publicKey);
  const topics = kernel.topics as Record<string, any>;
  const keys = (topics.$keys ?? { currentEpoch: -1, epochs: {} }) as MaterializedControlState['keys'];
  const finality = (topics.$finality ?? { schedule: [{ effectiveAfterMs: -1, policy: { kind: 'none' } }] }) as MaterializedControlState['finality'];
  const publications = (topics.$publications ?? { revision: 0, current: null, history: [] }) as MaterializedControlState['publications'];

  const schedule = parseFinalitySchedule(finality);
  const hasActiveFinality = schedule.some(entry => entry.policy.kind !== 'none');

  let closedThroughMs: bigint | null = null;
  let finalizedPublications: MaterializedControlState['finalizedPublications'] = null;
  if (input.checkpoints.length > 0) {
    const verified = await verifyFinalityV2({
      logId,
      schedule,
      checkpoints: input.checkpoints,
      knownOps: input.publicOps.map(op => ({ opId: bytesToHex(op.opId), authorTimestampMs: op.core.authorTimestampMs })),
    });
    closedThroughMs = verified.closedThroughMs;
    if (closedThroughMs !== null) {
      const finalOps = input.publicOps.filter(op => verified.includedOpIds.has(bytesToHex(op.opId)));
      const finalKernel = new TopicKernel({
        genesis,
        cas,
        blindHostMode: true,
        wasmModule: quickJsWasm,
      });
      await finalKernel.materialize(finalOps);
      const fPub = (finalKernel.topics as Record<string, any>).$publications ?? { revision: 0, current: null };
      finalizedPublications = { revision: fPub.revision ?? 0, current: fPub.current ?? null };
    }
  }

  const casMap = new Map(input.publicCas.map(n => [n.hash, n.bytes]));
  const referencedCasHashes = collectReferencedPublicCasHashes(genesis, input.publicOps, topics, casMap);

  return {
    logId,
    genesis,
    genesisBytes: input.genesisBytes,
    stateRoot: materialized.revision.stateRoot,
    historyDigest: materialized.revision.historyDigest,
    permissions,
    keys,
    finality,
    publications,
    finalizedPublications,
    hasActiveFinality,
    closedThroughMs,
    everMembers,
    referencedCasHashes,
  };
}

/** Read and materialize the current v2 blind-host control state (cached until next DB write). */
export async function readControlState(t: Tendril): Promise<MaterializedControlState | null> {
  return t.db.cachedAsync('v2:control-state', async () => {
    const genesisBytes = readStoredGenesisBytes(t);
    if (!genesisBytes) return null;
    const logId = bytesToHex(genesisLogId(genesisBytes));
    const publicCas = listPublicCasRows(t);
    const opRows = listPublicOpRows(t);
    const publicOps: KernelOperationInput[] = [];
    for (const row of opRows) {
      const signed = decodeSignedOperation(row.raw);
      const { core, opId } = await verifySignedOperation(signed);
      if (bytesToHex(core.logId) !== logId || core.visibility !== 'public') continue;
      publicOps.push({ opId, core });
    }
    const checkpoints = listCheckpointRows(t).map(row => decodeRecord<FinalityCheckpoint>(row.raw));
    return replayBlindHostControl({ genesisBytes, publicCas, publicOps, checkpoints });
  });
}

/**
 * Reconcile host-side effects after any public-control state change:
 * 1. Immediately close discovery/relay/rendezvous WebSockets belonging to revoked members.
 * 2. Reconcile active served code release with `$publications` (rolling back / unpublishing
 *    if a late earlier revocation invalidates a provisional release; serving only finalized
 *    releases when `$finality` has an active finalizing policy).
 */
export function reconcileHostEffects(t: Tendril, state: MaterializedControlState): void {
  if (t.db.get<boolean>('v2_open_readers', false) !== state.permissions.openReaders) {
    t.db.set('v2_open_readers', state.permissions.openReaders);
  }
  if (t.db.get<boolean>('v2_open_writers', false) !== state.permissions.openWriters) {
    t.db.set('v2_open_writers', state.permissions.openWriters);
  }
  const previousReaders = new Set(t.db.get<string[]>('v2_known_readers', []));
  const activeReaders = state.permissions.readers;
  const revokedKeys = new Set<string>();
  if (!state.permissions.openReaders) {
    for (const pk of new Set([...previousReaders, ...state.everMembers])) {
      if (!activeReaders.has(pk)) revokedKeys.add(pk);
    }
  }
  const mergedKnown = [...new Set([...previousReaders, ...activeReaders, ...state.everMembers])].sort();
  if (mergedKnown.length !== previousReaders.size || mergedKnown.some(k => !previousReaders.has(k))) {
    t.db.set('v2_known_readers', mergedKnown);
  }

  for (const pk of state.permissions.blockedAuthors) revokedKeys.add(pk);
  if (state.permissions.blockedAuthors.size > 0) {
    for (const pk of state.permissions.blockedAuthors) {
      t.db.run('DELETE FROM v2_mailbox_ops WHERE author = ?', pk);
    }
  }
  if (revokedKeys.size > 0) {
    for (const ws of t.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { peerId?: string; remotePeerId?: string } | null;
      if (!att) continue;
      if ((att.peerId && revokedKeys.has(att.peerId)) || (att.remotePeerId && revokedKeys.has(att.remotePeerId))) {
        try { ws.close(4003, 'Peer membership revoked'); } catch { /* already closed */ }
      }
    }
  }

  // Reconcile served publication version.
  const effectiveRelease = state.hasActiveFinality
    ? (state.finalizedPublications?.current ?? null)
    : state.publications.current;
  const currentVersion = t.db.get<number>('current', 0);
  if (effectiveRelease === null) {
    if (currentVersion > 0 && t.db.get<boolean>('v2_publications_managed', false)) {
      t.db.set('current', 0);
    }
  } else {
    const mapped = t.db.get<number | null>(`v2_pub_version:${effectiveRelease.opId}`, null);
    if (mapped !== null && mapped !== currentVersion) {
      t.db.set('current', mapped);
    }
  }
}

export async function applicationMetadata(t: Tendril): Promise<HostApplication> {
  const state = await readControlState(t);
  const currentVersion = t.db.get<number>('current', 0);
  let seededVersion: { version: number; entry: string; files: ControlReleaseFile[] } | null = null;
  if (currentVersion > 0 && !t.db.get<boolean>('v2_publications_managed', false)) {
    const vRow = t.db.one<{ entry: string }>('SELECT entry FROM versions WHERE version = ?', currentVersion);
    if (vRow) {
      const files = t.db.all<ControlReleaseFile>('SELECT path, hash, size, type FROM version_files WHERE version = ? ORDER BY path', currentVersion);
      if (files.length > 0) seededVersion = { version: currentVersion, entry: vRow.entry, files };
    }
  }
  return {
    selection: selectedApplication(t),
    configuration: t.db.get<HostAppConfig | null>(CONFIG, null),
    genesis: t.db.get<AuthorityRecord | null>(GENESIS_KEY, null),
    stateRoot: state?.stateRoot ?? null,
    historyDigest: state?.historyDigest ?? null,
    currentEpoch: state?.keys.currentEpoch ?? -1,
    closedThroughMs: state?.closedThroughMs !== null && state?.closedThroughMs !== undefined ? state.closedThroughMs.toString() : null,
    hostAttestationKey: hostAttestationKey(t.env),
    admissionAccounts: await admissionAccounts(t),
    ...(seededVersion ? { seededVersion } : {}),
  };
}

function object(value: unknown, fields: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw new HttpError(400, 'bad_request');
  }
  return value as Record<string, any>;
}
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Optional pre-genesis metadata preparation (publisher keys, optional tool descriptions). */
export async function prepareApplication(t: Tendril, principal: Principal, input: unknown): Promise<HostApplication> {
  authorityAccount(t, principal, true);
  if (principal.kind === 'agent') requireAgentScope(principal, 'control:write');
  return withAuthorityMutation(t, async () => {
    const value = object(input, ['publisherKeys', 'requestedFinality', 'tools', 'executionProfile']);
    if (value.publisherKeys !== undefined) {
      if (!Array.isArray(value.publisherKeys) || !value.publisherKeys.length || value.publisherKeys.length > 32 ||
        value.publisherKeys.some(key => !hex(key)) || new Set(value.publisherKeys).size !== value.publisherKeys.length) {
        throw new HttpError(400, 'application_configuration_invalid');
      }
    }
    if (value.executionProfile !== undefined && (typeof value.executionProfile !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(value.executionProfile))) {
      throw new HttpError(400, 'application_configuration_invalid');
    }
    if (value.tools !== undefined && (!value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools))) {
      throw new HttpError(400, 'tool_declaration_invalid');
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024) {
      throw new HttpError(413, 'application_configuration_too_large');
    }
    const toolDigest = value.tools === undefined ? undefined : await applicationDescriptionDigest(validateApplicationDescription(value.tools));
    const fingerprint = await recordDigest({ ...value, ...(toolDigest === undefined ? {} : { tools: toolDigest }) });
    const existing = t.db.get<string | null>('application_configuration_digest', null);
    await freshAuthorityAccess(t, principal);
    authorityAccount(t, principal, true);
    if (existing !== null && existing !== fingerprint) throw new HttpError(409, 'application_configuration_immutable');
    if (existing === null) {
      t.transaction(() => {
        authorityAccount(t, principal, true);
        t.db.set(CONFIG, value);
        t.db.set('application_configuration_digest', fingerprint);
      });
    }
    return applicationMetadata(t);
  }).catch(authorityError);
}

function parseCasNodesInput(raw: unknown): Array<{ hash: string; bytes: Uint8Array }> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 128) throw new HttpError(400, 'cas_nodes_invalid');
  const out: Array<{ hash: string; bytes: Uint8Array }> = [];
  for (const item of raw) {
    const obj = object(item, ['hash', 'bytes']);
    if (!hex(obj.hash) || typeof obj.bytes !== 'string') throw new HttpError(400, 'cas_nodes_invalid');
    let bytes: Uint8Array;
    if (/^(?:[0-9a-f]{2})*$/u.test(obj.bytes)) {
      bytes = obj.bytes.length ? Uint8Array.from(obj.bytes.match(/../g)!, b => parseInt(b, 16)) : new Uint8Array(0);
    } else {
      throw new HttpError(400, 'cas_nodes_invalid');
    }
    if (bytes.byteLength > MAX_PUBLIC_CAS_BYTES) throw new HttpError(413, 'cas_node_too_large');
    if (hashCasNode(bytes) === obj.hash) {
      try { decodeCasNode(bytes); } catch { throw new HttpError(400, 'cas_nodes_invalid'); }
    } else if (computeCasHash(bytes) !== obj.hash) {
      throw new HttpError(400, 'cas_hash_mismatch');
    }
    out.push({ hash: obj.hash, bytes });
  }
  return out;
}

/** Merge verified public-control ops, public CAS nodes, and checkpoints into the blind host. */
export async function syncControlState(
  t: Tendril,
  principal: Principal,
  input: {
    publicOps?: unknown[];
    casNodes?: unknown[];
    checkpoints?: unknown[];
    knownOpIds?: unknown[];
    knownCasHashes?: unknown[];
  },
): Promise<{
  genesis: AuthorityRecord;
  publicOps: AuthorityRecord[];
  casNodes: Array<{ hash: string; bytes: string }>;
  checkpoints: AuthorityRecord[];
  stateRoot: string;
  historyDigest: string;
  closedThroughMs: string | null;
  addedOps: number;
  addedCasNodes: number;
  addedCheckpoints: number;
}> {
  const genesisBytes = readStoredGenesisBytes(t);
  if (!genesisBytes) throw new HttpError(409, 'application_uninitialized');
  const logId = bytesToHex(genesisLogId(genesisBytes));

  const incomingCas = parseCasNodesInput(input.casNodes);
  const incomingOpsRaw = Array.isArray(input.publicOps) ? input.publicOps : [];
  if (incomingOpsRaw.length > 256) throw new HttpError(400, 'too_many_operations');
  const verifiedOps: Array<{ opId: string; author: string; authorTimestampMs: bigint; raw: Uint8Array; kernelInput: KernelOperationInput }> = [];
  for (const item of incomingOpsRaw) {
    const raw = authorityRecordBytes(item, 256 * 1024);
    const parsed = await verifyPublicControlOp(raw, logId);
    verifiedOps.push({ opId: parsed.opId, author: parsed.author, authorTimestampMs: parsed.authorTimestampMs, raw, kernelInput: parsed.kernelInput });
  }

  const incomingCheckpointsRaw = Array.isArray(input.checkpoints) ? input.checkpoints : [];
  if (incomingCheckpointsRaw.length > 64) throw new HttpError(400, 'too_many_checkpoints');
  const decodedCheckpoints: Array<{ cp: FinalityCheckpoint; raw: Uint8Array }> = [];
  for (const item of incomingCheckpointsRaw) {
    const raw = authorityRecordBytes(item, 256 * 1024);
    const cp = decodeRecord<FinalityCheckpoint>(raw);
    if (!cp || typeof cp !== 'object' || !cp.payload || cp.payload.logId !== logId) {
      throw new HttpError(400, 'checkpoint_invalid');
    }
    decodedCheckpoints.push({ cp, raw });
  }

  // Build candidate set & run TopicKernel in blindHostMode BEFORE committing.
  const existingCas = listPublicCasRows(t);
  const casMap = new Map(existingCas.map(n => [n.hash, n.bytes]));
  const newCas: Array<{ hash: string; bytes: Uint8Array }> = [];
  for (const node of incomingCas) {
    if (!casMap.has(node.hash)) {
      casMap.set(node.hash, node.bytes);
      newCas.push(node);
    }
  }

  const existingOpRows = listPublicOpRows(t);
  const opMap = new Map(existingOpRows.map(r => [r.op_id, r]));
  const newOps: typeof verifiedOps = [];
  for (const op of verifiedOps) {
    if (!opMap.has(op.opId)) {
      opMap.set(op.opId, { op_id: op.opId, author: op.author, author_ts: Number(op.authorTimestampMs), raw: op.raw });
      newOps.push(op);
    }
  }
  if (opMap.size > MAX_PUBLIC_OPS) throw new HttpError(413, 'public_ops_limit');

  const allKernelOps: KernelOperationInput[] = [];
  for (const row of opMap.values()) {
    const signed = decodeSignedOperation(row.raw);
    const { core, opId } = await verifySignedOperation(signed);
    allKernelOps.push({ opId, core });
  }

  const existingCpRows = listCheckpointRows(t);
  const existingCps = existingCpRows.map(r => decodeRecord<FinalityCheckpoint>(r.raw));
  const candidateCps = [...existingCps, ...decodedCheckpoints.map(d => d.cp)];

  // Validate new checkpoints against materialized $finality schedule!
  const state = await replayBlindHostControl({
    genesisBytes,
    publicCas: [...casMap.entries()].map(([hash, bytes]) => ({ hash, bytes })),
    publicOps: allKernelOps,
    checkpoints: candidateCps,
  });

  // Verify any newly supplied checkpoints actually passed verifyFinalityV2!
  const newCps: Array<{ cp: FinalityCheckpoint; raw: Uint8Array }> = [];
  if (decodedCheckpoints.length > 0) {
    const schedule = parseFinalitySchedule(state.finality);
    const verified = await verifyFinalityV2({
      logId,
      schedule,
      checkpoints: candidateCps,
      knownOps: allKernelOps.map(op => ({ opId: bytesToHex(op.opId), authorTimestampMs: op.core.authorTimestampMs })),
    });
    const verifiedDigests = new Set(await Promise.all(verified.verifiedCheckpoints.map(cp => recordDigest(cp))));
    for (const item of decodedCheckpoints) {
      if (!verifiedDigests.has(await recordDigest(item.cp))) {
        throw new HttpError(403, 'checkpoint_unverified', 'Finality checkpoint failed policy or handoff verification');
      }
      newCps.push(item);
    }
  }
  if (existingCpRows.length + newCps.length > MAX_CHECKPOINTS) throw new HttpError(413, 'checkpoints_limit');

  const referencedCas = state.referencedCasHashes;
  const acceptedNewCas = newCas.filter(node => referencedCas.has(node.hash));
  const staleExistingCas = existingCas.filter(node => !referencedCas.has(node.hash));
  let totalReferencedBytes = 0;
  for (const hash of referencedCas) {
    const b = casMap.get(hash);
    if (b) totalReferencedBytes += b.byteLength;
  }
  if (referencedCas.size > MAX_PUBLIC_CAS_NODES || totalReferencedBytes > MAX_PUBLIC_CAS_TOTAL) {
    throw new HttpError(413, 'public_cas_limit');
  }

  await freshAuthorityAccess(t, principal);
  if (acceptedNewCas.length > 0 || staleExistingCas.length > 0 || newOps.length > 0 || newCps.length > 0) {
    t.transaction(() => {
      authorityAccount(t, principal);
      for (const node of staleExistingCas) {
        t.db.run('DELETE FROM v2_public_cas WHERE hash = ?', node.hash);
      }
      for (const node of acceptedNewCas) {
        const copy = new Uint8Array(node.bytes.byteLength); copy.set(node.bytes);
        t.db.run('INSERT OR IGNORE INTO v2_public_cas(hash, bytes) VALUES(?, ?)', node.hash, copy.buffer);
      }
      for (const op of newOps) {
        const copy = new Uint8Array(op.raw.byteLength); copy.set(op.raw);
        t.db.run('INSERT OR IGNORE INTO v2_public_ops(op_id, author, author_ts, raw) VALUES(?, ?, ?, ?)',
          op.opId, op.author, Number(op.authorTimestampMs), copy.buffer);
      }
      for (const item of newCps) {
        const copy = new Uint8Array(item.raw.byteLength); copy.set(item.raw);
        t.db.run('INSERT OR REPLACE INTO v2_checkpoints(scope_id, closed_through, raw) VALUES(?, ?, ?)',
          item.cp.payload.policyScopeId, Number(item.cp.payload.closedThroughMs), copy.buffer);
      }
      prunePendingAdmissions(t, state);
      reconcileHostEffects(t, state);
      notifyDiscoveryWatchers(t);
    });
  }

  const knownOps = new Set<string>(Array.isArray(input.knownOpIds) ? input.knownOpIds.filter((x): x is string => typeof x === 'string') : []);
  const knownCas = new Set<string>(Array.isArray(input.knownCasHashes) ? input.knownCasHashes.filter((x): x is string => typeof x === 'string') : []);
  const missingOps = listPublicOpRows(t).filter(r => !knownOps.has(r.op_id)).map(r => authorityRecord(r.raw));
  const missingCas = listPublicCasRows(t).filter(r => !knownCas.has(r.hash)).map(r => ({ hash: r.hash, bytes: bytesToHex(r.bytes) }));
  const allCheckpoints = listCheckpointRows(t).map(r => authorityRecord(r.raw));

  return {
    genesis: authorityRecord(genesisBytes),
    publicOps: missingOps,
    casNodes: missingCas,
    checkpoints: allCheckpoints,
    stateRoot: state.stateRoot,
    historyDigest: state.historyDigest,
    closedThroughMs: state.closedThroughMs !== null ? state.closedThroughMs.toString() : null,
    addedOps: newOps.length,
    addedCasNodes: newCas.length,
    addedCheckpoints: newCps.length,
  };
}

const ENROLLMENT_FIELDS = [
  'action', 'publicKey', 'proof', 'invite', 'genesis', 'casNodes', 'publicOps',
  'checkpoints', 'knownOpIds', 'knownCasHashes', 'encryptedEnvelopes', 'knownEnvelopeDigests',
  'request',
];
const JOIN_REQUEST_DOMAIN = 'tendriller-join-request-v1';
const JOIN_REQUESTS_KEY = 'v2_join_requests';
const JOIN_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_JOIN_REQUESTS = 32;

interface JoinRequestPayload {
  readonly applicationId: string;
  readonly publicKey: string;
  readonly wrapKey: string;
  readonly label?: string;
  readonly requestedAt: number;
}

interface StoredJoinRequest {
  readonly publicKey: string;
  readonly wrapKey: string;
  readonly label: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly request: AuthorityRecord;
}

/**
 * Blind Store-and-Forward Mailbox for async peer-to-peer catch-up:
 * - On private logs: stores ONLY opaque AEAD-encrypted envelopes + CAS nodes (zero keys, zero plaintext).
 * - On public logs (`privateLog: false`): stores Ed25519-verified public app ops + CAS nodes so anonymous
 *   visitors hydrate even when the creator is offline, while enforcing `openWriters` and `blockedAuthors`.
 */
/**
 * Detect upstream `TopicKernel.hashSeenOpsSet` blobs (canonical CBOR arrays of
 * `"public:<author>:<opId>"` / `"encrypted:<author>:<opId>"` strings) which are
 * never dereferenced from CAS and must never persist on the blind host.
 */
export function isSeenOpsCasBlob(encoded: Uint8Array): boolean {
  try {
    const node = decodeCasNode(encoded);
    if (node.links.length !== 0 || node.bytes.length === 0) return false;
    const payload = decodeRecord<unknown>(node.bytes);
    if (!Array.isArray(payload) || payload.length === 0) return false;
    return payload.every(item => typeof item === 'string' && /^(?:public|encrypted):[0-9a-f]{64}:/.test(item));
  } catch {
    return false;
  }
}

async function syncMailbox(t: Tendril, principal: Principal, input: Record<string, any>) {
  const state = await readControlState(t);
  if (!state) throw new HttpError(409, 'application_uninitialized', 'Application genesis has not been initialized');
  const logId = state.logId;
  const now = t.now();

  const canWrite = (author: string): boolean => {
    if (state.permissions.blockedAuthors.has(author)) return false;
    return state.permissions.openWriters || state.permissions.writers.has(author) || state.permissions.administrators.has(author);
  };

  // Validate incoming encrypted envelopes (private logs only, 100% blind)
  const rawEnvs = Array.isArray(input.encryptedEnvelopes) ? input.encryptedEnvelopes : [];
  if (rawEnvs.length > 128) throw new HttpError(400, 'too_many_envelopes');
  const existingEnvDigests = new Set(t.db.all<{ digest: string }>('SELECT digest FROM v2_mailbox_envelopes').map(r => r.digest));
  const existingEnvBytes = t.db.one<{ total: number }>('SELECT COALESCE(SUM(LENGTH(raw)), 0) AS total FROM v2_mailbox_envelopes')?.total ?? 0;
  const newEnvs: Array<{ digest: string; epoch: number; author: string; raw: Uint8Array }> = [];
  let addedEnvBytes = 0;

  if (state.genesis.privateLog) {
    for (const item of rawEnvs) {
      const raw = authorityRecordBytes(item, MAX_MAILBOX_ITEM_BYTES);
      let env;
      try { env = decodeEncryptedEnvelope(raw); }
      catch { throw new HttpError(400, 'mailbox_envelope_invalid'); }
      if (bytesToHex(env.logId) !== logId) throw new HttpError(400, 'mailbox_log_mismatch');
      const author = bytesToHex(env.author);
      if (!canWrite(author)) continue;
      const digest = bytesToHex(encryptedEnvelopeDigest(raw));
      if (existingEnvDigests.has(digest) || newEnvs.some(e => e.digest === digest)) continue;
      if (existingEnvDigests.size + newEnvs.length >= MAX_MAILBOX_ITEMS) break;
      if (existingEnvBytes + addedEnvBytes + raw.byteLength > MAX_MAILBOX_TOTAL_BYTES) break;
      newEnvs.push({ digest, epoch: env.epoch, author, raw });
      addedEnvBytes += raw.byteLength;
    }
  }

  // Validate incoming public application ops (public logs only, Ed25519-verified, blockedAuthors rejected)
  const rawOps = Array.isArray(input.publicOps) ? input.publicOps : [];
  if (rawOps.length > 128) throw new HttpError(400, 'too_many_operations');
  const existingOpIds = new Set(t.db.all<{ op_id: string }>('SELECT op_id FROM v2_mailbox_ops').map(r => r.op_id));
  const existingOpBytes = t.db.one<{ total: number }>('SELECT COALESCE(SUM(LENGTH(raw)), 0) AS total FROM v2_mailbox_ops')?.total ?? 0;
  const newOps: Array<{ opId: string; author: string; authorTs: number; raw: Uint8Array }> = [];
  let addedOpBytes = 0;

  if (!state.genesis.privateLog) {
    for (const item of rawOps) {
      const raw = authorityRecordBytes(item, MAX_MAILBOX_ITEM_BYTES);
      let signed;
      try { signed = decodeSignedOperation(raw); }
      catch { throw new HttpError(400, 'mailbox_operation_invalid'); }
      const verified = await verifySignedOperation(signed).catch(() => null);
      if (!verified) throw new HttpError(400, 'mailbox_signature_invalid');
      if (bytesToHex(verified.core.logId) !== logId || verified.core.visibility !== 'public') continue;
      if (verified.core.updates.some(u => isControlTopic(u.topic))) continue;
      const author = bytesToHex(verified.core.author);
      if (!canWrite(author)) continue;
      const opId = bytesToHex(verified.opId);
      if (existingOpIds.has(opId) || newOps.some(o => o.opId === opId)) continue;
      if (existingOpIds.size + newOps.length >= MAX_MAILBOX_ITEMS) break;
      if (existingOpBytes + addedOpBytes + raw.byteLength > MAX_MAILBOX_TOTAL_BYTES) break;
      newOps.push({ opId, author, authorTs: Number(verified.core.authorTimestampMs), raw });
      addedOpBytes += raw.byteLength;
    }
  }

  // Validate incoming public CAS nodes only (hash-verified).
  // Private logs NEVER store CAS in the blind mailbox: public control CAS flows
  // through `syncControl` (reachability-filtered into `v2_public_cas`), and private
  // state converges strictly from AEAD `encryptedEnvelopes` replayed locally.
  // Public logs also reject/prune unreferenced `seenOps` blobs that upstream
  // `TopicKernel.hashSeenOpsSet` writes to the `"public"` CAS partition.
  const rawCas = Array.isArray(input.casNodes) ? input.casNodes : [];
  if (rawCas.length > 128) throw new HttpError(400, 'too_many_cas_nodes');
  const existingCasRows = t.db.all<{ hash: string; bytes: ArrayBuffer | Uint8Array }>('SELECT hash, bytes FROM v2_mailbox_cas');
  const existingCasHashes = new Set(existingCasRows.map(r => r.hash));
  const staleMailboxCasHashes = state.genesis.privateLog
    ? existingCasRows.map(r => r.hash)
    : existingCasRows.filter(r => isSeenOpsCasBlob(asBytes(r.bytes))).map(r => r.hash);
  const staleMailboxCasSet = new Set(staleMailboxCasHashes);
  const existingCasBytes = existingCasRows
    .filter(r => !staleMailboxCasSet.has(r.hash))
    .reduce((sum, r) => sum + asBytes(r.bytes).byteLength, 0);
  const newCas: Array<{ hash: string; partition: 'public'; bytes: Uint8Array }> = [];
  let addedCasBytes = 0;

  if (!state.genesis.privateLog) {
    for (const item of rawCas) {
      if (!item || typeof item !== 'object' || !hex(item.hash) || typeof item.bytes !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(item.bytes)) {
        throw new HttpError(400, 'mailbox_cas_invalid');
      }
      if (item.partition === 'private') continue;
      if (item.bytes.length > MAX_PUBLIC_CAS_BYTES * 2) throw new HttpError(413, 'mailbox_cas_too_large');
      const bytes = item.bytes.length === 0 ? new Uint8Array(0) : Uint8Array.from(item.bytes.match(/../g) as string[], (b: string) => parseInt(b, 16));
      if (hashCasNode(bytes) !== item.hash && computeCasHash(bytes, []) !== item.hash) {
        throw new HttpError(400, 'mailbox_cas_hash_mismatch');
      }
      if (isSeenOpsCasBlob(bytes)) continue;
      if (existingCasHashes.has(item.hash) || newCas.some(c => c.hash === item.hash)) continue;
      if (existingCasHashes.size - staleMailboxCasHashes.length + newCas.length >= MAX_MAILBOX_CAS_ITEMS) break;
      if (existingCasBytes + addedCasBytes + bytes.byteLength > MAX_MAILBOX_CAS_TOTAL_BYTES) break;
      newCas.push({ hash: item.hash, partition: 'public', bytes });
      addedCasBytes += bytes.byteLength;
    }
  }

  if (newEnvs.length > 0 || newOps.length > 0 || newCas.length > 0 || staleMailboxCasHashes.length > 0) {
    await freshAuthorityAccess(t, principal);
    t.transaction(() => {
      for (const hash of staleMailboxCasHashes) {
        t.db.run('DELETE FROM v2_mailbox_cas WHERE hash = ?', hash);
      }
      for (const e of newEnvs) {
        const copy = new Uint8Array(e.raw.byteLength); copy.set(e.raw);
        t.db.run('INSERT OR IGNORE INTO v2_mailbox_envelopes(digest, epoch, author, raw, stored_at) VALUES(?, ?, ?, ?, ?)',
          e.digest, e.epoch, e.author, copy.buffer, now);
      }
      for (const o of newOps) {
        const copy = new Uint8Array(o.raw.byteLength); copy.set(o.raw);
        t.db.run('INSERT OR IGNORE INTO v2_mailbox_ops(op_id, author, author_ts, raw, stored_at) VALUES(?, ?, ?, ?, ?)',
          o.opId, o.author, o.authorTs, copy.buffer, now);
      }
      for (const c of newCas) {
        const copy = new Uint8Array(c.bytes.byteLength); copy.set(c.bytes);
        t.db.run('INSERT OR IGNORE INTO v2_mailbox_cas(hash, partition, bytes, stored_at) VALUES(?, ?, ?, ?)',
          c.hash, c.partition, copy.buffer, now);
      }
      if (newEnvs.length > 0 || newOps.length > 0 || newCas.length > 0) {
        notifyDiscoveryWatchers(t);
        if (newEnvs.length > 0) notifyMcpSyncWatchers(t);
      }
    });
  }

  const knownDigests = new Set<string>(Array.isArray(input.knownEnvelopeDigests) ? input.knownEnvelopeDigests.filter((x): x is string => typeof x === 'string') : []);
  const knownOps = new Set<string>(Array.isArray(input.knownOpIds) ? input.knownOpIds.filter((x): x is string => typeof x === 'string') : []);
  const knownCas = new Set<string>(Array.isArray(input.knownCasHashes) ? input.knownCasHashes.filter((x): x is string => typeof x === 'string') : []);

  const encryptedEnvelopes = state.genesis.privateLog
    ? t.db.all<{ digest: string; raw: ArrayBuffer }>('SELECT digest, raw FROM v2_mailbox_envelopes ORDER BY stored_at ASC')
        .filter(r => !knownDigests.has(r.digest))
        .slice(0, 512)
        .map(r => authorityRecord(new Uint8Array(r.raw)))
    : [];

  const publicOps = !state.genesis.privateLog
    ? t.db.all<{ op_id: string; author: string; raw: ArrayBuffer }>('SELECT op_id, author, raw FROM v2_mailbox_ops ORDER BY author_ts ASC, op_id ASC')
        .filter(r => !knownOps.has(r.op_id) && !state.permissions.blockedAuthors.has(r.author))
        .slice(0, 512)
        .map(r => authorityRecord(new Uint8Array(r.raw)))
    : [];

  const casNodes = state.genesis.privateLog
    ? []
    : t.db.all<{ hash: string; partition: string; bytes: ArrayBuffer }>('SELECT hash, partition, bytes FROM v2_mailbox_cas ORDER BY stored_at ASC')
        .filter(r => !knownCas.has(r.hash))
        .slice(0, 512)
        .map(r => ({
          hash: r.hash,
          partition: (r.partition === 'private' ? 'private' : 'public') as 'public' | 'private',
          bytes: bytesToHex(new Uint8Array(r.bytes)),
        }));

  return {
    logId,
    privateLog: state.genesis.privateLog,
    encryptedEnvelopes,
    publicOps,
    casNodes,
    addedEnvelopes: newEnvs.length,
    addedOps: newOps.length,
    addedCasNodes: newCas.length,
  };
}

/**
 * Host-side admission, public-control sync & blind store-and-forward mailbox.
 * The host verifies key proofs, signs host attestations (evidence only), merges
 * member-signed v2 public-control operations into its blind `TopicKernel`, and
 * relays opaque encrypted envelopes or verified public ops for offline peers.
 */
export async function handleEnrollment(t: Tendril, req: Request, principal: Principal): Promise<Response> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const isOpenPublicInitialized = t.db.get(GENESIS_KEY, null) !== null && t.db.get<boolean>('v2_open_readers', false);
  if (principal.kind === 'page') {
    if ((!principal.accountId && !isOpenPublicInitialized) || principal.role === 'display') {
      throw new HttpError(403, 'browser_account_required');
    }
    const served = req.headers.get('x-tendril-origin');
    const pageHost = new URL(pageUrl(t.env, t.tid, 'a'.repeat(26))).hostname.toLowerCase();
    let servedHost: string | null = null; try { servedHost = served ? new URL(served).hostname.toLowerCase() : null; } catch {}
    let originAllowed = Boolean(served && servedHost && servedHost === pageHost);
    if (!originAllowed && served && servedHost) {
      const activeSub = t.activeSubdomain();
      if (activeSub && servedHost === pageHostForLabel(t.env, activeSub) && await isActiveSubdomainForPage(t.env, servedHost, t.tid)) {
        originAllowed = true;
      } else if (await isActiveCustomDomainForPage(t.env, servedHost, t.tid)) {
        originAllowed = true;
      }
    }
    if (!served || !originAllowed || req.headers.get('Origin') !== served) throw new HttpError(403, 'enrollment_origin_forbidden');
  }
  const input = object(await readJson(req, 4 * 1024 * 1024), ENROLLMENT_FIELDS);
  if (principal.kind === 'page' && !principal.accountId && input.action !== 'sync' && input.action !== 'mailbox') {
    throw new HttpError(403, 'browser_account_required');
  }
  try {
    return await withAuthorityMutation(t, async () => {
      await freshAuthorityAccess(t, principal);
      const accountId = authorityAccount(t, principal), applicationId = activeLogId(t);
      const browserOnly = () => { if (principal.kind !== 'page' || !principal.accountId) throw new HttpError(403, 'browser_account_required'); };
      const fields = (...allowed: string[]) => {
        if (Object.keys(input).some(key => key !== 'action' && !allowed.includes(key))) throw new HttpError(400, 'bad_request');
      };

      if (input.action === 'challenge') {
        browserOnly(); fields('publicKey');
        if (!applicationPrepared(t)) throw new HttpError(409, 'application_unprepared', UNPREPARED);
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
        if (!applicationPrepared(t)) throw new HttpError(409, 'application_unprepared', UNPREPARED);
        const proof = decodeRequestAuthorityRecord<Signed<EnrollmentRequestPayload>>(input.proof, 16 * 1024);
        let invite: InviteRedemption | undefined;
        if (input.invite !== undefined) {
          const value = object(input.invite, ['inviteId', 'secret']);
          if (typeof value.inviteId !== 'string' || !/^[0-9a-f]{32}$/.test(value.inviteId) || !hex(value.secret)) throw new HttpError(400, 'invite_invalid');
          invite = { inviteId: value.inviteId, secret: value.secret };
        }
        await verifyRecord(ENROLLMENT_REQUEST_DOMAIN, proof);
        const request = proof.payload;
        if (proof.signer !== request.publicKey || !hex(request.wrapKey)) throw new HttpError(400, 'enrollment_proof_invalid');
        const matches = (row: Challenge) =>
          row.challenge === request.challenge && row.accountId === accountId && row.publicKey === request.publicKey &&
          row.applicationId === request.applicationId && row.expiresAt > t.now();
        if (request.applicationId !== applicationId || !t.db.get<Challenge[]>(CHALLENGES, []).some(matches)) {
          throw new HttpError(403, 'enrollment_challenge_invalid');
        }
        await freshAuthorityAccess(t, principal);
        const attestation = await attestDevice(t, {
          accountId,
          publicKey: request.publicKey,
          wrapKey: request.wrapKey,
          invite,
          commit() {
            authorityAccount(t, principal);
            if (!t.db.get<Challenge[]>(CHALLENGES, []).some(matches)) throw new HttpError(403, 'enrollment_challenge_invalid');
          },
        });
        return json({ ...await applicationMetadata(t), attestation: authorityRecord(encodeRecord(attestation)) });
      }

      if (input.action === 'enroll-agent') {
        fields();
        if (principal.kind !== 'agent') throw new HttpError(403, 'agent_required');
        const attestation = await issueAgentAttestation(t, principal.agentId);
        return json({ ...await applicationMetadata(t), attestation: authorityRecord(encodeRecord(attestation)) });
      }

      if (input.action === 'initialize') {
        fields('genesis', 'casNodes', 'publicOps');
        return json(await initializeGenesis(t, principal, input.genesis, input.casNodes, input.publicOps));
      }

      if (input.action === 'sync') {
        fields('publicOps', 'casNodes', 'checkpoints', 'knownOpIds', 'knownCasHashes');
        const synced = await syncControlState(t, principal, input);
        return json({ ...await applicationMetadata(t), ...synced });
      }

      if (input.action === 'mailbox') {
        fields('encryptedEnvelopes', 'publicOps', 'casNodes', 'knownEnvelopeDigests', 'knownOpIds', 'knownCasHashes');
        return json(await syncMailbox(t, principal, input));
      }

      if (input.action === 'join_request') {
        fields('request');
        const state = await readControlState(t);
        if (!state) throw new HttpError(409, 'application_uninitialized', 'Application genesis has not been initialized');
        const signed = decodeRequestAuthorityRecord<Signed<JoinRequestPayload>>(input.request, 8 * 1024);
        await verifyRecord(JOIN_REQUEST_DOMAIN, signed);
        const p = signed.payload;
        if (
          !p ||
          signed.signer !== p.publicKey ||
          !hex(p.publicKey) ||
          !hex(p.wrapKey) ||
          (p.applicationId !== applicationId && p.applicationId !== state.logId) ||
          !Number.isSafeInteger(p.requestedAt)
        ) {
          throw new HttpError(400, 'join_request_invalid');
        }
        if (state.permissions.blockedAuthors.has(p.publicKey)) {
          throw new HttpError(403, 'author_blocked');
        }
        const now = t.now();
        const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 80) : 'New signer';
        const existing = t.db.get<StoredJoinRequest[]>(JOIN_REQUESTS_KEY, [])
          .filter(r => r.expiresAt > now && r.publicKey !== p.publicKey);
        const next: StoredJoinRequest[] = [
          ...existing.slice(-(MAX_JOIN_REQUESTS - 1)),
          {
            publicKey: p.publicKey,
            wrapKey: p.wrapKey,
            label,
            requestedAt: p.requestedAt,
            expiresAt: now + JOIN_REQUEST_TTL_MS,
            request: authorityRecord(encodeRecord(signed)),
          },
        ];
        t.db.set(JOIN_REQUESTS_KEY, next);
        notifyDiscoveryWatchers(t);
        return json({ accepted: true, count: next.length });
      }

      if (input.action === 'join_requests') {
        fields();
        const state = await readControlState(t);
        const now = t.now();
        const active = t.db.get<StoredJoinRequest[]>(JOIN_REQUESTS_KEY, [])
          .filter(r => r.expiresAt > now && !state?.permissions.readers.has(r.publicKey) && !state?.permissions.blockedAuthors.has(r.publicKey));
        return json({ requests: active });
      }

      if (input.action === 'admissions') {
        fields();
        const state = await readControlState(t);
        return json({ pending: pendingAdmissions(t, state) });
      }

      throw new HttpError(400, 'enrollment_action_invalid');
    });
  } catch (error) {
    return authorityError(error);
  }
}

/** Store a Chronolog v2 LogGenesis once, verifying logId, root admin, and host policy pins. */
async function initializeGenesis(
  t: Tendril,
  principal: Principal,
  genesisRecord: unknown,
  casNodesInput: unknown,
  initialOpsInput: unknown,
): Promise<HostApplication> {
  const genesisBytes = authorityRecordBytes(genesisRecord, 1024 * 1024);
  const stored = readStoredGenesisBytes(t);
  if (stored !== null) {
    if (stored.byteLength === genesisBytes.byteLength && stored.every((b, i) => b === genesisBytes[i])) {
      return applicationMetadata(t);
    }
    throw new HttpError(409, 'application_initialized');
  }

  let genesis: LogGenesis;
  try { genesis = decodeLogGenesis(genesisBytes); }
  catch { throw new HttpError(400, 'authority_genesis_invalid'); }
  const logId = bytesToHex(genesisLogId(genesisBytes));

  const casNodes = parseCasNodesInput(casNodesInput);
  const initialOpsRaw = Array.isArray(initialOpsInput) ? initialOpsInput : [];
  if (initialOpsRaw.length > 32) throw new HttpError(400, 'too_many_operations');
  const verifiedOps: Array<{ opId: string; author: string; authorTimestampMs: bigint; raw: Uint8Array; kernelInput: KernelOperationInput }> = [];
  for (const item of initialOpsRaw) {
    const raw = authorityRecordBytes(item, 256 * 1024);
    const parsed = await verifyPublicControlOp(raw, logId);
    verifiedOps.push({ opId: parsed.opId, author: parsed.author, authorTimestampMs: parsed.authorTimestampMs, raw, kernelInput: parsed.kernelInput });
  }

  // Validate full deterministic blind-host replay & evaluate $permissions via TopicKernel.query()!
  // This decouples Tendriller from any single hardcoded $permissions state shape (supporting
  // attestedMembers, multisigMembers, openMembers, or custom capability reducers).
  let state: MaterializedControlState;
  try {
    state = await replayBlindHostControl({
      genesisBytes,
      publicCas: casNodes,
      publicOps: verifiedOps.map(o => o.kernelInput),
      checkpoints: [],
    });
  } catch {
    throw new HttpError(400, 'authority_genesis_invalid', 'Genesis failed deterministic blind-host replay');
  }

  const admins = [...state.permissions.administrators].filter(pk =>
    (state.permissions.openReaders || state.permissions.readers.has(pk)) &&
    (state.permissions.openWriters || state.permissions.writers.has(pk)),
  );
  if (!admins.length) throw new HttpError(400, 'authority_root_member_invalid');

  const owner = t.db.get<string | null>('owner_account', null);
  if (principal.kind === 'agent') {
    requireAgentScope(principal, 'control:write');
    const grant = localAgentGrant(t, principal.agentId);
    if (!grant || !admins.includes(agentKeyHex(grant.public_key))) {
      throw new HttpError(403, 'initializer_root_required');
    }
  } else if (principal.role !== 'owner' || !owner || principal.accountId !== owner) {
    throw new HttpError(403, 'owner_required');
  }

  // Host-attested admission is OPT-IN: enforce hostKey & admissionAccounts when the log
  // declares an admission policy, while allowing non-host-attested authority models (admission: null)
  // such as multisig or open-write logs without host coupling!
  const admission = state.permissions.admission;
  if (admission !== null) {
    const hostKey = hostAttestationKey(t.env);
    if (!hostKey || !await loadHostAttestationIdentity(t.env)) throw new HttpError(503, 'attestation_unconfigured');
    if (admission.hostKey !== hostKey) throw new HttpError(400, 'admission_host_key_mismatch');
    if (Array.isArray(admission.accounts)) {
      const accounts = await admissionAccounts(t);
      if (accounts.length && accounts.some(acc => !admission.accounts!.includes(acc))) {
        throw new HttpError(400, 'admission_accounts_mismatch');
      }
    }
  }

  const acceptedGenesisCas = casNodes.filter(node => state.referencedCasHashes.has(node.hash));
  await freshAuthorityAccess(t, principal);
  t.transaction(() => {
    authorityAccount(t, principal);
    if (t.db.get(GENESIS_KEY, null) !== null) throw new HttpError(409, 'application_initialized');
    t.db.set(GENESIS_KEY, authorityRecord(genesisBytes));
    for (const node of acceptedGenesisCas) {
      const copy = new Uint8Array(node.bytes.byteLength); copy.set(node.bytes);
      t.db.run('INSERT OR IGNORE INTO v2_public_cas(hash, bytes) VALUES(?, ?)', node.hash, copy.buffer);
    }
    for (const op of verifiedOps) {
      const copy = new Uint8Array(op.raw.byteLength); copy.set(op.raw);
      t.db.run('INSERT OR IGNORE INTO v2_public_ops(op_id, author, author_ts, raw) VALUES(?, ?, ?, ?)',
        op.opId, op.author, Number(op.authorTimestampMs), copy.buffer);
    }
    prunePendingAdmissions(t, state);
    reconcileHostEffects(t, state);
    notifyDiscoveryWatchers(t);
  });
  return applicationMetadata(t);
}

/**
 * Opt-in Blind Host Notary: when a page's $finality schedule explicitly selects this host's
 * Ed25519 attestation key as a `signed-frontier` signer, sign a strictly monotonic closed-time
 * frontier checkpoint over opaque (opId, authorTimestampMs, author) metadata without ever
 * inspecting encrypted payloads.
 */
export async function notarizeBlindFrontier(
  t: Tendril,
  principal: Principal,
  options: {
    readonly extraInclusions?: readonly { readonly opId: string; readonly authorTimestampMs: number | string; readonly author: string }[];
  } = {},
): Promise<{
  readonly checkpoint: AuthorityRecord;
  readonly closedThroughMs: string;
  readonly includedCount: number;
}> {
  const state = await readControlState(t);
  if (!state) throw new HttpError(409, 'application_uninitialized');
  const hostIdentity = await loadHostAttestationIdentity(t.env);
  if (!hostIdentity) throw new HttpError(503, 'notary_unconfigured');

  const schedule = parseFinalitySchedule(state.finality);
  let activeEntry: (typeof schedule)[number] | null = null;
  for (const entry of schedule) {
    if (entry.policy.kind === 'signed-frontier' && entry.policy.signer === hostIdentity.publicKey) {
      activeEntry = entry;
    }
  }
  if (!activeEntry) {
    throw new HttpError(403, 'notary_not_scheduled', 'This page has not opted into the host signed-frontier notary in $finality');
  }

  const scopeId = await policyScopeId(state.logId, activeEntry);
  const existingRows = listCheckpointRows(t);
  const existingCps = existingRows.map(r => decodeRecord<FinalityCheckpoint>(r.raw));
  const priorClosed = existingCps.reduce((max, cp) => (cp.payload.closedThroughMs > max ? cp.payload.closedThroughMs : max), -1n);

  const nowMs = BigInt(Date.now());
  let closedThroughMs = nowMs > activeEntry.effectiveAfterMs ? nowMs : activeEntry.effectiveAfterMs;
  if (priorClosed >= closedThroughMs) closedThroughMs = priorClosed + 1n;

  const inclusionsByOpId = new Map<string, FinalityInclusionV2>();
  // Preserve every previously included op so checkpoints remain strictly cumulative & non-equivocating
  for (const cp of existingCps) {
    for (const inc of cp.payload.inclusions) {
      if (!inclusionsByOpId.has(inc.opId)) inclusionsByOpId.set(inc.opId, inc);
    }
  }
  for (const row of listPublicOpRows(t)) {
    const ts = BigInt(row.author_ts);
    if (ts <= closedThroughMs && !inclusionsByOpId.has(row.op_id)) {
      inclusionsByOpId.set(row.op_id, { opId: row.op_id, authorTimestampMs: ts, author: row.author });
    }
  }
  // Include public mailbox ops (zero plaintext ever read)
  for (const row of t.db.all<{ op_id: string; author: string; author_ts: number }>(
    'SELECT op_id, author, author_ts FROM v2_mailbox_ops WHERE author_ts <= ?',
    Number(closedThroughMs),
  )) {
    const ts = BigInt(row.author_ts);
    if (!inclusionsByOpId.has(row.op_id)) {
      inclusionsByOpId.set(row.op_id, { opId: row.op_id, authorTimestampMs: ts, author: row.author });
    }
  }
  // Allow admitted members to declare opaque (opId, authorTimestampMs, author) tuples for encrypted envelopes
  // already stored in v2_mailbox_envelopes (still 100% blind to plaintext)
  if (Array.isArray(options.extraInclusions)) {
    const HEX32 = /^[0-9a-f]{64}$/u;
    for (const item of options.extraInclusions.slice(0, 256)) {
      if (!item || !HEX32.test(item.opId) || !HEX32.test(item.author)) continue;
      let ts: bigint;
      try { ts = BigInt(item.authorTimestampMs); } catch { continue; }
      if (ts <= closedThroughMs && !inclusionsByOpId.has(item.opId)) {
        inclusionsByOpId.set(item.opId, { opId: item.opId, authorTimestampMs: ts, author: item.author });
      }
    }
  }

  const inclusions = [...inclusionsByOpId.values()].sort((a, b) =>
    a.authorTimestampMs !== b.authorTimestampMs
      ? (a.authorTimestampMs < b.authorTimestampMs ? -1 : 1)
      : (a.opId < b.opId ? -1 : 1),
  );
  const payload = {
    logId: state.logId,
    policyScopeId: scopeId,
    closedThroughMs,
    includedSetDigest: computeIncludedSetDigest(inclusions.map(i => i.opId)),
    historyDigest: state.historyDigest,
    stateRoot: state.stateRoot,
    inclusions,
  };
  const sig = await signFinalityCheckpoint(payload, hostIdentity);
  const checkpoint: FinalityCheckpoint = {
    payload,
    attestation: { kind: 'signatures', signatures: [sig] },
  };
  const verified = await verifyFinalityV2({
    logId: state.logId,
    schedule,
    checkpoints: [...existingCps, checkpoint],
  });
  if (verified.equivocationProofs.length > 0) {
    throw new HttpError(500, 'notary_equivocation_guard');
  }
  const rawCp = encodeRecord(checkpoint);
  await freshAuthorityAccess(t, principal);
  t.transaction(() => {
    authorityAccount(t, principal);
    const copy = new Uint8Array(rawCp.byteLength); copy.set(rawCp);
    t.db.run(
      'INSERT OR REPLACE INTO v2_checkpoints(scope_id, closed_through, raw) VALUES(?, ?, ?)',
      scopeId,
      Number(closedThroughMs),
      copy.buffer,
    );
  });
  notifyDiscoveryWatchers(t);
  return {
    checkpoint: authorityRecord(rawCp),
    closedThroughMs: closedThroughMs.toString(),
    includedCount: inclusions.length,
  };
}
