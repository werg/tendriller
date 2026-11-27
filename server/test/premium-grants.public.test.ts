import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createPremiumGrant, getPremiumGrant, listPremiumGrants, MAX_PREMIUM_GRANT_EXPIRY_MS, revokePremiumGrant } from "../src/billing/premium-grants";
import { applyPlanToAccount, canConsumeMcpCall, getAccountEntitlements, recordAccountUsage } from "../src/billing/entitlements";
import { GB, planSpec } from "../src/billing/plans";
import { processPolarWebhook, signStandardWebhook } from "../src/billing/polar";
import { reconcileBillingAndUsage } from "../src/billing/usage-sync";
import { accountLimits } from "../src/service-state";
import { route } from "../src/router";
import { BASE, create } from "./helpers";

const DAY = 86_400_000;
const ACTOR = "operator:testing";

afterEach(() => { vi.restoreAllMocks(); });

async function account() {
  const id = crypto.randomUUID();
  await env.ACCOUNTS.prepare("INSERT INTO accounts(id, created_at) VALUES (?, ?)").bind(id, Date.now()).run();
  return id;
}

function grantInput(accountId: string, plan: "pro" | "team" = "pro", now = Date.now()) {
  return { id: crypto.randomUUID(), accountId, plan, expiresAt: now + DAY, reason: "Premium feature testing" };
}

async function page(accountId: string, id = crypto.randomUUID()) {
  await env.ACCOUNTS.prepare("INSERT INTO tendrils(id, owner_account, created_at, lifetime) VALUES (?, ?, ?, 'resident')").bind(id, accountId, Date.now()).run();
  return id;
}

describe("Complimentary premium access", () => {
  it("raises every Pro/Team entitlement without rewriting paid state or leaving SQL quotas at Free", async () => {
    for (const plan of ["pro", "team"] as const) {
      const id = await account();
      // Explicitly materialized Free caps used to defeat a plan-only overlay.
      await applyPlanToAccount(env, id, "free");
      const input = grantInput(id, plan);
      const result = await createPremiumGrant(env, ACTOR, input);
      expect(result.created).toBe(true);
      const ent = await getAccountEntitlements(env, id);
      expect(ent.plan).toBe(plan);
      expect(ent.billingPlan).toBe("free");
      expect(ent.quotas).toEqual({ ...planSpec(plan).quotas, paygAllowed: false,
        paygMediaCentsPerGb: planSpec("free").quotas.paygMediaCentsPerGb,
        paygMcpCentsPer10k: planSpec("free").quotas.paygMcpCentsPer10k });
      expect(ent.paygEnabled).toBe(false);
      expect(ent.premiumGrant).toEqual({ id: input.id, plan, expiresAt: input.expiresAt });
      expect(ent.subscription).toBeNull();
      expect(await env.ACCOUNTS.prepare("SELECT plan, payg_enabled FROM accounts WHERE id = ?").bind(id).first()).toEqual({ plan: "free", payg_enabled: 0 });
      expect(await accountLimits(env, id)).toEqual({ pages: planSpec(plan).quotas.pages,
        residents: planSpec(plan).quotas.residents, storage: planSpec(plan).quotas.storageBytes });
      const statements = Array.from({ length: 21 }, () => env.ACCOUNTS.prepare("INSERT INTO tendrils(id, owner_account, created_at, lifetime) VALUES (?, ?, ?, 'resident')")
        .bind(crypto.randomUUID(), id, Date.now()));
      await expect(env.ACCOUNTS.batch(statements)).resolves.toHaveLength(21);
    }
  });

  it("is idempotent under concurrent creates and revocations, and exact retry never resurrects access", async () => {
    const id = await account(), input = grantInput(id);
    const created = await Promise.all([createPremiumGrant(env, ACTOR, input), createPremiumGrant(env, ACTOR, input)]);
    expect(created.filter(result => result.created)).toHaveLength(1);
    for (const changed of [{ plan: "team" as const }, { expiresAt: input.expiresAt + 1 }, { reason: "Different purpose" }, { accountId: crypto.randomUUID() }]) {
      await expect(createPremiumGrant(env, ACTOR, { ...input, ...changed })).rejects.toMatchObject({ status: 409, code: "grant_id_conflict" });
    }
    await expect(createPremiumGrant(env, "operator:someone-else", input)).rejects.toMatchObject({ status: 409 });
    const revoked = await Promise.all([revokePremiumGrant(env, ACTOR, input.id, "Testing complete"), revokePremiumGrant(env, ACTOR, input.id, "Testing complete")]);
    expect(revoked.filter(result => result.revoked)).toHaveLength(1);
    const retry = await createPremiumGrant(env, ACTOR, input, input.expiresAt + DAY);
    expect(retry.created).toBe(false);
    expect(retry.grant.revokedAt).not.toBeNull();
    expect((await getAccountEntitlements(env, id)).plan).toBe("free");
    const audit = await env.ACCOUNTS.prepare("SELECT actor, action FROM audit_log WHERE subject = ? ORDER BY action").bind(id).all();
    expect(audit.results).toEqual([{ actor: ACTOR, action: "premium:grant" }, { actor: ACTOR, action: "premium:revoke" }]);
    await expect(env.ACCOUNTS.prepare("UPDATE premium_grants SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL WHERE id = ?").bind(input.id).run()).rejects.toThrow("premium_grant_immutable");
  });

  it("rolls back a grant when its mandatory audit cannot be written", async () => {
    const id = await account(), input = grantInput(id);
    await env.ACCOUNTS.prepare("INSERT INTO audit_log(id, actor, action, subject, created_at) VALUES (?, ?, 'test', ?, ?)")
      .bind(`premium:grant:${input.id}`, ACTOR, id, Date.now()).run();
    await expect(createPremiumGrant(env, ACTOR, input)).rejects.toThrow();
    expect(await getPremiumGrant(env, input.id)).toBeNull();
  });

  it("rejects invalid bounds and inactive or nonexistent accounts", async () => {
    const id = await account(), now = Date.now(), input = grantInput(id, "pro", now);
    for (const expiresAt of [now, now - 1, 0, -1, MAX_PREMIUM_GRANT_EXPIRY_MS + 1, NaN, Infinity, now + 0.5])
      await expect(createPremiumGrant(env, ACTOR, { ...input, expiresAt }, now)).rejects.toMatchObject({ status: 400 });
    for (const reason of ["", " ", "reason\nwith control", "x".repeat(501)])
      await expect(createPremiumGrant(env, ACTOR, { ...input, reason }, now)).rejects.toMatchObject({ status: 400 });
    await expect(createPremiumGrant(env, ACTOR, { ...input, plan: "unlimited" as "pro" }, now)).rejects.toMatchObject({ status: 400 });
    await expect(createPremiumGrant(env, ACTOR, { ...input, accountId: crypto.randomUUID() }, now)).rejects.toMatchObject({ status: 404 });
    await env.ACCOUNTS.prepare("UPDATE accounts SET suspended_at = ? WHERE id = ?").bind(now, id).run();
    await expect(createPremiumGrant(env, ACTOR, input, now)).rejects.toMatchObject({ status: 404 });
    await env.ACCOUNTS.prepare("UPDATE accounts SET suspended_at = NULL, deleting_at = ? WHERE id = ?").bind(now, id).run();
    await expect(createPremiumGrant(env, ACTOR, input, now)).rejects.toMatchObject({ status: 404 });
  });

  it("supports never-expiring grants (omitted or null expiry) and longer finite expiries until revoked", async () => {
    const id = await account(), now = Date.now();
    await applyPlanToAccount(env, id, "free");
    // Longer than 90 days finite expiry is allowed.
    const oneYear = { id: crypto.randomUUID(), accountId: id, plan: "pro" as const, expiresAt: now + 365 * DAY, reason: "Annual beta" };
    expect((await createPremiumGrant(env, ACTOR, oneYear, now)).created).toBe(true);

    // Never-expiring grant (omitted expiresAt -> null) is preferred over finite same-tier grant.
    const foreverId = crypto.randomUUID();
    const created = await createPremiumGrant(env, ACTOR, { id: foreverId, accountId: id, plan: "pro", reason: "Founding tester" }, now);
    expect(created.created).toBe(true);
    expect(created.grant.expiresAt).toBeNull();
    // Exact retry with explicit null matches omitted expiresAt; finite expiry conflicts.
    const retried = await createPremiumGrant(env, ACTOR, { id: foreverId, accountId: id, plan: "pro", expiresAt: null, reason: "Founding tester" }, now + 10 * 365 * DAY);
    expect(retried.created).toBe(false);
    expect(retried.grant.expiresAt).toBeNull();
    await expect(createPremiumGrant(env, ACTOR, { id: foreverId, accountId: id, plan: "pro", expiresAt: now + DAY, reason: "Founding tester" }, now))
      .rejects.toMatchObject({ status: 409, code: "grant_id_conflict" });

    // Active now, preferred over oneYear, and still active 10 years later (entitlements, SQL limits, and usage exemption).
    expect((await getAccountEntitlements(env, id, now)).premiumGrant).toEqual({ id: foreverId, plan: "pro", expiresAt: null });
    const farFuture = now + 10 * 365 * DAY;
    expect((await getAccountEntitlements(env, id, farFuture)).plan).toBe("pro");
    expect(await accountLimits(env, id)).toEqual({ pages: 100, residents: 100, storage: 20 * GB });
    await recordAccountUsage(env, id, { mcpCalls: 5, mediaBytes: 4096 }, farFuture);
    expect((await getAccountEntitlements(env, id, farFuture)).usage).toMatchObject({
      mcpCalls: 5, complimentaryMcpCalls: 5, mediaBytes: 4096, complimentaryMediaBytes: 4096,
    });

    // Revoking both ends access immediately and retry never resurrects the never-expiring grant.
    await revokePremiumGrant(env, ACTOR, foreverId, "Ended", now + 1000);
    await revokePremiumGrant(env, ACTOR, oneYear.id, "Ended", now + 1000);
    expect((await getAccountEntitlements(env, id, now + 1000)).plan).toBe("free");
    const afterRevoke = await createPremiumGrant(env, ACTOR, { id: foreverId, accountId: id, plan: "pro", reason: "Founding tester" }, now + 2000);
    expect(afterRevoke.created).toBe(false);
    expect(afterRevoke.grant.revokedAt).toBe(now + 1000);
  });

  it("expires at the deadline without cron, including atomic SQL capacity checks", async () => {
    const id = await account(), now = Date.now();
    const input = { ...grantInput(id, "pro", now - 2 * DAY), expiresAt: now - DAY };
    await createPremiumGrant(env, ACTOR, input, now - 2 * DAY);
    expect((await getAccountEntitlements(env, id, input.expiresAt - 1)).plan).toBe("pro");
    expect((await getAccountEntitlements(env, id, input.expiresAt)).plan).toBe("free");
    expect(await accountLimits(env, id)).toEqual({ pages: 20, residents: 20, storage: GB });
    for (let i = 0; i < 20; i++) await page(id);
    await expect(page(id)).rejects.toThrow("account_tendrils_full");
    const retry = await createPremiumGrant(env, ACTOR, input);
    expect(retry.created).toBe(false);
    expect(retry.grant.expiresAt).toBe(input.expiresAt);
  });

  it("uses the highest live grant, falls back to a lower grant, and fails closed if grant reads fail", async () => {
    const id = await account(), now = Date.now();
    const pro = grantInput(id, "pro", now), team = { ...grantInput(id, "team", now), expiresAt: now + 1000 };
    await createPremiumGrant(env, ACTOR, pro, now);
    await createPremiumGrant(env, ACTOR, team, now);
    expect((await getAccountEntitlements(env, id, now)).plan).toBe("team");
    expect((await getAccountEntitlements(env, id, team.expiresAt)).plan).toBe("pro");
    await revokePremiumGrant(env, ACTOR, team.id, "Team testing complete", now);
    expect((await accountLimits(env, id)).pages).toBe(100);
    const unavailable = { ...env, ACCOUNTS: new Proxy(env.ACCOUNTS, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.includes("premium_grants")) throw new Error("Synthetic grant database failure");
        return target.prepare(sql);
      };
      return Reflect.get(target, key);
    } }) };
    const denied = await getAccountEntitlements(unavailable, id, now);
    expect(denied.plan).toBe("free");
    expect(denied.premiumGrant).toBeNull();
  });

  it("revokes capacity immediately while preserving pages and permitting storage release", async () => {
    const id = await account(), input = grantInput(id);
    await createPremiumGrant(env, ACTOR, input);
    const first = await page(id);
    for (let i = 1; i < 21; i++) await page(id);
    await env.ACCOUNTS.prepare("UPDATE tendrils SET reserved = ? WHERE id = ?").bind(2 * GB, first).run();
    await expect(env.ACCOUNTS.prepare("UPDATE tendrils SET reserved = ? WHERE id = ?").bind(11 * GB, first).run()).rejects.toThrow("service_full");
    await revokePremiumGrant(env, ACTOR, input.id, "Testing complete");
    await expect(page(id)).rejects.toThrow("account_tendrils_full");
    await expect(env.ACCOUNTS.prepare("UPDATE tendrils SET reserved = ? WHERE id = ?").bind(3 * GB, first).run()).rejects.toThrow("account_full");
    await env.ACCOUNTS.prepare("UPDATE tendrils SET reserved = ? WHERE id = ?").bind(1.5 * GB, first).run();
    await env.ACCOUNTS.prepare("UPDATE tendrils SET lifetime = 'ad_hoc' WHERE id = ?").bind(first).run();
    expect(await env.ACCOUNTS.prepare("SELECT COUNT(*) AS n FROM tendrils WHERE owner_account = ?").bind(id).first()).toEqual({ n: 21 });
    expect(await env.ACCOUNTS.prepare("SELECT reserved FROM accounts WHERE id = ?").bind(id).first()).toEqual({ reserved: 1.5 * GB });
  });

  it("preserves higher paid tiers, larger overrides, and unlimited service caps", async () => {
    const id = await account();
    await applyPlanToAccount(env, id, "team");
    await env.ACCOUNTS.prepare("UPDATE accounts SET agent_cap = 123, payg_enabled = 1 WHERE id = ?").bind(id).run();
    const input = grantInput(id, "pro");
    await createPremiumGrant(env, ACTOR, input);
    const ent = await getAccountEntitlements(env, id);
    expect(ent.plan).toBe("team");
    expect(ent.billingPlan).toBe("team");
    expect(ent.quotas.pages).toBe(1000);
    expect(ent.quotas.agents).toBe(123);
    expect(ent.paygEnabled).toBe(false);
    await revokePremiumGrant(env, ACTOR, input.id, "Done");
    expect((await getAccountEntitlements(env, id)).paygEnabled).toBe(true);
    await env.ACCOUNTS.prepare("UPDATE service_state SET account_page_cap = NULL, account_resident_cap = NULL, account_storage_cap = NULL WHERE id = 1").run();
    try {
      await createPremiumGrant(env, ACTOR, grantInput(id));
      expect((await getAccountEntitlements(env, id)).plan).toBe("unlimited");
      expect(await accountLimits(env, id)).toEqual({ pages: null, residents: null, storage: null });
    } finally {
      await env.ACCOUNTS.prepare("UPDATE service_state SET account_page_cap = 20, account_resident_cap = 20, account_storage_cap = ? WHERE id = 1").bind(GB).run();
    }
  });

  it("does not let Polar cancellation overwrite an active grant, or grant revocation overwrite paid billing", async () => {
    const id = await account(), input = grantInput(id, "team");
    const secret = "whsec_dGVzdF9wb2xhcl9zZWNyZXRfMTIzNDU2Nzg5MA==";
    const customEnv = { ...env, POLAR_WEBHOOK_SECRET: secret, POLAR_PRODUCTS_JSON: JSON.stringify({ pro_month: "pro-product" }) };
    const webhook = async (status: "active" | "revoked") => {
      const now = Date.now(), webhookId = crypto.randomUUID(), ts = Math.floor(now / 1000);
      const raw = JSON.stringify({ type: "subscription.updated", data: { id: `sub-${id}`, customer_id: `cus-${id}`,
        product_id: "pro-product", status, customer: { id: `cus-${id}`, external_id: id } } });
      const signature = await signStandardWebhook(webhookId, ts, raw, secret);
      return processPolarWebhook(customEnv, new Request(`${BASE}/api/webhooks/polar`, { method: "POST", body: raw,
        headers: { "webhook-id": webhookId, "webhook-timestamp": String(ts), "webhook-signature": signature } }), now);
    };
    await webhook("active");
    await createPremiumGrant(env, ACTOR, input);
    expect((await getAccountEntitlements(env, id)).plan).toBe("team");
    await webhook("revoked");
    expect((await getAccountEntitlements(env, id)).plan).toBe("team");
    expect((await getAccountEntitlements(env, id)).billingPlan).toBe("free");
    await webhook("active");
    await revokePremiumGrant(env, ACTOR, input.id, "Done");
    const ent = await getAccountEntitlements(env, id);
    expect(ent.plan).toBe("pro");
    expect(ent.subscription?.status).toBe("active");
  });

  it("never bills complimentary usage after revocation and later paid signup, while metering subsequent paid overage", async () => {
    const id = await account(), input = grantInput(id, "team");
    const customEnv = { ...env, POLAR_ACCESS_TOKEN: "test-only", POLAR_API_BASE: "https://polar.mock.test" };
    await createPremiumGrant(env, ACTOR, input);
    await recordAccountUsage(env, id, { mcpCalls: 90_000, mediaBytes: 300 * GB });
    await revokePremiumGrant(env, ACTOR, input.id, "Done");
    await applyPlanToAccount(env, id, "pro");
    await env.ACCOUNTS.prepare("UPDATE accounts SET payg_enabled = 1 WHERE id = ?").bind(id).run();
    const calls: Array<any> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    });
    const ent = await getAccountEntitlements(env, id);
    expect(ent.usage.complimentaryMcpCalls).toBe(90_000);
    expect(ent.usage.complimentaryMediaBytes).toBe(300 * GB);
    expect(ent.overage.totalCents).toBe(0);
    expect(canConsumeMcpCall(ent)).toEqual({ allowed: true, isOverage: false });
    await reconcileBillingAndUsage(customEnv);
    expect(calls).toHaveLength(0);
    await recordAccountUsage(env, id, { mcpCalls: 17_000, mediaBytes: 101 * GB });
    await reconcileBillingAndUsage(customEnv);
    const events = calls.flatMap(call => call.events).filter(event => event.external_customer_id === id);
    expect(events).toHaveLength(2);
    expect(events.find(event => event.name === "mcp_overage_calls").metadata.calls).toBe(2000);
    expect(events.find(event => event.name === "media_egress_gb").metadata.megabytes).toBe(1000);
  });

  it("exempts usage authorized before a revoke even if recording is delayed", async () => {
    const id = await account(), now = Date.now(), input = grantInput(id, "pro", now);
    await createPremiumGrant(env, ACTOR, input, now);
    await revokePremiumGrant(env, ACTOR, input.id, "Done", now + 1000);
    await recordAccountUsage(env, id, { mcpCalls: 1, mediaBytes: 123 }, now + 500);
    expect((await getAccountEntitlements(env, id)).usage).toMatchObject({ complimentaryMcpCalls: 1, complimentaryMediaBytes: 123 });
  });

  it("preserves a complimentary MCP admission when its grant is revoked in the same millisecond", async () => {
    const id = await account(), now = Date.now(), input = grantInput(id, "pro", now);
    await createPremiumGrant(env, ACTOR, input, now);
    const admitted = await getAccountEntitlements(env, id, now);
    expect(admitted.premiumGrant).not.toBeNull();
    await revokePremiumGrant(env, ACTOR, input.id, "Done", now);
    expect((await getAccountEntitlements(env, id, now)).premiumGrant).toBeNull();

    await recordAccountUsage(env, id, { mcpCalls: 1 }, now, { mcpComplimentary: Boolean(admitted.premiumGrant) });
    expect((await getAccountEntitlements(env, id, now)).usage).toMatchObject({ mcpCalls: 1, complimentaryMcpCalls: 1 });
  });

  it("preserves a non-complimentary MCP admission when a grant is added in the same millisecond", async () => {
    const id = await account(), now = Date.now();
    const admitted = await getAccountEntitlements(env, id, now);
    expect(admitted.premiumGrant).toBeNull();
    await createPremiumGrant(env, ACTOR, grantInput(id, "pro", now), now);
    expect((await getAccountEntitlements(env, id, now)).premiumGrant).not.toBeNull();

    await recordAccountUsage(env, id, { mcpCalls: 1 }, now, { mcpComplimentary: Boolean(admitted.premiumGrant) });
    expect((await getAccountEntitlements(env, id, now)).usage).toMatchObject({ mcpCalls: 1, complimentaryMcpCalls: 0 });
  });

  it("allows opting out of an existing PAYG preference while blocking enabling overage through a grant", async () => {
    const h = await create();
    await createPremiumGrant(env, ACTOR, grantInput(h.account!));
    const set = (enabled: boolean) => route(new Request(`${BASE}/dashboard/billing/payg`, { method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ payg_enabled: enabled }) }), env);
    expect((await set(true)).status).toBe(402);
    expect((await set(false)).status).toBe(200);
  });

  it("paginates account-scoped grant history with bounded opaque cursors", async () => {
    const id = await account(), other = await account(), now = Date.now();
    const inputs = Array.from({ length: 3 }, () => grantInput(id, "pro", now));
    for (const input of inputs) await createPremiumGrant(env, ACTOR, input, now);
    const foreign = grantInput(other);
    await createPremiumGrant(env, ACTOR, foreign);
    const first = await listPremiumGrants(env, id, { limit: 2 });
    expect(first.grants).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await listPremiumGrants(env, id, { limit: 2, before: first.nextCursor! });
    expect(second.grants).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.grants, ...second.grants].map(row => row.id)).size).toBe(3);
    await expect(listPremiumGrants(env, id, { before: foreign.id })).rejects.toMatchObject({ status: 400 });
    await expect(listPremiumGrants(env, id, { limit: 101 })).rejects.toMatchObject({ status: 400 });
  });
});
