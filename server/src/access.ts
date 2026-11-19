// Authentication resolves identity. Authorization and activity recording are explicit.
import type { Role } from "../../contract/index.mjs";
import type { Link, Tendril } from "./tendril";
import { HttpError } from "./http";
import { safeEqual, sha256Hex } from "./ids";

export const AGENT_SCOPES = ['host:read', 'host:manage', 'agents:delegate', 'participants:connect', 'control:write', 'publication:write', 'assistant:manage'] as const;
export type AgentScope = typeof AGENT_SCOPES[number];
export interface AgentBinding { id: string; scopes: AgentScope[]; revision: number }
export interface AgentPrincipal { kind: "agent"; name: string; credentialHash: string; binding?: AgentBinding }
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
export function agentBinding(t: Tendril, name: string): AgentBinding | null {
  return t.db.get<AgentBinding | null>('agent_binding:' + name, null);
}
export function hasAgentScope(principal: AgentPrincipal, scope: AgentScope): boolean {
  // Principals without a binding are historical bootstrap credentials. New
  // credentials always carry explicit scopes, including the initial owner key.
  return !principal.binding || principal.binding.scopes.includes(scope);
}
export function requireAgentScope(principal: AgentPrincipal, scope: AgentScope): void {
  if (!hasAgentScope(principal, scope)) throw new HttpError(403, 'agent_scope_required', `This agent binding requires ${scope}.`);
}
export function agentScopes(value: unknown, fallback: readonly AgentScope[] = AGENT_SCOPES): AgentScope[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > AGENT_SCOPES.length || !value.length || new Set(value).size !== value.length ||
      value.some(scope => !AGENT_SCOPES.includes(scope))) throw new HttpError(400, 'invalid_agent_scopes');
  return value as AgentScope[];
}
export function requireAccess(principal: Principal, action: AccessAction): void {
  if (!allows(principal, action)) throw new HttpError(403, 'forbidden');
}

// Cache immutable row snapshots only within this live object. Db invalidates
// every snapshot on local writes and rollback; time-dependent checks stay below.
const localToken = (t: Tendril, hash: string) => t.db.cached(`access:token:${hash}`, () =>
  t.db.one<{ name: string; hash: string }>("SELECT name,hash FROM tokens WHERE hash=?", hash));
const localSession = (t: Tendril, hash: string) => t.db.cached(`access:session:${hash}`, () =>
  t.db.one<{ account_id: string; role: Role; expires_at: number }>("SELECT account_id,role,expires_at FROM page_sessions WHERE hash=?", hash));

export async function authenticateAgentToken(t: Tendril, token: string): Promise<AgentPrincipal> {
  const hash = await sha256Hex(token);
  const row = localToken(t, hash);
  if (!row || !safeEqual(row.hash, hash)) throw new HttpError(401, "unauthorized", "Invalid or revoked token");
  const binding = agentBinding(t, row.name);
  return { kind: "agent", name: row.name, credentialHash: hash, ...(binding ? { binding } : {}) };
}

export async function authenticateAgent(t: Tendril, req: Request): Promise<AgentPrincipal> {
  const token = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) throw new HttpError(401, "unauthorized", "Missing Authorization: Bearer <token>");
  return authenticateAgentToken(t, token);
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
  if (localToken(t, principal.credentialHash)?.name !== principal.name) return null;
  const binding = agentBinding(t, principal.name);
  return JSON.stringify(binding) === JSON.stringify(principal.binding ?? null) ? principal : null;
}

/** Route ownership retains the exact credential incarnation for narrow revocation.
 * Capacity belongs to the human account (or the unclaimed page), so adding or
 * rotating a named agent never multiplies its delegating principal's budget. */
export function participantIdentity(t: Tendril, principal: Principal): { route: string; budget: string } {
  const current = currentPrincipal(t, principal);
  if (!current || current.kind === 'page' && (current.role === 'display' || !current.accountId))
    throw new HttpError(403, 'forbidden', 'Peer participation requires an authenticated participant');
  if (current.kind === 'agent') {
    requireAgentScope(current, 'participants:connect');
    const owner = t.db.get<string | null>('owner_account', null);
    return { route: `agent:${current.credentialHash}`, budget: owner ? `account:${owner}` : `page:${t.tid}` };
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
