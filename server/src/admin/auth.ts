/** Operator credentials are independent of accounts, page keys, agents and MCP. */
import type { Env } from "../env";
import { HttpError, isPlainObject } from "../http";
import { safeEqual, sha256Hex } from "../ids";
import { publicBase } from "../urls";

export const ADMIN_SCOPES = ["analytics:read", "premium:read", "premium:write", "audit:read"] as const;
export type AdminScope = typeof ADMIN_SCOPES[number];
export const ADMIN_CREDENTIAL_MAX_AGE_MS = 90 * 86_400_000;
const OPERATOR_ID = /^[a-z][a-z0-9_-]{2,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONFIG_FIELDS = new Set(["id", "sha256", "scopes", "issuedAt", "expiresAt", "revoked"]);

interface Credential {
  id: string;
  sha256: string;
  scopes: AdminScope[];
  issuedAt: number;
  expiresAt: number;
  revoked?: boolean;
}

export interface AdminPrincipal {
  id: string;
  actor: string;
  scopes: readonly AdminScope[];
}

/** Reject the whole configuration on ambiguity; never silently widen a scope. */
function credentials(raw: string | undefined): Credential[] {
  if (!raw) return [];
  if (raw.length > 32_768) throw new Error("invalid_admin_configuration");
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 32) throw new Error("invalid_admin_configuration");
  const ids = new Set<string>(), hashes = new Set<string>();
  for (const record of value) {
    if (!isPlainObject(record) || Object.keys(record).some(key => !CONFIG_FIELDS.has(key)) ||
        typeof record.id !== "string" || !OPERATOR_ID.test(record.id) || ids.has(record.id) ||
        typeof record.sha256 !== "string" || !HASH.test(record.sha256) || hashes.has(record.sha256) ||
        !Array.isArray(record.scopes) || !record.scopes.length || record.scopes.length > ADMIN_SCOPES.length ||
        new Set(record.scopes).size !== record.scopes.length ||
        record.scopes.some((scope: unknown) => !ADMIN_SCOPES.includes(scope as AdminScope)) ||
        !Number.isSafeInteger(record.issuedAt) || record.issuedAt < 0 ||
        !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.issuedAt ||
        record.expiresAt - record.issuedAt > ADMIN_CREDENTIAL_MAX_AGE_MS ||
        (record.revoked !== undefined && typeof record.revoked !== "boolean")) {
      throw new Error("invalid_admin_configuration");
    }
    ids.add(record.id); hashes.add(record.sha256);
  }
  return value as Credential[];
}

function checkOrigin(req: Request, env: Env): void {
  const url = new URL(req.url);
  const expected = new URL(publicBase(env)).origin;
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
  if (url.origin !== expected || (url.protocol !== "https:" && !loopback)) {
    throw new HttpError(404, "not_found");
  }
  const origin = req.headers.get("Origin");
  const fetchSite = req.headers.get("Sec-Fetch-Site");
  // No browser credential sharing or non-same-origin administration (including same-site subdomains), even on GETs.
  if ((origin !== null && origin !== expected) || (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none")) {
    throw new HttpError(403, "bad_origin", "Administration requires the service origin.");
  }
}

async function denyCredential(req: Request, env: Env): Promise<never> {
  // Use an existing edge rate-limit namespace with a disjoint prefix. Never
  // persist the address, Authorization header or any failed credential in D1.
  if (env.FAILED_AUTH_RATE && !(await env.FAILED_AUTH_RATE.limit({
    key: `admin:${(req.headers.get("CF-Connecting-IP") ?? "unknown").slice(0, 64)}`,
  })).success) throw new HttpError(429, "rate_limited", "Too many administration attempts.");
  throw new HttpError(401, "unauthorized", "An active operator credential is required.");
}

/** Machine-only authentication: an invalid bearer can never fall back to cookies. */
export async function authenticateAdmin(req: Request, env: Env, now = Date.now()): Promise<AdminPrincipal> {
  checkOrigin(req, env);
  let configured: Credential[];
  try { configured = credentials(env.ADMIN_API_CREDENTIALS_JSON); }
  catch { throw new HttpError(503, "admin_unavailable", "Operator credentials are not configured correctly."); }
  if (!configured.length) throw new HttpError(404, "not_found");
  const match = /^[Bb][Ee][Aa][Rr][Ee][Rr] (td_admin_[a-f0-9]{64})$/.exec(req.headers.get("Authorization") ?? "");
  if (!match) return denyCredential(req, env);
  const hash = await sha256Hex(match[1]);
  let principal: Credential | undefined;
  for (const candidate of configured) {
    const matches = safeEqual(hash, candidate.sha256);
    if (matches && !candidate.revoked && candidate.issuedAt <= now && now < candidate.expiresAt) principal = candidate;
  }
  if (!principal) return denyCredential(req, env);
  if (env.AUTH_RATE && !(await env.AUTH_RATE.limit({ key: `admin:${principal.id}` })).success) {
    throw new HttpError(429, "rate_limited", "Too many operator requests.");
  }
  return { id: principal.id, actor: `operator:${principal.id}`, scopes: [...principal.scopes] };
}

export function requireAdminScope(principal: AdminPrincipal, scope: AdminScope): void {
  if (!principal.scopes.includes(scope)) throw new HttpError(403, "forbidden", "Operator credential lacks the required scope.");
}
