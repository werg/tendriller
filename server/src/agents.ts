/** Account-level maintenance agents: self-chosen @handle + bio, credentials, page grants, and service-origin agent API. */
import type { Env } from './env';
import { AGENT_HEADER, AGENT_SCOPES, AGENT_SCOPES_HEADER, agentScopes, type AgentScope } from './access';
import { AGENT_HANDLE_RE, AGENT_PUBLIC_KEY_RE, validAgentBio, validAgentHandle } from './agent-grants';
import { HttpError, isPlainObject, json, readJson } from './http';
import { AGENT_ID_RE, AGENT_TOKEN_RE, newAgentId, newAgentToken, newTendrilId, randomB32, sha256Hex, TENDRIL_ID_RE } from './ids';
import { AGENT_JOIN_CODE_TTL, AGENT_PAGE_LIST_LIMIT, DAY, PAGE_LIMIT, RESIDENT_LIMIT } from './limits';
import { accountLimits, checkCreationIp, requireCreationOpen, reserveCreationIp } from './service-state';
import { broadcastSummary, getAgentVersions, recordAgentVersions } from './broadcasts';
import { publicBase } from './urls';
import { joinBlurb } from './sharing';

export const HUB_PROTOCOL = 'tendriller.hub.v1';
export { AGENT_HANDLE_RE };
const JOIN_CODE_RE = /^tj_[a-z2-7]{26}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const AGENT_CAPACITY = 50;
const UNCLAIMED_AGENT_CAPACITY = 20;
const UNCLAIMED_AGENT_RETENTION = 7 * DAY;

export interface AgentRow {
  id: string; account_id: string | null; owner_email: string | null; handle: string; bio: string; public_key: string;
  created_at: number; claimed_at: number | null;
}
export interface GrantedAgent extends AgentRow { scopes: AgentScope[] | null }

const AGENT_COLUMNS = 'a.id,a.account_id,a.owner_email,a.handle,a.bio,a.public_key,a.created_at,a.claimed_at';

export function agentView(row: AgentRow) {
  return {
    id: row.id, handle: row.handle, bio: row.bio, public_key: row.public_key, claimed: row.account_id !== null,
    ...(row.account_id === null ? { owner_email: row.owner_email } : {}), created_at: row.created_at, claimed_at: row.claimed_at,
  };
}

export function validPublicKey(value: unknown): string {
  if (typeof value !== 'string' || !AGENT_PUBLIC_KEY_RE.test(value))
    throw new HttpError(400, 'invalid_public_key', 'publicKey must be a base64url (unpadded) Ed25519 public key.');
  return value;
}
function validOwner(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !EMAIL_RE.test(value.trim()))
    throw new HttpError(400, 'bad_request', 'owner must be the owner’s email address');
  return value.trim().toLowerCase();
}
async function body(req: Request, limit = 4096): Promise<Record<string, unknown>> {
  const value = await readJson(req, limit);
  if (!isPlainObject(value)) throw new HttpError(400, 'bad_request', 'Expected a JSON object');
  return value;
}
const ip = (req: Request) => req.headers.get('CF-Connecting-IP') ?? 'unknown';

export function agentToken(req: Request): string | null {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('Authorization') ?? '')?.[1];
  if (bearer) return bearer;
  if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return null;
  return socketProtocols(req).find(value => AGENT_TOKEN_RE.test(value)) ?? null;
}
export function socketProtocols(req: Request): string[] {
  return (req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim()).filter(Boolean);
}

export async function authenticateAgentRequest(env: Env, req: Request, page?: string): Promise<GrantedAgent> {
  const token = agentToken(req);
  const row = token && AGENT_TOKEN_RE.test(token) ? await env.ACCOUNTS.prepare(`SELECT ${AGENT_COLUMNS},g.scopes FROM agents a
      LEFT JOIN accounts c ON c.id=a.account_id
      LEFT JOIN agent_grants g ON g.agent_id=a.id AND g.page_id=?
      WHERE a.token_hash=? AND a.revoked_at IS NULL AND (a.account_id IS NULL OR (c.suspended_at IS NULL AND c.deleting_at IS NULL))`)
    .bind(page ?? null, await sha256Hex(token)).first<AgentRow & { scopes: string | null }>() : null;
  if (!row) {
    if (env.FAILED_AUTH_RATE && !(await env.FAILED_AUTH_RATE.limit({ key: ip(req) })).success)
      throw new HttpError(429, 'rate_limited', 'Too many failed authentication attempts');
    throw new HttpError(401, 'unauthorized', token ? 'Invalid or revoked agent token' : 'Missing Authorization: Bearer <agent token>');
  }
  if (env.AGENT_RATE && !(await env.AGENT_RATE.limit({ key: 'agent:' + row.id })).success)
    throw new HttpError(429, 'rate_limited', 'Agent request rate limit reached');
  return { ...row, scopes: row.scopes === null ? null : JSON.parse(row.scopes) as AgentScope[] };
}

function pageStub(env: Env, id: string): DurableObjectStub { return env.TENDRIL.get(env.TENDRIL.idFromName(id)); }
function hubStub(env: Env, agentId: string): DurableObjectStub { return env.AGENT_HUB.get(env.AGENT_HUB.idFromName(agentId)); }

export function internalHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);
  for (const name of [...headers.keys()]) if (name.startsWith('x-tendril-') || name === 'x-account-id') headers.delete(name);
  return headers;
}

function forwardToPage(env: Env, req: Request, url: URL, page: string, rest: string, agent: GrantedAgent): Promise<Response> {
  const headers = internalHeaders(req);
  headers.delete('Authorization');
  if (headers.has('Sec-WebSocket-Protocol')) {
    const kept = socketProtocols(req).filter(value => !AGENT_TOKEN_RE.test(value));
    if (kept.length) headers.set('Sec-WebSocket-Protocol', kept.join(', ')); else headers.delete('Sec-WebSocket-Protocol');
  }
  headers.set('x-tendril-id', page);
  headers.set('x-tendril-rest', encodeURIComponent(rest));
  headers.set(AGENT_HEADER, agent.id);
  headers.set(AGENT_SCOPES_HEADER, (agent.scopes ?? []).join(' '));
  const init: RequestInit = { method: req.method, headers, signal: req.signal };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = req.body;
  return pageStub(env, page).fetch(new Request(`https://tendril.internal/agent${url.search}`, init));
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** `/api/agents*` and `/api/agent*`. Returns null for other paths. */
export async function routeAgentApi(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === '/api/agents') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST');
    return createUnclaimedAgent(req, env);
  }
  if (path === '/api/agents/join') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST');
    return joinAgent(req, env);
  }
  if (path === '/api/agent') {
    const agent = await authenticateAgentRequest(env, req);
    if (req.method === 'GET' || req.method === 'HEAD') return json(await agentSelf(env, agent));
    if (req.method === 'PATCH') return json(await updateAgentProfile(req, env, agent));
    if (req.method === 'DELETE') { await revokeAgent(env, agent.id); return new Response(null, { status: 204 }); }
    throw new HttpError(405, 'method_not_allowed');
  }
  if (path === '/api/agent/versions') {
    const agent = await authenticateAgentRequest(env, req);
    if (req.method === 'GET' || req.method === 'HEAD') {
      return json({ agent_id: agent.id, versions: await getAgentVersions(env, agent.id) });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const input = await body(req, 4096);
      const saved = await recordAgentVersions(env, agent.id, input);
      return json({ agent_id: agent.id, versions: saved, updated_at: Date.now() });
    }
    throw new HttpError(405, 'method_not_allowed');
  }
  if (path === '/api/agent/hub') {
    if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'websocket_required');
    if (!socketProtocols(req).includes(HUB_PROTOCOL)) throw new HttpError(400, 'hub_protocol_required', `Use the ${HUB_PROTOCOL} subprotocol with the agent token`);
    const agent = await authenticateAgentRequest(env, req);
    const headers = internalHeaders(req);
    headers.delete('Authorization');
    headers.set('Sec-WebSocket-Protocol', HUB_PROTOCOL);
    headers.set(AGENT_HEADER, agent.id);
    return hubStub(env, agent.id).fetch(new Request('https://hub.internal/connect', { headers }));
  }
  if (path === '/api/agent/pages') {
    const agent = await authenticateAgentRequest(env, req);
    if (req.method === 'GET' || req.method === 'HEAD') return json(await listAgentPages(env, agent, url.searchParams.get('cursor')));
    if (req.method === 'POST') return createAgentPage(req, env, agent);
    throw new HttpError(405, 'method_not_allowed');
  }
  const page = /^\/api\/agent\/pages\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (page) {
    if (!TENDRIL_ID_RE.test(page[1])) throw new HttpError(404, 'not_found', 'No such granted page');
    const agent = await authenticateAgentRequest(env, req, page[1]);
    if (!agent.scopes) throw new HttpError(404, 'not_found', 'No such granted page');
    return forwardToPage(env, req, url, page[1], safeDecode(page[2] ?? ''), agent);
  }
  return null;
}

async function pruneUnclaimed(env: Env): Promise<void> {
  await env.ACCOUNTS.prepare(`DELETE FROM agents WHERE account_id IS NULL AND created_at < ?
    AND NOT EXISTS(SELECT 1 FROM agent_grants g WHERE g.agent_id=agents.id)`).bind(Date.now() - UNCLAIMED_AGENT_RETENTION).run();
}

async function createUnclaimedAgent(req: Request, env: Env): Promise<Response> {
  await requireCreationOpen(env);
  if (req.headers.has('Authorization')) throw new HttpError(400, 'bad_request', 'Agent creation uses an owner email, not a credential');
  if (env.CREATE_RATE && !(await env.CREATE_RATE.limit({ key: ip(req) })).success)
    throw new HttpError(429, 'rate_limited', 'Creation rate limit reached');
  await checkCreationIp(env, req);
  const input = await body(req);
  const owner = validOwner(input.owner), handle = validAgentHandle(input.handle), bio = validAgentBio(input.bio), publicKey = validPublicKey(input.publicKey);
  await pruneUnclaimed(env);
  const token = newAgentToken(), now = Date.now();
  const row: AgentRow = { id: newAgentId(), account_id: null, owner_email: owner, handle, bio, public_key: publicKey, created_at: now, claimed_at: null };
  const inserted = await env.ACCOUNTS.prepare(`INSERT INTO agents(id,account_id,owner_email,handle,bio,token_hash,public_key,created_at)
    SELECT ?,NULL,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM agents WHERE account_id IS NULL AND owner_email=? AND revoked_at IS NULL) < ? RETURNING id`)
    .bind(row.id, owner, handle, bio, await sha256Hex(token), publicKey, now, owner, UNCLAIMED_AGENT_CAPACITY).first();
  if (!inserted) throw new HttpError(429, 'agent_capacity', 'Too many unclaimed agents for this owner. Ask the owner to sign in or add the agent from their dashboard.');
  return json({
    agent: agentView(row), token, service: publicBase(env),
    next_step: 'Store this token privately. Create pages with POST /api/agent/pages; the owner claims this agent by signing in to any page it created.',
  }, 201);
}

async function joinAgent(req: Request, env: Env): Promise<Response> {
  if (env.AUTH_RATE && !(await env.AUTH_RATE.limit({ key: 'agent-join:' + ip(req) })).success) throw new HttpError(429, 'rate_limited');
  const input = await body(req);
  const handle = validAgentHandle(input.handle), bio = validAgentBio(input.bio), publicKey = validPublicKey(input.publicKey);
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const fail = async () => {
    if (env.FAILED_AUTH_RATE && !(await env.FAILED_AUTH_RATE.limit({ key: ip(req) })).success)
      throw new HttpError(429, 'rate_limited', 'Too many failed attempts');
    return new HttpError(404, 'invalid_code', 'Unknown, used or expired join code. Ask the owner for a new one.');
  };
  if (!JOIN_CODE_RE.test(code)) throw await fail();
  const hash = await sha256Hex(code), token = newAgentToken(), now = Date.now(), id = newAgentId();
  let results: D1Result[];
  try {
    results = await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare(`UPDATE agent_join_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>?
        AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=agent_join_codes.account_id AND a.suspended_at IS NULL AND a.deleting_at IS NULL)`).bind(now, hash, now),
      env.ACCOUNTS.prepare(`INSERT INTO agents(id,account_id,owner_email,handle,bio,token_hash,public_key,created_at,claimed_at)
        SELECT ?,account_id,NULL,?,?,?,?,?,? FROM agent_join_codes WHERE code_hash=? AND used_at=?
          AND (SELECT COUNT(*) FROM agents x WHERE x.account_id=agent_join_codes.account_id AND x.revoked_at IS NULL) < ?
        RETURNING account_id`).bind(id, handle, bio, await sha256Hex(token), publicKey, now, now, hash, now, AGENT_CAPACITY),
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'agent_handle_in_use', `Handle @${handle} is already in use in this account. Choose another handle.`);
    throw error;
  }
  if (!results[0].meta.changes) throw await fail();
  const account = (results[1].results[0] as { account_id?: string } | undefined)?.account_id;
  if (!account) throw new HttpError(429, 'agent_capacity', 'This account already has the maximum number of agents.');
  const row: AgentRow = { id, account_id: account, owner_email: null, handle, bio, public_key: publicKey, created_at: now, claimed_at: now };
  return json({
    agent: agentView(row), token, service: publicBase(env),
    next_step: 'Store this token privately. The owner grants existing pages from their dashboard; pages you create are granted to you automatically.',
  }, 201);
}

async function updateAgentProfile(req: Request, env: Env, agent: GrantedAgent) {
  const input = await body(req);
  for (const key of Object.keys(input)) if (!['handle', 'bio'].includes(key))
    throw new HttpError(400, 'bad_request', `Unknown profile field ${key}`);
  const nextHandle = input.handle !== undefined ? validAgentHandle(input.handle) : agent.handle;
  const nextBio = input.bio !== undefined ? validAgentBio(input.bio) : agent.bio;
  try {
    await env.ACCOUNTS.prepare('UPDATE agents SET handle=?, bio=? WHERE id=? AND revoked_at IS NULL')
      .bind(nextHandle, nextBio, agent.id).run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'agent_handle_in_use', `Handle @${nextHandle} is already in use in this account.`);
    throw error;
  }
  const pages = await env.ACCOUNTS.prepare('SELECT page_id FROM agent_grants WHERE agent_id=?').bind(agent.id).all<{ page_id: string }>();
  await Promise.all(pages.results.map(page =>
    pageGrantCall(env, page.page_id, 'profile', { agentId: agent.id, handle: nextHandle, bio: nextBio }).catch(() => {}),
  ));
  return agentSelf(env, { ...agent, handle: nextHandle, bio: nextBio });
}

async function agentSelf(env: Env, agent: GrantedAgent) {
  const [row, versions, broadcasts] = await Promise.all([
    env.ACCOUNTS.prepare(`SELECT (SELECT COUNT(*) FROM agent_grants WHERE agent_id=?) AS grants,
      (SELECT email FROM accounts WHERE id=?) AS email`).bind(agent.id, agent.account_id).first<{ grants: number; email: string | null }>(),
    getAgentVersions(env, agent.id),
    broadcastSummary(env),
  ]);
  return {
    agent: agentView(agent),
    account: agent.account_id === null ? { claimed: false, owner_email: agent.owner_email } : { claimed: true, email: row?.email ?? null },
    grants: row?.grants ?? 0,
    ...(versions ? { versions } : {}),
    broadcasts,
    service: publicBase(env),
  };
}

async function listAgentPages(env: Env, agent: GrantedAgent, cursor: string | null) {
  if (cursor !== null && !TENDRIL_ID_RE.test(cursor)) throw new HttpError(400, 'invalid_cursor');
  const rows = await env.ACCOUNTS.prepare(`SELECT g.page_id,g.scopes,g.granted_by,g.granted_at,t.lifetime,t.state FROM agent_grants g
    JOIN tendrils t ON t.id=g.page_id WHERE g.agent_id=? AND g.page_id>? ORDER BY g.page_id LIMIT ?`)
    .bind(agent.id, cursor ?? '', AGENT_PAGE_LIST_LIMIT + 1)
    .all<{ page_id: string; scopes: string; granted_by: string; granted_at: number; lifetime: string; state: string }>();
  const visible = rows.results.slice(0, AGENT_PAGE_LIST_LIMIT);
  const pages = await Promise.all(visible.map(async row => {
    let detail: { name?: string; page_url?: string; application?: { id: string }; expires_at?: number | null; claimed?: boolean; primary_agent_id?: string | null; is_primary?: boolean; agents?: unknown[] } = {};
    try {
      const response = await pageStub(env, row.page_id).fetch(new Request('https://tendril.internal/agent-summary', { headers: { [AGENT_HEADER]: agent.id } }));
      if (response.ok) detail = await response.json(); else await response.body?.cancel();
    } catch { /* One unavailable page must not hide the rest. */ }
    return {
      id: row.page_id, name: detail.name ?? null, page_url: detail.page_url ?? null, api: `${publicBase(env)}/api/agent/pages/${row.page_id}`,
      scopes: JSON.parse(row.scopes) as AgentScope[], granted_by: row.granted_by, granted_at: row.granted_at,
      application: detail.application ?? null, lifetime: row.lifetime, state: row.state,
      claimed: detail.claimed ?? null, expires_at: detail.expires_at ?? null,
      primary_agent_id: detail.primary_agent_id ?? null, is_primary: detail.is_primary ?? false,
      agents: detail.agents ?? [],
    };
  }));
  return { pages, next_cursor: rows.results.length > AGENT_PAGE_LIST_LIMIT ? visible[visible.length - 1].page_id : null };
}

const errorCode = async (response: Response) => {
  try { return ((await response.clone().json()) as { error?: { code?: string } }).error?.code ?? ''; } catch { return ''; }
};

async function createAgentPage(req: Request, env: Env, agent: GrantedAgent): Promise<Response> {
  await requireCreationOpen(env);
  if (env.CREATE_RATE && !(await env.CREATE_RATE.limit({ key: 'agent:' + agent.id })).success)
    throw new HttpError(429, 'rate_limited', 'Creation rate limit reached');
  const input = await body(req, 64 * 1024);
  for (const key of Object.keys(input)) if (!['name', 'mode', 'application'].includes(key))
    throw new HttpError(400, 'bad_request', `Unknown page field ${key}`);
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 200)) throw new HttpError(400, 'bad_request', 'name must be a string');
  if (input.application !== undefined && (!isPlainObject(input.application) || Object.keys(input.application).length !== 1 ||
      typeof input.application.id !== 'string' || !/^[0-9a-f]{64}$/.test(input.application.id)))
    throw new HttpError(400, 'bad_request', 'application must be { id: <64 lowercase hex> }');
  const claimed = agent.account_id;
  const doBody = JSON.stringify({ ...input, ...(claimed ? {} : { owner: agent.owner_email }) });
  const releaseIp = claimed ? async () => {} : await reserveCreationIp(env, req);
  let created = false;
  try {
    for (let i = 0; i < 3; i++) {
      const id = newTendrilId(), now = Date.now();
      const admission = env.ADMISSION.get(env.ADMISSION.idFromName('global'));
      const allowed = await admission.fetch(new Request('https://admission.internal/reserve', { method: 'POST', headers: { 'x-tendril-id': id } }));
      if (!allowed.ok) return allowed;
      await allowed.body?.cancel();
      let indexed = false;
      const cancel = async () => {
        try { if (indexed) await env.ACCOUNTS.prepare('DELETE FROM tendrils WHERE id = ?').bind(id).run(); }
        finally {
          const cancelled = await admission.fetch(new Request('https://admission.internal/cancel', { method: 'POST', headers: { 'x-tendril-id': id } }));
          await cancelled.body?.cancel();
        }
      };
      let res: Response;
      try {
        try {
          await env.ACCOUNTS.prepare('INSERT INTO tendrils (id, owner_account, intended_owner, creator_ip, created_at, claimed_at, lifetime) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(id, claimed, claimed ? null : agent.owner_email, req.headers.get('CF-Connecting-IP'), now, claimed ? now : null, 'ad_hoc').run();
        } catch (err) {
          const message = String(err);
          if (message.includes('account_tendrils_full') || message.includes('account_residents_full')) {
            const limits = await accountLimits(env);
            if (message.includes('account_tendrils_full')) throw new HttpError(429, 'quota', 'Account tendril limit reached', { limit: limits.pages ?? PAGE_LIMIT });
            throw new HttpError(429, 'quota', 'Account resident tendril limit reached', { limit: limits.residents ?? RESIDENT_LIMIT });
          }
          throw err;
        }
        indexed = true;
        res = await pageStub(env, id).fetch(new Request('https://tendril.internal/create', {
          method: 'POST',
          headers: {
            'x-tendril-id': id, 'Content-Type': 'application/json', [AGENT_HEADER]: agent.id,
            'x-tendril-agent-handle': agent.handle, 'x-tendril-agent-bio': encodeURIComponent(agent.bio),
            'x-tendril-agent-key': agent.public_key,
            ...(claimed ? { 'x-account-id': claimed } : {}),
          },
          body: doBody,
        }));
      } catch (err) {
        await cancel();
        throw err;
      }
      if (res.status === 409 && await errorCode(res) === 'exists') { await res.body?.cancel(); await cancel(); continue; }
      if (!res.ok) { await cancel(); return res; }
      const page = await res.json() as { revision: number; scopes: AgentScope[] };
      try {
        await env.ACCOUNTS.prepare('INSERT INTO agent_grants(agent_id,page_id,scopes,revision,granted_at,granted_by) VALUES(?,?,?,?,?,?)')
          .bind(agent.id, id, JSON.stringify(page.scopes), page.revision, now, 'creator').run();
      } catch (err) { await cancel(); throw err; }
      created = true;
      if (claimed) {
        const released = await admission.fetch(new Request('https://admission.internal/release', { method: 'POST', headers: { 'x-tendril-id': id } }));
        await released.body?.cancel();
      }
      const { revision: _revision, ...result } = page as Record<string, unknown>;
      return json(result, 201);
    }
    throw new HttpError(500, 'internal', 'Could not allocate a tendril id');
  } finally {
    if (!created) await releaseIp();
  }
}

export async function claimCreatorAgents(env: Env, pageId: string, accountId: string, identities: unknown[] = []): Promise<void> {
  const candidates = await env.ACCOUNTS.prepare(`SELECT a.id,a.handle,a.bio,a.owner_email FROM agents a JOIN agent_grants g ON g.agent_id=a.id
    WHERE g.page_id=? AND g.granted_by='creator' AND a.account_id IS NULL AND a.revoked_at IS NULL`).bind(pageId).all<{ id: string; handle: string; bio: string; owner_email: string | null }>();
  const now = Date.now();
  for (const agent of candidates.results) {
    let claimed = false, finalHandle = agent.handle;
    for (const candidate of [agent.handle, `${agent.handle.slice(0, 25)}-${agent.id.slice(3, 9)}`]) {
      try {
        const row = await env.ACCOUNTS.prepare('UPDATE agents SET account_id=?, claimed_at=?, handle=? WHERE id=? AND account_id IS NULL AND revoked_at IS NULL RETURNING id')
          .bind(accountId, now, candidate, agent.id).first();
        claimed = Boolean(row);
        finalHandle = candidate;
        break;
      } catch (error) { if (!String(error).includes('UNIQUE')) throw error; }
    }
    if (claimed) {
      if (finalHandle !== agent.handle) {
        await pageGrantCall(env, pageId, 'profile', { agentId: agent.id, handle: finalHandle, bio: agent.bio }).catch(() => {});
      }
      if (agent.owner_email) await claimAgentPages(env, agent.id, agent.owner_email, pageId, accountId, identities);
    }
  }
}

async function claimAgentPages(env: Env, agentId: string, ownerEmail: string, signedIn: string, accountId: string, identities: unknown[]): Promise<void> {
  const pages = await env.ACCOUNTS.prepare(`SELECT t.id FROM tendrils t JOIN agent_grants g ON g.page_id=t.id
    WHERE g.agent_id=? AND g.granted_by='creator' AND t.id<>? AND t.owner_account IS NULL AND lower(t.intended_owner)=lower(?)
    ORDER BY t.created_at`).bind(agentId, signedIn, ownerEmail).all<{ id: string }>();
  for (const page of pages.results) {
    try {
      const response = await pageStub(env, page.id).fetch(new Request('https://tendril.internal/claim/agent-owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [AGENT_HEADER]: agentId },
        body: JSON.stringify({ account_id: accountId, identities }),
      }));
      await response.body?.cancel();
    } catch { /* The page remains claimable by signing in to it. */ }
  }
}

export interface AccountAgent { id: string; handle: string; bio: string; public_key: string; created_at: number; claimed_at: number | null; grants: number }
export async function listAccountAgents(env: Env, accountId: string): Promise<AccountAgent[]> {
  return (await env.ACCOUNTS.prepare(`SELECT a.id,a.handle,a.bio,a.public_key,a.created_at,a.claimed_at,
    (SELECT COUNT(*) FROM agent_grants g WHERE g.agent_id=a.id) AS grants FROM agents a
    WHERE a.account_id=? AND a.revoked_at IS NULL ORDER BY a.created_at, a.id`).bind(accountId).all<AccountAgent>()).results;
}

export async function accountGrants(env: Env, accountId: string): Promise<Map<string, Set<string>>> {
  const rows = await env.ACCOUNTS.prepare(`SELECT g.page_id,g.agent_id FROM agent_grants g JOIN agents a ON a.id=g.agent_id
    WHERE a.account_id=? AND a.revoked_at IS NULL`).bind(accountId).all<{ page_id: string; agent_id: string }>();
  const grants = new Map<string, Set<string>>();
  for (const row of rows.results) (grants.get(row.page_id) ?? grants.set(row.page_id, new Set()).get(row.page_id)!).add(row.agent_id);
  return grants;
}

export async function createJoinCode(env: Env, accountId: string): Promise<{ code: string; expires_at: number; blurb: string }> {
  const code = 'tj_' + randomB32(26), now = Date.now(), expiresAt = now + AGENT_JOIN_CODE_TTL;
  await env.ACCOUNTS.prepare('DELETE FROM agent_join_codes WHERE expires_at<? OR used_at IS NOT NULL AND used_at<?').bind(now, now - DAY).run();
  const inserted = await env.ACCOUNTS.prepare(`INSERT INTO agent_join_codes(code_hash,account_id,scopes,expires_at)
    SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM agent_join_codes WHERE account_id=? AND used_at IS NULL AND expires_at>?) < 10 RETURNING code_hash`)
    .bind(await sha256Hex(code), accountId, JSON.stringify(AGENT_SCOPES), expiresAt, accountId, now).first();
  if (!inserted) throw new HttpError(429, 'join_code_capacity', 'Ten join codes are already waiting. Use one or wait for them to expire.');
  return { code, expires_at: expiresAt, blurb: joinBlurb(publicBase(env), code, expiresAt) };
}

async function ownedAgent(env: Env, accountId: string, agentId: string): Promise<AgentRow> {
  if (!AGENT_ID_RE.test(agentId)) throw new HttpError(404, 'not_found', 'No such agent');
  const row = await env.ACCOUNTS.prepare(`SELECT ${AGENT_COLUMNS} FROM agents a WHERE a.id=? AND a.account_id=? AND a.revoked_at IS NULL`)
    .bind(agentId, accountId).first<AgentRow>();
  if (!row) throw new HttpError(404, 'not_found', 'No such agent');
  return row;
}

async function pageGrantCall(env: Env, pageId: string, path: 'put' | 'delete' | 'profile' | 'primary', bodyObj: Record<string, unknown>, accountId?: string): Promise<Response> {
  const response = await pageStub(env, pageId).fetch(new Request(`https://tendril.internal/agent-grant/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(accountId ? { 'x-account-id': accountId } : {}) }, body: JSON.stringify(bodyObj),
  }));
  if (response.ok) return response;
  let error: { code?: string; message?: string } = {};
  try { error = ((await response.json()) as { error?: typeof error }).error ?? {}; } catch { /* keep the status */ }
  throw new HttpError(response.status, error.code ?? 'unavailable', error.message);
}

export async function setAgentGrant(env: Env, accountId: string, agentId: string, pageId: string, granted: boolean): Promise<void> {
  const agent = await ownedAgent(env, accountId, agentId);
  if (!TENDRIL_ID_RE.test(pageId) || !await env.ACCOUNTS.prepare("SELECT 1 FROM tendrils WHERE id=? AND owner_account=? AND state='active'").bind(pageId, accountId).first())
    throw new HttpError(404, 'not_found', 'No such page');
  const res = granted
    ? await pageGrantCall(env, pageId, 'put', { agentId, handle: agent.handle, bio: agent.bio, publicKey: agent.public_key, scopes: [...AGENT_SCOPES] }, accountId)
    : await pageGrantCall(env, pageId, 'delete', { agentId }, accountId);
  await res.body?.cancel();
}

export async function setPagePrimaryAgent(env: Env, accountId: string, pageId: string, agentId: string | null): Promise<unknown> {
  if (!TENDRIL_ID_RE.test(pageId) || !await env.ACCOUNTS.prepare("SELECT 1 FROM tendrils WHERE id=? AND owner_account=? AND state='active'").bind(pageId, accountId).first())
    throw new HttpError(404, 'not_found', 'No such page');
  const res = await pageGrantCall(env, pageId, 'primary', { agentId }, accountId);
  return await res.json();
}

export async function revokeAgent(env: Env, agentId: string, accountId?: string): Promise<boolean> {
  const row = await env.ACCOUNTS.prepare(`UPDATE agents SET revoked_at=? WHERE id=? AND revoked_at IS NULL ${accountId ? 'AND account_id=?' : ''} RETURNING id`)
    .bind(...[Date.now(), agentId, ...(accountId ? [accountId] : [])]).first();
  if (!row) return false;
  await disconnectAgent(env, agentId, 'Agent revoked');
  const pages = await env.ACCOUNTS.prepare('SELECT page_id FROM agent_grants WHERE agent_id=?').bind(agentId).all<{ page_id: string }>();
  await Promise.all(pages.results.map(page =>
    pageGrantCall(env, page.page_id, 'delete', { agentId }).then(r => r.body?.cancel()).catch(error => console.error('Agent grant cleanup remains pending', error)),
  ));
  await env.ACCOUNTS.prepare('DELETE FROM agent_grants WHERE agent_id=?').bind(agentId).run();
  return true;
}

async function disconnectAgent(env: Env, agentId: string, reason: string): Promise<void> {
  try {
    const response = await hubStub(env, agentId).fetch(new Request('https://hub.internal/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    }));
    await response.body?.cancel();
  } catch (error) { console.error('Agent hub close failed', error); }
}

/**
 * MCP `register_agent`: an OAuth-linked assistant registers a workspace agent with a self-chosen
 * `@handle`, optional `bio`, and signing key. Re-registering the same handle rotates token & key.
 */
export async function registerAccountAgent(env: Env, accountId: string, rawHandle: unknown, rawKey: unknown, rawBio?: unknown) {
  const handle = validAgentHandle(rawHandle), bio = validAgentBio(rawBio), publicKey = validPublicKey(rawKey);
  const token = newAgentToken(), hash = await sha256Hex(token), now = Date.now();
  const existing = await env.ACCOUNTS.prepare(`SELECT ${AGENT_COLUMNS} FROM agents a WHERE a.account_id=? AND lower(a.handle)=lower(?) AND a.revoked_at IS NULL`)
    .bind(accountId, handle).first<AgentRow>();
  if (existing) {
    await env.ACCOUNTS.prepare('UPDATE agents SET token_hash=?, public_key=?, bio=? WHERE id=? AND revoked_at IS NULL').bind(hash, publicKey, bio, existing.id).run();
    await disconnectAgent(env, existing.id, 'Agent credential rotated');
    const grants = await env.ACCOUNTS.prepare(`SELECT g.page_id,g.scopes FROM agent_grants g JOIN tendrils t ON t.id=g.page_id
      WHERE g.agent_id=? AND t.owner_account=?`).bind(existing.id, accountId).all<{ page_id: string; scopes: string }>();
    await Promise.all(grants.results.map(grant => pageGrantCall(env, grant.page_id, 'put',
      { agentId: existing.id, handle, bio, publicKey, scopes: agentScopes(JSON.parse(grant.scopes)) }, accountId)
      .then(r => r.body?.cancel()).catch(error => console.error('Agent key re-mirror failed', error))));
    return { agent: agentView({ ...existing, handle, bio, public_key: publicKey }), token, rotated: true, service: publicBase(env) };
  }
  const row: AgentRow = { id: newAgentId(), account_id: accountId, owner_email: null, handle, bio, public_key: publicKey, created_at: now, claimed_at: now };
  let inserted: unknown;
  try {
    inserted = await env.ACCOUNTS.prepare(`INSERT INTO agents(id,account_id,owner_email,handle,bio,token_hash,public_key,created_at,claimed_at)
      SELECT ?,?,NULL,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM agents WHERE account_id=? AND revoked_at IS NULL) < ? RETURNING id`)
      .bind(row.id, accountId, handle, bio, hash, publicKey, now, now, accountId, AGENT_CAPACITY).first();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'agent_handle_in_use', 'Retry register_agent; another registration used this handle concurrently.');
    throw error;
  }
  if (!inserted) throw new HttpError(429, 'agent_capacity', 'This account already has the maximum number of agents.');
  return { agent: agentView(row), token, rotated: false, service: publicBase(env) };
}
