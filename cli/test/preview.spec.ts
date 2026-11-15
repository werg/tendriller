import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

test("preview loads the real control and state semantics, with server events and rendered reply receipts", async ({ page }) => {
  await page.goto(url());
  await page.waitForFunction(() => window.tendril.connected);
  expect(await page.evaluate(() => typeof (window.tendril as any)._core)).toBe("object");
  await page.locator("#tap").click();
  await expect.poll(() => server.preview.events.length).toBe(1);
  await page.evaluate(() => window.tendril.state.set("reading", null));
  await expect.poll(() => server.preview.state.reading).toBeNull();
  server.preview.updateState([{ op: "set", path: ["reading"], value: 42 }]);
  await expect.poll(() => page.evaluate(() => window.tendril.state.get("reading"))).toBe(42);
  server.preview.say({ text: "Your measurement arrived", in_reply_to: 1 });
  await expect(page.locator("body")).toContainText("Your measurement arrived");
  await expect.poll(() => server.preview.activity.some((item: any) => item.kind === "say_rendered")).toBe(true);
});

test("real runtime queues while disconnected and rejects display input", async ({ page }) => {
  await page.goto(url());
  await page.waitForFunction(() => window.tendril.connected);
  server.preview.setOnline(false);
  await page.waitForFunction(() => !window.tendril.connected);
  const queued = await page.evaluate(() => window.tendril.send({ kind: "queued" }));
  expect(queued.queued).toBe(true);
  server.preview.setOnline(true);
  await expect.poll(() => server.preview.events.length, { timeout: 15000 }).toBe(1);
  server.preview.setRole("display");
  await page.waitForFunction(() => window.tendril.device.role === "display");
  const denied = await page.evaluate(() => window.tendril.send({ kind: "denied" }));
  expect(denied).toMatchObject({ queued: false, error: "forbidden" });
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
