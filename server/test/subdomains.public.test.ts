import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { route } from "../src/router";
import { applyPlanToAccount } from "../src/billing/entitlements";
import { normalizePageSubdomain } from "../src/subdomains";
import { sha256Hex } from "../src/ids";
import { BASE, create, inDO, ownerHeaders, req } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

async function createAccountSession(email: string) {
  const accountId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = Date.now();
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(accountId, now, email),
    env.ACCOUNTS.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('github', ?, ?, ?, ?, ?)")
      .bind(accountId, accountId, email.split("@")[0]!, email, now),
    env.ACCOUNTS.prepare("INSERT INTO identity_emails (provider, subject, email) VALUES ('github', ?, ?)").bind(accountId, email),
    env.ACCOUNTS.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), accountId, now, now + 3600_000),
  ]);
  return { accountId, session: `__Host-tendriller=${token}` };
}

describe("Named page subdomains & bare-domain routing", () => {
  it("validates subdomain labels and rejects invalid or reserved names", () => {
    expect(normalizePageSubdomain("My-App", env)).toBe("my-app");
    expect(normalizePageSubdomain("abc", env)).toBe("abc");
    expect(normalizePageSubdomain("a".repeat(45), env)).toBe("a".repeat(45));
    expect(normalizePageSubdomain("team-tracker-2026", env)).toBe("team-tracker-2026");

    // Too short / too long / bad chars / consecutive hyphens / reserved
    for (const bad of [
      "",
      "ab",
      "a".repeat(46),
      "-leading",
      "trailing-",
      "double--dash",
      "xn--punycode",
      "foo--p-0123456789ab",
      "has.dot",
      "has space",
      "www",
      "api",
      "dashboard",
      "staging",
      "preview-123",
      "tendriller",
    ]) {
      expect(normalizePageSubdomain(bad, env), bad).toBeNull();
    }
  });

  it("gates named subdomains to paid plans, enforces per-plan quotas and uniqueness, keeps fallback URL working, and pauses cleanly on downgrade", async () => {
    const h = await create({ name: "Kitchen Notes" });
    const pageKey = new URL(h.page_url).pathname.split("/")[2]!;
    const fallbackUrl = h.page_url;
    const baseDomain = env.PAGE_BASE_DOMAIN;

    // 1. Free plan is gated (402) via both UI and Agent API
    const freeUi = await route(new Request(`${BASE}/dashboard/t/${h.id}/subdomain`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ subdomain: "kitchen-notes" }),
    }), env);
    expect(freeUi.status).toBe(402);
    expect(await freeUi.json()).toMatchObject({ error: { code: "plan_required", quota: "custom_subdomains" } });

    const freeAgent = await route(new Request(`${BASE}/api/agent/pages/${h.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: "kitchen-notes" }),
    }), env);
    expect(freeAgent.status).toBe(402);

    // GET /api/agent exposes customSubdomains quota (0 on Free)
    const freeSelf = await req("/api/agent", { anonymous: true, headers: { Authorization: `Bearer ${h.token}` } });
    expect((await freeSelf.json() as any).account.quotas.customSubdomains).toBe(0);

    // 2. Upgrade to Pro -> can add a named subdomain later on to an existing page
    await applyPlanToAccount(env, h.account!, "pro");
    const proSelf = await req("/api/agent", { anonymous: true, headers: { Authorization: `Bearer ${h.token}` } });
    expect((await proSelf.json() as any).account.quotas.customSubdomains).toBe(25);

    // Availability check before claiming
    const checkBefore = await route(new Request(`${BASE}/api/agent/subdomains/check?name=kitchen-notes`, {
      headers: { Authorization: `Bearer ${h.token}` },
    }), env);
    expect(checkBefore.status).toBe(200);
    expect(await checkBefore.json()).toMatchObject({ subdomain: "kitchen-notes", available: true });

    // Assign via dashboard API to existing page
    const setRes = await route(new Request(`${BASE}/dashboard/t/${h.id}/subdomain`, {
      method: "POST",
      headers: { Cookie: h.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ subdomain: "kitchen-notes" }),
    }), env);
    expect(setRes.status).toBe(200);
    const updated = await setRes.json() as {
      id: string;
      subdomain: string;
      page_url: string;
      bare_url: string;
      fallback_page_url: string;
    };
    expect(updated).toMatchObject({
      id: h.id,
      subdomain: "kitchen-notes",
      page_url: `https://kitchen-notes.${baseDomain}/s/${pageKey}/`,
      bare_url: `https://kitchen-notes.${baseDomain}/`,
      fallback_page_url: fallbackUrl,
    });

    // Availability check now reports in_use
    const checkAfter = await route(new Request(`${BASE}/api/agent/subdomains/check?name=kitchen-notes`, {
      headers: { Authorization: `Bearer ${h.token}` },
    }), env);
    expect(await checkAfter.json()).toMatchObject({ subdomain: "kitchen-notes", available: false, reason: "in_use" });

    // Agent API info and listing reflect the named subdomain
    const infoRes = await route(new Request(`${BASE}/api/agent/pages/${h.id}`, {
      headers: { Authorization: `Bearer ${h.token}` },
    }), env);
    expect(infoRes.status).toBe(200);
    expect(await infoRes.json()).toMatchObject({
      id: h.id,
      subdomain: "kitchen-notes",
      page_url: `https://kitchen-notes.${baseDomain}/s/${pageKey}/`,
      bare_url: `https://kitchen-notes.${baseDomain}/`,
      fallback_page_url: fallbackUrl,
    });

    // 3. Keyed auth round-trip on named subdomain
    const unauthNamed = await route(new Request(`https://kitchen-notes.${baseDomain}/s/${pageKey}/`), env);
    expect(unauthNamed.status).toBe(302);
    expect(unauthNamed.headers.get("Location")).toBe(`${BASE}/auth/page?tendril=${h.id}&key=${pageKey}&host=kitchen-notes.${baseDomain}`);

    const authStep = await route(new Request(`${BASE}/auth/page?tendril=${h.id}&key=${pageKey}&host=kitchen-notes.${baseDomain}`, {
      headers: { Cookie: h.session! },
    }), env);
    expect(authStep.status).toBe(303);
    const redeemUrl = authStep.headers.get("Location")!;
    expect(redeemUrl).toMatch(new RegExp(`^https://kitchen-notes\\.${baseDomain.replace(/\./g, "\\.")}/s/${pageKey}/_tendril/auth/session\\?code=`));

    const redeemRes = await route(new Request(redeemUrl), env);
    expect(redeemRes.status).toBe(303);
    expect(redeemRes.headers.get("Location")).toBe(`https://kitchen-notes.${baseDomain}/s/${pageKey}/`);
    const namedCookie = redeemRes.headers.get("Set-Cookie")!.split(";")[0]!;

    // Both named subdomain AND original gibberish fallback work!
    const liveNamed = await route(new Request(`https://kitchen-notes.${baseDomain}/s/${pageKey}/_tendril/manage`, {
      headers: { Cookie: namedCookie },
    }), env);
    expect(liveNamed.status).toBe(200);
    const manageHtml = await liveNamed.text();
    expect(manageHtml).toContain("Kitchen Notes");
    expect(manageHtml).toContain(`kitchen-notes.${baseDomain}`);

    const liveFallback = await route(new Request(fallbackUrl, {
      headers: ownerHeaders(fallbackUrl),
    }), env);
    expect(liveFallback.status).toBe(200);

    // 4. Global uniqueness across accounts: second Pro account cannot claim `kitchen-notes`
    const other = await create({ name: "Other Page" });
    await applyPlanToAccount(env, other.account!, "pro");
    const conflict = await route(new Request(`${BASE}/api/agent/pages/${other.id}/subdomain`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${other.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: "kitchen-notes" }),
    }), env);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "subdomain_in_use" } });

    // Cannot claim an existing page's 12-char ID as a subdomain
    const idCollision = await route(new Request(`${BASE}/api/agent/pages/${other.id}/subdomain`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${other.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: h.id }),
    }), env);
    expect(idCollision.status).toBe(409);

    // 5. Plan quota cap enforcement (tighten cap to 1 to test boundary; renaming own page still allowed!)
    await env.ACCOUNTS.prepare("UPDATE accounts SET subdomain_cap = 1 WHERE id = ?").bind(h.account!).run();
    const renameOwn = await route(new Request(`${BASE}/api/agent/pages/${h.id}/subdomain`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: "my-kitchen" }),
    }), env);
    expect(renameOwn.status).toBe(200);
    expect(await renameOwn.json()).toMatchObject({ subdomain: "my-kitchen" });

    // Second page in same account hits the cap (429 quota_exceeded)
    const createSecond = await route(new Request(`${BASE}/api/agent/pages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Page", subdomain: "second-app" }),
    }), env);
    expect(createSecond.status).toBe(429);
    expect(await createSecond.json()).toMatchObject({ error: { code: "quota_exceeded", quota: "custom_subdomains", limit: 1 } });

    // Raising cap allows creating a page WITH a subdomain directly via POST /api/agent/pages
    await env.ACCOUNTS.prepare("UPDATE accounts SET subdomain_cap = 5 WHERE id = ?").bind(h.account!).run();
    const createWithSub = await route(new Request(`${BASE}/api/agent/pages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Direct Named", subdomain: "direct-named" }),
    }), env);
    expect(createWithSub.status).toBe(201);
    const createdPage = await createWithSub.json() as { id: string; subdomain: string; page_url: string; bare_url: string };
    expect(createdPage.subdomain).toBe("direct-named");
    expect(createdPage.bare_url).toBe(`https://direct-named.${baseDomain}/`);
    expect(createdPage.page_url).toContain(`https://direct-named.${baseDomain}/s/`);

    // 6. Downgrading to Free pauses named subdomains (402) while preserving reservation & fallback URL
    await applyPlanToAccount(env, h.account!, "free");
    const pausedNamed = await route(new Request(`https://my-kitchen.${baseDomain}/s/${pageKey}/`), env);
    expect(pausedNamed.status).toBe(402);

    // Fallback gibberish URL still works 100%!
    const stillWorksFallback = await route(new Request(fallbackUrl, {
      headers: ownerHeaders(fallbackUrl),
    }), env);
    expect(stillWorksFallback.status).toBe(200);

    // Dashboard displays paused badge and keeps fallback link openable
    const dashRes = await route(new Request(`${BASE}/dashboard`, { headers: { Cookie: h.session! } }), env);
    expect(dashRes.status).toBe(200);
    const dashHtml = await dashRes.text();
    expect(dashHtml).toContain(`my-kitchen.${baseDomain}`);
    expect(dashHtml).toContain("Paused");
    expect(dashHtml).toContain(fallbackUrl);

    // Removing a paused subdomain still works even while on Free
    const removeRes = await route(new Request(`${BASE}/api/agent/pages/${h.id}/subdomain`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${h.token}` },
    }), env);
    expect(removeRes.status).toBe(200);
    expect(await removeRes.json()).toMatchObject({ subdomain: null, page_url: fallbackUrl });
  });

  it("supports bare domains for signed-in owners and public pages on both named and generated subdomains", async () => {
    const h = await create({ name: "Bare Domain App" });
    await applyPlanToAccount(env, h.account!, "pro");
    const baseDomain = env.PAGE_BASE_DOMAIN;

    // Assign a named subdomain
    const setRes = await route(new Request(`${BASE}/api/agent/pages/${h.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: "bare-demo" }),
    }), env);
    expect(setRes.status).toBe(200);

    // 1. Private page on named bare domain: unauthenticated GET / redirects to /auth/page?tendril=...&bare=1&host=...
    const unauthBare = await route(new Request(`https://bare-demo.${baseDomain}/`), env);
    expect(unauthBare.status).toBe(302);
    expect(unauthBare.headers.get("Location")).toBe(`${BASE}/auth/page?tendril=${h.id}&bare=1&host=bare-demo.${baseDomain}`);

    // Another account cannot sign into a private bare domain -> 403
    const stranger = await createAccountSession(`stranger-${crypto.randomUUID()}@example.test`);
    const strangerAuth = await route(new Request(`${BASE}/auth/page?tendril=${h.id}&bare=1&host=bare-demo.${baseDomain}`, {
      headers: { Cookie: stranger.session },
    }), env);
    expect(strangerAuth.status).toBe(403);

    // Signed-in owner completes bare-domain auth round-trip
    const ownerAuth = await route(new Request(`${BASE}/auth/page?tendril=${h.id}&bare=1&host=bare-demo.${baseDomain}`, {
      headers: { Cookie: h.session! },
    }), env);
    expect(ownerAuth.status).toBe(303);
    const bareRedeemUrl = ownerAuth.headers.get("Location")!;
    expect(bareRedeemUrl).toMatch(new RegExp(`^https://bare-demo\\.${baseDomain.replace(/\./g, "\\.")}/_tendril/auth/session\\?code=`));

    const bareRedeemed = await route(new Request(bareRedeemUrl), env);
    expect(bareRedeemed.status).toBe(303);
    expect(bareRedeemed.headers.get("Location")).toBe(`https://bare-demo.${baseDomain}/`);
    const bareCookie = bareRedeemed.headers.get("Set-Cookie")!.split(";")[0]!;

    // Owner accesses bare root, /_tendril/info, /_tendril/manage, and /_tendril/sw.js (scope "/")
    const bareHome = await route(new Request(`https://bare-demo.${baseDomain}/`, { headers: { Cookie: bareCookie } }), env);
    expect(bareHome.status).toBe(200);
    const bareInfo = await route(new Request(`https://bare-demo.${baseDomain}/_tendril/info`, { headers: { Cookie: bareCookie } }), env);
    expect(bareInfo.status).toBe(200);
    expect(await bareInfo.json()).toMatchObject({ id: h.id, base: "/" });

    const bareSw = await route(new Request(`https://bare-demo.${baseDomain}/_tendril/sw.js`, { headers: { Cookie: bareCookie } }), env);
    expect(bareSw.status).toBe(200);
    expect(bareSw.headers.get("Service-Worker-Allowed")).toBe("/");

    // 2. Standard gibberish subdomain ALSO supports bare domain for signed-in owner!
    const fallbackBareHome = await route(new Request(`https://${h.id}.${baseDomain}/`, {
      headers: ownerHeaders(h.page_url),
    }), env);
    expect(fallbackBareHome.status).toBe(200);

    const fallbackBareUnauth = await route(new Request(`https://${h.id}.${baseDomain}/`), env);
    expect(fallbackBareUnauth.status).toBe(302);
    expect(fallbackBareUnauth.headers.get("Location")).toBe(`${BASE}/auth/page?tendril=${h.id}&bare=1`);

    // 3. Public page (`v2_open_readers = true`): anonymous visitors open bare domain directly (both named & generated)!
    await inDO(h.id, (t) => {
      t.db.set("v2_open_readers", true);
    });
    const publicNamedBare = await route(new Request(`https://bare-demo.${baseDomain}/`), env);
    expect(publicNamedBare.status).toBe(200);

    const publicGibberishBare = await route(new Request(`https://${h.id}.${baseDomain}/`), env);
    expect(publicGibberishBare.status).toBe(200);

    // Owner-only management remains forbidden for anonymous visitors on public bare domain
    const publicManageDenied = await route(new Request(`https://bare-demo.${baseDomain}/_tendril/manage`), env);
    expect(publicManageDenied.status).toBe(403);

    // Owner managing via /_tendril/manage on bare domain can update the subdomain via form POST
    const formUpdate = await route(new Request(`https://bare-demo.${baseDomain}/_tendril/manage`, {
      method: "POST",
      headers: {
        Cookie: bareCookie,
        Origin: `https://bare-demo.${baseDomain}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ action: "set-subdomain", subdomain: "renamed-board" }).toString(),
    }), env);
    expect(formUpdate.status).toBe(200);
    expect(await formUpdate.text()).toContain(`https://renamed-board.${baseDomain}/`);

    // New named subdomain serves the public bare page immediately
    const renamedBare = await route(new Request(`https://renamed-board.${baseDomain}/`), env);
    expect(renamedBare.status).toBe(200);
    // Old named subdomain is now free (404)
    const oldNamedGone = await route(new Request(`https://bare-demo.${baseDomain}/`), env);
    expect(oldNamedGone.status).toBe(404);
  });

  it("renders named subdomain controls on /dashboard/domains, /dashboard/billing, and /pricing", async () => {
    const h = await create({ name: "UI Check Page" });

    // Free user sees Pro/Team upsell on /dashboard/domains
    const domainsFree = await route(new Request(`${BASE}/dashboard/domains`, { headers: { Cookie: h.session! } }), env);
    expect(domainsFree.status).toBe(200);
    const freeHtml = await domainsFree.text();
    expect(freeHtml).toContain("Named page subdomains");
    expect(freeHtml).toContain("Upgrade to Pro");

    // Pro user sees management form and quota counter on /dashboard/domains and /dashboard/billing
    await applyPlanToAccount(env, h.account!, "pro");
    const domainsPro = await route(new Request(`${BASE}/dashboard/domains`, { headers: { Cookie: h.session! } }), env);
    expect(domainsPro.status).toBe(200);
    const proHtml = await domainsPro.text();
    expect(proHtml).toContain("Save named subdomain");
    expect(proHtml).toContain("0 / 25");

    const billingPro = await route(new Request(`${BASE}/dashboard/billing`, { headers: { Cookie: h.session! } }), env);
    expect(billingPro.status).toBe(200);
    const billingHtml = await billingPro.text();
    expect(billingHtml).toContain("Named page subdomains");
    expect(billingHtml).toContain("Named subdomains · Manage");

    const pricing = await req("/pricing", { anonymous: true });
    expect(pricing.status).toBe(200);
    const pricingHtml = await pricing.text();
    expect(pricingHtml).toContain("Named page subdomains");
    expect(pricingHtml).toContain("25 pages");
  });

  it("atomically moves and swaps named subdomains between pages in the same account, enforcing agent grants and cross-account isolation", async () => {
    const pageA = await create({ name: "Page Alpha" });
    await applyPlanToAccount(env, pageA.account!, "pro");
    // Cap at 1 slot initially so we prove atomic move consumes 0 extra slots!
    await env.ACCOUNTS.prepare("UPDATE accounts SET subdomain_cap = 1 WHERE id = ?").bind(pageA.account!).run();

    // Create a second page B under the same agent & account
    const createB = await route(new Request(`${BASE}/api/agent/pages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pageA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Page Beta" }),
    }), env);
    expect(createB.status).toBe(201);
    const pageB = await createB.json() as { id: string; page_url: string };
    const baseDomain = env.PAGE_BASE_DOMAIN;

    // Bind `alpha-site` to Page A
    const bindA = await route(new Request(`${BASE}/api/agent/pages/${pageA.id}/subdomain`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${pageA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: "alpha-site" }),
    }), env);
    expect(bindA.status).toBe(200);

    // Without reassign: true, assigning `alpha-site` to Page B returns 409 with `owned_by_account: true`
    const conflictSameAccount = await route(new Request(`${BASE}/api/agent/pages/${pageB.id}/subdomain`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${pageA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: "alpha-site" }),
    }), env);
    expect(conflictSameAccount.status).toBe(409);
    expect(await conflictSameAccount.json()).toMatchObject({
      error: { code: "subdomain_in_use", existing_tendril_id: pageA.id, owned_by_account: true },
    });

    // With reassign: true, `alpha-site` moves atomically from Page A -> Page B (even at 1/1 quota cap!)
    const moved = await route(new Request(`${BASE}/api/agent/pages/${pageB.id}/subdomain`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${pageA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: "alpha-site", reassign: true }),
    }), env);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({
      id: pageB.id,
      subdomain: "alpha-site",
      previous_tendril_id: pageA.id,
      bare_url: `https://alpha-site.${baseDomain}/`,
    });

    // Verify Page A's DO mirror was cleared and Page B's DO mirror holds `alpha-site`
    const infoA = await (await route(new Request(`${BASE}/api/agent/pages/${pageA.id}`, {
      headers: { Authorization: `Bearer ${pageA.token}` },
    }), env)).json() as { subdomain: string | null };
    const infoB = await (await route(new Request(`${BASE}/api/agent/pages/${pageB.id}`, {
      headers: { Authorization: `Bearer ${pageA.token}` },
    }), env)).json() as { subdomain: string | null };
    expect(infoA.subdomain).toBeNull();
    expect(infoB.subdomain).toBe("alpha-site");

    // Raise cap to 2, assign `beta-site` to Page A, then atomically SWAP `alpha-site` <-> `beta-site` via UI endpoint
    await env.ACCOUNTS.prepare("UPDATE accounts SET subdomain_cap = 2 WHERE id = ?").bind(pageA.account!).run();
    const bindABeta = await route(new Request(`${BASE}/dashboard/domains/subdomains`, {
      method: "POST",
      headers: { Cookie: pageA.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tendril_id: pageA.id, subdomain: "beta-site" }),
    }), env);
    expect(bindABeta.status).toBe(200);

    // /dashboard/domains renders inline Move / swap controls for both pages
    const domainsHtml = await (await route(new Request(`${BASE}/dashboard/domains`, {
      headers: { Cookie: pageA.session! },
    }), env)).text();
    expect(domainsHtml).toContain("Move / swap page");
    expect(domainsHtml).toContain("swap with alpha-site");

    // Swap: move `alpha-site` onto Page A with swap: true -> Page A gets `alpha-site`, Page B gets `beta-site`!
    const swapped = await route(new Request(`${BASE}/dashboard/domains/subdomains`, {
      method: "POST",
      headers: { Cookie: pageA.session!, Origin: BASE, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tendril_id: pageA.id, subdomain: "alpha-site", reassign: true, swap: true }),
    }), env);
    expect(swapped.status).toBe(200);
    expect(await swapped.json()).toMatchObject({
      id: pageA.id,
      subdomain: "alpha-site",
      previous_tendril_id: pageB.id,
      swapped_subdomain: "beta-site",
    });

    const afterA = await (await route(new Request(`${BASE}/api/agent/pages/${pageA.id}`, {
      headers: { Authorization: `Bearer ${pageA.token}` },
    }), env)).json() as { subdomain: string | null };
    const afterB = await (await route(new Request(`${BASE}/api/agent/pages/${pageB.id}`, {
      headers: { Authorization: `Bearer ${pageA.token}` },
    }), env)).json() as { subdomain: string | null };
    expect(afterA.subdomain).toBe("alpha-site");
    expect(afterB.subdomain).toBe("beta-site");

    // Public routing immediately reflects the swap (both pages open on their new names!)
    await inDO(pageA.id, (t) => { t.db.set("v2_open_readers", true); });
    await inDO(pageB.id, (t) => { t.db.set("v2_open_readers", true); });
    const routeAlpha = await route(new Request(`https://alpha-site.${baseDomain}/_tendril/info`), env);
    const routeBeta = await route(new Request(`https://beta-site.${baseDomain}/_tendril/info`), env);
    expect((await routeAlpha.json() as any).id).toBe(pageA.id);
    expect((await routeBeta.json() as any).id).toBe(pageB.id);

    // Security check 1: Another account CANNOT hijack `alpha-site` even with `reassign: true, swap: true`
    const otherAcc = await create({ name: "Other Account Page" });
    await applyPlanToAccount(env, otherAcc.account!, "pro");
    const crossAccountAttempt = await route(new Request(`${BASE}/api/agent/pages/${otherAcc.id}/subdomain`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${otherAcc.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: "alpha-site", reassign: true, swap: true }),
    }), env);
    expect(crossAccountAttempt.status).toBe(409);

    // Security check 2: An agent without grant on Page A cannot reassign `alpha-site` onto Page B
    await env.ACCOUNTS.prepare("DELETE FROM agent_grants WHERE page_id = ?").bind(pageA.id).run();
    const ungrantedMove = await route(new Request(`${BASE}/api/agent/pages/${pageB.id}/subdomain`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${pageA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: "alpha-site", reassign: true }),
    }), env);
    expect(ungrantedMove.status).toBe(403);
  });
});
