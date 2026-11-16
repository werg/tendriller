import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ORIGIN = "http://localhost:7781";
const here = dirname(fileURLToPath(import.meta.url));

async function load(page: Page, role = "owner") {
  const entry = readFileSync(join(here, ".build/entry.js"), "utf8");
  await page.route(ORIGIN + "/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/entry.js") return route.fulfill({ body: entry, contentType: "text/javascript" });
    return route.fulfill({ contentType: "text/html",
      body: '<html><head><script>window.__TEST_OPTS__=' + JSON.stringify({ role }) +
        ';</script><script src="/entry.js"></script></head><body><main>App content</main></body></html>' });
  });
  await page.goto(ORIGIN + "/t/abc/s/key/");
  await expect(page.locator("tendril-control")).toHaveCount(1);
}
async function speechStub(page: Page, local = true) {
  await page.addInitScript((onDevice: boolean) => {
    const instances: any[] = [];
    class Recognition {
      onstart?: () => void;
      onresult?: (event: any) => void;
      onerror?: (event: any) => void;
      onend?: () => void;
      results: any[] = [];
      started = false;
      aborted = false;
      constructor() { if (onDevice) (this as any).processLocally = false; instances.push(this); }
      start() { this.started = true; this.onstart?.(); }
      abort() { this.aborted = true; this.onend?.(); }
      heard(text: string) {
        const index = this.results.length;
        this.results.push({ 0: { transcript: text }, isFinal: true });
        this.onresult?.({ resultIndex: index, results: this.results });
      }
      error(error: string) { this.onerror?.({ error }); this.onend?.(); }
      static async available() { return "downloadable"; }
      static async install() { return true; }
    }
    (window as any).SpeechRecognition = Recognition;
    (window as any).__wakeFake = { instances, heard: (text: string) => instances.at(-1)?.heard(text),
      error: (error: string) => instances.at(-1)?.error(error) };
  }, local);
}
async function open(page: Page) {
  await page.locator("tendril-control .presence").click();
  await expect(page.locator("#tendril-sheet")).toBeVisible();
}

test("every page gets visible hands-free controls and explicit privacy settings", async ({ page }) => {
  await speechStub(page);
  await load(page);
  await open(page);
  const start = page.getByRole("button", { name: "Start hands-free" });
  await expect(start).toBeVisible();
  await expect(page.locator(".wake-chip")).toBeHidden();
  await start.click();
  await expect(page.getByRole("button", { name: "Stop hands-free" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".wake-chip")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__wakeFake.instances.at(-1).processLocally)).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".wake-chip").getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".wake-chip")).toBeHidden();
  expect(await page.evaluate(() => (window as any).__wakeFake.instances.at(-1).aborted)).toBe(true);
});

test("a saved custom phrase routes a command through ordinary conversation; reload never starts microphone", async ({ page }) => {
  await speechStub(page);
  await load(page);
  await open(page);
  await page.getByRole("button", { name: "Configure" }).click();
  await page.getByLabel("Wake phrase (2+ words)").fill("Hey Kitchen");
  await page.getByLabel("Recognition and privacy").selectOption("browser");
  await expect(page.getByText("May send microphone audio to your browser vendor", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Save phrase and mode" }).click();
  await page.getByRole("tab", { name: "Talk", exact: true }).click();
  await page.getByRole("button", { name: "Start hands-free" }).click();
  expect(await page.evaluate(() => (window as any).__wakeFake.instances.at(-1).processLocally)).toBe(false);
  await page.evaluate(() => (window as any).__wakeFake.heard("Hey Kitchen, switch on the lights"));
  await expect.poll(() => page.evaluate(() => (window as any).__fake.calls.instruction)).toEqual([
    { text: "switch on the lights", via: "voice" },
  ]);
  await page.reload();
  await open(page);
  await expect(page.getByRole("button", { name: "Start hands-free" })).toBeVisible();
  await expect(page.locator(".wake-chip")).toBeHidden();
  expect(await page.evaluate(() => (window as any).__wakeFake.instances.length)).toBe(0);
  await page.getByRole("button", { name: "Configure" }).click();
  await expect(page.getByLabel("Wake phrase (2+ words)")).toHaveValue("Hey Kitchen");
  await expect(page.getByLabel("Recognition and privacy")).toHaveValue("browser");
});

test("testing the phrase cannot send commands; leaving the page disarms the microphone", async ({ page }) => {
  await speechStub(page);
  await load(page);
  await open(page);
  await page.getByRole("button", { name: "Configure" }).click();
  await page.getByRole("button", { name: "Test wake phrase" }).click();
  await page.evaluate(() => (window as any).__wakeFake.heard("Hey Tendril delete everything"));
  await expect(page.locator(".wake-status")).toContainText("Wake phrase recognized. Test passed; no command was sent.");
  expect(await page.evaluate(() => (window as any).__fake.calls.instruction)).toEqual([]);
  await page.getByRole("tab", { name: "Talk", exact: true }).click();
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(page.locator(".wake-chip")).toBeHidden();
  expect(await page.evaluate(() => (window as any).__wakeFake.instances.at(-1).aborted)).toBe(true);
});

test("strict local mode never falls back and role changes revoke hands-free access", async ({ page }) => {
  await speechStub(page, false);
  await load(page);
  await open(page);
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await expect(page.locator(".wake-status")).toContainText("On-device speech is not supported");
  expect(await page.evaluate(() => (window as any).__wakeFake.instances.some((r: any) => r.started))).toBe(false);
  await page.getByRole("button", { name: "Configure" }).click();
  await page.getByLabel("Recognition and privacy").selectOption("browser");
  await page.getByRole("button", { name: "Save phrase and mode" }).click();
  await page.getByRole("tab", { name: "Talk", exact: true }).click();
  await page.getByRole("button", { name: "Start hands-free" }).click();
  await expect(page.locator(".wake-chip")).toBeVisible();
  await page.evaluate(() => (window as any).__fake.setRole("display"));
  await expect(page.locator(".wake-chip")).toBeHidden();
  await expect(page.locator(".wake-card")).toBeHidden();
  expect(await page.evaluate(() => (window as any).__wakeFake.instances.at(-1).aborted)).toBe(true);
});
