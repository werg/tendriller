import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, inject, it, vi } from "vitest";
import { sha256Hex } from "../src/ids";
import { routeAuth } from "../src/accounts/auth";
import { reconcileSuspensions } from "../src/abuse/reconcile";
import { api, BASE, inDO, PageClient, req, type Handle } from "./helpers";

const db = env.ACCOUNTS!;
const creatorHeaders = { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" };

beforeAll(async () => {
  await applyD1Migrations(db, inject("d1Migrations"));
  await db.prepare("UPDATE service_state SET mode = 'open' WHERE id = 1").run();
});

async function createPublic(owner = "person@example.com", ip = "192.0.2.10"): Promise<Handle> {
  const res = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, "CF-Connecting-IP": ip }, body: JSON.stringify({ owner }) });
  expect(res.status).toBe(201);
  return res.json<Handle>();
}

async function claimAs(h: Handle, account: string, email: string, rawSession = `test-${crypto.randomUUID()}`): Promise<string> {
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('google', ?, ?, ?, ?, ?)")
      .bind(account, account, email.split('@')[0], email, now),
    db.prepare("INSERT INTO identity_emails (provider, subject, email) VALUES ('google', ?, ?)").bind(account, email),
    db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(rawSession), account, now, now + 86_400_000),
  ]);
  const cookie = `__Host-tendriller=${rawSession}`;
  const auth = await req(`/auth/page?tendril=${h.id}&key=${new URL(h.page_url).pathname.split('/')[2]}`,
    { headers: { Cookie: cookie }, redirect: "manual" });
  expect(auth.status).toBe(303);
  return cookie;
}

it("requires an owner email and refuses a different verified account", async () => {
  const missing = await req("/api/tendrils", { method: "POST", headers: creatorHeaders, body: "{}" });
  expect(missing.status).toBe(400);
  const h = await createPublic("right@example.com", "192.0.2.50");
  const account = crypto.randomUUID();
  const session = `wrong-${crypto.randomUUID()}`;
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, 'wrong@example.com')").bind(account, now),
    db.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('google', ?, ?, 'wrong', 'wrong@example.com', ?)").bind(account, account, now),
    db.prepare("INSERT INTO identity_emails (provider, subject, email) VALUES ('google', ?, 'wrong@example.com')").bind(account),
    db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(session), account, now, now + 86_400_000),
  ]);
  const key = new URL(h.page_url).pathname.split('/')[2];
  const result = await req(`/auth/page?tendril=${h.id}&key=${key}`, { redirect: "manual", headers: { Cookie: `__Host-tendriller=${session}` } });
  expect(result.status).toBe(403);
  expect((await db.prepare("SELECT owner_account FROM tendrils WHERE id = ?").bind(h.id).first<{ owner_account: string | null }>())?.owner_account).toBeNull();
});

it("blocks keyless creation from a configured CIDR range", async () => {
  await db.prepare("INSERT INTO blocks (kind, value, reason) VALUES ('cidr', '198.51.100.0/24', 'test')").run();
  const blocked = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, "CF-Connecting-IP": "198.51.100.42" }, body: JSON.stringify({ owner: "person@example.com" }) });
  expect(blocked.status).toBe(403);
  expect((await createPublic("person@example.com", "198.51.101.42")).id).toBeTruthy();
});

it("holds a young page after a burst of distinct guest sign-ins", async () => {
  const account = crypto.randomUUID();
  await db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(account, Date.now(), "burst@example.com").run();
  const h = await createPublic("burst@example.com", "192.0.2.44");
  await claimAs(h, account, "burst@example.com");
  await inDO(h.id, async t => {
    for (let i = 0; i < 8; i++) await t.recordVisitorSignal("guest", `guest-${i}`);
  });
  expect((await db.prepare("SELECT state FROM tendrils WHERE id = ?").bind(h.id).first<{ state: string }>())?.state).toBe("held");
  expect((await api(h, "GET", "")).status).toBe(403);
});

it("holds repeated claim releases before stripping the current owner", async () => {
  const account = crypto.randomUUID();
  await db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(account, Date.now(), "release@example.com").run();
  const h = await createPublic("release@example.com", "192.0.2.45");
  await claimAs(h, account, "release@example.com");
  await inDO(h.id, t => t.db.run("INSERT INTO release_events (at) VALUES (?), (?)", t.now(), t.now()));
  expect((await api(h, "POST", "release")).status).toBe(403);
  const row = await db.prepare("SELECT owner_account, state FROM tendrils WHERE id = ?").bind(h.id)
    .first<{ owner_account: string; state: string }>();
  expect(row).toMatchObject({ owner_account: account, state: "held" });
});

it("keeps concurrent reservations across two account pages under the exact account cap", async () => {
  const account = crypto.randomUUID();
  const first = "aaa" + crypto.randomUUID().replace(/-/g, "").slice(0, 9);
  const second = "bbb" + crypto.randomUUID().replace(/-/g, "").slice(0, 9);
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at) VALUES (?, ?)").bind(account, now),
    db.prepare("INSERT INTO tendrils (id, owner_account, created_at, claimed_at) VALUES (?, ?, ?, ?)").bind(first, account, now, now),
    db.prepare("INSERT INTO tendrils (id, owner_account, created_at, claimed_at) VALUES (?, ?, ?, ?)").bind(second, account, now, now),
  ]);
  const amount = 150 * 1024 * 1024;
  const results = await Promise.allSettled([
    db.prepare("UPDATE tendrils SET reserved = ? WHERE id = ?").bind(amount, first).run(),
    db.prepare("UPDATE tendrils SET reserved = ? WHERE id = ?").bind(amount, second).run(),
  ]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const used = await db.prepare("SELECT reserved FROM accounts WHERE id = ?").bind(account).first<{ reserved: number }>();
  expect(used?.reserved).toBe(amount);
  await db.prepare("DELETE FROM tendrils WHERE id IN (?, ?)").bind(first, second).run();
  await db.prepare("DELETE FROM accounts WHERE id = ?").bind(account).run();
});

it("keeps suspended owners on an appeal-only session with in-app notices", async () => {
  const account = crypto.randomUUID();
  const token = "session_" + crypto.randomUUID();
  const cookie = `__Host-tendriller=${token}`;
  await db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, 'appeal@example.com')").bind(account, Date.now()).run();
  const h = await createPublic("appeal@example.com", "192.0.2.47");
  await claimAs(h, account, "appeal@example.com", token);
  await inDO(h.id, t => t.hold("test hold"));
  await db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = ?").bind(Date.now(), account).run();
  const dashboard = await req("/dashboard", { headers: { Cookie: cookie } });
  expect(dashboard.status).toBe(200);
  const dashboardHtml = await dashboard.text();
  expect(dashboardHtml).toContain("Appeal account suspension");
  expect(dashboardHtml).toContain("test hold");
  expect((await req(`/appeal?tendril=${h.id}`, { headers: { Cookie: cookie } })).status).toBe(200);
  const posted = await req(`/appeal?tendril=${h.id}`, { method: "POST", headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ reason: "Wrongful hold" }) });
  expect(posted.status).toBe(200);
  expect((await db.prepare("SELECT reason FROM appeals WHERE tendril_id = ?").bind(h.id).first<{ reason: string }>())?.reason).toBe("Wrongful hold");
  const accountAppeal = await req("/appeal/account", { method: "POST", headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ reason: "Please review suspension" }) });
  expect(accountAppeal.status).toBe(200);
  expect((await db.prepare("SELECT reason FROM account_appeals WHERE account_id = ?").bind(account).first<{ reason: string }>())?.reason).toBe("Please review suspension");
  expect((await req("/auth/me", { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await req("/dashboard/keys", { method: "POST", headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/json" }, body: '{"name":"blocked"}' })).status).toBe(403);
  expect((await req("/dashboard/export", { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, Authorization: "Bearer obsolete" }, body: JSON.stringify({ owner: "person@example.com" }) })).status).toBe(400);
});

it("lets a suspended identity sign in again and redirects it to restricted dashboard", async () => {
  const account = crypto.randomUUID();
  const subject = "987654321";
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, suspended_at) VALUES (?, ?, ?)").bind(account, Date.now(), Date.now()),
    db.prepare("INSERT INTO identities (provider, subject, account_id, login, created_at) VALUES ('github', ?, ?, 'suspended', ?)")
      .bind(subject, account, Date.now()),
    db.prepare("INSERT INTO blocks (kind, value, reason) VALUES ('identity', ?, 'automatic suspension')")
      .bind(`github:${subject}`),
  ]);
  const testEnv = { ...env, GITHUB_CLIENT_ID: "test-id", GITHUB_CLIENT_SECRET: "test-secret", AUTH_RATE: undefined };
  const begin = await routeAuth(new Request(`${BASE}/auth/github`), testEnv, new URL(`${BASE}/auth/github`));
  expect(begin.status).toBe(302);
  const state = new URL(begin.headers.get("Location")!).searchParams.get("state")!;
  const oauthCookie = begin.headers.get("Set-Cookie")!.split(";")[0];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("access_token")) return Response.json({ access_token: "test-token" });
    if (url.endsWith("/user/emails")) return Response.json([{ email: "suspended@example.com", verified: true, primary: true }]);
    if (url.endsWith("/user")) return Response.json({ id: Number(subject), login: "suspended" });
    throw new Error(`Unexpected OAuth fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const callback = new URL(`${BASE}/auth/callback/github?state=${state}&code=test-code`);
    const response = await routeAuth(new Request(callback, { headers: { Cookie: oauthCookie } }), testEnv, callback);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/dashboard");
    const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
    expect((await req("/dashboard", { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await req("/auth/me", { headers: { Cookie: cookie } })).status).toBe(401);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("auto-claims only for a matching verified email and issues a page session", async () => {
  const h = await createPublic("ana@example.com");
  const page = await req(h.page_url, { redirect: "manual" });
  expect(page.status).toBe(302);
  const claimUrl = page.headers.get("Location")!;
  expect(claimUrl).toContain("/auth/page?");
  const signIn = await req(claimUrl);
  expect(await signIn.text()).toContain("Continue with GitHub");

  const account = crypto.randomUUID();
  const rawSession = "test-session-" + crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(account, now, "ana@example.com"),
    db.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('google', ?, ?, 'Ana', 'ana@example.com', ?)")
      .bind(account, account, now),
    db.prepare("INSERT INTO identity_emails (provider, subject, email) VALUES ('google', ?, 'ana@example.com')").bind(account),
    db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(rawSession), account, now, now + 86_400_000),
  ]);
  const cookie = `__Host-tendriller=${rawSession}`;
  const post = await req(claimUrl, { redirect: "manual", headers: { Cookie: cookie } });
  expect(post.status).toBe(303);
  const exchange = await req(post.headers.get("Location")!, { redirect: "manual" });
  expect(exchange.status).toBe(303);
  const pageCookie = exchange.headers.get("Set-Cookie")!.split(";")[0];
  expect(pageCookie).toMatch(/^__Host-tendril=/);
  const opened = await req(h.page_url, { headers: { Cookie: pageCookie } });
  expect(opened.status).toBe(200);
  expect(await opened.text()).toContain("is getting ready");
  expect(await (await api(h, "GET", "")).json()).toMatchObject({ owner: { provider: "google", login: "Ana" } });
  const without = await req(h.page_url, { redirect: "manual" });
  expect(without.status).toBe(302);
  const inviteRes = await api(h, "POST", "links", { role: "guest" });
  expect(inviteRes.status).toBe(201);
  const invite = await inviteRes.json<{ url: string }>();
  const guestAccount = crypto.randomUUID();
  const guestRaw = "guest-session-" + crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, 'guest@example.com')").bind(guestAccount, now),
    db.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('google', ?, ?, 'Guest', 'guest@example.com', ?)")
      .bind(guestAccount, guestAccount, now),
    db.prepare("INSERT INTO identity_emails (provider, subject, email) VALUES ('google', ?, 'guest@example.com')").bind(guestAccount),
    db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(guestRaw), guestAccount, now, now + 86_400_000),
  ]);
  const guestCookie = `__Host-tendriller=${guestRaw}`;
  const guestPage = await req(invite.url, { redirect: "manual" });
  const guestClaimUrl = guestPage.headers.get("Location")!;
  const guestScreen = await req(guestClaimUrl, { headers: { Cookie: guestCookie } });
  const guestNonce = /name="nonce" value="([^"]+)"/.exec(await guestScreen.text())?.[1];
  expect(guestNonce).toBeTruthy();
  const guestJoin = await req(guestClaimUrl, { method: "POST", headers: { Cookie: guestCookie, Origin: BASE,
    "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ nonce: guestNonce! }) });
  expect(await guestJoin.text()).toContain("Waiting for the owner");
  expect(await (await req(`${guestClaimUrl}&status=1`, { headers: { Cookie: guestCookie } })).json()).toMatchObject({ status: "pending" });
  const pending = await (await req(h.page_url + "_tendril/guests", { headers: { Cookie: pageCookie } })).json<{ guests: { account_id: string; link_id: string }[] }>();
  expect(pending.guests).toHaveLength(1);
  const approval = await req(h.page_url + `_tendril/guests/${guestAccount}/${pending.guests[0].link_id}/approve`, {
    method: "POST", headers: { Cookie: pageCookie, Origin: new URL(h.page_url).origin },
  });
  expect(approval.status).toBe(200);
  expect(await (await req(`${guestClaimUrl}&status=1`, { headers: { Cookie: guestCookie } })).json()).toMatchObject({ status: "approved" });
  const retry = await req(guestClaimUrl, { redirect: "manual", headers: { Cookie: guestCookie } });
  expect(retry.status).toBe(303);
  const guestExchange = await req(retry.headers.get("Location")!, { redirect: "manual" });
  const guestPageCookie = guestExchange.headers.get("Set-Cookie")!.split(";")[0];
  expect((await req(invite.url, { headers: { Cookie: guestPageCookie } })).status).toBe(200);
  const secondInvite = await (await api(h, "POST", "links", { role: "guest" })).json<{ url: string }>();
  const secondClaim = (await req(secondInvite.url, { redirect: "manual" })).headers.get("Location")!;
  const secondScreen = await (await req(secondClaim, { headers: { Cookie: guestCookie } })).text();
  const secondNonce = /name="nonce" value="([^"]+)"/.exec(secondScreen)?.[1];
  expect(secondNonce).toBeTruthy();
  await req(secondClaim, { method: "POST", headers: { Cookie: guestCookie, Origin: BASE,
    "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ nonce: secondNonce! }) });
  const secondPending = await (await req(h.page_url + "_tendril/guests", { headers: { Cookie: pageCookie } })).json<{ guests: { account_id: string; link_id: string }[] }>();
  expect(secondPending.guests).toHaveLength(1);
  const decline = await req(h.page_url + `_tendril/guests/${guestAccount}/${secondPending.guests[0].link_id}/decline`, {
    method: "POST", headers: { Cookie: pageCookie, Origin: new URL(h.page_url).origin },
  });
  expect(decline.status).toBe(200);
  expect(await (await req(`${secondClaim}&status=1`, { headers: { Cookie: guestCookie } })).json()).toMatchObject({ status: "declined" });
  expect((await req(secondClaim, { headers: { Cookie: guestCookie } })).status).toBe(403);
  expect((await api(h, "POST", "release")).status).toBe(403);
  expect((await req(invite.url + "_tendril/agents", { headers: { Cookie: guestPageCookie } })).status).toBe(403);
  const reportForm = await req(invite.url + "_tendril/report", { headers: { Cookie: guestPageCookie } });
  expect(await reportForm.text()).toContain("Report this page");
  const report = await req(invite.url + "_tendril/report", { method: "POST", headers: { Cookie: guestPageCookie, Origin: new URL(invite.url).origin,
    "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ reason: "Suspicious content" }) });
  expect(report.status).toBe(200);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM reports WHERE tendril_id = ?").bind(h.id).first<{ n: number }>())?.n).toBe(1);
  const ownerClient = await PageClient.connect(h.page_url, { headers: { Origin: new URL(h.page_url).origin, Cookie: pageCookie } });
  expect(ownerClient.welcome.role).toBe("owner");
  const displayReply = await ownerClient.request({ t: "links", create: { role: "display" } });
  expect(displayReply.created.url).toBeTruthy();
  expect((await req(displayReply.created.url)).status).toBe(200);
  const guestClient = await PageClient.connect(invite.url, { deviceId: ownerClient.deviceId, secret: ownerClient.secret,
    headers: { Origin: new URL(invite.url).origin, Cookie: guestPageCookie } });
  expect(guestClient.welcome.role).toBe("guest");
  const escalation = await guestClient.request({ t: "links", create: { role: "display" } });
  expect(escalation.code).toBe("forbidden");
  guestClient.close();
  ownerClient.close();
  const agents = await req(h.page_url + "_tendril/agents", { headers: { Cookie: pageCookie } });
  expect(await agents.json()).toMatchObject({ agents: [{ name: "main" }] });
  const denied = await req(h.page_url + "_tendril/agents/main/disconnect", { method: "POST", headers: { Origin: new URL(h.page_url).origin } });
  expect(denied.status).toBe(401);
  const disconnect = await req(h.page_url + "_tendril/agents/main/disconnect", { method: "POST", headers: { Cookie: pageCookie, Origin: new URL(h.page_url).origin } });
  expect(disconnect.status).toBe(200);
  expect((await api(h, "GET", "")).status).toBe(401);
  await db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = ?").bind(Date.now(), account).run();
  expect((await req(displayReply.created.url)).status).toBe(403);
  expect((await db.prepare("SELECT tendril_id FROM suspension_queue WHERE tendril_id = ?").bind(h.id).first())?.tendril_id).toBe(h.id);
  await reconcileSuspensions(env);
  expect(await db.prepare("SELECT 1 FROM suspension_queue WHERE tendril_id = ?").bind(h.id).first()).toBeNull();
  await db.prepare("UPDATE accounts SET suspended_at = NULL WHERE id = ?").bind(account).run();
  expect((await db.prepare("SELECT action FROM suspension_queue WHERE tendril_id = ?").bind(h.id).first<{ action: string }>())?.action).toBe("restore");
  await reconcileSuspensions(env);
  expect((await req(displayReply.created.url)).status).toBe(200);
});

it("caps an unclaimed tendril at 2 MiB across file versions", async () => {
  const h = await createPublic();
  const display = await api(h, "POST", "links", { role: "display" });
  expect(display.status).toBe(403);
  const first = await api(h, "PUT", "files/a.bin", new Uint8Array(1024 * 1024).fill(1));
  expect(first.status).toBe(200);
  const second = await api(h, "PUT", "files/b.bin", new Uint8Array(1024 * 1024).fill(2));
  expect(second.status).toBe(200);
  const over = await api(h, "PUT", "files/c.bin", new Uint8Array([3]));
  expect(over.status).toBe(413);
  expect(await over.json()).toMatchObject({ error: { code: "quota", limit: 2 * 1024 * 1024 } });
});

it("creates for an email without account credentials, then allows resident after opening", async () => {
  const email = `resident-${crypto.randomUUID()}@example.com`;
  const account = crypto.randomUUID();
  await db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(account, Date.now(), email).run();
  const h = await createPublic(email, "192.0.2.48");
  expect((await api(h, "PATCH", "", { lifetime: "resident" })).status).toBe(403);
  const cookie = await claimAs(h, account, email);
  expect((await api(h, "PATCH", "", { lifetime: "resident" })).status).toBe(200);
  expect((await (await req("/dashboard", { headers: { Cookie: cookie } })).text())).toContain(h.page_url);
  expect((await req("/dashboard/keys", { method: "POST", headers: { Cookie: cookie, Origin: BASE } })).status).toBe(404);
  expect((await req("/api/device", { method: "POST", headers: creatorHeaders, body: "{}" })).status).toBe(404);
});

it("keeps page hosts separate from the service and rejects sibling origins", async () => {
  const first = await createPublic();
  const second = await createPublic();
  expect(new URL(first.page_url).hostname).not.toBe(new URL(second.page_url).hostname);
  const pathOnService = new URL(first.page_url).pathname;
  expect((await req(pathOnService)).status).toBe(404);
  const sibling = new URL(second.page_url).origin;
  const crossPost = await req(first.page_url + "_tendril/report", { method: "POST", headers: {
    Origin: sibling, "Content-Type": "application/x-www-form-urlencoded",
  }, body: new URLSearchParams({ reason: "test" }) });
  expect(crossPost.status).toBe(403);
  const crossWs = await req(first.page_url + "_tendril/ws", { headers: { Upgrade: "websocket", Origin: sibling } });
  expect(crossWs.status).toBe(403);
  const page = await req(first.page_url, { redirect: "manual" });
  expect(page.headers.get("Strict-Transport-Security")).toContain("includeSubDomains");
});

it("deletes a reported unclaimed tendril and blocks its creator for 24 hours", async () => {
  const headers = { ...creatorHeaders, "CF-Connecting-IP": "192.0.2.99" };
  const created = await req("/api/tendrils", { method: "POST", headers, body: JSON.stringify({ owner: "person@example.com" }) });
  expect(created.status).toBe(201);
  const h = await created.json<Handle>();
  const stub = env.TENDRIL.get(env.TENDRIL.idFromName(h.id));
  const report = await stub.fetch(new Request("https://tendril.internal/abuse/report", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "external", account_id: null, reason: "deceptive" }) }));
  expect(report.status).toBe(200);
  expect((await db.prepare("SELECT 1 FROM tendrils WHERE id = ?").bind(h.id).first())).toBeNull();
  const blocked = await req("/api/tendrils", { method: "POST", headers, body: JSON.stringify({ owner: "person@example.com" }) });
  expect(blocked.status).toBe(403);
});

it("exports files and deletes an account with its tendrils", async () => {
  const account = crypto.randomUUID();
  const session = "export-session-" + crypto.randomUUID();
  const now = Date.now();
  await db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, 'export@example.com')").bind(account, now).run();
  const h = await createPublic("export@example.com", "192.0.2.49");
  await claimAs(h, account, "export@example.com", session);
  expect((await api(h, "PUT", "files/data.txt", "hello world")).status).toBe(200);
  const cookie = `__Host-tendriller=${session}`;
  await inDO(h.id, t => t.db.run("INSERT INTO activity (ts, kind, summary, device, source) VALUES (?, 'sensor', 'Page used camera', 'd_test', 'server')", t.now()));
  const sensors = await req(`/dashboard/t/${h.id}`, { headers: { Cookie: cookie } });
  expect(await sensors.text()).toContain("Page used camera");
  const exported = await req("/dashboard/export", { headers: { Cookie: cookie } });
  expect(exported.status).toBe(200);
  const archive = await exported.json<{ tendrils: { id: string; files: { base64: string }[] }[] }>();
  expect(archive.tendrils[0].id).toBe(h.id);
  expect(atob(archive.tendrils[0].files[0].base64)).toBe("hello world");
  const deleted = await req("/dashboard/delete", { method: "POST", redirect: "manual", headers: { Cookie: cookie,
    Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ confirm: "DELETE" }) });
  expect(deleted.status).toBe(303);
  expect((await db.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(account).first())).toBeNull();
  expect((await db.prepare("SELECT 1 FROM tendrils WHERE id = ?").bind(h.id).first())).toBeNull();
});

it("holds a high-risk version on a young account before serving it", async () => {
  const account = crypto.randomUUID();
  await db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)").bind(account, Date.now(), "screen@example.com").run();
  const h = await createPublic("screen@example.com", "192.0.2.46");
  await claimAs(h, account, "screen@example.com");
  const upload = await api(h, "PUT", "files/index.html", "<html><input type=password></html>");
  expect(upload.status).toBe(200);
  expect((await db.prepare("SELECT state FROM tendrils WHERE id = ?").bind(h.id).first<{ state: string }>())?.state).toBe("held");
  expect((await req(h.page_url)).status).toBe(403);
  const audits = await db.prepare("SELECT action FROM audit_log WHERE subject = ?").bind(h.id).all<{ action: string }>();
  expect(audits.results.some(row => row.action === "hold")).toBe(true);
});

it("accepts pages with many outbound URLs without a reputation service", async () => {
  const h = await createPublic("person@example.com", "192.0.2.223");
  const links = Array.from({ length: 60 }, (_, i) => `<a href="https://example.org/${i}">link</a>`).join("");
  const upload = await api(h, "PUT", "files/index.html", `<html>${links}</html>`);
  expect(upload.status).toBe(200);
  expect(await (await api(h, "GET", "files/index.html")).text()).toContain("https://example.org/59");
  const version = await inDO(h.id, t => t.db.one<{ risk_score: number; risk_flags: string }>(
    "SELECT risk_score, risk_flags FROM versions WHERE version = 1"));
  expect(version).toEqual({ risk_score: 0, risk_flags: "[]" });
});

it("retains local static screening for external form actions", async () => {
  const h = await createPublic("person@example.com", "192.0.2.224");
  const upload = await api(h, "PUT", "files/index.html", '<form action="https://example.org/collect"><p>Google sign in</p></form>');
  expect(upload.status).toBe(200);
  const version = await inDO(h.id, t => t.db.one<{ risk_score: number; risk_flags: string }>(
    "SELECT risk_score, risk_flags FROM versions WHERE version = 1"));
  expect(version).toEqual({ risk_score: 8, risk_flags: '["static_screening"]' });
});
