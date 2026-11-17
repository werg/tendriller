import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../lib/preview.mjs";

let server: any, dir: string;
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tendril-preview-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><html><head><title>Preview</title></head><body><h1>Real runtime</h1><button id="tap" onclick="tendril.send({kind:\'tap\'})">Tap</button></body></html>');
  server = await startServer(dir, { reading: 5 });
});
test.afterEach(async () => { await server?.stopPreview(); rmSync(dir, { recursive: true, force: true }); });
const url = () => `http://127.0.0.1:${server.address().port}/`;

async function openWithServiceWorker(page: Page) {
  await page.goto(url());
  await page.waitForFunction(() => window.tendril.connected);
  await page.evaluate(() => window.tendril.publication.saveOffline());
}

const readDevices = (page: Page) => page.evaluate(async () => {
  const response = await fetch("/_tendril/devices", { headers: window.tendril.host.deviceHeaders() });
  return { status: response.status, body: await response.json() };
});

test("preview runs the headless runtime with a page-owned conversation and presentation receipts", async ({ page }) => {
  await page.goto(url());
  await page.waitForFunction(() => window.tendril.connected);
  expect(await page.evaluate(() => typeof (window.tendril as any).state)).toBe("object");
  await page.locator("#tap").click();
  await expect.poll(() => server.preview.events.length).toBe(1);
  await page.evaluate(() => window.tendril.state.set("reading", null));
  await expect.poll(() => server.preview.state.reading).toBeNull();
  server.preview.updateState([{ op: "set", path: ["reading"], value: 42 }]);
  await expect.poll(() => page.evaluate(() => window.tendril.state.get("reading"))).toBe(42);
  await page.evaluate(() => {
    const article = document.createElement("article"); article.id = "replies"; document.body.append(article);
    window.tendril.on("say", message => {
      const paragraph = document.createElement("p"); paragraph.textContent = message.text; article.append(paragraph);
      window.tendril.conversation.presented(message.message_id);
    });
  });
  expect(await page.evaluate(() => "control" in window.tendril)).toBe(false);
  expect(await page.evaluate(() => Object.isFrozen(window.tendril))).toBe(true);
  server.preview.say({ text: "Your measurement arrived", in_reply_to: 1 });
  await expect(page.locator("#replies")).toContainText("Your measurement arrived");
  await expect.poll(() => server.preview.activity.some((item: any) => item.kind === "say_rendered")).toBe(true);
});

test("real runtime queues while disconnected and rejects display input", async ({ page }) => {
  await page.goto(url());
  await page.waitForFunction(() => window.tendril.connected);
  server.preview.setOnline(false);
  await page.waitForFunction(() => !window.tendril.connected);
  const queued = await page.evaluate(() => window.tendril.send({ kind: "queued" }));
  expect(queued.status).toBe("queued");
  server.preview.setOnline(true);
  await expect.poll(() => server.preview.events.length, { timeout: 15000 }).toBe(1);
  server.preview.setRole("display");
  await page.waitForFunction(() => window.tendril.device.role === "display");
  const denied = await page.evaluate(() => window.tendril.send({ kind: "denied" }));
  expect(denied).toMatchObject({ status: "rejected", error: "forbidden" });
  expect(server.preview.events).toHaveLength(1);
});

test("a page reload preserves an offline outbox and replays each event once", async ({ page }) => {
  await page.goto(url());
  await page.waitForFunction(() => window.tendril.connected);
  server.preview.setOnline(false);
  await page.waitForFunction(() => !window.tendril.connected);
  await page.evaluate(() => window.tendril.send({ kind: "survives-reload" }));
  await page.reload();
  server.preview.setOnline(true);
  await expect.poll(() => server.preview.events.length, { timeout: 15000 }).toBe(1);
  expect(server.preview.events[0].data.kind).toBe("survives-reload");
  await page.reload();
  await page.waitForFunction(() => window.tendril.connected);
  expect(server.preview.events).toHaveLength(1);
});

test("saving a nested document offline preserves the canonical publication root", async ({ page, context }) => {
  mkdirSync(join(dir, "reports"));
  writeFileSync(join(dir, "reports", "detail.html"), '<!doctype html><html><head><title>Report</title></head><body><h1>Nested report</h1></body></html>');
  await page.goto(url() + "reports/detail.html");
  await page.waitForFunction(() => window.tendril.connected);
  const publication = await page.evaluate(() => window.tendril.publication.saveOffline());
  const pinnedRoot = url() + "_publications/" + publication.id + "/";
  await expect(page).toHaveURL(pinnedRoot + "reports/detail.html");
  await expect(page.locator("h1")).toHaveText("Nested report");

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("h1")).toHaveText("Nested report");
  for (const root of [url(), pinnedRoot]) {
    await page.goto(root);
    await expect(page.locator("h1")).toHaveText("Real runtime");
  }
});

test("an edited preview script creates a new publication and remains available offline", async ({ page, context }) => {
  writeFileSync(join(dir, "index.html"), '<!doctype html><html><head><title>Continuous preview</title></head><body><h1 id="marker">Loading</h1><script src="app.js"></script></body></html>');
  const original = 'document.getElementById("marker").textContent = "Before the edit";';
  const updated = 'document.getElementById("marker").textContent = "After the edit";';
  writeFileSync(join(dir, "app.js"), original);
  await openWithServiceWorker(page);
  await expect(page.locator("#marker")).toHaveText("Before the edit");
  const originalPublication = await page.evaluate(() => window.__TENDRIL__.publication.id);
  const cachedScript = () => page.evaluate(async () => {
    const response = await caches.match(new URL("app.js", document.baseURI).href);
    return response?.text() ?? null;
  });
  await expect.poll(cachedScript).toBe(original);

  writeFileSync(join(dir, "app.js"), updated);
  await page.goto(url());
  await expect(page.locator("#marker")).toHaveText("After the edit");
  expect(await page.evaluate(() => window.__TENDRIL__.publication.id)).not.toBe(originalPublication);
  await page.evaluate(() => window.tendril.publication.saveOffline());
  await expect.poll(cachedScript).toBe(updated);

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator("#marker")).toHaveText("After the edit");
    expect(await cachedScript()).toBe(updated);
  } finally { await context.setOffline(false); }
});

test("a controlling service worker keeps device roster reads fresh across purpose changes", async ({ page }) => {
  await openWithServiceWorker(page);
  const device = await page.evaluate(() => window.tendril.device.id);
  expect(await readDevices(page)).toMatchObject({ status: 200, body: { devices: [{ id: device, purpose: "general" }] } });
  for (const purpose of ["controller", "general"]) {
    server.preview.updateDevice({ id: device, purpose });
    await page.waitForFunction(purpose => window.tendril.device.purpose === purpose, purpose);
    expect(await readDevices(page)).toMatchObject({ status: 200, body: { devices: [{ id: device, purpose }] } });
  }
  const cached = await page.evaluate(async () => {
    const names = await caches.keys(), paths: string[] = [];
    for (const name of names) for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
    return paths.filter(path => path.endsWith("/_tendril/devices"));
  });
  expect(cached).toEqual([]);
});

test("an unrelated cached owner roster cannot bypass live access checks", async ({ page }) => {
  await openWithServiceWorker(page);
  expect((await readDevices(page)).status).toBe(200);
  // A private response inserted into an unrelated cache must not satisfy a live service request.
  await page.evaluate(async () => {
    const cache = await caches.open("explicit-private-response-fixture");
    await cache.put(new URL("/_tendril/devices", location.href).href, new Response(JSON.stringify({ devices: [{ id: "old-owner", name: "Private owner device", purpose: "controller" }] }), { headers: { "Content-Type": "application/json" } }));
  });
  server.preview.setRole("guest");
  await page.waitForFunction(() => window.tendril.device.role === "guest");
  const denied = await readDevices(page);
  expect(denied).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  expect(denied.body).not.toHaveProperty("devices");
});
