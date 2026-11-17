import { hasResidentStorage } from './lifetime';
// The default membership administrator is a portable public artifact. This host
// supplies account authorization and durable bytes; it never loads application SQL.
import {
  MembershipAdministrator, provisionMembership, createMembershipLedgerClient, encodeMembershipLedgerResponse,
  decodeSignedEnrollmentRequest, encodeSignedEnrollmentApproval, decodeSignedEnrollmentApproval,
  encodeSignedGenesis, verifySignedEnrollmentRequest,
  type DurableOperationStore, type EnrollmentDescriptor, type SignedEnrollmentRequest,
} from '@chronolog/membership';
import type { MemberApproval, MemberProgram, MemberRequest, MembershipConfiguration, MembershipInfo } from '../../contract/members.mjs';
import { currentPrincipal, type Principal } from './access';
import { selectedApplication } from './application';
import { HttpError, isPlainObject, json, readJson } from './http';
import { sha256Hex } from './ids';
import type { Tendril } from './tendril';

export const MEMBERSHIP_ROUTE = /^members(?:\/|$)/;
const LIMITS = { valueBytes: 16 * 1024 * 1024, storageBytes: 64 * 1024 * 1024, requests: 2048, actions: 4096 };
interface RequestRow {
  id: string; account_id: string; request: string; created_at: number; approval: string | null; revoked: string;
}
interface ActionRow { id: string; kind: 'approve' | 'revoke'; payload: string; state: string; result: string | null; error: string | null }
interface HostState { store: DurableOperationStore; pending: Promise<unknown>; administrator?: Promise<MembershipAdministrator> }
const hosts = new WeakMap<Tendril, HostState>();

function host(t: Tendril): HostState {
  let value = hosts.get(t);
  if (value) return value;
  const store: DurableOperationStore = {
    async get(key) {
      const row = t.db.one<{ value: ArrayBuffer }>('SELECT value FROM membership_records WHERE key=?', key);
      return row ? new Uint8Array(row.value).slice() : null;
    },
    async put(key, input) {
      const bytes = input.slice();
      if (key.length > 1024 || bytes.length > LIMITS.valueBytes) throw new HttpError(413, 'membership_storage_full', 'Membership state exceeds its bounded record size');
      t.transaction(() => {
        const before = t.db.one<{ size: number }>('SELECT length(value) AS size FROM membership_records WHERE key=?', key)?.size ?? 0;
        const used = t.db.one<{ size: number }>('SELECT COALESCE(SUM(length(value)),0) AS size FROM membership_records')!.size;
        if (used - before + bytes.length > LIMITS.storageBytes) throw new HttpError(413, 'membership_storage_full', 'Membership storage is full; retained decisions were not removed');
        t.db.run('INSERT INTO membership_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, bytes.buffer);
      });
    },
  };
  value = { store, pending: Promise.resolve() }; hosts.set(t, value); return value;
}

function serial<T>(t: Tendril, work: () => Promise<T>): Promise<T> {
  const state = host(t), result = state.pending.then(work);
  state.pending = result.catch(() => {}); return result;
}

function identity(t: Tendril, principal: Principal, administrator = false) {
  const current = currentPrincipal(t, principal), owner = t.db.get<string | null>('owner_account', null);
  if (!owner || !current || current.kind === 'producer' || current.kind === 'page' && (current.role === 'display' || !current.accountId)) {
    throw new HttpError(403, 'forbidden', 'Membership requires an authenticated page account or owner agent');
  }
  const accountId = current.kind === 'agent' ? owner : current.accountId!;
  const mayAdminister = current.kind === 'agent' || current.role === 'owner' && accountId === owner;
  if (administrator && !mayAdminister) throw new HttpError(403, 'forbidden', 'Only the owner or an authorized owner agent can administer membership');
  return { accountId, administrator: mayAdminister, requestPrefix: `account:${accountId}:` };
}

function residentAdministrator(t: Tendril, principal: Principal): void {
  identity(t, principal, true);
  if (!hasResidentStorage(t))
    throw new HttpError(409, 'resident_required', 'A durable membership administrator requires an owned resident page');
}

function configuration(t: Tendril): MembershipConfiguration {
  const value = t.db.get<MembershipConfiguration | null>('membership_configuration', null);
  if (!value) throw new HttpError(409, 'membership_unconfigured', 'Configure the native authority and execution profile first');
  return value;
}

async function provisioned(t: Tendril, input = configuration(t), store = host(t).store) {
  return provisionMembership({ store, executionManifestDigest: decodeBytes(input.executionManifestDigest, 32),
    schemaAdministratorPublicKey: decodeBytes(input.schemaAdministratorPublicKey, 32),
    nativeAuthority: { historyId: input.nativeAuthority.historyId, publicKey: decodeBytes(input.nativeAuthority.publicKey, 32) },
    initialCapabilities: (input.initialMembers ?? []).flatMap(member => {
      const signingPublicKey = decodeBytes(member.signingPublicKey, 32);
      const common = { subjectId: signingPublicKey, signingPublicKey, transportAuthor: member.transportAuthor, validFromRevision: 0n };
      return [{ ...common, role: 'reader' as const, hpkePublicKey: decodeBytes(member.readerPublicKey, 32) },
        ...(member.writerProgram ? [{ ...common, role: 'writer' as const, program: member.writerProgram }] : [])];
    }), now: () => t.now() });
}

async function administrator(t: Tendril): Promise<MembershipAdministrator> {
  const state = host(t);
  if (!state.administrator) {
    const pending = (async () => {
      const value = await provisioned(t), config = configuration(t);
      const ledger = createMembershipLedgerClient({ url: config.nativeAuthority.url, ...value, now: () => t.now(),
        fetch: (url, input) => fetch(url, { ...input, signal: input?.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) }) });
      return MembershipAdministrator.open({ ...value, store: state.store, ledger });
    })();
    state.administrator = pending;
    void pending.catch(() => { if (state.administrator === pending) state.administrator = undefined; });
  }
  return state.administrator;
}

function publicRequest(t: Tendril, row: RequestRow): MemberRequest {
  const request = decodeSignedEnrollmentRequest(decodeBytes(row.request)).request;
  const approval = row.approval ? decodeSignedEnrollmentApproval(decodeBytes(row.approval)).approval : null;
  const capabilityIds = approval?.capabilityIds.map(encodeBytes) ?? [], revokedCapabilityIds = JSON.parse(row.revoked) as string[];
  const pending = t.db.one("SELECT 1 FROM membership_actions WHERE kind='approve' AND state='pending' AND json_extract(payload,'$.requestId')=?", row.id);
  return { id: row.id, accountId: row.account_id, signingPublicKey: encodeBytes(request.signingPublicKey),
    readerPublicKey: encodeBytes(request.readerPublicKey), transportAuthor: request.transportAuthor,
    requestId: request.requestId, requestedRoles: [...request.requestedRoles],
    ...(request.writerProgram ? { writerProgram: { ...request.writerProgram, topics: [...request.writerProgram.topics], signals: [...request.writerProgram.signals] } } : {}),
    status: approval ? capabilityIds.every(id => revokedCapabilityIds.includes(id)) ? 'revoked' : 'approved' : pending ? 'approving' : 'requested',
    createdAt: row.created_at, ...(row.approval ? { signedApproval: row.approval } : {}), capabilityIds, revokedCapabilityIds };
}

function requestRow(t: Tendril, id: unknown): RequestRow {
  if (typeof id !== 'string' || !/^r_[0-9a-f]{64}$/.test(id)) throw new HttpError(400, 'bad_request', 'Invalid member request identity');
  const row = t.db.one<RequestRow>('SELECT * FROM membership_requests WHERE id=?', id);
  if (!row) throw new HttpError(404, 'not_found', 'No such member request');
  return row;
}

function publicDescriptor(descriptor: EnrollmentDescriptor) {
  return { genesis: encodeBytes(encodeSignedGenesis(descriptor.genesis)), groupRoute: encodeBytes(descriptor.groupRoute) };
}

async function info(t: Tendril, principal: Principal): Promise<MembershipInfo> {
  const configured = t.db.get<MembershipConfiguration | null>('membership_configuration', null);
  const descriptor = configured ? publicDescriptor((await provisioned(t, configured)).descriptor) : null;
  // Capture the disclosure scope after asynchronous key/descriptor verification.
  const who = identity(t, principal);
  const rows = who.administrator ? t.db.all<RequestRow>('SELECT * FROM membership_requests ORDER BY created_at,id')
    : t.db.all<RequestRow>('SELECT * FROM membership_requests WHERE account_id=? ORDER BY created_at,id', who.accountId);
  return { descriptor,
    identity: who, requests: rows.map(row => publicRequest(t, row)), progress: t.db.get('membership_progress', null),
    pendingActions: t.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM membership_actions WHERE state='pending'")!.count };
}

function rememberProgress(t: Tendril, value: MembershipAdministrator) {
  const { verifiedThrough, root, receiptThrough, checkpointThrough, closedThroughMs } = value.progress;
  t.db.set('membership_progress', { verifiedThrough, root, receiptThrough, checkpointThrough, closedThroughMs: String(closedThroughMs) });
}

function approvedReader(t: Tendril, accountId: string, value?: MembershipAdministrator): boolean {
  return t.db.all<RequestRow>('SELECT * FROM membership_requests WHERE account_id=? AND approval IS NOT NULL', accountId).some(row => {
    const approval = decodeSignedEnrollmentApproval(decodeBytes(row.approval!)).approval, revoked = JSON.parse(row.revoked) as string[];
    return approval.capabilityIds.some((id, index) => {
      if (approval.roles[index] !== 'reader' || revoked.includes(encodeBytes(id))) return false;
      if (!value) return true;
      const key = [...id].map(byte => byte.toString(16).padStart(2, '0')).join(''), snapshot = value.snapshot;
      const capability = snapshot.capabilities.get(key);
      return capability?.grant.role === 'reader' && capability.grantedAtRevision <= snapshot.revision && capability.revokedAtRevision === undefined;
    });
  });
}

async function perform(t: Tendril, value: MembershipAdministrator, action: ActionRow): Promise<unknown> {
  if (action.state === 'done') return JSON.parse(action.result!);
  if (action.state === 'rejected') throw new HttpError(409, 'membership_rejected', action.error!);
  const input = JSON.parse(action.payload);
  try {
    let result: unknown;
    if (action.kind === 'approve') {
      const row = requestRow(t, input.requestId);
      const signed = await value.approve(decodeSignedEnrollmentRequest(decodeBytes(row.request)), {
        operationId: action.id, roles: input.roles, grantFullHistory: input.grantFullHistory,
        ...(input.writerProgram ? { writerProgram: input.writerProgram } : {}) });
      t.transaction(() => {
        t.db.run('UPDATE membership_requests SET approval=? WHERE id=?', encodeBytes(encodeSignedEnrollmentApproval(signed)), row.id);
        rememberProgress(t, value);
      });
      result = publicRequest(t, requestRow(t, row.id));
    } else {
      const revoked = await value.revoke({ operationId: action.id, capabilityIds: input.capabilityIds.map((id: string) => decodeBytes(id, 32)) });
      t.transaction(() => {
        for (const row of t.db.all<RequestRow>('SELECT * FROM membership_requests WHERE approval IS NOT NULL')) {
          const ids = decodeSignedEnrollmentApproval(decodeBytes(row.approval!)).approval.capabilityIds.map(encodeBytes);
          const previous = JSON.parse(row.revoked) as string[];
          const next = [...new Set([...previous, ...input.capabilityIds.filter((id: string) => ids.includes(id))])].sort();
          if (next.length !== previous.length) t.db.run('UPDATE membership_requests SET revoked=? WHERE id=?', JSON.stringify(next), row.id);
        }
        rememberProgress(t, value);
      });
      result = { membershipRevision: encodeBytes(revoked.membershipRevision), epoch: String(revoked.epoch), frontier: encodeBytes(revoked.target.frontier) };
    }
    t.db.run("UPDATE membership_actions SET state='done',result=?,error=NULL WHERE id=?", JSON.stringify(result), action.id);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^(ENROLLMENT_REQUEST_UNAUTHORIZED|ENROLLMENT_DECISION_CONFLICT|OPERATION_ID_CONFLICT|MEMBERSHIP_REVOCATION_INVALID)$/.test(message)) {
      t.db.run("UPDATE membership_actions SET state='rejected',error=? WHERE id=?", message, action.id);
      throw new HttpError(409, 'membership_rejected', message);
    }
    // A cancelled/unavailable append is a pending durable decision, never a domain rejection.
    throw error;
  }
}

function stage(t: Tendril, principal: Principal, kind: ActionRow['kind'], input: Record<string, unknown>): ActionRow {
  const id = operationId(input.operationId), payload = JSON.stringify(input);
  return t.transaction(() => {
    identity(t, principal, true);
    const prior = t.db.one<ActionRow>('SELECT * FROM membership_actions WHERE id=?', id);
    if (prior) {
      if (prior.kind !== kind || prior.payload !== payload) throw new HttpError(409, 'operation_conflict', 'The original membership decision has different contents');
      return prior;
    }
    if (t.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM membership_actions')!.count >= LIMITS.actions)
      throw new HttpError(429, 'membership_quota', 'The retained membership decision budget is full');
    t.db.run("INSERT INTO membership_actions(id,kind,payload,state,result,error) VALUES(?,?,?,'pending',NULL,NULL)", id, kind, payload);
    return t.db.one<ActionRow>('SELECT * FROM membership_actions WHERE id=?', id)!;
  });
}

async function resume(t: Tendril, value: MembershipAdministrator) {
  for (const action of t.db.all<ActionRow>("SELECT * FROM membership_actions WHERE state='pending' ORDER BY rowid LIMIT 16")) {
    try { await perform(t, value, action); }
    catch (error) { if (!(error instanceof HttpError) || error.code !== 'membership_rejected') throw error; }
  }
}

export async function handleMembership(t: Tendril, req: Request, url: URL, path: string, principal: Principal): Promise<Response> {
  identity(t, principal);
  if (selectedApplication(t).kind !== 'peer') throw new HttpError(409, 'application_backend', 'Membership belongs to this page\'s selected peer application');
  // Read untrusted client bytes before joining the shared administrator queue.
  // A paused upload cannot block roster reads, approvals or revocation. Every
  // authority check is repeated after the body arrives and the queue advances.
  const bodyLimit = path === 'members' && req.method === 'PUT' ? 256 * 1024
    : path === 'members/requests' && req.method === 'POST' ? 512 * 1024
      : (path === 'members/approve' || path === 'members/revoke') && req.method === 'POST' ? 32 * 1024 : null;
  if (bodyLimit !== null && path !== 'members/requests') identity(t, principal, true);
  const inputBody = bodyLimit === null ? undefined : await readJson(req, bodyLimit);
  return serial(t, async () => {
    identity(t, principal);
    if (selectedApplication(t).kind !== 'peer') throw new HttpError(409, 'application_backend', 'Membership belongs to this page\'s selected peer application');
    try {
      if (path === 'members' && req.method === 'GET') return json(await info(t, principal));
      if (path === 'members' && req.method === 'PUT') {
        residentAdministrator(t, principal);
        const input = parseConfiguration(inputBody), state = host(t);
        const previous = t.db.get<MembershipConfiguration | null>('membership_configuration', null);
        if (previous && JSON.stringify(previous) !== JSON.stringify(input)) throw new HttpError(409, 'membership_configuration_conflict', 'The membership group and native authority are immutable for this page');
        await provisioned(t, input, { get: key => state.store.get(key), put: async (key, bytes) => {
          residentAdministrator(t, principal); await state.store.put(key, bytes);
        } });
        t.transaction(() => { residentAdministrator(t, principal); t.db.set('membership_configuration', input); });
        return json(await info(t, principal));
      }
      if (path === 'members/requests' && req.method === 'POST') {
        const body = inputBody;
        if (!isPlainObject(body) || Object.keys(body).join(',') !== 'signedRequest') throw new HttpError(400, 'bad_request', 'Expected one signed enrollment request');
        const bytes = decodeBytes(body.signedRequest);
        let signed: SignedEnrollmentRequest;
        try { signed = decodeSignedEnrollmentRequest(bytes); }
        catch { throw new HttpError(400, 'membership_request_invalid', 'The enrollment request is not canonical signed enrollment bytes'); }
        let verified = false;
        try { verified = await verifySignedEnrollmentRequest(signed); } catch { /* Malformed public signing keys are unauthorized. */ }
        const value = await provisioned(t), who = identity(t, principal);
        if (!signed.request.requestId.startsWith(who.requestPrefix) || signed.request.requestId.length === who.requestPrefix.length ||
            encodeBytes(signed.request.groupId) !== encodeBytes(value.descriptor.history.groupId) ||
            encodeBytes(signed.request.genesisDigest) !== encodeBytes(value.descriptor.history.genesisDigest) ||
            encodeBytes(signed.request.executionManifestDigest) !== encodeBytes(value.descriptor.history.executionManifestDigest) ||
            !verified) throw new HttpError(403, 'membership_request_identity', 'Sign the request for this authenticated account and group');
        const id = 'r_' + await sha256Hex(bytes);
        t.transaction(() => {
          const current = identity(t, principal);
          if (current.accountId !== who.accountId) throw new HttpError(403, 'forbidden');
          const prior = t.db.one<RequestRow>('SELECT * FROM membership_requests WHERE id=?', id);
          if (prior) {
            if (prior.account_id !== who.accountId || prior.request !== body.signedRequest) throw new HttpError(409, 'membership_request_conflict');
          } else {
            if (t.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM membership_requests')!.count >= LIMITS.requests) throw new HttpError(429, 'membership_quota', 'The retained membership request budget is full');
            t.db.run("INSERT INTO membership_requests(id,account_id,request,created_at,approval,revoked) VALUES(?,?,?,?,NULL,'[]')", id, who.accountId, body.signedRequest, t.now());
          }
        });
        return json(publicRequest(t, requestRow(t, id)));
      }
      const match = /^members\/requests\/(r_[0-9a-f]{64})$/.exec(path);
      if (match && req.method === 'GET') {
        const row = requestRow(t, match[1]), who = identity(t, principal);
        if (!who.administrator && row.account_id !== who.accountId) throw new HttpError(403, 'forbidden');
        return json(publicRequest(t, row));
      }
      if (path === 'members/approve' && req.method === 'POST') {
        identity(t, principal, true);
        const input = parseApproval(inputBody); requestRow(t, input.requestId);
        const action = stage(t, principal, 'approve', { ...input });
        return json(await perform(t, await administrator(t), action));
      }
      if (path === 'members/revoke' && req.method === 'POST') {
        identity(t, principal, true);
        const body = inputBody;
        if (!isPlainObject(body) || Object.keys(body).sort().join(',') !== 'capabilityIds,operationId' || !Array.isArray(body.capabilityIds) ||
            !body.capabilityIds.length || body.capabilityIds.length > 128) throw new HttpError(400, 'bad_request', 'Expected stable operationId and bounded capabilityIds');
        const capabilityIds = [...new Set(body.capabilityIds.map((id: unknown) => encodeBytes(decodeBytes(id, 32))))].sort();
        const action = stage(t, principal, 'revoke', { operationId: operationId(body.operationId), capabilityIds });
        return json(await perform(t, await administrator(t), action));
      }
      if (path === 'members/sync' && req.method === 'POST') {
        const value = await administrator(t); await resume(t, value); await value.sync(); rememberProgress(t, value);
        identity(t, principal); return json(await info(t, principal));
      }
      if (path === 'members/history' && req.method === 'GET') {
        const who = identity(t, principal);
        if (!who.administrator && !approvedReader(t, who.accountId)) {
          throw new HttpError(403, 'membership_approval_required', 'Approve this account\'s device before reading group history descriptors');
        }
        const after = integer(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER), limit = integer(url.searchParams.get('limit') ?? '128', 1, 128);
        const value = await administrator(t); await value.sync(); rememberProgress(t, value);
        const current = identity(t, principal);
        if (!current.administrator && !approvedReader(t, current.accountId, value)) throw new HttpError(403, 'membership_reader_revoked', 'This account has no active approved reader grant');
        if (after > value.progress.verifiedThrough) throw new HttpError(409, 'membership_cursor_ahead', 'The requested position is beyond the verified native prefix');
        return new Response(encodeMembershipLedgerResponse(value.read({ after, limit })).slice().buffer,
          { headers: { 'Content-Type': 'application/cbor', 'Cache-Control': 'no-store' } });
      }
      throw new HttpError(404, 'not_found', 'Unknown membership operation');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/^(MEMBERSHIP_CONFIGURATION|MEMBERSHIP_INITIAL|MEMBERSHIP_ROOT|MEMBERSHIP_URL|ENROLLMENT_|PROGRAM_RIGHTS|PROTOCOL_|SCHEMA_)/.test(message)) {
        throw new HttpError(400, 'invalid_membership', message);
      }
      throw new HttpError(503, 'membership_pending', 'Membership progress is waiting for its native authority; retry the same operation identity');
    }
  });
}

function parseConfiguration(value: unknown): MembershipConfiguration {
  if (!isPlainObject(value) || Object.keys(value).some(key => !['executionManifestDigest', 'schemaAdministratorPublicKey', 'nativeAuthority', 'initialMembers'].includes(key)) ||
      !isPlainObject(value.nativeAuthority) || Object.keys(value.nativeAuthority).sort().join(',') !== 'historyId,publicKey,url') throw new HttpError(400, 'bad_request', 'Expected the native authority and execution profile');
  const native = value.nativeAuthority;
  let url: URL; try { url = new URL(native.url); } catch { throw new HttpError(400, 'bad_request', 'Invalid native membership endpoint'); }
  if (url.username || url.password || url.hash || url.search || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
      !/^h_[0-9a-f]{32}$/.test(native.historyId)) throw new HttpError(400, 'bad_request', 'Pin a native HTTPS endpoint, history and authority key');
  if (value.initialMembers !== undefined && (!Array.isArray(value.initialMembers) || value.initialMembers.length > 128)) throw new HttpError(400, 'bad_request', 'Initial public members exceed their bound');
  return { executionManifestDigest: encodeBytes(decodeBytes(value.executionManifestDigest, 32)),
    schemaAdministratorPublicKey: encodeBytes(decodeBytes(value.schemaAdministratorPublicKey, 32)),
    nativeAuthority: { url: url.href, historyId: native.historyId, publicKey: encodeBytes(decodeBytes(native.publicKey, 32)) },
    initialMembers: (value.initialMembers ?? []).map((member: unknown) => {
      if (!isPlainObject(member) || Object.keys(member).some(key => !['signingPublicKey', 'readerPublicKey', 'transportAuthor', 'writerProgram'].includes(key)) ||
          typeof member.transportAuthor !== 'string' || !member.transportAuthor || member.transportAuthor.length > 512) throw new HttpError(400, 'bad_request', 'Invalid initial member public identity');
      return { signingPublicKey: encodeBytes(decodeBytes(member.signingPublicKey, 32)), readerPublicKey: encodeBytes(decodeBytes(member.readerPublicKey, 32)),
        transportAuthor: member.transportAuthor, ...(member.writerProgram === undefined ? {} : { writerProgram: program(member.writerProgram) }) };
    }) };
}

function parseApproval(value: unknown): MemberApproval {
  if (!isPlainObject(value) || Object.keys(value).some(key => !['operationId', 'requestId', 'roles', 'grantFullHistory', 'writerProgram'].includes(key)) ||
      typeof value.requestId !== 'string' || !/^r_[0-9a-f]{64}$/.test(value.requestId) || !Array.isArray(value.roles) ||
      !value.roles.length || value.roles.length > 2 || value.roles.some(role => !['reader', 'writer'].includes(role)) ||
      typeof value.grantFullHistory !== 'boolean') throw new HttpError(400, 'bad_request', 'Expected one explicit membership approval');
  if (value.roles.includes('writer') !== (value.writerProgram !== undefined))
    throw new HttpError(400, 'bad_request', 'Writer approval requires explicit SQL, event and signal rights; reader-only approval cannot carry them');
  return { operationId: operationId(value.operationId), requestId: value.requestId, roles: [...new Set(value.roles)].sort() as MemberApproval['roles'],
    grantFullHistory: value.grantFullHistory, ...(value.writerProgram === undefined ? {} : { writerProgram: program(value.writerProgram) }) };
}

function program(value: unknown): MemberProgram {
  if (!isPlainObject(value) || typeof value.sql !== 'boolean' || value.forwarded !== undefined && typeof value.forwarded !== 'boolean' ||
      Object.keys(value).some(key => !['sql', 'topics', 'signals', 'forwarded'].includes(key))) throw new HttpError(400, 'bad_request', 'Invalid writer rights');
  const topics = (items: unknown): string[] => {
    if (!Array.isArray(items) || items.length > 128 || items.some(item => typeof item !== 'string' || item !== '*' && !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(item))) throw new HttpError(400, 'bad_request', 'Invalid writer topics');
    return [...new Set(items)].sort();
  };
  return { sql: value.sql, topics: topics(value.topics), signals: topics(value.signals), forwarded: value.forwarded ?? false };
}

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new HttpError(400, 'bad_request', 'A stable operationId is required');
  return value;
}
function integer(value: string | null, min: number, max: number): number {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new HttpError(400, 'bad_request', 'Expected an explicit integer cursor');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new HttpError(400, 'bad_request', 'Membership range exceeds its bound');
  return result;
}
function decodeBytes(value: unknown, length?: number): Uint8Array {
  if (typeof value !== 'string' || value.length > 400_000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, 'bad_request', 'Expected canonical base64url bytes');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)); }
  catch { throw new HttpError(400, 'bad_request', 'Invalid base64url bytes'); }
  if (encodeBytes(bytes) !== value || length !== undefined && bytes.length !== length) throw new HttpError(400, 'bad_request', 'Unexpected byte identity');
  return bytes;
}
function encodeBytes(bytes: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
