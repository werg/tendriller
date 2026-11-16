// Optional notification capability; no application rule engine.
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const ORIGIN = "https://tendril.test";
const URL_ = ORIGIN + "/t/tid1/";
let bundle = "";

test.beforeAll(() => {
  bundle = execFileSync("npx", ["esbuild", join(here, "entry.ts"), "--bundle", "--format=iife", "--target=es2020"], { cwd: root, encoding: "utf8" });
});

async function serve(context: BrowserContext) {
  await context.route(ORIGIN + "/**", (route) => route.request().url().endsWith("/sw.js")
    ? route.fulfill({ contentType: "application/javascript", body: "self.addEventListener('push', () => {});" })
    : route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><script>${bundle}</script></head><body>t</body></html>` }));
}

async function open(context: BrowserContext, opts: { features?: any } = {}): Promise<Page> {
  await serve(context);
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as any).__spoken = [];
    speechSynthesis.speak = (u: SpeechSynthesisUtterance) => { (window as any).__spoken.push(u.text); };
  });
  await page.goto(URL_);
  await page.evaluate((features) => {
    const w = window as any;
    const { core, log, state } = w.T.makeCore(features);
    w.core = core; w.log = log; w.st = state;
  }, opts.features ?? null);
  return page;
}

test.describe("push availability", () => {
  test("unavailable without server push, with a reason", async ({ context }) => {
    const page = await open(context);
    const r = await page.evaluate(() => { const p = (window as any).T.setupPush((window as any).core); return { a: p.available, reason: p.reason }; });
    expect(r.a).toBe(false);
    expect(r.reason).toMatch(/not set up/);
  });

  test("iOS in a browser tab explains home-screen install", async ({ browser }) => {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    });
    const page = await open(context, { features: { push: true, vapid: "BAAA" } });
    const r = await page.evaluate(() => { const p = (window as any).T.setupPush((window as any).core); return { a: p.available, reason: p.reason }; });
    expect(r.a).toBe(false);
    expect(r.reason).toMatch(/Home Screen/);
    await context.close();
  });

  test("Chromium with push configured: available, not subscribed", async ({ context }) => {
    await context.grantPermissions(["notifications"], { origin: ORIGIN }); // headless reports "denied" otherwise
    const page = await open(context, { features: { push: true, vapid: "BAAA" } });
    const r = await page.evaluate(async () => {
      // Register an empty service worker so a registration exists.
      const sw = await navigator.serviceWorker.register("/t/tid1/sw.js", { scope: "/t/tid1/" }).catch((e) => String(e));
      const p = (window as any).T.setupPush((window as any).core);
      return { a: p.available, reason: p.reason ?? null, sub: await p.subscribed(), sw: typeof sw };
    });
    expect(r.reason).toBeNull();
    expect(r.a).toBe(true);
    expect(r.sub).toBe(false);
  });

  test("denied notification permission is reported", async ({ context }) => {
    const page = await open(context, { features: { push: true, vapid: "BAAA" } });
    const r = await page.evaluate(() => {
      Object.defineProperty(Notification, "permission", { get: () => "denied" });
      const p = (window as any).T.setupPush((window as any).core);
      return { a: p.available, reason: p.reason };
    });
    expect(r.a).toBe(false);
    expect(r.reason).toMatch(/blocked/);
  });
});
