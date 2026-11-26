import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { route } from "../src/router";
import { applyPlanToAccount, getAccountEntitlements, PAST_DUE_GRACE_MS, recordAccountUsage } from "../src/billing/entitlements";
import { signStandardWebhook } from "../src/billing/polar";
import { reconcileBillingAndUsage } from "../src/billing/usage-sync";
import { GB } from "../src/billing/plans";
import { BASE, create, req } from "./helpers";

const WEBHOOK_SECRET = "whsec_dGVzdF9wb2xhcl9zZWNyZXRfMTIzNDU2Nzg5MA==";
const PRODUCTS = JSON.stringify({
  pro_month: "prod_pro_m",
  pro_year: "prod_pro_y",
  team_month: "prod_team_m",
  team_year: "prod_team_y",
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function sendSignedWebhook(
  customEnv: typeof env,
  payload: unknown,
  opts: { id?: string; timestampSec?: number; secret?: string; signatureOverride?: string } = {},
) {
  const raw = JSON.stringify(payload);
  const id = opts.id ?? `msg_${crypto.randomUUID()}`;
  const ts = opts.timestampSec ?? Math.floor(Date.now() / 1000);
  const sig = opts.signatureOverride ?? await signStandardWebhook(id, ts, raw, opts.secret ?? WEBHOOK_SECRET);
  return route(new Request(`${BASE}/api/webhooks/polar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": sig,
    },
    body: raw,
  }), customEnv);
}

describe("Pricing, self-host, and Polar.sh MoR billing", () => {
  it("renders public /pricing and /self-host pages cleanly without billing secrets", async () => {
    const pricing = await req("/pricing", { anonymous: true });
    expect(pricing.status).toBe(200);
    expect(pricing.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://polar.sh https://*.polar.sh");
    const pricingHtml = await pricing.text();
    expect(pricingHtml).toContain("Free");
    expect(pricingHtml).toContain("Pro");
    expect(pricingHtml).toContain("Team");
    expect(pricingHtml).toContain("Self-Hosted");
    expect(pricingHtml).toContain("$12 / mo");
    expect(pricingHtml).toContain("20</strong> active pages");
    expect(pricingHtml).toContain("5</strong> resident pages");
    expect(pricingHtml).toContain("Team OAuth tie-ins");

    const home = await req("/", { anonymous: true });
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain("Zero lock-in");
    expect(homeHtml).toContain("/self-host");

    const selfHost = await req("/self-host", { anonymous: true });
    expect(selfHost.status).toBe(200);
    const shHtml = await selfHost.text();
    expect(shHtml).toContain("scripts/provision.mjs");
    expect(shHtml).toContain("CF_REALTIME_APP_ID");
  });

  it("verifies Polar Standard Webhooks HMAC signatures, rejects tampering/replay, and deduplicates events", async () => {
    const h = await create();
    const billingEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: "polar_test_tok",
      POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
      POLAR_PRODUCTS_JSON: PRODUCTS,
    };

    const subEvent = {
      type: "subscription.created",
      data: {
        id: "sub_001",
        customer_id: "cus_001",
        product_id: "prod_pro_m",
        status: "active",
        recurring_interval: "month",
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        cancel_at_period_end: false,
        customer: { id: "cus_001", external_id: h.account },
      },
    };

    // Tampered signature -> 403
    const badSig = await sendSignedWebhook(billingEnv, subEvent, { signatureOverride: "v1,deadbeef" });
    expect(badSig.status).toBe(403);

    // Stale timestamp (> 5 min) -> 400
    const stale = await sendSignedWebhook(billingEnv, subEvent, { timestampSec: Math.floor(Date.now() / 1000) - 600 });
    expect(stale.status).toBe(400);

    // Valid delivery -> upgrades account atomically to Pro
    const eventId = `msg_${crypto.randomUUID()}`;
    const ok = await sendSignedWebhook(billingEnv, subEvent, { id: eventId });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, handled: true, effectivePlan: "pro" });

    const ent = await getAccountEntitlements(billingEnv, h.account!);
    expect(ent.plan).toBe("pro");
    expect(ent.quotas.pages).toBe(100);
    expect(ent.quotas.residents).toBe(25);
    expect(ent.quotas.mcpCallsPerMonth).toBe(15_000);
    expect(ent.quotas.sfuEnabled).toBe(true);

    // Duplicate webhook-id -> ignored idempotently
    const dup = await sendSignedWebhook(billingEnv, subEvent, { id: eventId });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ ok: true, duplicate: true, handled: false });
  });

  it("applies 7-day past_due grace period and downgrades non-destructively without deleting existing pages", async () => {
    const h = await create();
    const billingEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: "polar_test_tok",
      POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
      POLAR_PRODUCTS_JSON: PRODUCTS,
    };

    // Activate Pro and create 7 resident pages (> Free cap of 5)
    await sendSignedWebhook(billingEnv, {
      type: "subscription.active",
      data: {
        id: "sub_grace",
        customer_id: "cus_grace",
        product_id: "prod_pro_m",
        status: "active",
        customer: { id: "cus_grace", external_id: h.account },
      },
    });
    for (let i = 0; i < 7; i++) {
      await env.ACCOUNTS.prepare("INSERT INTO tendrils (id, owner_account, created_at, lifetime) VALUES (?, ?, ?, 'resident')")
        .bind(`g${crypto.randomUUID().replace(/-/g, "").slice(0, 11).replace(/[^a-z2-7]/g, "a")}`, h.account!, Date.now()).run();
    }

    // Mark past_due -> stays Pro during 7-day grace window
    const pastDueRes = await sendSignedWebhook(billingEnv, {
      type: "subscription.updated",
      data: {
        id: "sub_grace",
        customer_id: "cus_grace",
        product_id: "prod_pro_m",
        status: "past_due",
        customer: { id: "cus_grace", external_id: h.account },
      },
    });
    expect(pastDueRes.status).toBe(200);
    const duringGrace = await getAccountEntitlements(billingEnv, h.account!);
    expect(duringGrace.plan).toBe("pro");
    expect(duringGrace.inGracePeriod).toBe(true);

    // Polar also emits customer.state_changed with empty active_subscriptions on past_due -> must preserve grace!
    const stateChanged = await sendSignedWebhook(billingEnv, {
      type: "customer.state_changed",
      data: { id: "cus_grace", external_id: h.account, active_subscriptions: [] },
    });
    expect(stateChanged.status).toBe(200);
    expect(await stateChanged.json()).toMatchObject({ ok: true, effectivePlan: "pro" });
    expect((await getAccountEntitlements(billingEnv, h.account!)).plan).toBe("pro");

    // After grace period elapses -> cron downgrades to Free non-destructively
    const afterGrace = await reconcileBillingAndUsage(billingEnv, Date.now() + PAST_DUE_GRACE_MS + 60_000);
    expect(afterGrace.expiredSubscriptions).toBeGreaterThanOrEqual(1);

    const postDowngrade = await getAccountEntitlements(billingEnv, h.account!);
    expect(postDowngrade.plan).toBe("free");
    expect(postDowngrade.quotas.residents).toBe(5);

    // All 7 existing resident pages still exist (never deleted on downgrade!)
    const existingResidents = await env.ACCOUNTS.prepare(
      "SELECT COUNT(*) AS n FROM tendrils WHERE owner_account = ? AND lifetime = 'resident' AND state = 'active'",
    ).bind(h.account!).first<{ n: number }>();
    expect(existingResidents!.n).toBeGreaterThanOrEqual(7);
  });

  it("supports /dashboard/billing PAYG toggle, removable spend cap, Polar checkout/portal, and metered usage flush", async () => {
    const h = await create();
    const billingEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: "polar_test_tok",
      POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
      POLAR_PRODUCTS_JSON: PRODUCTS,
      POLAR_API_BASE: "https://polar.mock.test",
    };

    // Free account cannot enable PAYG -> 402
    const freePayg = await route(new Request(`${BASE}/dashboard/billing/payg`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ payg_enabled: true }),
    }), billingEnv);
    expect(freePayg.status).toBe(402);

    // Upgrade account to Pro
    await applyPlanToAccount(billingEnv, h.account!, "pro");

    // Enable PAYG with $20 spend cap
    const setCap = await route(new Request(`${BASE}/dashboard/billing/payg`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ payg_enabled: true, spend_cap_usd: 20 }),
    }), billingEnv);
    expect(setCap.status).toBe(200);
    expect(await setCap.json()).toEqual({ ok: true, payg_enabled: true, payg_spend_cap_cents: 2000 });

    // Disable spend cap completely (uncapped PAYG -> NULL)
    const disableCap = await route(new Request(`${BASE}/dashboard/billing/payg`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ payg_enabled: true, uncapped: true }),
    }), billingEnv);
    expect(disableCap.status).toBe(200);
    expect(await disableCap.json()).toEqual({ ok: true, payg_enabled: true, payg_spend_cap_cents: null });

    // Dashboard billing page renders live meters and uncapped indicator
    const page = await route(new Request(`${BASE}/dashboard/billing`, {
      method: "GET",
      headers: { Cookie: h.session! },
    }), billingEnv);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Billing &amp; quotas");
    expect(html).toContain("uncapped");
    expect(html).toContain("SFU up to 12 peers (720p)");
    expect(html).toContain("Host-brokered personal OAuth");

    // Mock Polar API for checkout, portal, and /v1/events/ingest
    const fetched: Array<{ url: string; body: any }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetched.push({ url, body });
      if (url.endsWith("/v1/checkouts/")) {
        return new Response(JSON.stringify({ id: "chk_1", url: "https://polar.sh/checkout/chk_1" }), { status: 201 });
      }
      if (url.endsWith("/v1/customer-sessions/")) {
        return new Response(JSON.stringify({ customer_portal_url: "https://polar.sh/portal/sess_1" }), { status: 201 });
      }
      if (url.endsWith("/v1/events/ingest")) {
        return new Response(JSON.stringify({ inserted: body.events.length }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const checkoutRes = await route(new Request(`${BASE}/dashboard/billing/checkout`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.5" },
      body: "plan=team&interval=year",
    }), billingEnv);
    expect(checkoutRes.status).toBe(303);
    expect(checkoutRes.headers.get("Location")).toBe("https://polar.sh/checkout/chk_1");
    expect(fetched[0].body).toMatchObject({
      products: ["prod_team_y"],
      external_customer_id: h.account,
      customer_ip_address: "203.0.113.5",
    });

    const portalRes = await route(new Request(`${BASE}/dashboard/billing/portal`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE },
    }), billingEnv);
    expect(portalRes.status).toBe(303);
    expect(portalRes.headers.get("Location")).toBe("https://polar.sh/portal/sess_1");

    // Record overage beyond Pro included 100 GB media + 15k MCP calls and flush to Polar
    await recordAccountUsage(billingEnv, h.account!, {
      mediaBytes: 100 * GB + 500 * 1024 * 1024, // 500 MB overage
      mcpCalls: 17_500, // 2,500 overage calls -> reports 2,000 chunk
    });
    const synced = await reconcileBillingAndUsage(billingEnv);
    expect(synced.flushedEvents).toBe(2);
    const ingestCall = fetched.find(f => f.url.endsWith("/v1/events/ingest"));
    expect(ingestCall?.body.events).toHaveLength(2);
    expect(ingestCall?.body.events[0]).toMatchObject({ name: "media_egress_gb", external_customer_id: h.account });
    expect(ingestCall?.body.events[1]).toMatchObject({ name: "mcp_overage_calls", external_customer_id: h.account });

    // Second reconciliation emits 0 duplicate events
    const second = await reconcileBillingAndUsage(billingEnv);
    expect(second.flushedEvents).toBe(0);
  });
});
