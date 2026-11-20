import type { Env } from './env';
import type { Principal } from './assistant-shared';
import { assistantOAuth, fields, requireScope, string } from './assistant-shared';
import { activeGrant, ensureOAuthSchema, scopesOf } from './accounts/oauth-data';
import { inspectAccessToken } from './accounts/oauth-tokens';
import { HttpError, json, readJson } from './http';
import { sha256Hex } from './ids';
import { checkCreationIp, requireCreationOpen } from './service-state';
import { publicBase } from './urls';
import { setupCredentialActive } from './setup-credential';
import { setupRequest, setupRequestDigest, type SetupRequest, type SetupResult } from '../../contract/setup.mjs';

export interface SetupRow {
  service_origin: string; account_id: string; client_id: string; operation_id: string; request_digest: string;
  credential_commitment: string; grant_id: string; intended_email: string; page_id: string; application_id: string;
  request_json: string; creator_ip: string; creation_day: string; state: SetupResult['state']; indexed: number;
  initialization_started: number; created_at: number; expires_at: number; updated_at: number; failure_code: string | null;
}
type Allocation = Pick<SetupRow, 'service_origin' | 'account_id' | 'client_id' | 'operation_id' | 'request_digest' |
  'credential_commitment' | 'grant_id' | 'intended_email' | 'page_id' | 'application_id' | 'creator_ip' | 'creation_day' | 'created_at' | 'expires_at'>;
type ResultRow = Allocation & Partial<Pick<SetupRow, 'state' | 'failure_code'>>;
const DAY = 86_400_000;
const OPERATION = /^[A-Za-z0-9_.:-]{1,160}$/;
const HASH = /^[a-f0-9]{64}$/;
const namespace = (origin: string, principal: Principal, operationId: string) => [origin, principal.account, principal.client, operationId];
const query = 'service_origin=? AND account_id=? AND client_id=? AND operation_id=?';

/** Stable in the authenticated namespace, never derived from mutable display or token values. */
export async function accountSetupPageId(origin: string, account: string, client: string, operationId: string): Promise<string> {
  const hash = await sha256Hex(JSON.stringify(['tendriller/account-setup/page/v1', origin, account, client, operationId]));
  let bits = BigInt('0x' + hash.slice(0,15)), id = '';
  for (let i=0; i<12; i++) { id = 'abcdefghijklmnopqrstuvwxyz234567'[Number(bits & 31n)] + id; bits >>= 5n; }
  return id;
}

/** No runtime table creation or interpretation of an older/different journal. */
export async function requireSetupSchema(env: Env): Promise<void> {
  try {
    const identity = await env.ACCOUNTS.prepare('SELECT id,revision FROM account_setup_schema').all<{ id: number; revision: number }>();
    if (identity.results.length !== 1 || identity.results[0].id !== 1 || identity.results[0].revision !== 3) throw new Error('revision');
    const names = await env.ACCOUNTS.prepare('PRAGMA table_info(account_setups)').all<{ name: string; type: string }>();
    const expected = ['service_origin','account_id','client_id','operation_id','request_digest','credential_commitment','grant_id','intended_email',
      'page_id','application_id','request_json','creator_ip','creation_day','state','indexed','initialization_started','created_at','expires_at','updated_at','failure_code'];
    if (names.results.length !== expected.length || expected.some((name, index) => names.results[index]?.name !== name)) throw new Error('shape');
    const fences = await env.ACCOUNTS.prepare('PRAGMA table_info(account_setup_allocations)').all<{ name: string }>();
    const fenceNames = ['service_origin','account_id','client_id','operation_id','request_digest','credential_commitment','grant_id','intended_email',
      'page_id','application_id','creator_ip','creation_day','created_at','expires_at'];
    if (fences.results.length !== fenceNames.length || fenceNames.some((name, index) => fences.results[index]?.name !== name)) throw new Error('allocation shape');
    const guards = await env.ACCOUNTS.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('account_setup_capacity','account_setup_charge')").first<{ n: number }>();
    if (guards?.n !== 2) throw new Error('guards');
  } catch { throw new HttpError(503, 'setup_storage_unavailable', 'Apply required account migrations 0004_account_setup.sql and 0005_account_setup_recovery.sql to compatible storage before account-bound setup.'); }
}

export async function requireSetupPrincipal(env: Env, principal: Principal): Promise<void> {
  requireScope(principal, 'tendrils:create');
  const config = await assistantOAuth(env);
  const grant = config && await activeGrant(env, config, principal.grant, principal.account);
  if (!grant || grant.client_id !== principal.client || !scopesOf(grant).includes('tendrils:create') || principal.expires <= Date.now())
    throw new HttpError(401, 'invalid_token', 'Account setup requires a current configured OAuth grant with tendrils:create.');
}
export async function readSetupRow(env: Env, pageId: string): Promise<SetupRow | null> {
  await requireSetupSchema(env);
  const row = await env.ACCOUNTS.prepare('SELECT * FROM account_setups WHERE page_id=?').bind(pageId).first<SetupRow>();
  if (row) await rowIntegrity(env, row);
  return row;
}
async function verifiedEmail(env: Env, account: string): Promise<string> {
  const rows = await env.ACCOUNTS.prepare(`SELECT DISTINCT lower(e.email) AS email, lower(a.email) AS display_email
    FROM accounts a JOIN identities i ON i.account_id=a.id JOIN identity_emails e ON e.provider=i.provider AND e.subject=i.subject
    WHERE a.id=? AND a.suspended_at IS NULL AND a.deleting_at IS NULL ORDER BY email LIMIT 100`).bind(account)
    .all<{ email: string; display_email: string | null }>();
  const emails = rows.results.filter(row => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) && row.email.length <= 254);
  const selected = emails.find(row => row.email === row.display_email) ?? emails[0];
  if (!selected) throw new HttpError(403, 'owner_verification_required', 'Verify an email on this linked account before preparing a page. No page or quota was allocated.');
  return selected.email;
}
async function rowIntegrity(env: Env, row: SetupRow): Promise<SetupRequest> {
  try {
    const input = setupRequest(JSON.parse(row.request_json));
    if (input.operationId !== row.operation_id || input.applicationId !== row.application_id || input.credentialCommitment !== row.credential_commitment ||
        await setupRequestDigest(row.service_origin, input) !== row.request_digest || !/^[a-z2-7]{12}$/.test(row.page_id) ||
        !HASH.test(row.credential_commitment) || !Number.isSafeInteger(row.expires_at) || row.expires_at <= row.created_at) throw new Error('mismatch');
    const fence = await env.ACCOUNTS.prepare('SELECT * FROM account_setup_allocations WHERE page_id=?').bind(row.page_id).first<Allocation>();
    if (!fence || (Object.keys(fence) as (keyof Allocation)[]).some(key => fence[key] !== row[key])) throw new Error('allocation mismatch');
    return input;
  } catch { throw new HttpError(409, 'reconciliation_required', 'The retained setup journal is corrupt. Preserve its page and original local credential for operator reconciliation.'); }
}
function result(row: ResultRow, state: SetupResult['state'] = row.state ?? 'reconciliation_required', code: string | null = row.failure_code ?? null, page?: SetupResult['page']): SetupResult {
  return { schemaVersion: 1, serviceOrigin: row.service_origin, operationId: row.operation_id, requestDigest: row.request_digest,
    credentialCommitment: row.credential_commitment, state, code, pageId: row.page_id, applicationId: row.application_id, expiresAt: row.expires_at,
    nextAction: state === 'ready' ? 'Combine this receipt with the original locally retained credential, prepare the signed app, and let the intended owner sign in. Browser enrollment and assistant consent remain separate. If the local credential was lost, inspect this page and use the authenticated owner’s reviewed delegation route; this service cannot reconstruct the secret from its commitment.'
      : state === 'expired' ? 'This setup credential expired. The operation ID remains reserved. Use the owner’s reviewed adoption/delegation route if claimed; otherwise allow the unclaimed page to expire.'
      : state === 'reconciliation_required' ? 'Preserve the original operation, page and private credential. Inspect or ask the operator to reconcile this allocation; do not create a replacement page or credential.'
      : state === 'blocked' ? 'Resolve the reported readiness, account, grant or capacity condition on this service, then inspect or retry the same operation and credential commitment.'
      : 'Inspect or retry the same operation with its original input and credential commitment. Preparation is not a connected application.', ...(page ? { page } : {}) };
}
async function pageRequest(env: Env, row: SetupRow, action: 'inspect' | 'reserve' | 'initialize') {
  const response = await env.TENDRIL.get(env.TENDRIL.idFromName(row.page_id)).fetch(new Request('https://tendril.internal/setup/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tendril-id': row.page_id },
    body: JSON.stringify({ requestDigest: row.request_digest }),
  }));
  const body = await response.json<{ page?: SetupResult['page']; missing?: boolean; credentialActive?: boolean; error?: { code: string; message: string } }>();
  if (!response.ok) throw new HttpError(response.status, body.error?.code ?? 'reconciliation_required', body.error?.message);
  if (body.page && (body.page.id !== row.page_id || body.page.application?.id !== row.application_id ||
      body.page.api !== row.service_origin + '/api/t/' + row.page_id || 'token' in body.page)) throw new HttpError(409, 'reconciliation_required');
  return body;
}
async function inspectRow(env: Env, row: SetupRow): Promise<SetupResult> {
  await rowIntegrity(env, row);
  if (row.expires_at <= Date.now()) return result(row, 'expired', 'setup_expired');
  if (row.indexed) {
    const indexed = await env.ACCOUNTS.prepare('SELECT state FROM tendrils WHERE id=?').bind(row.page_id).first<{ state: string }>();
    if (!indexed || indexed.state !== 'active') return result(row, 'reconciliation_required', indexed ? 'setup_page_unavailable' : 'setup_page_deleted');
    try {
      const inspected = await pageRequest(env, row, 'inspect');
      if (inspected.page) return inspected.credentialActive === false || !await setupCredentialActive(env, row)
        ? result(row, 'blocked', 'setup_binding_inactive', inspected.page) : result(row, 'ready', null, inspected.page);
      if (row.state === 'ready') return result(row, 'reconciliation_required', 'setup_page_state_missing');
    } catch (error) {
      if (error instanceof HttpError && error.code === 'reconciliation_required') return result(row, 'reconciliation_required', error.code);
      if (error instanceof HttpError && error.code === 'setup_expired') return result(row, 'expired', error.code);
      return result(row, 'provisioning', 'setup_inspection_unavailable');
    }
  }
  return result(row);
}

export async function inspectTendrilSetup(env: Env, principal: Principal, operationId: unknown): Promise<SetupResult> {
  await requireSetupPrincipal(env, principal); await requireSetupSchema(env);
  const op = string(operationId, 160, OPERATION);
  const row = await env.ACCOUNTS.prepare('SELECT * FROM account_setups WHERE ' + query).bind(...namespace(publicBase(env), principal, op)).first<SetupRow>();
  if (!row) {
    const allocation = await env.ACCOUNTS.prepare('SELECT * FROM account_setup_allocations WHERE ' + query).bind(...namespace(publicBase(env), principal, op)).first<Allocation>();
    if (allocation) {
      await requireSetupPrincipal(env, principal);
      return result(allocation, 'reconciliation_required', 'setup_journal_missing');
    }
    throw new HttpError(404, 'setup_not_found', 'No setup with this operation ID belongs to this linked account and OAuth client.');
  }
  const inspected = await inspectRow(env, row);
  await requireSetupPrincipal(env, principal);
  return inspected;
}
export async function listTendrilSetups(env: Env, principal: Principal) {
  await requireSetupPrincipal(env, principal); await requireSetupSchema(env);
  const rows = await env.ACCOUNTS.prepare(`SELECT a.*,s.state,s.failure_code FROM account_setup_allocations a LEFT JOIN account_setups s ON s.page_id=a.page_id
    WHERE a.service_origin=? AND a.account_id=? AND a.client_id=? ORDER BY a.created_at DESC LIMIT 100`)
    .bind(publicBase(env), principal.account, principal.client).all<ResultRow>();
  // The bounded account view does not wake every page; inspect an exact operation to reconcile it.
  await requireSetupPrincipal(env, principal);
  return { serviceOrigin: publicBase(env), setups: rows.results.map(row => !row.state ? result(row, 'reconciliation_required', 'setup_journal_missing')
    : result(row, row.expires_at <= Date.now() ? 'expired' : row.state)) };
}
export async function prepareTendrilSetup(env: Env, principal: Principal, raw: unknown, req: Request): Promise<SetupResult> {
  await requireSetupPrincipal(env, principal); await requireSetupSchema(env);
  const args = fields(raw, ['operationId', 'name', 'mode', 'applicationId', 'credentialCommitment'], ['operationId', 'applicationId', 'credentialCommitment']);
  let input: SetupRequest;
  try { input = setupRequest(args as unknown as SetupRequest); }
  catch { throw new HttpError(400, 'invalid_setup_request'); }
  const origin = publicBase(env), digest = await setupRequestDigest(origin, input), key = namespace(origin, principal, input.operationId);
  let row = await env.ACCOUNTS.prepare('SELECT * FROM account_setups WHERE ' + query).bind(...key).first<SetupRow>();
  allocate: if (!row) {
    const allocation = await env.ACCOUNTS.prepare('SELECT * FROM account_setup_allocations WHERE ' + query).bind(...key).first<Allocation>();
    if (allocation) {
      // A concurrent exact call may have completed allocation since the first read.
      row = await env.ACCOUNTS.prepare('SELECT * FROM account_setups WHERE ' + query).bind(...key).first<SetupRow>();
      if (row) break allocate;
      if (allocation.request_digest !== digest || allocation.credential_commitment !== input.credentialCommitment)
        throw new HttpError(409, 'setup_operation_conflict', 'The original allocation still reserves this operation and its exact request.');
      await requireSetupPrincipal(env, principal);
      return result(allocation, 'reconciliation_required', 'setup_journal_missing');
    }
    await requireCreationOpen(env);
    const email = await verifiedEmail(env, principal.account), { ip, day } = await checkCreationIp(env, req);
    if (env.CREATE_RATE && !(await env.CREATE_RATE.limit({ key: ip })).success) throw new HttpError(429, 'rate_limited');
    const now = Date.now();
    await requireSetupPrincipal(env, principal);
    const pageId = await accountSetupPageId(origin,principal.account,principal.client,input.operationId);
    const probe = await env.TENDRIL.get(env.TENDRIL.idFromName(pageId)).fetch(new Request('https://tendril.internal/setup/allocation', {
      method:'POST',headers:{'Content-Type':'application/json','x-tendril-id':pageId},
      body:JSON.stringify({requestDigest:digest,accountId:principal.account,clientId:principal.client,serviceOrigin:origin}),
    }));
    const existing = await probe.json<{occupied?:boolean;matches?:boolean}>();
    if (!probe.ok || existing.occupied !== false) {
      row = await env.ACCOUNTS.prepare('SELECT * FROM account_setups WHERE ' + query).bind(...key).first<SetupRow>();
      if (row) break allocate;
      throw new HttpError(409,'reconciliation_required',existing.matches ? 'The original page exists without its allocation journal. Preserve it for reconciliation.' : 'The allocated page identity is occupied or cannot be verified. No replacement was created.');
    }
    const admissionProbe = await env.ADMISSION.get(env.ADMISSION.idFromName('global')).fetch(new Request('https://admission.internal/status',{
      headers:{'x-tendril-id':pageId},
    }));
    const admissionState = await admissionProbe.json<{state?:string}>();
    if (!admissionProbe.ok || admissionState.state !== 'absent') {
      row = await env.ACCOUNTS.prepare('SELECT * FROM account_setups WHERE ' + query).bind(...key).first<SetupRow>();
      if (row) break allocate;
      throw new HttpError(409,'reconciliation_required','The page has retained admission evidence without its setup journal. Do not reserve or recreate it.');
    }
    try {
      await env.ACCOUNTS.prepare(`INSERT OR IGNORE INTO account_setups(service_origin,account_id,client_id,operation_id,request_digest,
        credential_commitment,grant_id,intended_email,page_id,application_id,request_json,creator_ip,creation_day,state,created_at,expires_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)`)
        .bind(...key, digest, input.credentialCommitment, principal.grant, email, pageId, input.applicationId, JSON.stringify(input), ip, day, now, now + DAY, now).run();
    } catch (error) {
      const code = ['setup_ledger_full','setup_pending_full','setup_account_full','setup_creation_rate_limited','setup_binding_inactive','owner_verification_required','creation_paused','reconciliation_required'].find(code => String(error).includes(code));
      if (String(error).includes('setup_journal_missing') || String(error).includes('setup_allocation_conflict'))
        throw new HttpError(409,'reconciliation_required','This allocation has retained or conflicting evidence. No replacement page or quota charge was created.');
      if (code === 'reconciliation_required') throw new HttpError(409, code, 'The original allocation is retained but its operation journal is missing. Inspect it without creating a replacement.');
      if (code) throw new HttpError(code==='creation_paused'?503:['setup_binding_inactive','owner_verification_required'].includes(code)?403:429, code,
        ['setup_binding_inactive','owner_verification_required','creation_paused'].includes(code)
          ? 'Setup authorization, verification or readiness changed before allocation. Inspect this service and retain the original operation.'
          : 'Setup capacity is full. Inspect retained operations or ask the operator for reviewed retirement; uncertain operation IDs are never discarded.');
      throw error;
    }
    row = await env.ACCOUNTS.prepare('SELECT * FROM account_setups WHERE ' + query).bind(...key).first<SetupRow>();
    if (!row) throw new HttpError(409, 'reconciliation_required', 'Setup allocation did not retain its operation journal.');
  }
  if (row.request_digest !== digest || row.credential_commitment !== input.credentialCommitment) throw new HttpError(409, 'setup_operation_conflict', 'Retry this operation only with its original request and credential commitment.');
  await rowIntegrity(env, row);
  const observed = await inspectRow(env, row);
  if (['ready','expired','reconciliation_required'].includes(observed.state) || observed.state === 'blocked' && observed.code === 'setup_binding_inactive') {
    await requireSetupPrincipal(env, principal);
    if (observed.state === 'ready') await env.ACCOUNTS.prepare(`UPDATE account_setups SET state='ready',failure_code=NULL,updated_at=? WHERE ${query}`).bind(Date.now(), ...key).run();
    return observed;
  }
  try {
    await requireCreationOpen(env);
    if (!await setupCredentialActive(env, row)) return result(row, 'blocked', 'setup_binding_inactive');
    // A removed verified identity never reassigns the pending page to another account/email.
    const verified = await env.ACCOUNTS.prepare(`SELECT 1 FROM identities i JOIN identity_emails e ON e.provider=i.provider AND e.subject=i.subject
      WHERE i.account_id=? AND lower(e.email)=?`).bind(row.account_id, row.intended_email).first();
    if (!verified) return result(row, 'blocked', 'owner_verification_required');
    // A durable expiry journal and alarm precede global admission. An abandoned
    // pre-page reservation can therefore release capacity without another retry.
    await pageRequest(env, row, 'reserve');
    const admissionObject = env.ADMISSION.get(env.ADMISSION.idFromName('global'));
    const statusResponse = await admissionObject.fetch(new Request('https://admission.internal/status',{headers:{'x-tendril-id':row.page_id}}));
    const status = await statusResponse.json<{state?:string}>();
    if (!statusResponse.ok || !['absent','reserved'].includes(status.state ?? ''))
      return result(row,'reconciliation_required','setup_admission_retired');
    const admission = await admissionObject.fetch(new Request('https://admission.internal/reserve', {
      method: 'POST', headers: { 'x-tendril-id': row.page_id, 'x-setup-expires-at': String(row.expires_at) },
    }));
    if (!admission.ok) return admission.status === 410 ? result(row, 'expired', 'setup_expired') : result(row, 'blocked', 'setup_admission_unavailable');
    await requireSetupPrincipal(env, principal); await requireCreationOpen(env);
    if (!row.indexed) {
      // Index and stage marker share one D1 transaction; neither is compensated on a lost response.
      await env.ACCOUNTS.batch([
        env.ACCOUNTS.prepare(`INSERT INTO tendrils(id,owner_account,intended_owner,creator_ip,created_at,claimed_at,lifetime)
          SELECT page_id,NULL,intended_email,creator_ip,created_at,NULL,'ad_hoc' FROM account_setups
          WHERE ${query} AND indexed=0 AND state<>'expired' AND expires_at>? ON CONFLICT(id) DO NOTHING`).bind(...key, Date.now()),
        env.ACCOUNTS.prepare(`UPDATE account_setups SET indexed=1,state='provisioning',updated_at=? WHERE ${query} AND state<>'expired'
          AND EXISTS(SELECT 1 FROM tendrils WHERE id=account_setups.page_id)`).bind(Date.now(), ...key),
      ]);
    }
    await env.ACCOUNTS.prepare(`UPDATE account_setups SET initialization_started=1,updated_at=?
      WHERE ${query} AND indexed=1 AND state<>'expired'`).bind(Date.now(), ...key).run();
    // A missing reply says nothing about delivery. The page retries exactly this
    // initialization only against its retained reservation and atomic write set.
    const initialized = await pageRequest(env, row, 'initialize');
    if (!initialized.page) return result(row, 'provisioning', 'setup_reconciliation_pending');
    if (initialized.credentialActive === false || !await setupCredentialActive(env, row)) return result(row, 'blocked', 'setup_binding_inactive', initialized.page);
    await requireSetupPrincipal(env, principal);
    await env.ACCOUNTS.prepare(`UPDATE account_setups SET state='ready',failure_code=NULL,updated_at=? WHERE ${query}`).bind(Date.now(), ...key).run();
    return result(row, 'ready', null, initialized.page);
  } catch (error) {
    if (error instanceof HttpError && ['invalid_token','insufficient_scope'].includes(error.code)) throw error;
    const state = error instanceof HttpError && error.code === 'reconciliation_required' ? 'reconciliation_required'
      : error instanceof HttpError && error.code === 'setup_expired' ? 'expired'
      : error instanceof HttpError && ['creation_paused','setup_binding_inactive','owner_verification_required'].includes(error.code) ? 'blocked' : 'provisioning';
    return result(row, state,
      error instanceof HttpError ? error.code : 'setup_outcome_unknown');
  }
}

export async function routeAccountSetup(req: Request, env: Env): Promise<Response> {
  const config = await assistantOAuth(env), url = new URL(req.url);
  if (!config || config.issuer !== url.origin) throw new HttpError(404, 'not_found');
  if (req.headers.has('Origin') && req.headers.get('Origin') !== config.issuer) throw new HttpError(403, 'invalid_origin');
  const raw = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/i.exec(req.headers.get('Authorization') ?? '')?.[1];
  await ensureOAuthSchema(env);
  const access = raw && await inspectAccessToken(env, config, raw);
  if (!access) throw new HttpError(401, 'invalid_token');
  const principal: Principal = { account: access.sub, grant: access.sid, client: access.client_id, scopes: access.scope.split(' ').filter(Boolean), expires: access.exp * 1000 };
  if (req.method === 'POST') return json(await prepareTendrilSetup(env, principal, await readJson(req, 4096), req), 200, { 'Cache-Control': 'no-store' });
  if (req.method === 'GET') return json(url.searchParams.has('operationId') ? await inspectTendrilSetup(env, principal, url.searchParams.get('operationId'))
    : await listTendrilSetups(env, principal), 200, { 'Cache-Control': 'no-store' });
  throw new HttpError(405, 'method_not_allowed');
}
