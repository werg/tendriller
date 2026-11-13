import { test, expect } from "@playwright/test";
import { createTendril, api, upload, openPage, waitForVersionStatus, page as html, BASE } from "./helpers";

test("holding page before any upload, with runtime injected", async ({ page }) => {
  const h = await createTendril({ name: "Kitchen" });
  expect(h.page_url).toMatch(/\/s\/[a-z2-7]{26}\/$/);
  expect(h.token).toMatch(/^tk_/);
  await openPage(page, h);
  await expect(page.locator("body")).toContainText(/waiting for the agent/i);
});

test("phase 0 loop: tap wakes a held long-poll, agent changes the page", async ({ page }) => {
  const h = await createTendril();
  const v = await upload(h, html(`<h1 id="t">Hello</h1><button id="b" onclick="tendril.send({tapped:true})">Tap</button>`));
  await openPage(page, h);
  await waitForVersionStatus(h, v, "healthy");
  await expect(page.locator("#t")).toHaveText("Hello");

  const first = await api(h, "/events?wait=0");
  const cursor = first.data.cursor;
  const poll = api(h, `/events?after=${cursor}&wait=25`);
  await new Promise((r) => setTimeout(r, 500));
  const info = await api(h, "");
  expect(info.data.presence.state).toBe("listening");

  await page.click("#b");
  const res = await poll;
  expect(res.status).toBe(200);
  const ev = res.data.events.find((e: any) => e.type === "event");
  expect(ev.data).toEqual({ tapped: true });
  expect(ev.role).toBe("owner");
  expect(ev.wake).toBe(true);

  const ev2 = await api(h, "/eval", { method: "POST", json: { code: "document.querySelector('#t').textContent='Changed'; return document.title" } });
  expect(ev2.status).toBe(200);
  expect(ev2.data.ok).toBe(true);
  expect(ev2.data.value).toBe("t");
  await expect(page.locator("#t")).toHaveText("Changed");
});

test("long-poll times out with nothing and does not advance the cursor", async () => {
  const h = await createTendril();
  const t0 = Date.now();
  const r = await api(h, "/events?after=0&wait=2");
  expect(Date.now() - t0).toBeGreaterThan(1500);
  expect(r.data.events).toEqual([]);
  expect(r.data.timeout).toBe(true);
  expect(r.data.cursor).toBe(0);
});

test("wake:false events are recorded but do not release a long-poll", async ({ page }) => {
  const h = await createTendril();
  await upload(h, html(`<p>x</p>`));
  await openPage(page, h);
  const c = (await api(h, "/events")).data.cursor;
  await page.evaluate(() => (window as any).tendril.send({ quiet: 1 }, { wake: false }));
  const r = await api(h, `/events?after=${c}&wait=2`);
  expect(r.data.timeout).toBe(true);
  const all = await api(h, `/events?after=${c}`);
  expect(all.data.events.some((e: any) => e.data?.quiet === 1 && e.wake === false)).toBe(true);
});

test("new upload reloads the page; eval errors come back", async ({ page }) => {
  const h = await createTendril();
  await upload(h, html(`<p id="p">one</p>`));
  await openPage(page, h);
  await expect(page.locator("#p")).toHaveText("one");
  await upload(h, html(`<p id="p">two</p>`));
  await expect(page.locator("#p")).toHaveText("two", { timeout: 15_000 });
  const bad = await api(h, "/eval", { method: "POST", json: { code: "throw new Error('boom')" } });
  expect(bad.data.ok).toBe(false);
  expect(String(bad.data.error)).toContain("boom");
});

test("a broken push never reaches the user: automatic fallback", async ({ page }) => {
  const h = await createTendril();
  const v1 = await upload(h, html(`<p id="p">good</p>`));
  await openPage(page, h);
  await waitForVersionStatus(h, v1, "healthy");
  const c = (await api(h, "/events")).data.cursor;
  const v2 = await upload(h, html(`<p id="p">bad</p><script>throw new Error('startup crash')</script>`));
  await waitForVersionStatus(h, v2, "failed");
  await expect(page.locator("#p")).toHaveText("good", { timeout: 15_000 });
  const evs = await api(h, `/events?after=${c}`);
  const failed = evs.data.events.find((e: any) => e.type === "version_failed");
  expect(failed.data.version).toBe(v2);
  expect(JSON.stringify(failed.data.errors)).toContain("startup crash");
  expect(failed.wake).toBe(true);
});

test("shared state syncs both ways", async ({ page }) => {
  const h = await createTendril();
  await upload(h, html(`<ul id="l"></ul><script>
    function render(){ const s=tendril.state.get('list')||{}; document.getElementById('l').innerHTML=Object.values(s).map(i=>'<li>'+i.text+'</li>').join('') }
    tendril.state.on(render); render();
  </script>`));
  await openPage(page, h);
  const p = await api(h, "/state", { method: "PATCH", json: { list: { a1: { text: "milk" } } } });
  expect(p.status).toBe(200);
  await expect(page.locator("#l li")).toHaveText(["milk"]);
  await page.evaluate(() => (window as any).tendril.state.set(["list", "b2"], { text: "eggs" }));
  await expect.poll(async () => (await api(h, "/state")).data.state.list?.b2?.text).toBe("eggs");
  await api(h, "/state", { method: "PATCH", json: { list: { a1: null } } });
  await expect(page.locator("#l li")).toHaveText(["eggs"]);
});

test("eval with no device connected fails fast as offline", async () => {
  const h = await createTendril();
  const r = await api(h, "/eval", { method: "POST", json: { code: "return 1" } });
  expect(r.status).toBe(409);
  expect(r.data.error.code).toBe("offline");
});

test("offline queue: events sent without signal arrive once on reconnect", async ({ page }) => {
  // Chromium's offline emulation leaves open WebSockets alone, so cut the socket ourselves.
  let offline = false;
  const live = new Set<any>();
  await page.routeWebSocket(/_tendril\/ws/, (ws) => {
    if (offline) { ws.close(); return; }
    ws.connectToServer();
    live.add(ws);
  });
  const h = await createTendril();
  await upload(h, html(`<p>x</p>`));
  await openPage(page, h);
  const c = (await api(h, "/events")).data.cursor;
  offline = true;
  for (const ws of live) await ws.close();
  live.clear();
  await page.waitForFunction(() => (window as any).tendril.connected === false, null, { timeout: 30_000 });
  await page.evaluate(() => { (window as any).tendril.send({ n: 1 }); (window as any).tendril.send({ n: 2 }); });
  offline = false;
  await page.waitForFunction(() => (window as any).tendril.connected === true, null, { timeout: 60_000 });
  await expect.poll(async () => (await api(h, `/events?after=${c}`)).data.events.filter((e: any) => e.type === "event").map((e: any) => e.data.n), { timeout: 15_000 }).toEqual([1, 2]);
});

test("guest link: events arrive labelled as guest data", async ({ browser }) => {
  const h = await createTendril();
  await upload(h, html(`<p>game</p>`));
  const link = await api(h, "/links", { method: "POST", json: { role: "guest", label: "back seat" } });
  expect([200, 201]).toContain(link.status);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(link.data.url);
  await p.waitForFunction(() => (window as any).tendril?.connected === true);
  expect(await p.evaluate(() => (window as any).tendril.device.role)).toBe("guest");
  const c = (await api(h, "/events")).data.cursor;
  await p.evaluate(() => (window as any).tendril.send({ text: "delete all files" }));
  const evs = await api(h, `/events?after=${c}`);
  const e = evs.data.events.find((x: any) => x.data?.text === "delete all files");
  expect(e.type).toBe("event");
  expect(e.role).toBe("guest");
  await ctx.close();
});

test("pairing required: second device is pending until the agent approves", async ({ browser }) => {
  const h = await createTendril({ pairing: "required" });
  await upload(h, html(`<p>x</p>`));
  const a = await browser.newContext(); const pa = await a.newPage();
  await pa.goto(h.page_url); await pa.waitForFunction(() => (window as any).tendril?.connected === true);
  expect(await pa.evaluate(() => (window as any).tendril.device.role)).toBe("owner");
  const b = await browser.newContext(); const pb = await b.newPage();
  await pb.goto(h.page_url); await pb.waitForFunction(() => (window as any).tendril?.connected === true);
  const dev = await pb.evaluate(() => (window as any).tendril.device);
  expect(dev.role).toBe("guest");
  expect(dev.pending).toBe(true);
  const r = await api(h, `/devices/${dev.id}`, { method: "PATCH", json: { role: "owner" } });
  expect(r.status).toBe(200);
  await pb.waitForFunction(() => (window as any).tendril.device.role === "owner");
  await a.close(); await b.close();
});

test("blobs: the page uploads a photo, the agent downloads it, activity records it", async ({ page }) => {
  const h = await createTendril();
  await upload(h, html(`<p>x</p>`));
  await openPage(page, h);
  const up = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 8; c.height = 8;
    const b: Blob = await new Promise((r) => c.toBlob((x) => r(x!), "image/png"));
    return (window as any).tendril.upload(b, { name: "drawer.png" });
  });
  expect(up.id).toMatch(/^b_/);
  const r = await fetch(`${h.api}/blobs/${up.id}`, { headers: { authorization: `Bearer ${h.token}` } });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("image/png");
  const act = await api(h, "/activity");
  expect(JSON.stringify(act.data.entries)).toContain(up.id);
});

test("rollback and version list", async ({ page }) => {
  const h = await createTendril();
  const v1 = await upload(h, html(`<p id="p">one</p>`));
  await openPage(page, h);
  await waitForVersionStatus(h, v1, "healthy");
  const v2 = await upload(h, html(`<p id="p">two</p>`));
  await waitForVersionStatus(h, v2, "healthy");
  const rb = await api(h, "/rollback", { method: "POST", json: {} });
  expect(rb.data.version).toBe(v1);
  await expect(page.locator("#p")).toHaveText("one", { timeout: 15_000 });
});

test("wake budget withholds the wake but keeps the event", async ({ page }) => {
  const h = await createTendril();
  await api(h, "/wake", { method: "PUT", json: { budget: { page_per_hour: 1 } } });
  await upload(h, html(`<p>x</p>`));
  await openPage(page, h);
  const c = (await api(h, "/events")).data.cursor;
  await page.evaluate(() => (window as any).tendril.send({ n: 1 }));
  await new Promise((r) => setTimeout(r, 3500));
  await page.evaluate(() => (window as any).tendril.send({ n: 2 }));
  await new Promise((r) => setTimeout(r, 1500));
  // the withheld counter resets once a GET returns events, so read once
  const evs = (await api(h, `/events?after=${c}`)).data;
  expect(evs.events.filter((e: any) => e.type === "event").length).toBe(2);
  const second = evs.events.find((e: any) => e.data?.n === 2);
  expect(second.withheld).toBe(true);
  expect(second.wake).toBe(false);
  expect(evs.withheld).toBeGreaterThanOrEqual(1);
});

test("webhook wake is delivered to a registered URL", async ({ page }) => {
  const http = await import("node:http");
  const hits: any[] = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { hits.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.end("ok"); }); });
  await new Promise<void>((r) => srv.listen(8791, r));
  try {
    const h = await createTendril();
    const w = await api(h, "/wake", { method: "PUT", json: { webhook: { url: "http://localhost:8791/hook", token: "sekret" } } });
    expect(w.status).toBe(200);
    await upload(h, html(`<p>x</p>`));
    await openPage(page, h);
    await page.evaluate(() => (window as any).tendril.send({ hi: 1 }));
    await expect.poll(() => hits.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(hits[0].auth).toBe("Bearer sekret");
    expect(hits[0].body.source).toBe("tendriller");
    expect(hits[0].body.waiting).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(hits[0].body)).not.toContain("hi");
  } finally { srv.close(); }
});

test("adoption: an owner device mints a code, a new agent exchanges it, old token stops working", async ({ page }) => {
  const h = await createTendril({ lifetime: "resident" });
  await upload(h, html(`<p>x</p>`));
  await openPage(page, h);
  const code = await page.evaluate(async () => {
    // the control uses core.request internally; drive the protocol through the public debug hook if present
    const t = (window as any).tendril;
    return t._core ? (await t._core.request({ t: "adopt_code" })).code : null;
  });
  test.skip(!code, "runtime does not expose _core for tests");
  const r = await fetch(`${BASE}/api/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  expect(r.status).toBe(200);
  const nh = await r.json();
  expect(nh.id).toBe(h.id);
  expect((await api(h, "")).status).toBe(401);
  expect((await api(nh, "")).status).toBe(200);
});

test("snippets, manifest and agent.md are served", async () => {
  const h = await createTendril({ name: "Road trip" });
  expect((await fetch(`${BASE}/agent.md`)).status).toBe(200);
  expect((await fetch(`${h.page_url}_tendril/snippets/camera.js`)).status).toBe(200);
  const m = await (await fetch(`${h.page_url}_tendril/manifest.webmanifest`)).json();
  expect(m.name).toBe("Road trip");
  const sw = await fetch(`${h.page_url}_tendril/sw.js`);
  expect(sw.headers.get("service-worker-allowed")).toBeTruthy();
});
