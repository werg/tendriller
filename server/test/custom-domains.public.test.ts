import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { route } from "../src/router";
import { applyPlanToAccount } from "../src/billing/entitlements";
import { normalizeCustomHostname } from "../src/custom-domains";
import { BASE, create } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Per-page custom domains (Team & Self-Hosted)", () => {
  it("validates custom hostnames and rejects reserved/invalid hosts", () => {
    expect(normalizeCustomHostname("Tracker.YourTeam.com.", env)).toBe("tracker.yourteam.com");
    expect(normalizeCustomHostname("https://app.acme.co/foo", env)).toBe("app.acme.co");
    expect(normalizeCustomHostname("tendriller.dev", env)).toBeNull();
    expect(normalizeCustomHostname("sub.tendriller.dev", env)).toBeNull();
    expect(normalizeCustomHostname("localhost", env)).toBeNull();
    expect(normalizeCustomHostname("127.0.0.1", env)).toBeNull();
    expect(normalizeCustomHostname("not-a-fqdn", env)).toBeNull();
  });

  it("gates custom domain creation to Team/Unlimited, verifies DNS TXT, routes traffic + auth round-trip, and enforces downgrade pause", async () => {
    const h = await create({ name: "Team Tracker" });
    const pageKey = new URL(h.page_url).pathname.split("/")[2]!;

    // Free account cannot bind a custom domain -> 402
    const freeAttempt = await route(new Request(`${BASE}/dashboard/domains`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tendril_id: h.id, hostname: "tracker.yourteam.test" }),
    }), env);
    expect(freeAttempt.status).toBe(402);

    // Upgrade to Team -> can add a custom domain (self-hosted DoH TXT flow)
    await applyPlanToAccount(env, h.account!, "team");
    const addRes = await route(new Request(`${BASE}/dashboard/domains`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tendril_id: h.id, hostname: "tracker.yourteam.test" }),
    }), env);
    expect(addRes.status).toBe(201);
    const added = await addRes.json() as {
      hostname: string;
      status: string;
      verification_txt_name: string;
      verification_txt_value: string;
    };
    expect(added.hostname).toBe("tracker.yourteam.test");
    expect(added.status).toBe("pending");
    expect(added.verification_txt_name).toBe("_tendriller-verify.tracker.yourteam.test");

    // Before verification, requests to the custom hostname return 404
    const preVerify = await route(new Request(`https://tracker.yourteam.test/s/${pageKey}/`), env);
    expect(preVerify.status).toBe(404);

    // Mock DoH TXT record match -> verify transitions domain to active
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("dns-query") && url.includes("_tendriller-verify.tracker.yourteam.test")) {
        return new Response(JSON.stringify({
          Answer: [{ type: 16, data: `"${added.verification_txt_value}"` }],
        }), { status: 200, headers: { "Content-Type": "application/dns-json" } });
      }
      return new Response("not found", { status: 404 });
    });

    const verifyRes = await route(new Request(`${BASE}/dashboard/domains/verify`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ hostname: "tracker.yourteam.test" }),
    }), env);
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toMatchObject({ hostname: "tracker.yourteam.test", status: "active" });

    // Unauthenticated request on the custom domain redirects to /auth/page preserving &host=tracker.yourteam.test
    const unauthCustom = await route(new Request(`https://tracker.yourteam.test/s/${pageKey}/`), env);
    expect(unauthCustom.status).toBe(302);
    expect(unauthCustom.headers.get("Location")).toBe(`${BASE}/auth/page?tendril=${h.id}&key=${pageKey}&host=tracker.yourteam.test`);
    expect(unauthCustom.headers.get("Strict-Transport-Security")).toContain("max-age=63072000");

    // Signed-in owner hits /auth/page with verified custom host -> redirects back to custom domain with one-time code
    const authStep = await route(new Request(`${BASE}/auth/page?tendril=${h.id}&key=${pageKey}&host=tracker.yourteam.test`, {
      headers: { Cookie: h.session! },
    }), env);
    expect(authStep.status).toBe(303);
    const redeemUrl = authStep.headers.get("Location")!;
    expect(redeemUrl).toMatch(new RegExp(`^https://tracker\\.yourteam\\.test/s/${pageKey}/_tendril/auth/session\\?code=`));

    // Redeeming the code on the custom domain sets the page session cookie and redirects to custom domain page root
    const redeemRes = await route(new Request(redeemUrl), env);
    expect(redeemRes.status).toBe(303);
    expect(redeemRes.headers.get("Location")).toBe(`https://tracker.yourteam.test/s/${pageKey}/`);
    const pageCookie = redeemRes.headers.get("Set-Cookie")!.split(";")[0]!;

    // Authenticated visit to the custom domain serves the page & its management UI!
    const livePage = await route(new Request(`https://tracker.yourteam.test/s/${pageKey}/_tendril/manage`, {
      headers: { Cookie: pageCookie },
    }), env);
    expect(livePage.status).toBe(200);
    expect(await livePage.text()).toContain("Team Tracker");

    // Unverified/evil host parameter on /auth/page is ignored (no open redirect!)
    const evilHost = await route(new Request(`${BASE}/auth/page?tendril=${h.id}&key=${pageKey}&host=evil.attacker.test`, {
      headers: { Cookie: h.session! },
    }), env);
    expect(evilHost.status).toBe(303);
    expect(evilHost.headers.get("Location")).not.toContain("evil.attacker.test");

    // Downgrading off Team pauses custom domain cleanly with 402 (never deletes data)
    await applyPlanToAccount(env, h.account!, "free");
    const paused = await route(new Request(`https://tracker.yourteam.test/s/${pageKey}/`, {
      headers: { Cookie: pageCookie },
    }), env);
    expect(paused.status).toBe(402);

    // Owner can still remove the custom domain cleanly
    const delRes = await route(new Request(`${BASE}/dashboard/domains/delete`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ hostname: "tracker.yourteam.test" }),
    }), env);
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true, hostname: "tracker.yourteam.test" });
  });

  it("provisions, refreshes, and deletes Cloudflare for SaaS custom hostnames when CF_SAAS_* secrets are set", async () => {
    const h = await create();
    await applyPlanToAccount(env, h.account!, "team");
    const saasEnv = {
      ...env,
      CF_SAAS_ZONE_ID: "zone_test_123",
      CF_SAAS_API_TOKEN: "cf_tok_test",
      CF_SAAS_API_BASE: "https://cf-saas.mock.test/client/v4",
    };

    const calls: Array<{ method: string; url: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method === "POST" && url.endsWith("/zones/zone_test_123/custom_hostnames")) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            id: "ch_001",
            status: "pending",
            ownership_verification: { type: "txt", name: "_cf-custom-hostname.portal.acme.test", value: "tok_cf_1" },
            ssl: { status: "pending_validation" },
          },
        }), { status: 201 });
      }
      if (method === "GET" && url.endsWith("/zones/zone_test_123/custom_hostnames/ch_001")) {
        return new Response(JSON.stringify({
          success: true,
          result: { id: "ch_001", status: "active", ssl: { status: "active" } },
        }), { status: 200 });
      }
      if (method === "DELETE" && url.endsWith("/zones/zone_test_123/custom_hostnames/ch_001")) {
        return new Response(JSON.stringify({ success: true, result: { id: "ch_001" } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const add = await route(new Request(`${BASE}/dashboard/domains`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tendril_id: h.id, hostname: "portal.acme.test" }),
    }), saasEnv);
    expect(add.status).toBe(201);
    expect(await add.json()).toMatchObject({
      hostname: "portal.acme.test",
      status: "pending",
      verification_txt_name: "_cf-custom-hostname.portal.acme.test",
      verification_txt_value: "tok_cf_1",
    });

    const verify = await route(new Request(`${BASE}/dashboard/domains/verify`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ hostname: "portal.acme.test" }),
    }), saasEnv);
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({ hostname: "portal.acme.test", status: "active", ssl_status: "active" });

    const del = await route(new Request(`${BASE}/dashboard/domains/delete`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ hostname: "portal.acme.test" }),
    }), saasEnv);
    expect(del.status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
  });
});
