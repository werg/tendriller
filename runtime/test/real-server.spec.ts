// End-to-end against a running server:
//   TENDRIL_REAL=http://localhost:8702 npx playwright test --config runtime/test/playwright.config.ts real-server
import { test, expect } from "@playwright/test";

const BASE = process.env.TENDRIL_REAL;
test.skip(!BASE, "set TENDRIL_REAL to a running server origin");

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers as any) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const r = await fetch(BASE + path, { ...init, headers });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body };
}

test("real server: page loads, send, eval, state both ways, health", async ({ page }) => {
  const created = await api("/api/tendrils", { method: "POST", body: JSON.stringify({ name: "Runtime test" }), headers: { "Content-Type": "application/json" } });
  expect(created.status).toBe(201);
  const { token, page_url } = created.body;
  const apiBase = new URL(created.body.api).pathname;
  const pageUrl = BASE + new URL(page_url).pathname; // PUBLIC_BASE may point at another port
  const up = await api(`${apiBase}/files/index.html`, {
    method: "PUT", token, headers: { "Content-Type": "text/html" },
    body: `<!doctype html><html><head><title>Real</title><script>window.__TENDRIL_NO_SW__=true</script></head><body><h1 id="h">Real page</h1><button id="b" onclick="tendril.send({tap:1})">Tap</button></body></html>`,
  });
  expect(up.status).toBe(200);

  await page.goto(pageUrl);
  await page.waitForFunction(() => (window as any).tendril?.connected, null, { timeout: 15000 });
  expect(await page.evaluate(() => (window as any).tendril.version)).toBe(up.body.version);

  // send → event
  const r = await page.evaluate(() => (window as any).tendril.send({ hello: "world" }));
  expect(r.queued).toBe(false);
  const ev = await api(`${apiBase}/events?after=0`, { token });
  expect(ev.body.events.some((e: any) => e.type === "event" && e.data && e.data.hello === "world")).toBe(true);

  // eval
  const ev1 = await api(`${apiBase}/eval`, { method: "POST", token, body: JSON.stringify({ code: "return document.getElementById('h')" }), headers: { "Content-Type": "application/json" } });
  expect(ev1.body).toMatchObject({ ok: true, value: '<h1 id="h">Real page</h1>' });
  const ev2 = await api(`${apiBase}/eval`, { method: "POST", token, body: JSON.stringify({ code: "throw new Error('nope')" }), headers: { "Content-Type": "application/json" } });
  expect(ev2.body.ok).toBe(false);
  expect(ev2.body.error).toContain("nope");

  // state page → server
  await page.evaluate(() => (window as any).tendril.state.patch({ list: { a: { text: "milk" } } }));
  await expect.poll(async () => (await api(`${apiBase}/state`, { token })).body.state.list?.a?.text).toBe("milk");
  // state server → page (merge patch)
  await api(`${apiBase}/state`, { method: "PATCH", token, body: JSON.stringify({ list: { b: { text: "eggs" } }, mode: "x" }), headers: { "Content-Type": "application/json" } });
  await page.waitForFunction(() => (window as any).tendril.state.get("list.b.text") === "eggs");
  expect(await page.evaluate(() => (window as any).tendril.state.get("list.a.text"))).toBe("milk");

  // logs
  await page.evaluate(() => console.warn("runtime e2e log"));
  await expect.poll(async () => (await api(`${apiBase}/logs`, { token })).body.logs.some((l: any) => l.message === "runtime e2e log" && l.level === "warn")).toBe(true);

  // health → version healthy
  await expect.poll(async () => (await api(`${apiBase}/versions`, { token })).body.versions[0].status, { timeout: 10000 }).toBe("healthy");

  // new upload → page reloads onto it
  const up2 = await api(`${apiBase}/files/index.html`, { method: "PUT", token, headers: { "Content-Type": "text/html" }, body: `<h1 id="h">Second</h1><script>window.__TENDRIL_NO_SW__=true</script>` });
  await page.waitForFunction((v) => (window as any).tendril?.version === v, up2.body.version, { timeout: 10000 });
  await expect(page.locator("#h")).toHaveText("Second");
  await expect.poll(async () => (await api(`${apiBase}/versions`, { token })).body.healthy, { timeout: 10000 }).toBe(up2.body.version);

  // broken upload → failed, rolled back
  const up3 = await api(`${apiBase}/files/index.html`, { method: "PUT", token, headers: { "Content-Type": "text/html" }, body: `<h1 id="h">Broken</h1><script>window.__TENDRIL_NO_SW__=true; nothingHere()</script>` });
  await expect.poll(async () => (await api(`${apiBase}/versions`, { token })).body.versions.find((v: any) => v.version === up3.body.version)?.status, { timeout: 15000 }).toBe("failed");
  await page.waitForFunction((v) => (window as any).tendril?.version === v && (window as any).tendril.connected, up2.body.version, { timeout: 15000 });

  await api(apiBase, { method: "DELETE", token });
});

test("real server: service worker caches the page for offline reload", async ({ page, context }) => {
  const created = await api("/api/tendrils", { method: "POST", body: JSON.stringify({ name: "SW test" }), headers: { "Content-Type": "application/json" } });
  const { token } = created.body;
  const apiBase = new URL(created.body.api).pathname;
  const pageUrl = BASE + new URL(created.body.page_url).pathname;
  await api(`${apiBase}/files`, { method: "POST", token, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: {
    "index.html": `<h1 id="h">Offline ok</h1><script src="app.js"></script>`,
    "app.js": "window.__app = 1;",
  } }) });
  await page.goto(pageUrl);
  await page.waitForFunction(() => (window as any).tendril?.connected, null, { timeout: 15000 });
  await page.evaluate(() => (window as any).tendril.state.set("x", 42));
  await page.waitForFunction(async () => {
    const name = (await caches.keys()).find((k) => /^tendril-.*-v\d+$/.test(k));
    return !!name && (await (await caches.open(name)).keys()).length >= 3 && !!navigator.serviceWorker.controller;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#h")).toHaveText("Offline ok");
  expect(await page.evaluate(() => (window as any).__app)).toBe(1);
  expect(await page.evaluate(() => (window as any).tendril.state.get("x"))).toBe(42);
  await context.setOffline(false);
  await api(apiBase, { method: "DELETE", token });
});
