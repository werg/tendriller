/** Per-account tier entitlement resolution, coalesced usage accounting, and structured quota errors. */
import type { Env } from "../env";
import { HttpError } from "../http";
import { publicBase } from "../urls";
import { currentUsagePeriod, estimateOverageCents, isPlanId, planSpec, type PlanId, type PlanQuotas } from "./plans";

export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PAYG_SPEND_CAP_CENTS = 2500;

export type QuotaKind =
  | "pages"
  | "residents"
  | "storage"
  | "page_storage"
  | "agents"
  | "guests"
  | "mcp_pages"
  | "mcp_calls"
  | "mcp_store"
  | "media_bytes"
  | "sfu"
  | "relay_concurrent"
  | "relay_duration";

export interface SubscriptionSummary {
  provider: string;
  customerId: string | null;
  subscriptionId: string | null;
  planId: PlanId;
  billingInterval: "month" | "year";
  status: "active" | "trialing" | "past_due" | "canceled" | "incomplete" | "revoked";
  periodStart: number | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: number | null;
}

export interface UsageSnapshot {
  period: string;
  resetsAt: string;
  mcpCalls: number;
  relayMs: number;
  relayBytes: number;
  mediaBytes: number;
  reportedMediaOverageMb: number;
  reportedMcpOverageCalls: number;
}

export interface AccountEntitlements {
  accountId: string;
  plan: PlanId;
  /** True when global service_state caps are NULL (localhost / self-hosted unlimited mode) or account plan is unlimited. */
  unlimitedHost: boolean;
  billingConfigured: boolean;
  quotas: PlanQuotas;
  paygEnabled: boolean;
  /** Monthly spend cap in integer cents; null means user explicitly disabled the cap (uncapped PAYG). */
  paygSpendCapCents: number | null;
  overage: {
    mediaCents: number;
    mcpCents: number;
    totalCents: number;
    mediaOverageBytes: number;
    mcpOverageCalls: number;
    withinSpendCap: boolean;
  };
  subscription: SubscriptionSummary | null;
  inGracePeriod: boolean;
  usage: UsageSnapshot;
}

export function billingConfigured(env: Env): boolean {
  return Boolean(env.POLAR_ACCESS_TOKEN && env.POLAR_PRODUCTS_JSON) || env.BILLING_ENABLED === "1";
}

interface AccountRow {
  plan?: string | null;
  page_cap?: number | null;
  resident_cap?: number | null;
  storage_cap?: number | null;
  agent_cap?: number | null;
  guest_cap?: number | null;
  version_retention_cap?: number | null;
  mcp_page_cap?: number | null;
  mcp_call_cap?: number | null;
  mcp_store_cap?: number | null;
  media_bytes_cap?: number | null;
  relay_ms_cap?: number | null;
  relay_concurrent_cap?: number | null;
  payg_enabled?: number | null;
  payg_spend_cap_cents?: number | null;
}

interface ServiceCapRow {
  account_page_cap: number | null;
  account_resident_cap: number | null;
  account_storage_cap: number | null;
}

interface SubRow {
  provider: string;
  customer_id: string | null;
  subscription_id: string | null;
  plan_id: string;
  billing_interval: string;
  status: string;
  period_start: number | null;
  period_end: number | null;
  cancel_at_period_end: number;
  grace_until: number | null;
}

interface UsageRow {
  mcp_calls: number;
  relay_ms: number;
  relay_bytes: number;
  media_bytes: number;
  reported_media_overage_mb: number;
  reported_mcp_overage_calls: number;
}

/** Resolve an account's effective tier, caps, subscription status, and current-period usage. */
export async function getAccountEntitlements(env: Env, accountId: string, now = Date.now()): Promise<AccountEntitlements> {
  const { period, resetsAt } = currentUsagePeriod(now);
  const configured = billingConfigured(env);

  let serviceCaps: ServiceCapRow | null = null;
  let account: AccountRow | null = null;
  let sub: SubRow | null = null;
  let usageRow: UsageRow | null = null;

  if (env.ACCOUNTS) {
    try {
      const [sc, acc, s, u] = await Promise.all([
        env.ACCOUNTS.prepare("SELECT account_page_cap, account_resident_cap, account_storage_cap FROM service_state WHERE id = 1")
          .first<ServiceCapRow>().catch(() => null),
        env.ACCOUNTS.prepare(`SELECT plan, page_cap, resident_cap, storage_cap, agent_cap, guest_cap, version_retention_cap,
          mcp_page_cap, mcp_call_cap, mcp_store_cap, media_bytes_cap, relay_ms_cap, relay_concurrent_cap,
          payg_enabled, payg_spend_cap_cents FROM accounts WHERE id = ?`)
          .bind(accountId).first<AccountRow>().catch(() => null),
        env.ACCOUNTS.prepare(`SELECT provider, customer_id, subscription_id, plan_id, billing_interval, status,
          period_start, period_end, cancel_at_period_end, grace_until FROM subscriptions WHERE account_id = ?`)
          .bind(accountId).first<SubRow>().catch(() => null),
        env.ACCOUNTS.prepare(`SELECT mcp_calls, relay_ms, relay_bytes, media_bytes,
          reported_media_overage_mb, reported_mcp_overage_calls FROM usage_periods WHERE account_id = ? AND period = ?`)
          .bind(accountId, period).first<UsageRow>().catch(() => null),
      ]);
      serviceCaps = sc;
      account = acc;
      sub = s;
      usageRow = u;
    } catch {
      /* fall back to defaults if schema is partially initialized */
    }
  }

  const serviceUnlimited =
    serviceCaps !== null &&
    serviceCaps.account_page_cap === null &&
    serviceCaps.account_resident_cap === null &&
    serviceCaps.account_storage_cap === null;

  let plan: PlanId = isPlanId(account?.plan) ? account!.plan : "free";
  const subscription: SubscriptionSummary | null = sub && isPlanId(sub.plan_id) ? {
    provider: sub.provider,
    customerId: sub.customer_id,
    subscriptionId: sub.subscription_id,
    planId: sub.plan_id,
    billingInterval: sub.billing_interval === "year" ? "year" : "month",
    status: sub.status as SubscriptionSummary["status"],
    periodStart: sub.period_start,
    periodEnd: sub.period_end,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    graceUntil: sub.grace_until,
  } : null;

  let inGracePeriod = false;
  if (subscription && subscription.status === "past_due") {
    if (subscription.graceUntil !== null && subscription.graceUntil > now) {
      inGracePeriod = true;
    } else if (plan !== "unlimited") {
      // Grace period expired: treat effective entitlements as Free until payment recovers.
      plan = "free";
    }
  }

  const unlimitedHost = serviceUnlimited || plan === "unlimited";
  const effectivePlan: PlanId = unlimitedHost ? "unlimited" : plan;
  const base = planSpec(effectivePlan).quotas;

  // Materialized columns on `accounts` can override plan defaults (e.g. comps/beta);
  // in unlimited host mode, caps stay null (unlimited).
  const pick = (override: number | null | undefined, fallback: number | null): number | null =>
    unlimitedHost ? null : (override ?? fallback);

  const quotas: PlanQuotas = {
    ...base,
    pages: pick(account?.page_cap, serviceCaps ? serviceCaps.account_page_cap : base.pages),
    residents: pick(account?.resident_cap, serviceCaps ? serviceCaps.account_resident_cap : base.residents),
    storageBytes: pick(account?.storage_cap, serviceCaps ? serviceCaps.account_storage_cap : base.storageBytes),
    agents: pick(account?.agent_cap, base.agents),
    guestsPerPage: pick(account?.guest_cap, base.guestsPerPage),
    versionRetention: pick(account?.version_retention_cap, base.versionRetention),
    mcpPages: pick(account?.mcp_page_cap, base.mcpPages),
    mcpCallsPerMonth: pick(account?.mcp_call_cap, base.mcpCallsPerMonth),
    mcpStoreBytes: pick(account?.mcp_store_cap, base.mcpStoreBytes),
    mediaBytesPerMonth: pick(account?.media_bytes_cap, base.mediaBytesPerMonth),
    relayMsPerMonth: pick(account?.relay_ms_cap, base.relayMsPerMonth),
    relayConcurrentSessions: pick(account?.relay_concurrent_cap, base.relayConcurrentSessions),
  };

  // If the account's plan has explicit non-free caps (e.g., pro/team), honor them even when service_state has Free defaults.
  if (!unlimitedHost && effectivePlan !== "free") {
    quotas.pages = account?.page_cap ?? base.pages;
    quotas.residents = account?.resident_cap ?? base.residents;
    quotas.storageBytes = account?.storage_cap ?? base.storageBytes;
  }

  const usage: UsageSnapshot = {
    period,
    resetsAt,
    mcpCalls: usageRow?.mcp_calls ?? 0,
    relayMs: usageRow?.relay_ms ?? 0,
    relayBytes: usageRow?.relay_bytes ?? 0,
    mediaBytes: usageRow?.media_bytes ?? 0,
    reportedMediaOverageMb: usageRow?.reported_media_overage_mb ?? 0,
    reportedMcpOverageCalls: usageRow?.reported_mcp_overage_calls ?? 0,
  };

  const paygEnabled = !unlimitedHost && base.paygAllowed && Boolean(account?.payg_enabled);
  const paygSpendCapCents = account?.payg_spend_cap_cents === undefined
    ? DEFAULT_PAYG_SPEND_CAP_CENTS
    : account.payg_spend_cap_cents;

  const est = estimateOverageCents(effectivePlan, { mediaBytes: usage.mediaBytes, mcpCalls: usage.mcpCalls });
  const withinSpendCap = paygEnabled && (paygSpendCapCents === null || est.totalCents < paygSpendCapCents);

  return {
    accountId,
    plan: effectivePlan,
    unlimitedHost,
    billingConfigured: configured,
    quotas,
    paygEnabled,
    paygSpendCapCents,
    overage: { ...est, withinSpendCap },
    subscription,
    inGracePeriod,
    usage,
  };
}

/** Materialize a plan's canonical caps onto an account row (preserving non-destructive downgrade). */
export async function applyPlanToAccount(env: Env, accountId: string, plan: PlanId): Promise<void> {
  const q = planSpec(plan).quotas;
  await env.ACCOUNTS.prepare(`UPDATE accounts SET
    plan = ?,
    page_cap = ?,
    resident_cap = ?,
    storage_cap = ?,
    agent_cap = ?,
    guest_cap = ?,
    version_retention_cap = ?,
    mcp_page_cap = ?,
    mcp_call_cap = ?,
    mcp_store_cap = ?,
    media_bytes_cap = ?,
    relay_ms_cap = ?,
    relay_concurrent_cap = ?,
    payg_enabled = CASE WHEN ? = 1 THEN payg_enabled ELSE 0 END
    WHERE id = ?`)
    .bind(
      plan,
      q.pages,
      q.residents,
      q.storageBytes,
      q.agents,
      q.guestsPerPage,
      q.versionRetention,
      q.mcpPages,
      q.mcpCallsPerMonth,
      q.mcpStoreBytes,
      q.mediaBytesPerMonth,
      q.relayMsPerMonth,
      q.relayConcurrentSessions,
      q.paygAllowed ? 1 : 0,
      accountId,
    ).run();
}

/** Atomically increment monthly coalesced usage counters in D1 (never called per relay packet). */
export async function recordAccountUsage(
  env: Env,
  accountId: string,
  delta: { mcpCalls?: number; relayMs?: number; relayBytes?: number; mediaBytes?: number },
  now = Date.now(),
): Promise<void> {
  if (!env.ACCOUNTS || !accountId) return;
  const mcpCalls = Math.max(0, Math.floor(delta.mcpCalls ?? 0));
  const relayMs = Math.max(0, Math.floor(delta.relayMs ?? 0));
  const relayBytes = Math.max(0, Math.floor(delta.relayBytes ?? 0));
  const mediaBytes = Math.max(0, Math.floor(delta.mediaBytes ?? 0));
  if (!mcpCalls && !relayMs && !relayBytes && !mediaBytes) return;
  const { period } = currentUsagePeriod(now);
  try {
    await env.ACCOUNTS.prepare(`INSERT INTO usage_periods
      (account_id, period, mcp_calls, relay_ms, relay_bytes, media_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, period) DO UPDATE SET
        mcp_calls = mcp_calls + excluded.mcp_calls,
        relay_ms = relay_ms + excluded.relay_ms,
        relay_bytes = relay_bytes + excluded.relay_bytes,
        media_bytes = media_bytes + excluded.media_bytes,
        updated_at = excluded.updated_at`)
      .bind(accountId, period, mcpCalls, relayMs, relayBytes, mediaBytes, now).run();
  } catch {
    /* Non-fatal if account was deleted concurrently */
  }
}

/** Acquire a bounded concurrent relay lease for an account; returns false when over cap. */
export async function acquireRelayLease(
  env: Env,
  accountId: string,
  pageId: string,
  sessionId: string,
  expiresAt: number,
  cap: number | null,
  now = Date.now(),
): Promise<{ allowed: boolean; active: number }> {
  if (!env.ACCOUNTS || cap === null) return { allowed: true, active: 0 };
  try {
    await env.ACCOUNTS.prepare("DELETE FROM active_relay_leases WHERE account_id = ? AND expires_at <= ?")
      .bind(accountId, now).run();
    const row = await env.ACCOUNTS.prepare(
      "SELECT COUNT(*) AS n FROM active_relay_leases WHERE account_id = ? AND expires_at > ? AND session_id != ?",
    ).bind(accountId, now, sessionId).first<{ n: number }>();
    const active = row?.n ?? 0;
    if (active >= cap) return { allowed: false, active };
    await env.ACCOUNTS.prepare(`INSERT INTO active_relay_leases (session_id, account_id, page_id, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET expires_at = excluded.expires_at`)
      .bind(sessionId, accountId, pageId, expiresAt).run();
    return { allowed: true, active: active + 1 };
  } catch {
    return { allowed: true, active: 0 };
  }
}

export async function releaseRelayLease(env: Env, sessionId: string): Promise<void> {
  if (!env.ACCOUNTS) return;
  try {
    await env.ACCOUNTS.prepare("DELETE FROM active_relay_leases WHERE session_id = ?").bind(sessionId).run();
  } catch { /* non-fatal */ }
}

export interface QuotaErrorInput {
  env: Env;
  quota: QuotaKind;
  plan: PlanId;
  used: number;
  limit: number;
  message: string;
  status?: number;
  /** Optional legacy code override (defaults to `quota_exceeded`; callers needing `quota` for existing tests can pass `code: 'quota'`). */
  code?: string;
  resetsAt?: string | null;
  localAlternative?: string;
}

/** Build a structured, agent- and human-friendly quota HttpError with upgrade & self-host pointers. */
export function quotaError(input: QuotaErrorInput): HttpError {
  const origin = publicBase(input.env);
  const { resetsAt } = currentUsagePeriod();
  return new HttpError(
    input.status ?? 429,
    input.code ?? "quota_exceeded",
    input.message,
    {
      quota: input.quota,
      plan: input.plan,
      used: input.used,
      limit: input.limit,
      resetsAt: input.resetsAt === undefined ? resetsAt : input.resetsAt,
      localAlternative: input.localAlternative ?? "Your local device data stays editable offline; you can also run your own Tendriller host on Cloudflare with no limits.",
      upgradeUrl: `${origin}/dashboard/billing`,
      pricingUrl: `${origin}/pricing`,
      selfHostUrl: `${origin}/self-host`,
    },
  );
}

/** Check whether an account can make another hosted MCP call (including PAYG headroom). */
export function canConsumeMcpCall(ent: AccountEntitlements): { allowed: boolean; isOverage: boolean } {
  const cap = ent.quotas.mcpCallsPerMonth;
  if (ent.unlimitedHost || cap === null) return { allowed: true, isOverage: false };
  if (ent.usage.mcpCalls < cap) return { allowed: true, isOverage: false };
  if (ent.overage.withinSpendCap) return { allowed: true, isOverage: true };
  return { allowed: false, isOverage: true };
}

/** Check whether an account can consume TURN/SFU media bytes (including PAYG headroom). */
export function canConsumeMedia(ent: AccountEntitlements): { allowed: boolean; isOverage: boolean } {
  const cap = ent.quotas.mediaBytesPerMonth;
  if (ent.unlimitedHost || cap === null) return { allowed: true, isOverage: false };
  if (ent.usage.mediaBytes < cap) return { allowed: true, isOverage: false };
  if (ent.overage.withinSpendCap) return { allowed: true, isOverage: true };
  return { allowed: false, isOverage: true };
}
