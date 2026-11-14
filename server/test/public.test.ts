import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, inject, it } from "vitest";
import { sha256Hex } from "../src/ids";
import { abuseEmail } from "../src/abuse/mail";
import { reconcileSuspensions } from "../src/abuse/reconcile";
import { api, BASE, inDO, PageClient, req, type Handle } from "./helpers";

const db = env.ACCOUNTS!;
const creatorHeaders = { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" };

beforeAll(async () => {
  await applyD1Migrations(db, inject("d1Migrations"));
  await db.prepare("UPDATE service_state SET mode = 'open' WHERE id = 1").run();
});

async function createPublic(owner?: string, ip = "192.0.2.10"): Promise<Handle> {
  const res = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, "CF-Connecting-IP": ip }, body: JSON.stringify({ owner }) });
  expect(res.status).toBe(201);
  return res.json<Handle>();
}

it("turns abuse email URLs into reports without granting ordinary senders an automatic hold", async () => {
  const h = await createPublic(undefined, "192.0.2.222");
  const message = {
    to: "abuse@tendriller.dev", from: "someone@example.net", rawSize: 400,
    raw: new Response(`From: someone@example.net\r\nTo: abuse@tendriller.dev\r\nSubject: Page report\r\nContent-Type: text/plain\r\n\r\nPlease inspect ${h.page_url}`).body!,
    setReject: () => { throw new Error("Unexpected rejection"); },
  } as unknown as ForwardableEmailMessage;
  await abuseEmail(message, env);
  const report = await db.prepare("SELECT source FROM reports WHERE tendril_id = ?").bind(h.id).first<{ source: string }>();
  expect(report?.source).toBe("mail");
  const stillLive = await db.prepare("SELECT id FROM tendrils WHERE id = ?").bind(h.id).first();
  expect(stillLive).toBeTruthy();
});

it("blocks keyless creation from a configured CIDR range", async () => {
  await db.prepare("INSERT INTO blocks (kind, value, reason) VALUES ('cidr', '198.51.100.0/24', 'test')").run();
  const blocked = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, "CF-Connecting-IP": "198.51.100.42" }, body: "{}" });
  expect(blocked.status).toBe(403);
  expect((await createPublic(undefined, "198.51.101.42")).id).toBeTruthy();
});

it("holds a young page after a burst of distinct guest sign-ins", async () => {
  const account = crypto.randomUUID();
  const key = "ak_burst_" + crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, 'burst@example.com')").bind(account, Date.now()),
    db.prepare("INSERT INTO api_keys (hash, name, account_id, created_at) VALUES (?, 'burst', ?, ?)")
      .bind(await sha256Hex(key), account, Date.now()),
  ]);
  const created = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, Authorization: `Bearer ${key}` }, body: "{}" });
  expect(created.status).toBe(201);
  const h = await created.json<Handle>();
  await inDO(h.id, async t => {
    for (let i = 0; i < 8; i++) await t.recordVisitorSignal("guest", `guest-${i}`);
  });
  expect((await db.prepare("SELECT state FROM tendrils WHERE id = ?").bind(h.id).first<{ state: string }>())?.state).toBe("held");
  expect((await api(h, "GET", "")).status).toBe(403);
});

it("holds repeated claim releases before stripping the current owner", async () => {
  const account = crypto.randomUUID();
  const key = "ak_release_" + crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, 'release@example.com')").bind(account, Date.now()),
    db.prepare("INSERT INTO api_keys (hash, name, account_id, created_at) VALUES (?, 'release', ?, ?)")
      .bind(await sha256Hex(key), account, Date.now()),
  ]);
  const created = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, Authorization: `Bearer ${key}` }, body: "{}" });
  expect(created.status).toBe(201);
  const h = await created.json<Handle>();
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

it("allows a suspended owner to appeal through an expiring one-use token", async () => {
  const account = crypto.randomUUID();
  const key = "ak_appeal_" + crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, email, suspended_at) VALUES (?, ?, 'appeal@example.com', NULL)").bind(account, Date.now()),
    db.prepare("INSERT INTO api_keys (hash, name, account_id, created_at) VALUES (?, 'appeal', ?, ?)")
      .bind(await sha256Hex(key), account, Date.now()),
  ]);
  const created = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, Authorization: `Bearer ${key}` }, body: "{}" });
  expect(created.status).toBe(201);
  const h = await created.json<Handle>();
  await inDO(h.id, t => t.hold("test hold"));
  await db.prepare("UPDATE accounts SET suspended_at = ? WHERE id = ?").bind(Date.now(), account).run();
  const raw = "x".repeat(43);
  await db.prepare("INSERT INTO appeal_tokens (hash, account_id, tendril_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(raw), account, h.id, Date.now() + 60_000).run();
  const path = `/appeal?tendril=${h.id}&token=${raw}`;
  expect((await req(path)).status).toBe(200);
  const posted = await req(path, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ reason: "Wrongful hold" }) });
  expect(posted.status).toBe(200);
  expect((await db.prepare("SELECT reason FROM appeals WHERE tendril_id = ?").bind(h.id).first<{ reason: string }>())?.reason).toBe("Wrongful hold");
  expect(await db.prepare("SELECT 1 FROM appeal_tokens WHERE tendril_id = ?").bind(h.id).first()).toBeNull();
});

it("requires an explicit matching claim and a page session", async () => {
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
  const screen = await req(claimUrl, { headers: { Cookie: cookie } });
  const body = await screen.text();
  expect(body).toContain("Claim and open page");
  const nonce = /name="nonce" value="([^"]+)"/.exec(body)?.[1];
  expect(nonce).toBeTruthy();
  const post = await req(claimUrl, { method: "POST", redirect: "manual", headers: {
    Cookie: cookie, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded",
  }, body: new URLSearchParams({ nonce: nonce! }) });
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

it("creates named account keys and claimed resident tendrils with an exact cap", async () => {
  const account = crypto.randomUUID();
  const rawSession = "key-session-" + crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, 'key@example.com')").bind(account, now),
    db.prepare("INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES ('github', ?, ?, 'keyuser', 'key@example.com', ?)")
      .bind(account, account, now),
    db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(rawSession), account, now, now + 86_400_000),
  ]);
  const cookie = `__Host-tendriller=${rawSession}`;
  const dashboard = await req("/dashboard", { headers: { Cookie: cookie } });
  expect(await dashboard.text()).toContain("Agent keys");
  const badOrigin = await req("/dashboard/keys", { method: "POST", headers: { Cookie: cookie, Origin: "https://elsewhere.test" }, body: "{}" });
  expect(badOrigin.status).toBe(403);
  const keyRes = await req("/dashboard/keys", { method: "POST", headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "builder" }) });
  expect(keyRes.status).toBe(201);
  const key = (await keyRes.json<{ key: string }>()).key;
  expect(key).toMatch(/^ak_/);
  const created: Handle[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ name: `resident ${i}`, lifetime: "resident" }) });
    expect(res.status).toBe(201);
    created.push(await res.json<Handle>());
  }
  const populatedDashboard = await (await req("/dashboard", { headers: { Cookie: cookie } })).text();
  expect(populatedDashboard).toContain("resident 0");
  expect(populatedDashboard).toContain(created[0].page_url);
  expect(populatedDashboard).toContain("Copy link");
  const fourth = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ lifetime: "resident" }) });
  expect(fourth.status).toBe(429);
  expect(await fourth.json()).toMatchObject({ error: { code: "quota", limit: 3 } });
  const owner = await (await api(created[0], "GET", "")).json<{ owner: { login: string } }>();
  expect(owner.owner.login).toBe("keyuser");
  const page = await req(created[0].page_url, { redirect: "manual" });
  expect(page.status).toBe(302);
  const auth = await req(page.headers.get("Location")!, { redirect: "manual", headers: { Cookie: cookie } });
  expect(auth.status).toBe(303);
  const revoke = await req("/dashboard/keys/builder", { method: "DELETE", headers: { Cookie: cookie, Origin: BASE } });
  expect(revoke.status).toBe(204);
  const denied = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, Authorization: `Bearer ${key}` }, body: "{}" });
  expect(denied.status).toBe(401);
});

it("grants a one-time agent key through device approval", async () => {
  const account = crypto.randomUUID();
  const rawSession = "device-session-" + crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, 'device@example.com')").bind(account, now),
    db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(rawSession), account, now, now + 86_400_000),
  ]);
  const init = await req("/api/device", { method: "POST", headers: { ...creatorHeaders }, body: JSON.stringify({ name: "my agent" }) });
  expect(init.status).toBe(201);
  const codes = await init.json<{ device_code: string; user_code: string; verification_url: string }>();
  expect((await req("/api/device/token", { method: "POST", headers: creatorHeaders,
    body: JSON.stringify({ device_code: codes.device_code }) })).status).toBe(428);
  const cookie = `__Host-tendriller=${rawSession}`;
  expect(await (await req(`/device?code=${codes.user_code}`, { headers: { Cookie: cookie } })).text()).toContain("my agent");
  const denied = await req("/device", { method: "POST", headers: { Cookie: cookie, Origin: "https://elsewhere.test" },
    body: new URLSearchParams({ code: codes.user_code }) });
  expect(denied.status).toBe(403);
  const approve = await req("/device", { method: "POST", headers: { Cookie: cookie, Origin: BASE,
    "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: codes.user_code }) });
  expect(approve.status).toBe(200);
  const grant = await req("/api/device/token", { method: "POST", headers: creatorHeaders,
    body: JSON.stringify({ device_code: codes.device_code }) });
  expect(grant.status).toBe(200);
  const key = (await grant.json<{ key: string }>()).key;
  expect(key).toMatch(/^ak_/);
  expect((await req("/api/device/token", { method: "POST", headers: creatorHeaders,
    body: JSON.stringify({ device_code: codes.device_code }) })).status).toBe(400);
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
  const created = await req("/api/tendrils", { method: "POST", headers, body: "{}" });
  expect(created.status).toBe(201);
  const h = await created.json<Handle>();
  const stub = env.TENDRIL.get(env.TENDRIL.idFromName(h.id));
  const report = await stub.fetch(new Request("https://tendril.internal/abuse/report", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "external", account_id: null, reason: "deceptive" }) }));
  expect(report.status).toBe(200);
  expect((await db.prepare("SELECT 1 FROM tendrils WHERE id = ?").bind(h.id).first())).toBeNull();
  const blocked = await req("/api/tendrils", { method: "POST", headers, body: "{}" });
  expect(blocked.status).toBe(403);
});

it("exports files and deletes an account with its tendrils", async () => {
  const account = crypto.randomUUID();
  const session = "export-session-" + crypto.randomUUID();
  const key = "ak_export_" + crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, 'export@example.com')").bind(account, now),
    db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(session), account, now, now + 86_400_000),
    db.prepare("INSERT INTO api_keys (hash, name, account_id, created_at) VALUES (?, 'export', ?, ?)")
      .bind(await sha256Hex(key), account, now),
  ]);
  const created = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, Authorization: `Bearer ${key}` }, body: "{}" });
  expect(created.status).toBe(201);
  const h = await created.json<Handle>();
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
  const key = "ak_screen_" + crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO accounts (id, created_at, email) VALUES (?, ?, 'screen@example.com')").bind(account, Date.now()),
    db.prepare("INSERT INTO api_keys (hash, name, account_id, created_at) VALUES (?, 'screen', ?, ?)")
      .bind(await sha256Hex(key), account, Date.now()),
  ]);
  const created = await req("/api/tendrils", { method: "POST", headers: { ...creatorHeaders, Authorization: `Bearer ${key}` }, body: "{}" });
  expect(created.status).toBe(201);
  const h = await created.json<Handle>();
  const upload = await api(h, "PUT", "files/index.html", "<html><input type=password></html>");
  expect(upload.status).toBe(200);
  expect((await db.prepare("SELECT state FROM tendrils WHERE id = ?").bind(h.id).first<{ state: string }>())?.state).toBe("held");
  expect((await req(h.page_url)).status).toBe(403);
  const audits = await db.prepare("SELECT action FROM audit_log WHERE subject = ?").bind(h.id).all<{ action: string }>();
  expect(audits.results.some(row => row.action === "hold")).toBe(true);
});

it("accepts pages with many outbound URLs without a reputation service", async () => {
  const h = await createPublic(undefined, "192.0.2.223");
  const links = Array.from({ length: 60 }, (_, i) => `<a href="https://example.org/${i}">link</a>`).join("");
  const upload = await api(h, "PUT", "files/index.html", `<html>${links}</html>`);
  expect(upload.status).toBe(200);
  expect(await (await api(h, "GET", "files/index.html")).text()).toContain("https://example.org/59");
  const version = await inDO(h.id, t => t.db.one<{ risk_score: number; risk_flags: string }>(
    "SELECT risk_score, risk_flags FROM versions WHERE version = 1"));
  expect(version).toEqual({ risk_score: 0, risk_flags: "[]" });
});

it("retains local static screening for external form actions", async () => {
  const h = await createPublic(undefined, "192.0.2.224");
  const upload = await api(h, "PUT", "files/index.html", '<form action="https://example.org/collect"><p>Google sign in</p></form>');
  expect(upload.status).toBe(200);
  const version = await inDO(h.id, t => t.db.one<{ risk_score: number; risk_flags: string }>(
    "SELECT risk_score, risk_flags FROM versions WHERE version = 1"));
  expect(version).toEqual({ risk_score: 8, risk_flags: '["static_screening"]' });
});
