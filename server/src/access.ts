// Authentication resolves identity. Authorization and activity recording are explicit.
import type { Role, StreamInfo } from "../../contract/index.mjs";
import type { Att, Link, Tendril } from "./tendril";
import { HttpError } from "./http";
import { safeEqual, sha256Hex } from "./ids";

export interface AgentPrincipal { kind: "agent"; name: string; credentialHash: string }
export interface ProducerPrincipal { kind: "producer"; name: string; credentialHash: string; streams: string[] }
export interface PagePrincipal {
  kind: "page"; name: string; role: Role; accountId: string | null; linkId: string;
  sessionHash: string | null; deviceId: string | null;
}
export type Principal = AgentPrincipal | ProducerPrincipal | PagePrincipal;
/** Small reader identity also used by trusted in-process stream adapters. */
export interface StreamActor { kind: "agent" | "page"; name: string; role?: Role }
export interface PageSession { account_id: string; role: Role; hash: string }
export type AccessAction = "agent.manage" | "page.owner" | "page.write" | "stream.read" | "stream.append";
type StreamResource = Pick<StreamInfo, "name" | "readers" | "builtin">;

export function canReadStream(info: Pick<StreamInfo, "readers">, actor: StreamActor): boolean {
  return actor.kind === "agent" || info.readers === "page" || info.readers === "owner" && actor.role === "owner";
}

export function allows(principal: Principal, action: AccessAction, stream?: StreamResource): boolean {
  switch (action) {
    case "agent.manage": return principal.kind === "agent";
    case "page.owner": return principal.kind === "page" && principal.role === "owner";
    case "page.write": return principal.kind === "page" && principal.role !== "display";
    case "stream.read": return !!stream && principal.kind !== "producer" && canReadStream(stream, principal);
    case "stream.append": return !!stream && !stream.builtin && (principal.kind === "agent"
      || principal.kind === "page" && principal.role === "owner"
      || principal.kind === "producer" && producerMayAppend(principal, stream.name));
  }
}

export function requireAccess(principal: Principal, action: AccessAction, stream?: StreamResource): void {
  if (!allows(principal, action, stream)) throw new HttpError(403, "forbidden", "This identity is not allowed to perform this operation");
}

export async function authenticateAgentToken(t: Tendril, token: string): Promise<AgentPrincipal> {
  const hash = await sha256Hex(token);
  const row = t.db.one<{ name: string; hash: string }>("SELECT name,hash FROM tokens WHERE hash=?", hash);
  if (!row || !safeEqual(row.hash, hash)) throw new HttpError(401, "unauthorized", "Invalid or revoked token");
  return { kind: "agent", name: row.name, credentialHash: hash };
}

export async function authenticateAgent(t: Tendril, req: Request): Promise<AgentPrincipal> {
  const token = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) throw new HttpError(401, "unauthorized", "Missing Authorization: Bearer <token>");
  return authenticateAgentToken(t, token);
}

export async function authenticateProducer(t: Tendril, req: Request): Promise<ProducerPrincipal> {
  const token = /^Bearer\s+(tp_[a-z2-7]{40})\s*$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) throw new HttpError(401, "unauthorized", "Invalid producer credential");
  const hash = await sha256Hex(token);
  const row = t.db.one<{ name: string; streams: string }>("SELECT name,streams FROM stream_producers WHERE hash=?", hash);
  if (!row) throw new HttpError(401, "unauthorized", "Invalid or revoked producer credential");
  return { kind: "producer", name: row.name, credentialHash: hash, streams: JSON.parse(row.streams) };
}

export function producerStillValid(t: Tendril, principal: ProducerPrincipal): boolean {
  return !!t.db.one("SELECT name FROM stream_producers WHERE hash=?", principal.credentialHash);
}
export function producerMayAppend(principal: ProducerPrincipal, stream: string): boolean {
  return !stream.startsWith("system.") && principal.streams.includes(stream);
}
export function recordProducerActivity(t: Tendril, principal: ProducerPrincipal): void {
  t.db.run("UPDATE stream_producers SET last_seen=? WHERE hash=?", t.now(), principal.credentialHash);
  t.db.set("last_producer_seen", t.now());
  t.scheduleAlarm();
}

/** One account/page policy for HTTP, socket requests, and ongoing stream delivery. */
export async function pageAccessAllowed(t: Tendril): Promise<boolean> {
  if (t.db.get("disabled", false)) return false;
  const status = await t.env.ACCOUNTS.prepare(`SELECT t.state,t.owner_account,a.id AS owner_id,a.suspended_at,a.deleting_at
    FROM tendrils t LEFT JOIN accounts a ON a.id=t.owner_account WHERE t.id=?`).bind(t.tid)
    .first<{ state: string; owner_account: string | null; owner_id: string | null; suspended_at: number | null; deleting_at: number | null }>();
  return !t.db.get("disabled", false) && !!status && status.state === "active"
    && status.owner_account === t.db.get<string | null>("owner_account", null)
    && (!status.owner_account || !!status.owner_id)
    && status.suspended_at === null && status.deleting_at === null;
}
export async function accountActive(t: Tendril, accountId: string): Promise<boolean> {
  return !!await t.env.ACCOUNTS.prepare("SELECT 1 FROM accounts WHERE id=? AND suspended_at IS NULL AND deleting_at IS NULL").bind(accountId).first();
}

export async function readPageSession(t: Tendril, req: Request): Promise<PageSession | null> {
  const token = /(?:^|;\s*)__Host-tendril=([^;]+)/.exec(req.headers.get("Cookie") ?? "")?.[1];
  if (!token) return null;
  const hash = await sha256Hex(token);
  const read = () => t.db.one<{ account_id: string; role: Role }>("SELECT account_id,role FROM page_sessions WHERE hash=? AND expires_at>?", hash, t.now());
  const session = read();
  if (!session || !await accountActive(t, session.account_id)) return null;
  // The account query yields; the local session may have expired or been revoked.
  const current = read();
  return current && current.account_id === session.account_id && current.role === session.role ? { ...current, hash } : null;
}

function localPagePrincipal(t: Tendril, identity: Omit<PagePrincipal, "kind" | "name">): PagePrincipal | null {
  if (t.db.get("disabled", false)) return null;
  const link = t.db.one<{ role: Role; expires_at: number | null; created_by_agent: number }>("SELECT role,expires_at,created_by_agent FROM links WHERE id=?", identity.linkId);
  if (!link || link.role !== identity.role || link.expires_at !== null && link.expires_at <= t.now()) return null;
  if (identity.role === "display") {
    if (link.created_by_agent || !t.db.get("owner_account", null)) return null;
  } else {
    if (!identity.sessionHash || !t.db.one("SELECT 1 FROM page_sessions WHERE hash=? AND account_id=? AND role=? AND expires_at>?",
      identity.sessionHash, identity.accountId, identity.role, t.now())) return null;
    if (identity.role === "owner" && identity.accountId !== t.db.get("owner_account", null)) return null;
    if (identity.role === "guest" && !t.db.one("SELECT 1 FROM guest_accounts WHERE account_id=? AND link_id=? AND approved=1", identity.accountId, identity.linkId)) return null;
  }
  return { kind: "page", name: identity.accountId ?? identity.linkId, ...identity };
}

export async function authenticatePage(t: Tendril, req: Request, link: Link): Promise<{ principal: PagePrincipal; session: PageSession | null }> {
  const session = await readPageSession(t, req);
  const principal = localPagePrincipal(t, { role: link.role, accountId: session?.account_id ?? null,
    linkId: link.id, sessionHash: session?.hash ?? null, deviceId: null });
  if (!principal) throw new HttpError(401, "unauthorized", "Page sign-in required");
  return { principal, session };
}

interface SocketAccessOptions { fresh?: boolean; beforeHello?: boolean }

export function socketPrincipal(t: Tendril, ws: WebSocket, options: SocketAccessOptions = {}): PagePrincipal | null {
  const att = t.att(ws);
  if (!att?.sessionRole || !options.beforeHello && !att.deviceId || att.deviceId && !t.device(att.deviceId)) return null;
  return localPagePrincipal(t, { role: att.sessionRole, accountId: att.accountId ?? null, linkId: att.linkId,
    sessionHash: att.sessionHash ?? null, deviceId: att.deviceId });
}

export async function authorizeSocket(t: Tendril, ws: WebSocket, options: SocketAccessOptions = {}): Promise<PagePrincipal | null> {
  let principal = socketPrincipal(t, ws, options);
  const att = t.att(ws);
  if (!principal || !att) return null;
  if (options.fresh || !att.checkedAt || t.now() - att.checkedAt > 1000) {
    if (!await pageAccessAllowed(t) || principal.accountId && !await accountActive(t, principal.accountId)) return null;
    // Preserve stream cursors advanced during asynchronous account checks.
    principal = socketPrincipal(t, ws, options);
    if (!principal) return null;
    ws.serializeAttachment({ ...t.att(ws)!, checkedAt: t.now() } satisfies Att);
  }
  return principal;
}
