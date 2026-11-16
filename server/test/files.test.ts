import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { advance, api, apiJson, create, PageClient, publishTestFiles, req, runAlarm, uploadAgent } from "./helpers";
import { sha256Hex } from "../src/ids";

const PAGE = `<!doctype html><html><head lang="en"><title>T</title></head><body><h1>Hi</h1></body></html>`;

async function events(h: any, after = 0) {
  return apiJson(h, "GET", `events?after=${after}`);
}

describe("files and versions", () => {

  it("injects at the very start when there is no <head>", async () => {
    const h = await create();
    await publishTestFiles(h, { files: { "index.html": "<p>bare</p>" } });
    const html = await (await req(h.page_url)).text();
    expect(html.startsWith("<base href=")).toBe(true);
    expect(html).toContain("<script>window.__TENDRIL__=");
    expect(html.endsWith("<p>bare</p>")).toBe(true);
  });


  it("rejects reserved and invalid paths", async () => {
    const h = await create();
    const blob = await uploadAgent(h, "x", "text/html");
    for (const p of ["_tendril/x.js", "dir/"]) {
      const res = await api(h, "POST", "publications", { cid: crypto.randomUUID(), expected_generations: {},
        expected_head_revision: 0, entry: p, files: [{ path: p, blob_id: blob.id, type: "text/html" }] });
      expect(res.status, p).toBe(400);
      await res.text();
    }
    const dots = await api(h, "POST", "publications", { cid: crypto.randomUUID(), expected_generations: {},
      expected_head_revision: 0, entry: "a/../b", files: [{ path: "a/../b", blob_id: blob.id, type: "text/html" }] });
    expect(dots.status).toBe(400);
    expect(await dots.json()).toMatchObject({ error: { code: "bad_request" } });
  });


  it("stores content once per hash in R2", async () => {
    const h = await create();
    await uploadAgent(h, "same", "text/plain", "a.txt");
    await uploadAgent(h, "same", "text/plain", "b.txt");
    const list = await env.FILES.list({ prefix: `t/${h.id}/files/` });
    expect(list.objects.length).toBe(1);
  });

  it("pins file bytes to explicit immutable publication URLs", async () => {
    const h = await create();
    await publishTestFiles(h, { files: { "app.js": "v1" } });
    await publishTestFiles(h, { files: { "app.js": "v2" } });
    expect(await (await req(h.page_url + "app.js")).text()).toBe("v2");
    expect(await (await req(h.page_url + "_publications/1/app.js")).text()).toBe("v1");
  });

  it("serves directory index files", async () => {
    const h = await create();
    await publishTestFiles(h, { files: { "sub/index.html": "<p>sub</p>" } });
    const html = await (await req(h.page_url + "sub/")).text();
    expect(html).toContain("<p>sub</p>");
    expect(html).toContain("__TENDRIL__");
  });
});

describe("health and fallback", () => {
  it("ok report makes a version healthy and emits version_healthy without wake", async () => {
    const h = await create();
    await publishTestFiles(h, { files: { "index.html": PAGE } });
    const page = await PageClient.connect(h.page_url, { version: 1 });
    page.send({ t: "health", version: 1, visible: true, ok: true, errors: [] });
    await page.request({ t: "versions" }); // round-trip so the health message is processed
    const v = await apiJson(h, "GET", "publications");
    expect(v).toMatchObject({ current: 1, latest: 1, healthy: 1 });
    expect(v.versions[0].status).toBe("healthy");
    const ev = await events(h);
    const healthy = ev.events.find((e: any) => e.type === "version_healthy");
    expect(healthy).toMatchObject({ data: { version: 1 }, wake: false });
    page.close();
  });

  it("failed report rolls back to the last healthy version and wakes once", async () => {
    const h = await create();
    await publishTestFiles(h, { files: { "index.html": "<p>good</p>" } });
    const page = await PageClient.connect(h.page_url, { version: 1 });
    page.send({ t: "health", version: 1, visible: true, ok: true, errors: [] });
    await page.request({ t: "versions" });

    await publishTestFiles(h, { files: { "index.html": "<p>bad</p>" } });
    expect((await page.next("reload")).version).toBe(2);
    expect(await (await req(h.page_url)).text()).toContain("bad");

    page.send({ t: "health", version: 2, visible: true, ok: false, errors: ["ReferenceError: x is not defined"] });
    expect((await page.next("reload")).version).toBe(1);
    page.send({ t: "health", version: 2, visible: true, ok: false, errors: ["again"] }); // second report ignored
    await page.request({ t: "versions" });

    const v = await apiJson(h, "GET", "publications");
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
    await publishTestFiles(h, { files: { "index.html": "<p>only</p>" } });
    const page = await PageClient.connect(h.page_url, { version: 1 });
    page.send({ t: "health", version: 1, visible: true, ok: false, errors: ["boom"] });
    await page.request({ t: "versions" });
    const ev = await events(h);
    expect(ev.events.find((e: any) => e.type === "version_failed").data.rolled_back_to).toBeNull();
    expect(await (await req(h.page_url)).text()).toContain("only");
    page.close();
  });

  it("a background navigation cannot roll back a pending update", async () => {
    const h = await create();
    await publishTestFiles(h, { files: { "index.html": "<p>good</p>" } });
    const page = await PageClient.connect(h.page_url, { version: 1 });
    page.send({ t: "health", version: 1, visible: true, ok: true, errors: [] });
    await page.request({ t: "versions" });
    await publishTestFiles(h, { files: { "index.html": "<p>hangs</p>" } });
    // A browser navigation is not evidence that its tab is visible.
    const res = await req(h.page_url, { headers: { "Sec-Fetch-Mode": "navigate" } });
    expect(await res.text()).toContain("hangs");
    await advance(h.id, 16_000);
    await runAlarm(h.id);
    const v = await apiJson(h, "GET", "publications");
    expect(v.versions[0]).toMatchObject({ version: 2, status: "pending" });
    expect(v.current).toBe(2);
    expect(await (await req(h.page_url)).text()).toContain("hangs");
    page.send({ t: "health", version: 2, visible: false, ok: false, errors: ["background error"] });
    await page.request({ t: "versions" });
    expect((await apiJson(h, "GET", "publications")).versions[0].status).toBe("pending");
    page.send({ t: "health", version: 2, visible: true, ok: true, errors: [] });
    await page.request({ t: "versions" });
    expect((await apiJson(h, "GET", "publications")).versions[0].status).toBe("healthy");
    page.close();
  });

  it("publishes while every device is offline and waits for visible health", async () => {
    const h = await create();
    await publishTestFiles(h, { files: { "index.html": "<p>x</p>" } });
    await advance(h.id, 20_000);
    await runAlarm(h.id);
    const v = await apiJson(h, "GET", "publications");
    expect(v.current).toBe(1);
    expect(v.versions[0].status).toBe("pending");
    expect(await (await req(h.page_url)).text()).toContain("x");
  });
});

describe("rollback", () => {
  it("defaults to the newest healthy version older than current; accepts explicit versions", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    for (const n of [1, 2, 3]) {
      await publishTestFiles(h, { files: { "index.html": `<p>v${n}</p>` } });
      await page.next("reload");
      page.send({ t: "health", version: n, visible: true, ok: true, errors: [] });
    }
    await page.request({ t: "versions" });
    expect(await apiJson(h, "POST", "publications/rollback", { cid: "back-to-2", expected_generations: {},
      expected_head_revision: 3, version: 2 })).toEqual({ version: 2, head_revision: 4 });
    expect((await page.next("reload")).version).toBe(2);
    expect(await (await req(h.page_url)).text()).toContain("v2");
    expect(await apiJson(h, "POST", "publications/rollback", { cid: "forward-to-3", expected_generations: {},
      expected_head_revision: 4, version: 3 })).toEqual({ version: 3, head_revision: 5 });
    const none = await api(h, "POST", "publications/rollback", { cid: "missing-version", expected_generations: {},
      expected_head_revision: 5, version: 99 });
    expect(none.status).toBe(404);
    await none.text();
    page.close();
  });

  it("owner page can roll back ('go back') and list versions", async () => {
    const h = await create();
    const page = await PageClient.connect(h.page_url);
    for (const n of [1, 2]) {
      await publishTestFiles(h, { files: { "index.html": `<p>v${n}</p>` } });
      page.send({ t: "health", version: n, visible: true, ok: true, errors: [] });
    }
    const vs = await page.request({ t: "versions" });
    expect(vs).toMatchObject({ t: "versions", current: 2 });
    expect(vs.versions).toHaveLength(2);
    const ack = await page.request({ t: "rollback" });
    expect(ack).toMatchObject({ t: "ack", version: 1 });
    expect((await apiJson(h, "GET", "publications")).current).toBe(1);
    const none = await page.request({ t: "rollback" });
    expect(none.error).toBe("no_healthy_version");
    page.close();
  });
});

describe("device proof on page HTTP routes", () => {
  it("page upload reservations require valid device proof", async () => {
    const h = await create();
    const owner = await PageClient.connect(h.page_url);
    const bytes = new TextEncoder().encode("x");
    const body = JSON.stringify({ cid: "device-proof", sha256: await sha256Hex(bytes),
      size: 1, type: "text/plain" });
    const up = (headers: Record<string, string>) => req(h.page_url + "_tendril/uploads", { method: "POST",
      headers: { "Content-Type": "application/json", ...headers }, body });
    expect((await up({ "X-Tendril-Device": owner.deviceId })).status).toBe(401);
    expect((await up({ "X-Tendril-Device": owner.deviceId, "X-Tendril-Device-Secret": owner.secret })).status).toBe(201);
    owner.close();
  });
});
