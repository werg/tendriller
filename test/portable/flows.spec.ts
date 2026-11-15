import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../cli/lib/preview.mjs";
import { openRecipe, savedForOffline } from "./helpers";

test("keyboard submission, shared state and display rejection use the production runtime", async ({ page }) => {
  const app = await openRecipe(page, "field-notebook");
  try {
    await page.locator("#note").fill("A browser-independent observation");
    await page.locator("#send").press("Enter");
    await expect(page.locator("#status")).toContainText("Observation received");
    await expect.poll(() => app.server.preview.events.filter((event: any) => event.data.type === "notebook.observation").length).toBe(1);
    await expect.poll(() => Object.keys(app.server.preview.state.notebook?.entries || {}).length).toBe(1);
    app.server.preview.setRole("display");
    await page.waitForFunction(() => window.tendril.device.role === "display");
    await expect(page.locator("#compose")).toBeHidden();
    const rejected = await page.evaluate(() => window.tendril.send({ type: "forbidden-probe" }));
    expect(rejected).toMatchObject({ status: "rejected", error: "forbidden" });
    expect(app.server.preview.events.some((event: any) => event.data.type === "forbidden-probe")).toBe(false);
  } finally { await app.close(); }
});

test("an offline observation survives reload and reaches the agent once on reconnect", async ({ page, context }) => {
  const app = await openRecipe(page, "field-notebook");
  try {
    await savedForOffline(page);
    app.server.preview.setOnline(false);
    await page.waitForFunction(() => !window.tendril.connected);
    await context.setOffline(true);
    await page.locator("#note").fill("Saved while the connection was away");
    await page.locator("#send").press("Enter");
    await expect(page.locator("#status")).toContainText("Saved on this device");
    await page.reload();
    await expect(page.locator("#timeline")).toContainText("Saved while the connection was away");
    await context.setOffline(false);
    app.server.preview.setOnline(true);
    await page.waitForFunction(() => window.tendril.connected);
    await expect.poll(() => app.server.preview.events.filter((event: any) => event.data.type === "notebook.observation").length, { timeout: 15000 }).toBe(1);
    await page.reload();
    await page.waitForFunction(() => window.tendril.connected);
    expect(app.server.preview.events.filter((event: any) => event.data.type === "notebook.observation")).toHaveLength(1);
  } finally { await context.setOffline(false); await app.close(); }
});

test("edited external assets refresh online and keep the new bytes for offline reload", async ({ page, context }) => {
  const dir = mkdtempSync(join(tmpdir(), "tendriller-portable-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><html lang="en"><title>Asset refresh</title><main><h1 id="version"></h1></main><script src="app.js"></script></html>');
  writeFileSync(join(dir, "app.js"), 'document.querySelector("h1").textContent="Original asset";');
  const server = await startServer(dir);
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await expect(page.locator("h1")).toHaveText("Original asset");
    await savedForOffline(page);
    writeFileSync(join(dir, "app.js"), 'document.querySelector("h1").textContent="Updated asset";');
    await page.reload();
    await expect(page.locator("h1")).toHaveText("Updated asset");
    await page.waitForFunction(async () => {
      const response = await (await caches.open("tendril-preview-v1")).match(new URL("app.js", location.href).href);
      return !!response && (await response.text()).includes("Updated asset");
    });
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator("h1")).toHaveText("Updated asset");
  } finally { await context.setOffline(false); await page.close(); await server.stopPreview(); rmSync(dir, { recursive: true, force: true }); }
});

test("granted geolocation works without requesting camera or microphone", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 52.52, longitude: 13.405, accuracy: 12 });
  const app = await openRecipe(page, "field-notebook");
  try {
    const report = await page.evaluate(() => window.tendril.capabilities());
    expect(report.capabilities.location.available).toBe(true);
    await page.locator("#locate").press("Enter");
    await expect(page.locator("#location-detail")).toContainText("52.52000, 13.40500");
    await expect(page.locator("#include-location")).toBeChecked();
    expect(app.server.preview.events).toHaveLength(0);
  } finally { await app.close(); }
});

test("denied location remains explicit and does not prevent a text observation", async ({ page }) => {
  await page.addInitScript(() => {
    const denied = Object.assign(new EventTarget(), { state: "denied" });
    Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => denied } });
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      getCurrentPosition: (_success: unknown, failure: (error: object) => void) => failure({ code: 1, message: "Denied by the portable test fixture" }),
    } });
  });
  const app = await openRecipe(page, "field-notebook");
  try {
    const report = await page.evaluate(() => window.tendril.capabilities());
    expect(report.capabilities.location).toMatchObject({ available: true, permission: "denied" });
    await page.locator("#locate").press("Enter");
    await expect(page.locator("#status")).toContainText("Location permission was declined");
    await expect(page.locator("#location-review")).toBeHidden();
    await page.locator("#note").fill("A useful note without location access");
    await page.locator("#send").press("Enter");
    await expect(page.locator("#status")).toContainText("Observation received");
    const event = app.server.preview.events.find((event: any) => event.data.type === "notebook.observation");
    expect(event.data.entry).not.toHaveProperty("location");
  } finally { await app.close(); }
});

test("unsupported serial leaves a labelled simulation usable", async ({ page }) => {
  await page.addInitScript(() => {
    delete (navigator as any).serial;
    delete (Navigator.prototype as any).serial;
  });
  const app = await openRecipe(page, "hardware-experiment");
  try {
    expect((await page.evaluate(() => window.tendril.capabilities())).capabilities.serial.available).toBe(false);
    await expect(page.locator("#serial")).toBeDisabled();
    await expect(page.locator("#support")).toContainText("not available");
    await page.locator("#simulate").press("Enter");
    await expect(page.locator("#source")).toContainText("SIMULATED");
    await expect(page.locator("#count")).toHaveText(/^[1-9]\d* samples$/);
    await page.locator("#stop").press("Enter");
    await page.locator("#send").press("Enter");
    await expect.poll(() => app.server.preview.events.some((event: any) => event.data.type === "experiment.summary" && event.data.run.source === "simulation")).toBe(true);
  } finally { await app.close(); }
});
