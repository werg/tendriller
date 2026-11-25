// Authentication resolves identity. Authorization and activity recording are explicit.
import type { Role } from "../../contract/index.mjs";
import type { Link, Tendril } from "./tendril";
import { HttpError } from "./http";
import { AGENT_ID_RE, sha256Hex } from "./ids";

export const AGENT_SCOPES = ['host:read', 'host:manage', 'participants:connect', 'control:write', 'publication:write', 'assistant:manage', 'notifications:send'] as const;
export type AgentScope = typeof AGENT_SCOPES[number];
/** Internal headers the service router (or an agent hub) sets after its D1 grant check. */
export const AGENT_HEADER = 'x-tendril-agent';
export const AGENT_SCOPES_HEADER = 'x-tendril-agent-scopes';
/** A maintenance agent acting on this page through a mirrored owner or creator grant. */
export interface AgentPrincipal { kind: "agent"; agentId: string; scopes: AgentScope[]; revision: number }
export interface PagePrincipal {
  kind: "page"; name: string; role: Role; accountId: string | null; linkId: string;
  sessionHash: string | null;
}
export type Principal = AgentPrincipal | PagePrincipal;
export interface PageSession { account_id: string; role: Role; hash: string }
export type AccessAction = 'agent.manage' | 'page.owner' | 'page.write';
export function allows(principal: Principal, action: AccessAction): boolean {
  switch (action) {
    case 'agent.manage': return principal.kind === 'agent' && hasAgentScope(principal, 'host:manage');
    case 'page.owner': return principal.kind === 'page' && principal.role === 'owner';
    case 'page.write': return principal.kind === 'page' && principal.role !== 'display';
  }
}
export function hasAgentScope(principal: AgentPrincipal, scope: AgentScope): boolean {
  return principal.scopes.includes(scope);
}
export function requireAgentScope(principal: AgentPrincipal, scope: AgentScope): void {
  if (!hasAgentScope(principal, scope)) throw new HttpError(403, 'agent_scope_required', `This agent grant requires ${scope}.`);
}
/** Parses a requested scope list into canonical order. Duplicates and unknown scopes are rejected. */
export function agentScopes(value: unknown, fallback: readonly AgentScope[] = AGENT_SCOPES): AgentScope[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > AGENT_SCOPES.length || !value.length || new Set(value).size !== value.length ||
      value.some(scope => !AGENT_SCOPES.includes(scope))) throw new HttpError(400, 'invalid_agent_scopes');
  return AGENT_SCOPES.filter(scope => value.includes(scope));
}
export function requireAccess(principal: Principal, action: AccessAction): void {
  if (!allows(principal, action)) throw new HttpError(403, 'forbidden');
}

/** The page's synchronous mirror of one agent grant. D1 remains the routing index. */
export interface LocalAgentGrant { agent_id: string; public_key: string; scopes: AgentScope[]; revision: number; granted_by: string; granted_at: number }
export function localAgentGrant(t: Tendril, agentId: string): LocalAgentGrant | null {
  return t.db.cached(`access:agent:${agentId}`, () => {
    const row = t.db.one<Omit<LocalAgentGrant, 'scopes'> & { scopes: string }>(
      'SELECT agent_id,public_key,scopes,revision,granted_by,granted_at FROM agent_grants WHERE agent_id=?', agentId);
    return row ? Object.freeze({ ...row, scopes: JSON.parse(row.scopes) as AgentScope[] }) : null;
  });
}

// Cache immutable row snapshots only within this live object. Db invalidates
// every snapshot on local writes and rollback; time-dependent checks stay below.
const localSession = (t: Tendril, hash: string) => t.db.cached(`access:session:${hash}`, () =>
  t.db.one<{ account_id: string; role: Role; expires_at: number }>("SELECT account_id,role,expires_at FROM page_sessions WHERE hash=?", hash));

/**
 * Resolves the agent named by the router's internal headers against the local
 * grant mirror. The router already checked the credential and its D1 grant; a
 * missing or changed mirror fails closed.
 */
export function authenticateAgent(t: Tendril, req: Request): AgentPrincipal {
  const agentId = req.headers.get(AGENT_HEADER) ?? '', scopes = (req.headers.get(AGENT_SCOPES_HEADER) ?? '').split(' ').filter(Boolean);
  if (!AGENT_ID_RE.test(agentId)) throw new HttpError(401, 'unauthorized', 'Agent credential required');
  const grant = localAgentGrant(t, agentId);
  if (!grant) throw new HttpError(404, 'not_found', 'No such granted page');
  if (grant.scopes.length !== scopes.length || grant.scopes.some(scope => !scopes.includes(scope)))
    throw new HttpError(409, 'agent_grant_changed', 'This page grant changed; retry the request.');
  return { kind: 'agent', agentId, scopes: [...grant.scopes], revision: grant.revision };
}

/** Check page-owner and optional visitor account policy in one primary read. */
export async function pagePolicy(t: Tendril, visitor: string | null = null): Promise<"active" | "page" | "visitor"> {
  if (t.db.get("disabled", false)) return "page";
  const status = await t.env.ACCOUNTS.prepare(`SELECT t.state,t.owner_account,a.id AS owner_id,a.suspended_at,a.deleting_at,
    CASE WHEN ?1 IS NULL OR ?1=t.owner_account THEN 1 ELSE EXISTS(
      SELECT 1 FROM accounts WHERE id=?1 AND suspended_at IS NULL AND deleting_at IS NULL
    ) END AS visitor_active
    FROM tendrils t LEFT JOIN accounts a ON a.id=t.owner_account WHERE t.id=?2`).bind(visitor, t.tid)
    .first<{ state: string; owner_account: string | null; owner_id: string | null; suspended_at: number | null; deleting_at: number | null; visitor_active: number }>();
  const pageActive = !t.db.get("disabled", false) && !!status && status.state === "active"
    && status.owner_account === t.db.get<string | null>("owner_account", null)
    && (!status.owner_account || !!status.owner_id)
    && status.suspended_at === null && status.deleting_at === null;
  return !pageActive ? "page" : status.visitor_active ? "active" : "visitor";
}

export async function pageAccessAllowed(t: Tendril): Promise<boolean> {
  return await pagePolicy(t) === "active";
}
export async function accountActive(t: Tendril, accountId: string): Promise<boolean> {
  return !!await t.env.ACCOUNTS.prepare("SELECT 1 FROM accounts WHERE id=? AND suspended_at IS NULL AND deleting_at IS NULL").bind(accountId).first();
}

function sessionByHash(t: Tendril, hash: string): PageSession | null {
  const row = localSession(t, hash);
  return row && row.expires_at > t.now() ? { account_id: row.account_id, role: row.role, hash } : null;
}

async function browserSession(t: Tendril, req: Request): Promise<PageSession | null> {
  const token = /(?:^|;\s*)__Host-tendril=([^;]+)/.exec(req.headers.get("Cookie") ?? "")?.[1];
  return token ? sessionByHash(t, await sha256Hex(token)) : null;
}

export async function readPageSession(t: Tendril, req: Request): Promise<PageSession | null> {
  const session = await browserSession(t, req);
  if (!session || !await accountActive(t, session.account_id)) return null;
  const current = sessionByHash(t, session.hash);
  return current && current.account_id === session.account_id && current.role === session.role ? current : null;
}

function localPagePrincipal(t: Tendril, identity: Omit<PagePrincipal, "kind" | "name">, key?: string): PagePrincipal | null {
  if (t.db.get("disabled", false)) return null;
  const link = t.db.cached(`access:link:${identity.linkId}`, () =>
    t.db.one<{ key: string; role: Role; expires_at: number | null; created_by_agent: number }>("SELECT key,role,expires_at,created_by_agent FROM links WHERE id=?", identity.linkId));
  if (!link || (key !== undefined && link.key !== key) || link.role !== identity.role || link.expires_at !== null && link.expires_at <= t.now()) return null;
  if (identity.role === "display") {
    if (link.created_by_agent || !t.db.get("owner_account", null)) return null;
  } else {
    const session = identity.sessionHash && localSession(t, identity.sessionHash);
    if (!session || session.account_id !== identity.accountId || session.role !== identity.role || session.expires_at <= t.now()) return null;
    if (identity.role === "owner" && identity.accountId !== t.db.get("owner_account", null)) return null;
    if (identity.role === "guest" && !t.db.cached(`access:guest:${JSON.stringify([identity.accountId, identity.linkId])}`, () =>
      t.db.one("SELECT 1 FROM guest_accounts WHERE account_id=? AND link_id=? AND approved=1", identity.accountId, identity.linkId))) return null;
  }
  return { kind: "page", name: identity.accountId ?? identity.linkId, ...identity };
}

/** Recheck local revocation at a synchronous commit after asynchronous preparation. */
export function currentPrincipal(t: Tendril, principal: Principal, pageKey?: string): Principal | null {
  if (t.db.get("disabled", false)) return null;
  if (principal.kind === "page") return localPagePrincipal(t, principal, pageKey);
  return localAgentGrant(t, principal.agentId)?.revision === principal.revision ? principal : null;
}

/** Grants are mirrored locally and revoked by the page object itself, so freshness is local. */
export async function freshPrincipal(t: Tendril, principal: Principal, pageKey?: string): Promise<Principal | null> {
  return currentPrincipal(t, principal, pageKey);
}

/** Route ownership retains the agent identity for narrow revocation. Capacity
 * belongs to the human account (or, before claim, the creating agent), so adding
 * agents never multiplies an account's budget. */
export function participantIdentity(t: Tendril, principal: Principal): { route: string; budget: string } {
  const current = currentPrincipal(t, principal);
  if (!current || current.kind === 'page' && (current.role === 'display' || !current.accountId))
    throw new HttpError(403, 'forbidden', 'Peer participation requires an authenticated participant');
  if (current.kind === 'agent') {
    requireAgentScope(current, 'participants:connect');
    const owner = t.db.get<string | null>('owner_account', null);
    return { route: `agent:${current.agentId}`, budget: owner ? `account:${owner}` : `agent:${current.agentId}` };
  }
  return { route: `account:${current.accountId}`, budget: `account:${current.accountId}` };
}

export async function authenticateLocalPage(t: Tendril, req: Request, link: Link): Promise<{ principal: PagePrincipal; session: PageSession | null }> {
  const session = link.role === "display" ? null : await browserSession(t, req);
  const principal = localPagePrincipal(t, { role: link.role, accountId: session?.account_id ?? null,
    linkId: link.id, sessionHash: session?.hash ?? null });
  if (!principal) throw new HttpError(401, "unauthorized", "Page sign-in required");
  return { principal, session };
}
