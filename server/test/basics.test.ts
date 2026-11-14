import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { route } from "../src/router";
import { api, apiJson, BASE, create, PageClient, req } from "./helpers";

describe("public routes", () => {
  it("serves health, landing page and 404s", async () => {
    expect(await (await req("/health")).json()).toEqual({ ok: true });
    const landing = await req("/");
    expect(landing.headers.get("Content-Type")).toContain("text/html");
    expect(await landing.text()).toContain("/agent.md");
    const nf = await req("/nope");
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("serves the runtime bundle as a static asset", async () => {
    const res = await req("/_tendril/tendril.js");
    expect(res.status).toBe(200);
    await res.text();
  });

  it("answers CORS preflight and adds CORS headers on /api", async () => {
    const pre = await req("/api/tendrils", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    const h = await create();
    const res = await api(h, "GET", "");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await res.text();
  });
});

describe("create", () => {
  it("creates a tendril with defaults", async () => {
    const h = await create();
    expect(h.id).toMatch(/^[a-z2-7]{12}$/);
    expect(h.token).toMatch(/^tk_[a-z2-7]{32}$/);
    expect(h.name).toBe("Tendril");
    expect(h.lifetime).toBe("ad_hoc");
    expect(h.page_url).toMatch(new RegExp(`^${BASE}/t/${h.id}/s/[a-z2-7]{26}/$`));
    expect(h.api).toBe(`${BASE}/api/t/${h.id}`);
    expect(h.agent_md).toBe(`${BASE}/agent.md`);
    expect(h.expires_at).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const info = await apiJson(h, "GET", "");
    expect(info).toMatchObject({ id: h.id, name: "Tendril", pairing: "open", lifetime: "ad_hoc", version: { current: null, latest: null, healthy: null } });
    expect(info.presence.state).toBe("working"); // the GET itself was a check-in
  });

  it("accepts name, lifetime and pairing; validates them", async () => {
    const h = await create({ name: "Kitchen", lifetime: "resident", pairing: "required" });
    expect(h).toMatchObject({ name: "Kitchen", lifetime: "resident", expires_at: null });
    const bad = await req("/api/tendrils", { method: "POST", body: JSON.stringify({ lifetime: "forever" }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("requires CREATE_KEY when configured", async () => {
    const e = { ...env, CREATE_KEY: "sekrit" };
    const no = await route(new Request(BASE + "/api/tendrils", { method: "POST", body: "{}" }), e);
    expect(no.status).toBe(401);
    const yes = await route(new Request(BASE + "/api/tendrils", { method: "POST", body: "{}", headers: { Authorization: "Bearer sekrit" } }), e);
    expect(yes.status).toBe(201);
    await yes.text();
  });

  it("rejects missing or wrong tokens", async () => {
    const h = await create();
    const none = await req(h.api);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: { code: "unauthorized" } });
    const wrong = await api(h, "GET", "", undefined, {}, "tk_" + "a".repeat(32));
    expect(wrong.status).toBe(401);
    await wrong.text();
    const missing = await req(`${BASE}/api/t/aaaaaaaaaaaa`, { headers: { Authorization: `Bearer ${h.token}` } });
    expect(missing.status).toBe(404);
    await missing.text();
  });

  it("PATCH updates name and install metadata", async () => {
    const h = await create();
    const info = await apiJson(h, "PATCH", "", { name: "Road trip", short_name: "Trip", theme_color: "#112233", lifetime: "resident" });
    expect(info).toMatchObject({ name: "Road trip", lifetime: "resident", expires_at: null, meta: { short_name: "Trip", theme_color: "#112233" } });
    const bad = await api(h, "PATCH", "", { icon: "ftp://x" });
    expect(bad.status).toBe(400);
    await bad.text();
  });
});

describe("page URLs", () => {
  it("serves the holding page with the runtime injected", async () => {
    const h = await create({ name: "Hello <World>" });
    const res = await req(h.page_url);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Waiting for the agent");
    expect(html).toContain("Hello &lt;World&gt;");
    const base = new URL(h.page_url).pathname;
    expect(html).toContain(`<script src="${base}_tendril/tendril.js"></script>`);
    const m = /window\.__TENDRIL__=(\{.*?\});<\/script>/.exec(html)!;
    const cfg = JSON.parse(m[1]);
    expect(cfg).toEqual({
      id: h.id,
      base,
      version: 0,
      ws: `${base}_tendril/ws`,
      features: { transcribe: false, voice: false, push: false, vapid: null },
    });
    // injected right after <head>
    expect(html.indexOf("<script>window.__TENDRIL__")).toBe(html.indexOf("<head>") + "<head>".length);
  });

  it("redirects P without trailing slash with 308", async () => {
    const h = await create();
    const res = await req(h.page_url.slice(0, -1) + "?x=1", { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe(h.page_url + "?x=1");
  });

  it("404s for an unknown page key", async () => {
    const h = await create();
    const res = await req(`${BASE}/t/${h.id}/s/${"a".repeat(26)}/`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("serves runtime, service worker and snippets under P", async () => {
    const h = await create();
    const js = await req(h.page_url + "_tendril/tendril.js");
    expect(js.status).toBe(200);
    await js.text();
    const sw = await req(h.page_url + "_tendril/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("Service-Worker-Allowed")).toBe(new URL(h.page_url).pathname);
    await sw.text();
    const sn = await req(h.page_url + "_tendril/snippets/does-not-exist.js");
    expect(sn.status).toBe(404);
    await sn.text();
  });

  it("accepts the subdomain shape", async () => {
    const h = await create();
    const key = new URL(h.page_url).pathname.split("/")[4];
    const e = { ...env, PAGE_BASE_DOMAIN: "pages.example.com", PAGE_HOST_MODE: "subdomain" as const };
    const res = await route(new Request(`https://${h.id}.pages.example.com/s/${key}/`), e);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`"base":"/s/${key}/"`);
    const redirect = await route(new Request(`https://${h.id}.pages.example.com/s/${key}`), e);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("Strict-Transport-Security")).toContain("includeSubDomains");
    const servicePath = await route(new Request(`http://localhost:8787/t/${h.id}/s/${key}/`), e);
    expect(servicePath.status).toBe(404);
    const serviceApiOnPage = await route(new Request(`https://${h.id}.pages.example.com/api/tendrils`, { method: "POST" }), e);
    expect(serviceApiOnPage.status).toBe(404);
    const sibling = await route(new Request(`https://${h.id}.pages.example.com/s/${key}/_tendril/blob`, {
      method: "POST", headers: { Origin: "https://other.pages.example.com" }, body: "attack",
    }), e);
    expect(sibling.status).toBe(403);
    const socket = await route(new Request(`https://${h.id}.pages.example.com/s/${key}/_tendril/ws`, {
      headers: { Upgrade: "websocket", Origin: "https://other.pages.example.com" },
    }), e);
    expect(socket.status).toBe(403);
  });

  it("serves info, manifest and a generated icon", async () => {
    const h = await create({ name: "Pantry" });
    const info = await (await req(h.page_url + "_tendril/info")).json<any>();
    expect(info).toMatchObject({ id: h.id, version: 0, files: [], features: { push: false } });
    const man = await (await req(h.page_url + "_tendril/manifest.webmanifest")).json<any>();
    const base = new URL(h.page_url).pathname;
    expect(man).toMatchObject({ name: "Pantry", start_url: base, scope: base });
    const icon = await req(h.page_url + "_tendril/icon");
    expect(icon.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await icon.text()).toContain(">P</text>");
  });

  it("transcribe is 501 without the AI binding", async () => {
    const h = await create();
    const res = await req(h.page_url + "_tendril/transcribe", { method: "POST", body: new Uint8Array([1, 2, 3]) });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: { code: "unavailable" } });
  });

  it("voice session delegates to voice.ts (501 stub)", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    const res = await req(h.page_url + "_tendril/voice/session", {
      method: "POST", body: "{}",
      headers: { "X-Tendril-Device": page.deviceId, "X-Tendril-Device-Secret": page.secret },
    });
    page.close();
    expect(res.status).toBe(501);
    await res.text();
  });
});
