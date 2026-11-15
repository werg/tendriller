import runtimeRelease from "../src/runtime-release.json";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { route } from "../src/router";
import { api, apiJson, BASE, create, PageClient, req } from "./helpers";

describe("public routes", () => {
  it("serves health, landing page and 404s", async () => {
    expect(await (await req("/health")).json()).toEqual({ ok: true });
    const landing = await req("/");
    expect(landing.headers.get("Content-Type")).toContain("text/html");
    const html = await landing.text();
    expect(html).toContain("/agent.md");
    expect(html).toContain("https://github.com/werg/tendriller");
    expect(html).toContain("Why Tendriller?");
    const nf = await req("/nope");
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("serves a staging service host within its page zone", async () => {
    const staging = { ...env, PUBLIC_BASE: "https://staging.tendriller.dev", PAGE_BASE_DOMAIN: "tendriller.dev" };
    const health = await route(new Request("https://staging.tendriller.dev/health"), staging);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    const invalidPage = await route(new Request("https://not-a-page.tendriller.dev/health"), staging);
    expect(invalidPage.status).toBe(404);
  });

  it("serves the runtime bundle as a static asset", async () => {
    const res = await req(`/_tendril/runtime/${runtimeRelease.id}/tendril.js`);
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

  it("serves immutable runtime and scoped service worker under P", async () => {
    const h = await create();
    const js = await req(h.page_url + `_tendril/runtime/${runtimeRelease.id}/tendril.js`);
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


});
