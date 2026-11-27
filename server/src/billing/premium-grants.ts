/** Operator-controlled complimentary entitlements, separate from billing and page data. */
import type { Env } from "../env";
import { HttpError } from "../http";

export const MAX_PREMIUM_GRANT_EXPIRY_MS = 253_402_300_799_999;
export const PREMIUM_GRANT_REASON_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PremiumGrant {
  id: string;
  accountId: string;
  plan: "pro" | "team";
  createdAt: number;
  /** Optional expiry in epoch milliseconds; null means never expires unless revoked. */
  expiresAt: number | null;
  createdBy: string;
  reason: string;
  revokedAt: number | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export interface CreatePremiumGrantInput {
  /** Client-generated UUID retained unchanged on retry. */
  id: string;
  accountId: string;
  plan: "pro" | "team";
  /** Optional expiry in epoch milliseconds; omit or pass null for a never-expiring grant. */
  expiresAt?: number | null;
  reason: string;
}

interface GrantRow {
  id: string; account_id: string; plan_id: "pro" | "team";
  created_at: number; expires_at: number | null; created_by: string; reason: string;
  revoked_at: number | null; revoked_by: string | null; revoke_reason: string | null;
}

function grant(row: GrantRow): PremiumGrant {
  return { id: row.id, accountId: row.account_id, plan: row.plan_id, createdAt: row.created_at,
    expiresAt: row.expires_at, createdBy: row.created_by, reason: row.reason,
    revokedAt: row.revoked_at, revokedBy: row.revoked_by, revokeReason: row.revoke_reason };
}

function validateId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !UUID.test(id)) throw new HttpError(400, "invalid_grant_id", "Grant ID must be a lowercase UUID retained unchanged on retry.");
}

function validateActor(actor: string): void {
  if (typeof actor !== "string" || !/^operator:[A-Za-z0-9_-]{1,80}$/.test(actor)) throw new HttpError(400, "invalid_operator_actor");
}

function validateReason(reason: unknown): asserts reason is string {
  if (typeof reason !== "string" || reason !== reason.trim() || reason.length < 1 || reason.length > PREMIUM_GRANT_REASON_LIMIT || /[\u0000-\u001f\u007f]/.test(reason))
    throw new HttpError(400, "invalid_grant_reason", "Supply a nonempty, trimmed reason of at most 500 characters without control characters.");
}

function normalizeExpiresAt(expiresAt: unknown): number | null {
  if (expiresAt === undefined || expiresAt === null) return null;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > MAX_PREMIUM_GRANT_EXPIRY_MS) {
    throw new HttpError(400, "invalid_grant_expiry", "When supplied, expiresAt must be a valid timestamp in epoch milliseconds.");
  }
  return expiresAt;
}

function assertSameRequest(existing: PremiumGrant, actor: string, input: CreatePremiumGrantInput, expiresAt: number | null): void {
  if (existing.accountId !== input.accountId || existing.plan !== input.plan || existing.expiresAt !== expiresAt ||
    existing.reason !== input.reason || existing.createdBy !== actor)
    throw new HttpError(409, "grant_id_conflict", "That grant ID already identifies a different request.");
}

export async function getPremiumGrant(env: Env, id: string): Promise<PremiumGrant | null> {
  validateId(id);
  const row = await env.ACCOUNTS.prepare("SELECT * FROM premium_grants WHERE id = ?").bind(id).first<GrantRow>();
  return row ? grant(row) : null;
}

export async function createPremiumGrant(env: Env, actor: string, input: CreatePremiumGrantInput, now = Date.now()): Promise<{ grant: PremiumGrant; created: boolean }> {
  validateActor(actor);
  validateId(input?.id);
  validateReason(input.reason);
  if (typeof input.accountId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.accountId))
    throw new HttpError(400, "invalid_account_id");
  if (input.plan !== "pro" && input.plan !== "team") throw new HttpError(400, "invalid_grant_plan", "Only Pro or Team may be granted.");
  if (!Number.isSafeInteger(now) || now < 0) throw new HttpError(400, "invalid_grant_expiry");
  const expiresAt = normalizeExpiresAt(input.expiresAt);

  // A retry after expiry or revocation returns the original immutable result.
  const existing = await getPremiumGrant(env, input.id);
  if (existing) { assertSameRequest(existing, actor, input, expiresAt); return { grant: existing, created: false }; }
  if (expiresAt !== null && expiresAt <= now)
    throw new HttpError(400, "invalid_grant_expiry", "When supplied, expiresAt must be in the future.");

  // The active-account check is in the mutating statement, so suspension/deletion
  // cannot race a separate preflight. The ledger's trigger writes the audit atomically.
  const [inserted, selected] = await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare(`INSERT INTO premium_grants (id, account_id, plan_id, created_at, expires_at, created_by, reason)
      SELECT ?, id, ?, ?, ?, ?, ? FROM accounts WHERE id = ? AND suspended_at IS NULL AND deleting_at IS NULL
      ON CONFLICT(id) DO NOTHING`)
      .bind(input.id, input.plan, now, expiresAt, actor, input.reason, input.accountId),
    env.ACCOUNTS.prepare("SELECT * FROM premium_grants WHERE id = ?").bind(input.id),
  ]);
  const row = selected.results?.[0] as GrantRow | undefined;
  if (!row) throw new HttpError(404, "eligible_account_not_found", "No active account with that ID is eligible for a grant.");
  const result = grant(row);
  assertSameRequest(result, actor, input, expiresAt);
  return { grant: result, created: (inserted.meta.changes ?? 0) > 0 };
}

export async function revokePremiumGrant(env: Env, actor: string, id: string, reason: string, now = Date.now()): Promise<{ grant: PremiumGrant; revoked: boolean }> {
  validateActor(actor); validateId(id); validateReason(reason);
  if (!Number.isSafeInteger(now)) throw new HttpError(400, "invalid_time");
  // A concurrent revoke changes one row exactly once; the trigger preserves its
  // first actor/reason and audit. A retry is safe even when its response was lost.
  const [updated, selected] = await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare("UPDATE premium_grants SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, actor, reason, id),
    env.ACCOUNTS.prepare("SELECT * FROM premium_grants WHERE id = ?").bind(id),
  ]);
  const row = selected.results?.[0] as GrantRow | undefined;
  if (!row) throw new HttpError(404, "premium_grant_not_found");
  return { grant: grant(row), revoked: (updated.meta.changes ?? 0) > 0 };
}

/** Account-scoped history only; there is no account or page enumeration here. */
export async function listPremiumGrants(env: Env, accountId: string, options: { limit?: number; before?: string } = {}): Promise<{ grants: PremiumGrant[]; nextCursor: string | null }> {
  if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw new HttpError(400, "invalid_account_id");
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid_limit", "Limit must be between 1 and 100.");
  let before: GrantRow | null = null;
  if (options.before !== undefined) {
    validateId(options.before);
    before = await env.ACCOUNTS.prepare("SELECT * FROM premium_grants WHERE account_id = ? AND id = ?").bind(accountId, options.before).first<GrantRow>();
    if (!before) throw new HttpError(400, "invalid_cursor");
  }
  const query = before
    ? env.ACCOUNTS.prepare(`SELECT * FROM premium_grants WHERE account_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(accountId, before.created_at, before.created_at, before.id, limit + 1)
    : env.ACCOUNTS.prepare("SELECT * FROM premium_grants WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(accountId, limit + 1);
  const rows = (await query.all<GrantRow>()).results;
  const grants = rows.slice(0, limit).map(grant);
  return { grants, nextCursor: rows.length > limit ? grants[grants.length - 1].id : null };
}

/** Application checks use their operation clock; SQL quota guards use SQLite's live clock. */
export async function activePremiumGrant(env: Env, accountId: string, now: number): Promise<PremiumGrant | null> {
  const row = await env.ACCOUNTS.prepare(`SELECT g.* FROM premium_grants g JOIN accounts a ON a.id = g.account_id
    WHERE g.account_id = ? AND g.revoked_at IS NULL AND g.created_at <= ? AND (g.expires_at IS NULL OR g.expires_at > ?)
      AND a.suspended_at IS NULL AND a.deleting_at IS NULL
    ORDER BY CASE g.plan_id WHEN 'team' THEN 2 ELSE 1 END DESC, g.expires_at IS NOT NULL ASC, g.expires_at DESC, g.id DESC LIMIT 1`)
    .bind(accountId, now, now).first<GrantRow>();
  return row ? grant(row) : null;
}
