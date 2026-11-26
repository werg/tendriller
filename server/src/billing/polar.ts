/**
 * Polar.sh Merchant of Record adapter for Cloudflare Workers (native fetch + WebCrypto).
 * Handles Checkout Sessions, Customer Portal Sessions, Standard Webhooks HMAC verification,
 * idempotent subscription sync, and PAYG metered usage ingestion (`/v1/events/ingest`).
 */
import type { Env } from "../env";
import { HttpError, readBody } from "../http";
import { safeEqual } from "../ids";
import { applyPlanToAccount, PAST_DUE_GRACE_MS, type SubscriptionSummary } from "./entitlements";
import { isPlanId, type BillingInterval, type PlanId } from "./plans";

export interface PolarProductCatalog {
  pro_month?: string;
  pro_year?: string;
  team_month?: string;
  team_year?: string;
}

export interface PolarMeterCatalog {
  media_egress_gb: string;
  mcp_overage_calls: string;
}

export interface PolarUsageEvent {
  name: string;
  external_customer_id: string;
  external_id: string;
  timestamp: string;
  metadata: Record<string, string | number | boolean>;
}

const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;
const MAX_WEBHOOK_BYTES = 256 * 1024;

export function polarApiBase(env: Env): string {
  if (env.POLAR_API_BASE) return env.POLAR_API_BASE.replace(/\/+$/, "");
  return env.POLAR_SERVER === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";
}

export function parsePolarProducts(env: Env): PolarProductCatalog {
  if (!env.POLAR_PRODUCTS_JSON) return {};
  try {
    const parsed = JSON.parse(env.POLAR_PRODUCTS_JSON) as Record<string, unknown>;
    const pick = (k: string) => (typeof parsed[k] === "string" && parsed[k] ? (parsed[k] as string) : undefined);
    return {
      pro_month: pick("pro_month"),
      pro_year: pick("pro_year"),
      team_month: pick("team_month"),
      team_year: pick("team_year"),
    };
  } catch {
    return {};
  }
}

export function parsePolarMeters(env: Env): PolarMeterCatalog {
  const fallback: PolarMeterCatalog = {
    media_egress_gb: "media_egress_gb",
    mcp_overage_calls: "mcp_overage_calls",
  };
  if (!env.POLAR_METERS_JSON) return fallback;
  try {
    const parsed = JSON.parse(env.POLAR_METERS_JSON) as Record<string, unknown>;
    return {
      media_egress_gb: typeof parsed.media_egress_gb === "string" && parsed.media_egress_gb ? parsed.media_egress_gb : fallback.media_egress_gb,
      mcp_overage_calls: typeof parsed.mcp_overage_calls === "string" && parsed.mcp_overage_calls ? parsed.mcp_overage_calls : fallback.mcp_overage_calls,
    };
  } catch {
    return fallback;
  }
}

export function productIdForPlan(env: Env, plan: "pro" | "team", interval: BillingInterval): string | null {
  const catalog = parsePolarProducts(env);
  const key = `${plan}_${interval}` as keyof PolarProductCatalog;
  return catalog[key] ?? null;
}

export function planFromProductId(env: Env, productId: string | null | undefined): { plan: PlanId; interval: BillingInterval } | null {
  if (!productId) return null;
  const catalog = parsePolarProducts(env);
  if (productId === catalog.pro_month) return { plan: "pro", interval: "month" };
  if (productId === catalog.pro_year) return { plan: "pro", interval: "year" };
  if (productId === catalog.team_month) return { plan: "team", interval: "month" };
  if (productId === catalog.team_year) return { plan: "team", interval: "year" };
  return null;
}

async function polarFetch<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  if (!env.POLAR_ACCESS_TOKEN) {
    throw new HttpError(503, "billing_unconfigured", "Polar billing is not configured on this host.");
  }
  const res = await fetch(`${polarApiBase(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HttpError(502, "billing_upstream_error", `Polar API error (${res.status})`, {
      status: res.status,
      detail: detail.slice(0, 300),
    });
  }
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

export async function createPolarCheckout(
  env: Env,
  params: {
    accountId: string;
    email: string | null;
    plan: "pro" | "team";
    interval: BillingInterval;
    customerIp: string | null;
    successUrl: string;
    returnUrl: string;
  },
): Promise<{ id: string; url: string }> {
  const productId = productIdForPlan(env, params.plan, params.interval);
  if (!productId) {
    throw new HttpError(503, "billing_product_unconfigured", `Checkout for ${params.plan} (${params.interval}) is not configured yet.`);
  }
  const payload: Record<string, unknown> = {
    products: [productId],
    external_customer_id: params.accountId,
    success_url: params.successUrl,
    return_url: params.returnUrl,
    metadata: {
      account_id: params.accountId,
      plan: params.plan,
      interval: params.interval,
    },
  };
  if (params.email) payload.customer_email = params.email;
  if (params.customerIp) payload.customer_ip_address = params.customerIp;

  const data = await polarFetch<{ id: string; url: string }>(env, "POST", "/v1/checkouts/", payload);
  if (!data?.url) throw new HttpError(502, "billing_upstream_error", "Polar checkout did not return a redirect URL.");
  return data;
}

export async function createPolarCustomerSession(
  env: Env,
  params: { accountId: string; customerId?: string | null; returnUrl: string },
): Promise<{ customer_portal_url: string }> {
  const payload: Record<string, unknown> = {
    return_url: params.returnUrl,
    ...(params.customerId ? { customer_id: params.customerId } : { external_customer_id: params.accountId }),
  };
  const data = await polarFetch<{ customer_portal_url?: string }>(env, "POST", "/v1/customer-sessions/", payload);
  if (!data?.customer_portal_url) {
    throw new HttpError(502, "billing_upstream_error", "Polar customer portal session did not return a URL.");
  }
  return { customer_portal_url: data.customer_portal_url };
}

export async function ingestPolarUsageEvents(env: Env, events: PolarUsageEvent[]): Promise<{ inserted: number }> {
  if (!events.length) return { inserted: 0 };
  const res = await polarFetch<{ inserted?: number }>(env, "POST", "/v1/events/ingest", { events });
  return { inserted: typeof res?.inserted === "number" ? res.inserted : events.length };
}

function decodeWebhookSecret(secret: string): Uint8Array {
  const trimmed = secret.trim();
  const body = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  // Polar / Standard Webhooks secrets are either base64-encoded (with or without whsec_) or raw UTF-8.
  if (trimmed.startsWith("whsec_") || /^[A-Za-z0-9+/]+={0,2}$/.test(body) && body.length % 4 === 0 && body.length >= 24) {
    try {
      const bin = atob(body);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch { /* fall back to UTF-8 bytes */ }
  }
  return new TextEncoder().encode(trimmed);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Sign a payload according to Standard Webhooks (also exported for tests). */
export async function signStandardWebhook(webhookId: string, timestampSec: number, rawBody: string, secret: string): Promise<string> {
  const keyBytes = decodeWebhookSecret(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = `${webhookId}.${timestampSec}.${rawBody}`;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)));
  return `v1,${toBase64(mac)}`;
}

/** Verify Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`). */
export async function verifyStandardWebhook(
  headers: Headers,
  rawBody: string,
  secret: string,
  nowMs = Date.now(),
  toleranceSec = DEFAULT_WEBHOOK_TOLERANCE_SEC,
): Promise<{ webhookId: string; timestampSec: number }> {
  const webhookId = headers.get("webhook-id")?.trim() ?? "";
  const tsRaw = headers.get("webhook-timestamp")?.trim() ?? "";
  const sigHeader = headers.get("webhook-signature")?.trim() ?? "";
  if (!webhookId || !tsRaw || !sigHeader) {
    throw new HttpError(400, "invalid_webhook_headers", "Missing Standard Webhooks headers.");
  }
  if (!/^\d{9,12}$/.test(tsRaw)) {
    throw new HttpError(400, "invalid_webhook_timestamp", "Invalid webhook timestamp.");
  }
  const timestampSec = Number(tsRaw);
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - timestampSec) > toleranceSec) {
    throw new HttpError(400, "webhook_timestamp_expired", "Webhook timestamp is outside the allowed replay window.");
  }
  const expected = await signStandardWebhook(webhookId, timestampSec, rawBody, secret);
  const candidates = sigHeader.split(/\s+/).filter(Boolean);
  const matched = candidates.some(candidate => safeEqual(candidate, expected));
  if (!matched) {
    throw new HttpError(403, "invalid_webhook_signature", "Webhook signature verification failed.");
  }
  return { webhookId, timestampSec };
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeStatus(raw: unknown): SubscriptionSummary["status"] {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "active" || s === "trialing" || s === "past_due" || s === "canceled" || s === "incomplete" || s === "revoked") {
    return s;
  }
  if (s === "unpaid" || s === "incomplete_expired") return "revoked";
  return "active";
}

interface ParsedSubEvent {
  accountId: string;
  customerId: string | null;
  subscriptionId: string | null;
  planId: PlanId;
  interval: BillingInterval;
  status: SubscriptionSummary["status"];
  periodStart: number | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

const PLAN_RANK: Record<PlanId, number> = { free: 0, pro: 1, team: 2, unlimited: 3 };

function extractSubscriptionFromEvent(env: Env, type: string, data: Record<string, unknown>): ParsedSubEvent | null {
  if (type === "customer.state_changed") {
    const accountId = typeof data.external_id === "string" ? data.external_id : null;
    if (!accountId) return null;
    const customerId = typeof data.id === "string" ? data.id : null;
    const activeSubs = (Array.isArray(data.active_subscriptions) ? data.active_subscriptions : [])
      .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === "object"));
    if (!activeSubs.length) {
      return {
        accountId,
        customerId,
        subscriptionId: null,
        planId: "free",
        interval: "month",
        status: "canceled",
        periodStart: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
      };
    }
    // Pick the highest-ranked active subscription when a customer transitions tiers mid-cycle.
    const ranked = activeSubs.map(sub => {
      const productId = typeof sub.product_id === "string" ? sub.product_id : null;
      const mapped = planFromProductId(env, productId);
      const meta = (sub.metadata && typeof sub.metadata === "object" ? sub.metadata : {}) as Record<string, unknown>;
      const metaPlan = isPlanId(meta.plan) ? meta.plan : null;
      const planId: PlanId = mapped?.plan ?? metaPlan ?? "pro";
      const interval: BillingInterval = mapped?.interval ?? (meta.interval === "year" ? "year" : "month");
      return { sub, planId, interval };
    }).sort((a, b) => PLAN_RANK[b.planId] - PLAN_RANK[a.planId]);
    const best = ranked[0]!;
    return {
      accountId,
      customerId,
      subscriptionId: typeof best.sub.id === "string" ? best.sub.id : null,
      planId: best.planId,
      interval: best.interval,
      status: normalizeStatus(best.sub.status ?? "active"),
      periodStart: parseIsoMs(best.sub.current_period_start),
      periodEnd: parseIsoMs(best.sub.current_period_end),
      cancelAtPeriodEnd: Boolean(best.sub.cancel_at_period_end),
    };
  }

  if (!type.startsWith("subscription.")) return null;
  const customer = (data.customer && typeof data.customer === "object" ? data.customer : {}) as Record<string, unknown>;
  const meta = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, unknown>;
  const accountId =
    (typeof customer.external_id === "string" && customer.external_id) ||
    (typeof meta.account_id === "string" && meta.account_id) ||
    null;
  if (!accountId) return null;

  const product = (data.product && typeof data.product === "object" ? data.product : {}) as Record<string, unknown>;
  const productId =
    (typeof data.product_id === "string" && data.product_id) ||
    (typeof product.id === "string" && product.id) ||
    null;
  const mapped = planFromProductId(env, productId);
  const metaPlan = isPlanId(meta.plan) ? meta.plan : null;
  const planId: PlanId = mapped?.plan ?? metaPlan ?? "pro";
  const recurringInterval = data.recurring_interval === "year" ? "year" : "month";
  const interval: BillingInterval = mapped?.interval ?? (meta.interval === "year" ? "year" : recurringInterval);
  const status = type === "subscription.revoked"
    ? "revoked"
    : type === "subscription.canceled"
      ? "canceled"
      : normalizeStatus(data.status ?? "active");

  return {
    accountId,
    customerId: (typeof data.customer_id === "string" && data.customer_id) || (typeof customer.id === "string" && customer.id) || null,
    subscriptionId: typeof data.id === "string" ? data.id : null,
    planId,
    interval,
    status,
    periodStart: parseIsoMs(data.current_period_start),
    periodEnd: parseIsoMs(data.current_period_end),
    cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
  };
}

/** Handle verified Polar webhook deliveries idempotently and update account entitlements. */
export async function processPolarWebhook(
  env: Env,
  req: Request,
  now = Date.now(),
): Promise<{ ok: true; duplicate?: boolean; handled: boolean; eventType: string; accountId?: string; effectivePlan?: PlanId }> {
  if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (!env.POLAR_WEBHOOK_SECRET) throw new HttpError(503, "webhook_unconfigured", "Polar webhook secret is not configured.");
  const rawBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readBody(req, MAX_WEBHOOK_BYTES, 15_000));
  const { webhookId } = await verifyStandardWebhook(req.headers, rawBody, env.POLAR_WEBHOOK_SECRET, now);

  let event: { type?: unknown; data?: unknown };
  try {
    event = JSON.parse(rawBody) as { type?: unknown; data?: unknown };
  } catch {
    throw new HttpError(400, "bad_json", "Webhook body must be valid JSON.");
  }
  const eventType = typeof event?.type === "string" ? event.type : "";
  const data = event?.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : null;
  if (!eventType || !data) throw new HttpError(400, "bad_request", "Malformed Polar webhook payload.");

  const parsed = extractSubscriptionFromEvent(env, eventType, data);

  // Deduplicate on Standard Webhooks `webhook-id` before mutating account state.
  const inserted = await env.ACCOUNTS.prepare(
    "INSERT OR IGNORE INTO billing_events (event_id, provider, kind, account_id, received_at) VALUES (?, 'polar', ?, ?, ?)",
  ).bind(webhookId, eventType, parsed?.accountId ?? null, now).run();
  if ((inserted.meta?.changes ?? 0) === 0) {
    return { ok: true, duplicate: true, handled: false, eventType };
  }

  if (!parsed) {
    return { ok: true, handled: false, eventType };
  }

  const accountExists = await env.ACCOUNTS.prepare("SELECT plan FROM accounts WHERE id = ?")
    .bind(parsed.accountId).first<{ plan: string }>();
  if (!accountExists) {
    return { ok: true, handled: false, eventType, accountId: parsed.accountId };
  }

  const existingSub = await env.ACCOUNTS.prepare("SELECT plan_id, grace_until, status FROM subscriptions WHERE account_id = ?")
    .bind(parsed.accountId).first<{ plan_id: string; grace_until: number | null; status: string }>();

  // Polar emits `customer.state_changed` with empty `active_subscriptions` when a subscription
  // enters `past_due`; preserve an active 7-day grace window instead of downgrading prematurely.
  if (
    eventType === "customer.state_changed" &&
    parsed.subscriptionId === null &&
    existingSub?.status === "past_due" &&
    existingSub.grace_until !== null &&
    existingSub.grace_until > now
  ) {
    const keptPlan: PlanId = accountExists.plan === "unlimited"
      ? "unlimited"
      : isPlanId(existingSub.plan_id) ? existingSub.plan_id : "pro";
    return { ok: true, handled: true, eventType, accountId: parsed.accountId, effectivePlan: keptPlan };
  }

  // Determine grace window & effective account tier (non-destructive downgrade: never deletes pages/files).
  let graceUntil: number | null = null;
  let effectivePlan: PlanId = "free";
  if (parsed.status === "active" || parsed.status === "trialing") {
    effectivePlan = parsed.planId;
    graceUntil = null;
  } else if (parsed.status === "past_due") {
    graceUntil = existingSub?.status === "past_due" && existingSub.grace_until
      ? existingSub.grace_until
      : now + PAST_DUE_GRACE_MS;
    effectivePlan = graceUntil > now ? parsed.planId : "free";
  } else if (parsed.status === "canceled") {
    // Keep paid entitlements through current_period_end if cancel_at_period_end; drop immediately once expired.
    if (parsed.periodEnd && parsed.periodEnd > now) {
      effectivePlan = parsed.planId;
    } else {
      effectivePlan = "free";
    }
  } else {
    // revoked / incomplete -> immediately back to Free caps (non-destructive).
    effectivePlan = "free";
  }

  // Never downgrade an operator-granted `unlimited` account via webhook.
  if (accountExists.plan === "unlimited") effectivePlan = "unlimited";

  await env.ACCOUNTS.prepare(`INSERT INTO subscriptions
    (account_id, provider, customer_id, subscription_id, plan_id, billing_interval, status, period_start, period_end, cancel_at_period_end, grace_until, updated_at)
    VALUES (?, 'polar', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      customer_id = COALESCE(excluded.customer_id, subscriptions.customer_id),
      subscription_id = COALESCE(excluded.subscription_id, subscriptions.subscription_id),
      plan_id = excluded.plan_id,
      billing_interval = excluded.billing_interval,
      status = excluded.status,
      period_start = COALESCE(excluded.period_start, subscriptions.period_start),
      period_end = COALESCE(excluded.period_end, subscriptions.period_end),
      cancel_at_period_end = excluded.cancel_at_period_end,
      grace_until = excluded.grace_until,
      updated_at = excluded.updated_at`)
    .bind(
      parsed.accountId,
      parsed.customerId,
      parsed.subscriptionId,
      parsed.planId,
      parsed.interval,
      parsed.status,
      parsed.periodStart,
      parsed.periodEnd,
      parsed.cancelAtPeriodEnd ? 1 : 0,
      graceUntil,
      now,
    ).run();

  await applyPlanToAccount(env, parsed.accountId, effectivePlan);

  await env.ACCOUNTS.prepare(
    "INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, 'polar', ?, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(),
    `billing:${eventType}`,
    parsed.accountId,
    `status=${parsed.status} plan=${effectivePlan}`,
    now,
  ).run();

  return { ok: true, handled: true, eventType, accountId: parsed.accountId, effectivePlan };
}
