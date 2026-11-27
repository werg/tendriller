import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { route } from "../src/router";
import { applyPlanToAccount, getAccountEntitlements, PAST_DUE_GRACE_MS, recordAccountUsage } from "../src/billing/entitlements";
import { signStandardWebhook } from "../src/billing/polar";
import { reconcileBillingAndUsage } from "../src/billing/usage-sync";
import { GB } from "../src/billing/plans";
import { createPremiumGrant, revokePremiumGrant } from "../src/billing/premium-grants";
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
    expect(pricingHtml).toContain("20</strong> pages");
    expect(pricingHtml).toContain("1,000</strong> pages");
    expect(pricingHtml).toContain("Compare all plans");
    expect(pricingHtml).toContain("Team OAuth tie-ins");
    expect(pricingHtml).toContain("Custom page domains");
    expect(pricingHtml).toContain("data-theme-toggle");

    const home = await req("/", { anonymous: true });
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain("Zero lock-in");
    expect(homeHtml).toContain("data-theme-toggle");
    expect(homeHtml).toContain("/self-host");
    expect(homeHtml).toContain('href="/pricing"');
    expect(homeHtml).toContain('id="pricing"');
    expect(homeHtml).toContain("Room to grow");
    expect(homeHtml).toContain("/pricing.md");

    const discovery = await req("/.well-known/tendriller.json", { anonymous: true });
    expect(discovery.status).toBe(200);
    const desc = await discovery.json() as { documentation: Record<string, string>; interfaces: Record<string, unknown> };
    expect(desc.documentation.pricing).toBe(`${BASE}/docs/PRICING.md`);
    expect(desc.documentation.self_hosting).toBe(`${BASE}/docs/SELF_HOSTING.md`);
    expect(desc.interfaces.pricing).toBe(`${BASE}/pricing`);
    expect(desc.interfaces.pricing_markdown).toBe(`${BASE}/pricing.md`);
    expect(desc.interfaces.self_host).toBe(`${BASE}/self-host`);
    expect(desc.interfaces.billing).toBe(`${BASE}/dashboard/billing`);

    const selfHost = await req("/self-host", { anonymous: true });
    expect(selfHost.status).toBe(200);
    const shHtml = await selfHost.text();
    expect(shHtml).toContain("scripts/provision.mjs");
    expect(shHtml).toContain("CF_REALTIME_APP_ID");
  });

  it("exposes live account plan, quotas, and usage on GET /api/agent", async () => {
    const h = await create();
    const res = await req("/api/agent", {
      anonymous: true,
      headers: { Authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { account: Record<string, any> };
    expect(data.account).toMatchObject({
      claimed: true,
      plan: "free",
      billingUrl: `${BASE}/dashboard/billing`,
      pricingUrl: `${BASE}/pricing`,
      selfHostUrl: `${BASE}/self-host`,
      quotas: expect.objectContaining({ pages: 20, residents: 20, agents: 5, sfuEnabled: false }),
      usage: expect.objectContaining({ mcpCalls: 0, mediaBytes: 0, relayMs: 0 }),
    });
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
    expect(ent.quotas.residents).toBe(100);
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

    // Activate Pro and create 22 resident pages (> Free cap of 20)
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
    for (let i = 0; i < 22; i++) {
      await env.ACCOUNTS.prepare("INSERT INTO tendrils (id, owner_account, created_at, lifetime) VALUES (?, ?, ?, 'resident')")
        .bind(`g${String(i).padStart(2, "0")}${crypto.randomUUID().replace(/-/g, "").slice(0, 9).replace(/[^a-z2-7]/g, "a")}`, h.account!, Date.now()).run();
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
    expect(postDowngrade.quotas.residents).toBe(20);

    // All 22 existing resident pages still exist (never deleted on downgrade!)
    const existingResidents = await env.ACCOUNTS.prepare(
      "SELECT COUNT(*) AS n FROM tendrils WHERE owner_account = ? AND lifetime = 'resident' AND state = 'active'",
    ).bind(h.account!).first<{ n: number }>();
    expect(existingResidents!.n).toBeGreaterThanOrEqual(22);
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

  it.each(["pro", "team"] as const)("keeps paid %s checkout available during grant-only access", async plan => {
    const h = await create();
    const billingEnv = { ...env, POLAR_ACCESS_TOKEN: "polar_test_tok", POLAR_PRODUCTS_JSON: PRODUCTS, POLAR_API_BASE: "https://polar.mock.test" };
    const grant = { id: crypto.randomUUID(), accountId: h.account!, plan, expiresAt: Date.now() + 86_400_000, reason: "Checkout testing" };
    await createPremiumGrant(billingEnv, "operator:testing", grant);

    const page = await route(new Request(`${BASE}/dashboard/billing`, { headers: { Cookie: h.session! } }), billingEnv);
    expect(page.status).toBe(200);
    const html = await page.text();
    const checkoutForms = (html.match(/<form\b[^>]*action="\/dashboard\/billing\/checkout"[\s\S]*?<\/form>/g) ?? []);
    expect(checkoutForms).toHaveLength(4);
    for (const form of checkoutForms) expect(form).not.toMatch(/<button\b[^>]*\bdisabled\b/);
    expect(html).not.toContain("Current (");

    // Public /pricing must also keep the granted tier's checkout form available for grant-only users.
    const pricing = await route(new Request(`${BASE}/pricing`, { headers: { Cookie: h.session! } }), billingEnv);
    expect(pricing.status).toBe(200);
    const pricingHtml = await pricing.text();
    expect(pricingHtml).not.toContain("Current plan · Manage");
    expect(pricingHtml).toContain(`<input type="hidden" name="plan" value="${plan}">`);

    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "chk_grant", url: "https://polar.sh/checkout/chk_grant",
    }), { status: 201 }));
    const checkout = await route(new Request(`${BASE}/dashboard/billing/checkout`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ plan, interval: "month" }),
    }), billingEnv);
    expect(checkout.status).toBe(303);
    expect(checkout.headers.get("Location")).toBe("https://polar.sh/checkout/chk_grant");
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ products: [`prod_${plan}_m`], external_customer_id: h.account });
    expect(await getAccountEntitlements(billingEnv, h.account!)).toMatchObject({
      billingPlan: "free", plan, premiumGrant: { id: grant.id }, subscription: null,
    });
  });

  it.each([
    { cap: 2000, ending: "revocation" },
    { cap: null, ending: "expiry" },
  ] as const)("allows saved PAYG opt-out during a grant and keeps it off after $ending (cap $cap)", async ({ cap, ending }) => {
    const h = await create();
    const billingEnv = { ...env, POLAR_ACCESS_TOKEN: "polar_test_tok", POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET, POLAR_PRODUCTS_JSON: PRODUCTS };
    const activated = await sendSignedWebhook(billingEnv, {
      type: "subscription.active",
      data: {
        id: `sub_${crypto.randomUUID()}`, product_id: "prod_pro_y", status: "active",
        recurring_interval: "year", customer: { external_id: h.account },
      },
    });
    expect(activated.status).toBe(200);
    const setPreference = (body: unknown) => route(new Request(`${BASE}/dashboard/billing/payg`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }), billingEnv);
    expect((await setPreference({ payg_enabled: true, spend_cap_cents: cap })).status).toBe(200);
    const grant = { id: crypto.randomUUID(), accountId: h.account!, plan: "team" as const, expiresAt: Date.now() + 60_000, reason: "PAYG preference testing" };
    await createPremiumGrant(billingEnv, "operator:testing", grant);
    expect(await getAccountEntitlements(billingEnv, h.account!)).toMatchObject({ billingPlan: "pro", plan: "team", paygEnabled: false });
    expect(await env.ACCOUNTS.prepare("SELECT payg_enabled FROM accounts WHERE id = ?").bind(h.account).first()).toEqual({ payg_enabled: 1 });

    const dashboard = () => route(new Request(`${BASE}/dashboard/billing`, { headers: { Cookie: h.session! } }), billingEnv);
    const html = await (await dashboard()).text();
    expect(html).toContain("Pay-as-you-go overage is paused");
    expect(html).toContain("Your saved opt-in will resume");
    expect(html).toContain("Turn off saved pay-as-you-go");
    const paygForm = html.match(/<form\b[^>]*action="\/dashboard\/billing\/payg"[\s\S]*?<\/form>/)?.[0];
    expect(paygForm).toContain('name="payg_enabled" value="0"');
    expect(paygForm).not.toMatch(/<button\b[^>]*\bdisabled\b/);
    expect(html).toContain('disabled>Current (Pro Annual)</button>');
    expect(html).toContain('class="secondary sm">Team Annual ($320)</button>');
    expect(html).not.toContain("Current (Team");
    expect((await setPreference({ payg_enabled: true })).status).toBe(402);

    // Submit the opt-out form without a cap field, preserving the saved cap.
    const optedOut = await route(new Request(`${BASE}/dashboard/billing/payg`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
      body: "payg_enabled=0",
    }), billingEnv);
    expect(optedOut.status).toBe(303);
    expect(optedOut.headers.get("Location")).toBe("/dashboard/billing?saved=1");
    expect(await env.ACCOUNTS.prepare("SELECT payg_enabled, payg_spend_cap_cents FROM accounts WHERE id = ?").bind(h.account).first())
      .toEqual({ payg_enabled: 0, payg_spend_cap_cents: cap });
    expect(await (await dashboard()).text()).not.toContain("Turn off saved pay-as-you-go");

    if (ending === "revocation") await revokePremiumGrant(billingEnv, "operator:testing", grant.id, "Testing complete");
    else vi.spyOn(Date, "now").mockReturnValue(grant.expiresAt + 1);
    expect(await getAccountEntitlements(billingEnv, h.account!)).toMatchObject({ plan: "pro", premiumGrant: null, paygEnabled: false, paygSpendCapCents: cap });
    const afterGrant = await (await dashboard()).text();
    expect(afterGrant).not.toContain("Pay-as-you-go overage is paused");
    expect(afterGrant.match(/<input\b[^>]*name="payg_enabled"[^>]*>/)?.[0]).toBeDefined();
    expect(afterGrant.match(/<input\b[^>]*name="payg_enabled"[^>]*>/)?.[0]).not.toContain("checked");
  });

  it("does not clobber a concurrently saved spend cap when a PAYG update omits the cap field", async () => {
    const h = await create();
    await applyPlanToAccount(env, h.account!, "pro");
    // Start uncapped (NULL) with PAYG enabled.
    await env.ACCOUNTS.prepare("UPDATE accounts SET payg_enabled = 1, payg_spend_cap_cents = NULL WHERE id = ?")
      .bind(h.account).run();

    // Begin a request omitting the cap field whose body streams in after another request saves a $20 cap.
    let releaseBody!: () => void;
    let bodyReading!: () => void;
    const bodyStarted = new Promise<void>(resolve => { bodyReading = resolve; });
    const bodyGate = new Promise<void>(resolve => { releaseBody = resolve; });
    const encoder = new TextEncoder();
    const delayedStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        bodyReading();
        await bodyGate;
        controller.enqueue(encoder.encode(JSON.stringify({ payg_enabled: false })));
        controller.close();
      },
    });
    const staleReq = route(new Request(`${BASE}/dashboard/billing/payg`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: delayedStream,
      // @ts-expect-error duplex is required by Request with ReadableStream body
      duplex: "half",
    }), env);

    await bodyStarted;
    const concurrentCap = await route(new Request(`${BASE}/dashboard/billing/payg`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ payg_enabled: true, spend_cap_cents: 2000 }),
    }), env);
    expect(concurrentCap.status).toBe(200);
    expect(await concurrentCap.json()).toEqual({ ok: true, payg_enabled: true, payg_spend_cap_cents: 2000 });

    releaseBody();
    const staleRes = await staleReq;
    expect(staleRes.status).toBe(200);
    expect(await staleRes.json()).toEqual({ ok: true, payg_enabled: false, payg_spend_cap_cents: 2000 });
    expect(await env.ACCOUNTS.prepare("SELECT payg_enabled, payg_spend_cap_cents FROM accounts WHERE id = ?").bind(h.account).first())
      .toEqual({ payg_enabled: 0, payg_spend_cap_cents: 2000 });
  });

  it("excludes complimentary usage from billing dashboard quota meters after a grant ends", async () => {
    const h = await create();
    const grant = { id: crypto.randomUUID(), accountId: h.account!, plan: "team" as const, expiresAt: Date.now() + 60_000, reason: "Meter display test" };
    await createPremiumGrant(env, "operator:testing", grant);
    await recordAccountUsage(env, h.account!, { mcpCalls: 500, mediaBytes: 3 * GB });
    await revokePremiumGrant(env, "operator:testing", grant.id, "Done");

    const res = await route(new Request(`${BASE}/dashboard/billing`, { headers: { Cookie: h.session! } }), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("500 complimentary calls excluded");
    expect(html).toContain("3.0 GB complimentary excluded");
  });

  it("redirects signed-in users from / and /auth to /dashboard, supports /?home=1, and shows contextual upgrade card on /dashboard", async () => {
    const h = await create();

    // Signed-in GET / -> 302 /dashboard (with Vary: Cookie)
    const rootRes = await route(new Request(`${BASE}/`, {
      method: "GET",
      headers: { Cookie: h.session! },
    }), env);
    expect(rootRes.status).toBe(302);
    expect(rootRes.headers.get("Location")).toBe("/dashboard");
    expect(rootRes.headers.get("Vary")).toBe("Cookie");

    // Signed-in GET /?home=1 -> 200 landing page with signed-in Dashboard link
    const explicitHome = await route(new Request(`${BASE}/?home=1`, {
      method: "GET",
      headers: { Cookie: h.session! },
    }), env);
    expect(explicitHome.status).toBe(200);
    const homeHtml = await explicitHome.text();
    expect(homeHtml).toContain("Room to grow");
    expect(homeHtml).toContain('href="/dashboard"');

    // Signed-in GET /auth -> 302 /dashboard (or requested return_to)
    const authRes = await route(new Request(`${BASE}/auth?return_to=%2Fdashboard%2Fbilling`, {
      method: "GET",
      headers: { Cookie: h.session! },
    }), env);
    expect(authRes.status).toBe(302);
    expect(authRes.headers.get("Location")).toBe("/dashboard/billing");

    // Dashboard on Free plan shows "Want more tendrils?" upgrade card and Home link
    const dashFree = await route(new Request(`${BASE}/dashboard`, {
      method: "GET",
      headers: { Cookie: h.session! },
    }), env);
    expect(dashFree.status).toBe(200);
    const dashFreeHtml = await dashFree.text();
    expect(dashFreeHtml).toContain('href="/?home=1"');
    expect(dashFreeHtml).toContain("Want more tendrils?");
    expect(dashFreeHtml).toContain("Upgrade to Pro");

    // Dashboard on Pro plan shifts prompt to Team upgrade
    await applyPlanToAccount(env, h.account!, "pro");
    const dashPro = await route(new Request(`${BASE}/dashboard`, {
      method: "GET",
      headers: { Cookie: h.session! },
    }), env);
    const dashProHtml = await dashPro.text();
    expect(dashProHtml).toContain("Need room for a bigger team?");
    expect(dashProHtml).toContain("Upgrade to Team");

    // Dashboard on Team plan does not show an upgrade card
    await applyPlanToAccount(env, h.account!, "team");
    const dashTeam = await route(new Request(`${BASE}/dashboard`, {
      method: "GET",
      headers: { Cookie: h.session! },
    }), env);
    const dashTeamHtml = await dashTeam.text();
    expect(dashTeamHtml).not.toContain("Want more tendrils?");
    expect(dashTeamHtml).not.toContain("Need room for a bigger team?");
  });
});
