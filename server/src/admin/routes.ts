/** Versioned, backend-only administration. No page-content or generic SQL APIs. */
import type { Env } from "../env";
import { errorResponse, HttpError, isPlainObject, json, readJson } from "../http";
import { createPremiumGrant, listPremiumGrants, revokePremiumGrant } from "../billing/premium-grants";
import { authenticateAdmin, requireAdminScope } from "./auth";
import { queryServiceAnalytics } from "./analytics";

export const ADMIN_API_PREFIX = "/api/admin/v1";
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function queryKeys(url: URL, allowed: readonly string[]): void {
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) {
      throw new HttpError(400, "invalid_query", "Unknown or repeated query parameter.");
    }
  }
}

function limitParam(url: URL): number {
  const value = url.searchParams.get("limit") ?? "50";
  if (!/^[0-9]{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100) {
    throw new HttpError(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  return Number(value);
}

async function body(req: Request, allowed: readonly string[]): Promise<Record<string, unknown>> {
  if (req.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Administration requires application/json.");
  }
  const input: unknown = await readJson(req, 4096);
  if (!isPlainObject(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    throw new HttpError(400, "invalid_body", "Expected a JSON object containing only declared fields.");
  }
  return input;
}

interface AuditRow { id: string; actor: string; action: string; subject: string; reason: string | null; created_at: number }

async function premiumAudit(env: Env, url: URL) {
  queryKeys(url, ["limit", "before"]);
  const limit = limitParam(url);
  let cursor: { at: number; id: string } | null = null;
  const raw = url.searchParams.get("before");
  if (raw !== null) {
    try {
      if (!raw || raw.length > 256) throw new Error();
      const value: unknown = JSON.parse(atob(raw));
      if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "at,id" ||
          !Number.isSafeInteger(value.at) || value.at < 0 || typeof value.id !== "string" ||
          !/^[A-Za-z0-9:_-]{1,128}$/.test(value.id)) throw new Error();
      cursor = { at: value.at, id: value.id };
    } catch { throw new HttpError(400, "invalid_cursor", "Invalid audit cursor."); }
  }
  const records = await env.ACCOUNTS.prepare(`SELECT id, actor, action, subject, reason, created_at FROM audit_log
    WHERE action IN ('premium:grant', 'premium:revoke')
      ${cursor ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...(cursor ? [cursor.at, cursor.at, cursor.id] : []), limit + 1).all<AuditRow>();
  const rows = records.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    entries: rows.map(row => ({ id: row.id, actor: row.actor, action: row.action, subject: row.subject, reason: row.reason, createdAt: row.created_at })),
    nextCursor: records.results.length > limit && last ? btoa(JSON.stringify({ at: last.created_at, id: last.id })) : null,
  };
}

export async function routeAdministration(req: Request, env: Env, url = new URL(req.url)): Promise<Response> {
  let response: Response;
  try {
    const principal = await authenticateAdmin(req, env);
    const path = url.pathname;
    if (path === ADMIN_API_PREFIX && req.method === "GET") {
      queryKeys(url, []);
      response = json({ version: 1, operator: principal.id, scopes: principal.scopes });
    } else if (path === `${ADMIN_API_PREFIX}/analytics` && req.method === "GET") {
      requireAdminScope(principal, "analytics:read");
      queryKeys(url, ["from", "to"]);
      response = json(await queryServiceAnalytics(env, {
        ...(url.searchParams.has("from") ? { from: url.searchParams.get("from")! } : {}),
        ...(url.searchParams.has("to") ? { to: url.searchParams.get("to")! } : {}),
      }));
    } else if (path === `${ADMIN_API_PREFIX}/premium-grants` && req.method === "POST") {
      requireAdminScope(principal, "premium:write");
      queryKeys(url, []);
      const input = await body(req, ["id", "accountId", "plan", "expiresAt", "reason"]);
      if (typeof input.accountId !== "string" || !ACCOUNT_ID.test(input.accountId) ||
          typeof input.id !== "string" || !GRANT_ID.test(input.id) ||
          (input.plan !== "pro" && input.plan !== "team") || typeof input.expiresAt !== "number" || typeof input.reason !== "string") {
        throw new HttpError(400, "invalid_grant", "Specify a grant UUID, accountId, pro/team plan, expiresAt in milliseconds and reason.");
      }
      const result = await createPremiumGrant(env, principal.actor, {
        id: input.id, accountId: input.accountId, plan: input.plan, expiresAt: input.expiresAt, reason: input.reason,
      });
      response = json(result, result.created ? 201 : 200);
    } else if (path === `${ADMIN_API_PREFIX}/premium-grants` && req.method === "GET") {
      requireAdminScope(principal, "premium:read");
      queryKeys(url, ["accountId", "limit", "before"]);
      const accountId = url.searchParams.get("accountId") ?? "";
      if (!ACCOUNT_ID.test(accountId)) throw new HttpError(400, "invalid_account", "An exact accountId is required.");
      response = json(await listPremiumGrants(env, accountId, {
        limit: limitParam(url), ...(url.searchParams.has("before") ? { before: url.searchParams.get("before")! } : {}),
      }));
    } else if (path.startsWith(`${ADMIN_API_PREFIX}/premium-grants/`) && path.endsWith("/revoke") && req.method === "POST") {
      requireAdminScope(principal, "premium:write");
      queryKeys(url, []);
      const id = path.slice(`${ADMIN_API_PREFIX}/premium-grants/`.length, -"/revoke".length);
      if (!GRANT_ID.test(id)) throw new HttpError(404, "not_found");
      const input = await body(req, ["reason"]);
      if (typeof input.reason !== "string") throw new HttpError(400, "invalid_reason", "A reason is required.");
      response = json(await revokePremiumGrant(env, principal.actor, id, input.reason));
    } else if (path === `${ADMIN_API_PREFIX}/audit` && req.method === "GET") {
      requireAdminScope(principal, "audit:read");
      response = json(await premiumAudit(env, url));
    } else {
      response = errorResponse(404, "not_found");
    }
  } catch (error) {
    if (error instanceof HttpError) response = errorResponse(error.status, error.code, error.message, error.extra);
    else {
      // A database error can contain bound values. Never log the exception,
      // request, body or credential on this sensitive boundary.
      console.warn("admin_api_unavailable");
      response = errorResponse(503, "admin_unavailable", "Administration is temporarily unavailable.");
    }
  }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  // Deliberately bypass the public API's wildcard CORS and OPTIONS handler.
  return response;
}
