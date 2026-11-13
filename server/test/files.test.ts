import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { advance, api, apiJson, create, PageClient, req, runAlarm } from "./helpers";

const PAGE = `<!doctype html><html><head lang="en"><title>T</title></head><body><h1>Hi</h1></body></html>`;

async function events(h: any, after = 0) {
  return apiJson(h, "GET", `events?after=${after}`);
}

describe("files and versions", () => {
  it("upload creates a version and the page is served with injection", async () => {
    const h = await create();
    const r = await apiJson(h, "PUT", "files/index.html", PAGE, 200);
    expect(r).toEqual({ version: 1, files: ["index.html"] });
    const res = await req(h.page_url);
    const html = await res.text();
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(html.startsWith(`<!doctype html><html><head lang="en"><script>window.__TENDRIL__=`)).toBe(true);
    expect(html).toContain(`"version":1`);
    expect(html).toContain("<h1>Hi</h1>");
  });

  it("injects at the very start when there is no <head>", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/index.html", "<p>bare</p>");
    const html = await (await req(h.page_url)).text();
    expect(html.startsWith("<script>window.__TENDRIL__=")).toBe(true);
    expect(html.endsWith("<p>bare</p>")).toBe(true);
  });

  it("guesses content types and serves other files without injection", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/index.html", PAGE);
    await apiJson(h, "PUT", "files/js/app.js", "console.log(1)", undefined);
    const r = await apiJson(h, "PUT", "files/data.json", '{"a":1}');
    expect(r).toEqual({ version: 3, files: ["data.json", "index.html", "js/app.js"] });
    const js = await req(h.page_url + "js/app.js");
    expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe("console.log(1)");
    const bin = await api(h, "PUT", "files/img.png", new Uint8Array([137, 80, 78, 71]), { "Content-Type": "application/octet-stream" });
    await bin.text();
    const png = await req(h.page_url + "img.png");
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    const custom = await api(h, "PUT", "files/x.txt", "x", { "Content-Type": "text/x-custom" });
    await custom.text();
    expect((await req(h.page_url + "x.txt")).headers.get("Content-Type")).toBe("text/x-custom");
    const missing = await req(h.page_url + "nope.js");
    expect(missing.status).toBe(404);
    await missing.text();
  });

  it("rejects reserved and invalid paths", async () => {
    const h = await create();
    for (const p of ["_tendril/x.js", "dir/"]) {
      const res = await api(h, "PUT", "files/" + p, "x");
      expect(res.status, p).toBe(400);
      await res.text();
    }
    const dots = await api(h, "POST", "files", { files: { "a/../b": "x" } });
    expect(dots.status).toBe(400);
    expect(await dots.json()).toMatchObject({ error: { code: "bad_path" } });
  });

  it("POST files with base64, delete and replace", async () => {
    const h = await create();
    const r1 = await apiJson(h, "POST", "files", { files: { "index.html": PAGE, "a.css": "body{}", "b.bin": { base64: btoa("\x00\x01"), type: "application/x-test" } }, message: "first" });
    expect(r1).toEqual({ version: 1, files: ["a.css", "b.bin", "index.html"] });
    const r2 = await apiJson(h, "POST", "files", { files: { "c.js": "1" }, delete: ["a.css"] });
    expect(r2).toEqual({ version: 2, files: ["b.bin", "c.js", "index.html"] });
    const r3 = await apiJson(h, "POST", "files", { files: { "index.html": "<p>only</p>" }, replace: true });
    expect(r3).toEqual({ version: 3, files: ["index.html"] });
    const list = await apiJson(h, "GET", "files?version=1");
    expect(list.version).toBe(1);
    expect(list.files.find((f: any) => f.path === "b.bin")).toMatchObject({ type: "application/x-test", size: 2 });
    expect(list.files[0].hash).toMatch(/^[0-9a-f]{64}$/);
    const cur = await apiJson(h, "GET", "files");
    expect(cur).toMatchObject({ version: 3, files: [{ path: "index.html" }] });
    const content = await api(h, "GET", "files/index.html");
    expect(await content.text()).toBe("<p>only</p>");
    const old = await api(h, "GET", "files/a.css?version=1");
    expect(await old.text()).toBe("body{}");
    const versions = await apiJson(h, "GET", "versions");
    expect(versions).toMatchObject({ current: 3, latest: 3, healthy: null });
    expect(versions.versions.map((v: any) => v.version)).toEqual([3, 2, 1]);
    expect(versions.versions[2]).toMatchObject({ status: "pending", message: "first", files: 3 });
  });

  it("stores content once per hash in R2", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/a.txt", "same");
    await apiJson(h, "PUT", "files/b.txt", "same");
    const list = await env.FILES.list({ prefix: `t/${h.id}/files/` });
    expect(list.objects.length).toBe(1);
  });

  it("honours ?v= for non-root files", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/app.js", "v1");
    await apiJson(h, "PUT", "files/app.js", "v2");
    expect(await (await req(h.page_url + "app.js")).text()).toBe("v2");
    expect(await (await req(h.page_url + "app.js?v=1")).text()).toBe("v1");
  });

  it("serves directory index files", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/sub/index.html", "<p>sub</p>");
    const html = await (await req(h.page_url + "sub/")).text();
    expect(html).toContain("<p>sub</p>");
    expect(html).toContain("__TENDRIL__");
  });
});

describe("health and fallback", () => {
  it("ok report makes a version healthy and emits version_healthy without wake", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/index.html", PAGE);
    const page = await PageClient.connect(h.page_url, { version: 1 });
    page.send({ t: "health", version: 1, ok: true, errors: [] });
    await page.request({ t: "versions" }); // round-trip so the health message is processed
    const v = await apiJson(h, "GET", "versions");
    expect(v).toMatchObject({ current: 1, latest: 1, healthy: 1 });
    expect(v.versions[0].status).toBe("healthy");
    const ev = await events(h);
    const healthy = ev.events.find((e: any) => e.type === "version_healthy");
    expect(healthy).toMatchObject({ data: { version: 1 }, wake: false });
    page.close();
  });

  it("failed report rolls back to the last healthy version and wakes once", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/index.html", "<p>good</p>");
    const page = await PageClient.connect(h.page_url, { version: 1 });
    page.send({ t: "health", version: 1, ok: true, errors: [] });
    await page.request({ t: "versions" });

    await apiJson(h, "PUT", "files/index.html", "<p>bad</p>");
    expect((await page.next("reload")).version).toBe(2);
    expect(await (await req(h.page_url)).text()).toContain("bad");

    page.send({ t: "health", version: 2, ok: false, errors: ["ReferenceError: x is not defined"] });
    expect((await page.next("reload")).version).toBe(1);
    page.send({ t: "health", version: 2, ok: false, errors: ["again"] }); // second report ignored
    await page.request({ t: "versions" });

    const v = await apiJson(h, "GET", "versions");
    expect(v).toMatchObject({ current: 1, latest: 2, healthy: 1 });
    expect(v.versions[0]).toMatchObject({ version: 2, status: "failed", errors: ["ReferenceError: x is not defined"] });
    expect(await (await req(h.page_url)).text()).toContain("good");

    const ev = await events(h);
    const failed = ev.events.filter((e: any) => e.type === "version_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ wake: true, data: { version: 2, rolled_back_to: 1, errors: ["ReferenceError: x is not defined"] } });
    page.close();
  });

  it("serving rule: failed current with no healthy version still serves current", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/index.html", "<p>only</p>");
    const page = await PageClient.connect(h.page_url, { version: 1 });
    page.send({ t: "health", version: 1, ok: false, errors: ["boom"] });
    await page.request({ t: "versions" });
    const ev = await events(h);
    expect(ev.events.find((e: any) => e.type === "version_failed").data.rolled_back_to).toBeNull();
    expect(await (await req(h.page_url)).text()).toContain("only");
    page.close();
  });

  it("no report within 15 s after serving fails the version (alarm)", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/index.html", "<p>good</p>");
    const page = await PageClient.connect(h.page_url, { version: 1 });
    page.send({ t: "health", version: 1, ok: true, errors: [] });
    await page.request({ t: "versions" });
    await apiJson(h, "PUT", "files/index.html", "<p>hangs</p>");
    // A browser navigation serves version 2.
    const res = await req(h.page_url, { headers: { "Sec-Fetch-Mode": "navigate" } });
    expect(await res.text()).toContain("hangs");
    await advance(h.id, 16_000);
    await runAlarm(h.id);
    const v = await apiJson(h, "GET", "versions");
    expect(v.versions[0]).toMatchObject({ version: 2, status: "failed" });
    expect(v.current).toBe(1);
    expect(await (await req(h.page_url)).text()).toContain("good");
    page.close();
  });

  it("a plain fetch (curl) of the page does not start the health timer", async () => {
    const h = await create();
    await apiJson(h, "PUT", "files/index.html", "<p>x</p>");
    await (await req(h.page_url)).text();
    await advance(h.id, 20_000);
    await runAlarm(h.id);
    const v = await apiJson(h, "GET", "versions");
    expect(v.versions[0].status).toBe("pending");
  });
});

describe("rollback", () => {
  it("defaults to the newest healthy version older than current; accepts explicit versions", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    for (const n of [1, 2, 3]) {
      await apiJson(h, "PUT", "files/index.html", `<p>v${n}</p>`);
      await page.next("reload");
      page.send({ t: "health", version: n, ok: true, errors: [] });
    }
    await page.request({ t: "versions" });
    expect(await apiJson(h, "POST", "rollback", {})).toEqual({ version: 2 });
    expect((await page.next("reload")).version).toBe(2);
    expect(await (await req(h.page_url)).text()).toContain("v2");
    expect(await apiJson(h, "POST", "rollback", { version: 3 })).toEqual({ version: 3 });
    const none = await api(h, "POST", "rollback", { version: 99 });
    expect(none.status).toBe(404);
    await none.text();
    page.close();
  });

  it("owner page can roll back ('go back') and list versions", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    for (const n of [1, 2]) {
      await apiJson(h, "PUT", "files/index.html", `<p>v${n}</p>`);
      page.send({ t: "health", version: n, ok: true, errors: [] });
    }
    const vs = await page.request({ t: "versions" });
    expect(vs).toMatchObject({ t: "versions", current: 2 });
    expect(vs.versions).toHaveLength(2);
    const ack = await page.request({ t: "rollback" });
    expect(ack).toMatchObject({ t: "ack", version: 1 });
    expect((await apiJson(h, "GET", "versions")).current).toBe(1);
    const none = await page.request({ t: "rollback" });
    expect(none.error).toBe("no_healthy_version");
    page.close();
  });
});

describe("device proof on page HTTP routes", () => {
  const post = (url: string, headers: Record<string, string> = {}) =>
    req(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ tools: [] }) });

  it("voice sessions need a verified owner device on an owner link", async () => {
    const h = await create();
    const owner = await PageClient.connect(h.page_url);
    const proof = { "X-Tendril-Device": owner.deviceId, "X-Tendril-Device-Secret": owner.secret };
    // no proof, wrong secret
    expect((await post(h.page_url + "_tendril/voice/session")).status).toBe(403);
    expect((await post(h.page_url + "_tendril/voice/session", { ...proof, "X-Tendril-Device-Secret": "a".repeat(32) })).status).toBe(403);
    // a verified owner passes the gate (501: no provider configured in tests)
    expect((await post(h.page_url + "_tendril/voice/session", proof)).status).toBe(501);
    // a guest device on a guest link is refused
    const link = await apiJson(h, "POST", "links", { role: "guest" });
    const guest = await PageClient.connect(link.url);
    const gproof = { "X-Tendril-Device": guest.deviceId, "X-Tendril-Device-Secret": guest.secret };
    expect((await post(link.url + "_tendril/voice/session", gproof)).status).toBe(403);
    // an owner's proof used through a guest link is refused too
    expect((await post(link.url + "_tendril/voice/session", proof)).status).toBe(403);
    owner.close();
    guest.close();
  });

  it("blob uploads are attributed only with a valid device proof", async () => {
    const h = await create();
    const owner = await PageClient.connect(h.page_url);
    const up = async (headers: Record<string, string>) =>
      (await req(h.page_url + "_tendril/blob", { method: "POST", headers: { "Content-Type": "text/plain", ...headers }, body: "x" })).json() as Promise<any>;
    await up({ "X-Tendril-Device": owner.deviceId });
    await up({ "X-Tendril-Device": owner.deviceId, "X-Tendril-Device-Secret": owner.secret });
    const blobs = (await apiJson(h, "GET", "blobs")).blobs;
    expect(blobs.map((b: any) => b.device).sort()).toEqual([null, owner.deviceId].sort());
    owner.close();
  });
});
