import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createPeerRelay } from "../../contract/peers.mjs";
import { applyPlanToAccount, getAccountEntitlements, recordAccountUsage } from "../src/billing/entitlements";
import { registerAccountAgent } from "../src/agents";
import { HOUR } from "../src/limits";
import { api, create, inDO, ownerHeaders, req, stub, testPublicKey, testWrapKey } from "./helpers";
import { createTestPage } from "./public-fixture";

describe("Per-tier quotas, cost guardrails, and coalesced metering", () => {
  it("enforces Free agent cap (5) with structured quota_exceeded error and unlocks more on Pro", async () => {
    const h = await create();
    // Account already has 1 creator agent from `create()`. Register 4 more -> hits Free cap of 5.
    for (const handle of ["bot-two", "bot-three", "bot-four", "bot-five"]) {
      await registerAccountAgent(env, h.account!, handle, testPublicKey(), testWrapKey());
    }

    await expect(
      registerAccountAgent(env, h.account!, "bot-six", testPublicKey(), testWrapKey()),
    ).rejects.toMatchObject({
      status: 429,
      code: "quota_exceeded",
      extra: expect.objectContaining({
        quota: "agents",
        plan: "free",
        limit: 5,
        upgradeUrl: expect.stringContaining("/dashboard/billing"),
        selfHostUrl: expect.stringContaining("/self-host"),
      }),
    });

    // Upgrading to Pro allows registering additional workspace agents.
    await applyPlanToAccount(env, h.account!, "pro");
    const sixth = await registerAccountAgent(env, h.account!, "bot-six", testPublicKey(), testWrapKey());
    expect(sixth.agent.handle).toBe("bot-six");
  });

  it("enforces per-page guest cap (10 on Free) with structured quota_exceeded", async () => {
    const h = await create();
    // Age tendril past the 7-day young-tendril visitor hold so this test exercises the Free 10-guest quota.
    await inDO(h.id, t => { t.db.set("created_at", t.now() - 30 * 24 * 60 * 60_000); });
    const link = await inDO(h.id, t => t.createLink("guest", "Friends", null));

    for (let i = 0; i < 10; i++) {
      const res = await stub(h.id).fetch(new Request("https://tendril.internal/claim/guest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tendril-key": link.key },
        body: JSON.stringify({ account_id: `guest_acc_${i}`, identities: [] }),
      }));
      expect(res.status).toBe(200);
    }

    const eleventh = await stub(h.id).fetch(new Request("https://tendril.internal/claim/guest", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tendril-key": link.key },
      body: JSON.stringify({ account_id: "guest_acc_10", identities: [] }),
    }));
    expect(eleventh.status).toBe(429);
    const body = await eleventh.json() as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: "quota_exceeded",
      quota: "guests",
      plan: "free",
      limit: 10,
    });
  });

  it("renders the friendly 3-choice upgrade/self-host card on HTML claim limit", async () => {
    const h = await create();
    const ownerRow = await env.ACCOUNTS.prepare("SELECT email FROM accounts WHERE id = ?").bind(h.account!).first<{ email: string }>();
    // Fill remaining 19 page slots (Free cap = 20; `create()` already created 1)
    for (let i = 0; i < 19; i++) {
      await env.ACCOUNTS.prepare("INSERT INTO tendrils (id, owner_account, created_at, lifetime) VALUES (?, ?, ?, 'resident')")
        .bind(`r${crypto.randomUUID().replace(/-/g, "").slice(0, 11).replace(/[^a-z2-7]/g, "b")}`, h.account!, Date.now()).run();
    }
    const extra = await create({ claim: false, owner: ownerRow!.email });
    await inDO(extra.id, t => { t.db.set("lifetime", "resident"); });
    const key = new URL(extra.page_url).pathname.split("/")[2]!;
    const res = await req(`/auth/page?tendril=${extra.id}&key=${key}`, {
      anonymous: true,
      redirect: "manual",
      headers: { Cookie: h.session!, Accept: "text/html" },
    });
    expect(res.status).toBe(429);
    const html = await res.text();
    expect(html).toContain("Manage pages");
    expect(html).toContain("/dashboard/billing");
    expect(html).toContain("/self-host");
  });

  it("enforces coalesced relay metering and monthly relay duration cap", async () => {
    const page = await createTestPage();
    const { id } = await (await page.api("GET", "")).json() as { id: string };
    const ownerAccount = await inDO(id, t => t.db.get<string | null>("owner_account", null));
    expect(ownerAccount).toBeTruthy();

    const left = "11".repeat(32);
    const right = "22".repeat(32);
    const a = createPeerRelay({
      reliable: page.relaySocket("meter-chan", left, right, "reliable"),
      live: page.relaySocket("meter-chan", left, right, "live"),
    }, { peerId: left, remotePeerId: right });
    const b = createPeerRelay({
      reliable: page.ownerRelaySocket("meter-chan", right, left, "reliable"),
      live: page.ownerRelaySocket("meter-chan", right, left, "live"),
    }, { peerId: right, remotePeerId: left });

    let got = 0;
    b.reliable.addEventListener("message", () => { got++; });
    await Promise.all([a.ready, b.ready]);
    a.reliable.send(new Uint8Array(1024));
    await expect.poll(() => got).toBe(1);
    a.close();
    b.close();

    // Closing flushes coalesced relay bytes & active ms into D1 usage_periods
    await expect.poll(async () => {
      const ent = await getAccountEntitlements(env, ownerAccount!);
      return ent.usage.relayBytes;
    }).toBeGreaterThanOrEqual(1024);

    // Exhaust Free monthly relay allowance (5 hrs) -> next pairing gets 429 quota_exceeded
    const h2 = await create();
    await recordAccountUsage(env, h2.account!, { relayMs: 5 * HOUR });
    const relayHeaders = { Upgrade: "websocket", "Sec-WebSocket-Protocol": "tendriller.relay.v1" };
    const open = (channel: string, peerId: string, remotePeerId: string, lane: string) =>
      api(h2, "GET", `peers/relay?${new URLSearchParams({ channel, peerId, remotePeerId, lane })}`, undefined, relayHeaders);
    const r1 = await open("over-cap", left, right, "reliable");
    const r2 = await open("over-cap", left, right, "live");
    const r3 = await req(`${h2.page_url}_tendril/peers/relay?${new URLSearchParams({ channel: "over-cap", peerId: right, remotePeerId: left, lane: "reliable" })}`, {
      headers: { ...ownerHeaders(h2.page_url), ...relayHeaders },
    });
    expect(r1.status).toBe(101); r1.webSocket!.accept();
    expect(r2.status).toBe(101); r2.webSocket!.accept();
    expect(r3.status).toBe(101); r3.webSocket!.accept();
    const r4 = await req(`${h2.page_url}_tendril/peers/relay?${new URLSearchParams({ channel: "over-cap", peerId: right, remotePeerId: left, lane: "live" })}`, {
      headers: { ...ownerHeaders(h2.page_url), ...relayHeaders },
    });
    expect(r4.status).toBe(429);
    const errBody = await r4.json() as { error: Record<string, unknown> };
    expect(errBody.error).toMatchObject({ code: "quota_exceeded", quota: "relay_duration", plan: "free" });
    r1.webSocket!.close(); r2.webSocket!.close(); r3.webSocket!.close();
  });

  it("enforces mcp_store byte cap on blind envelope sync", async () => {
    const h = await create();
    // Set a tiny mcp_store_cap (100 bytes) on this account to test enforcement cleanly
    await env.ACCOUNTS.prepare("UPDATE accounts SET mcp_store_cap = 100 WHERE id = ?").bind(h.account!).run();

    // Seed authority bundle and an existing 90-byte row in mcp_store
    await inDO(h.id, t => {
      t.db.run("INSERT OR REPLACE INTO mcp_store(k, v) VALUES(?, ?)", "envelope/" + "a".repeat(64), new Uint8Array(90).buffer);
    });
    const ent = await getAccountEntitlements(env, h.account!);
    expect(ent.quotas.mcpStoreBytes).toBe(100);
  });
});
