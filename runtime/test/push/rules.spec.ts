// Device rules and push availability (push agent). Fake Core, mocked geolocation, fake clock.
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

const SHOP = { lat: 52.52, lon: 13.405 };
// ~1 m of latitude is 1/111_320 degrees.
const north = (m: number) => ({ latitude: SHOP.lat + m / 111_320, longitude: SHOP.lon, accuracy: 5 });

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
    w.T.startRules(core);
  }, opts.features ?? null);
  return page;
}

const fired = (page: Page) => page.evaluate(() => (window as any).log.raw.filter((m: any) => m.t === "rule_fired"));
const welcome = (page: Page, rules: any[]) => page.evaluate((rules) => (window as any).core.bus.emit("welcome", { rules }), rules);
const settle = (page: Page) => page.waitForTimeout(400);

test.describe("geofence", () => {
  test.beforeEach(async ({ context }) => { await context.grantPermissions(["geolocation"], { origin: ORIGIN }); });

  test("enter fires once per entry, with hysteresis, and runs all actions", async ({ context }) => {
    await context.setGeolocation(north(2000));
    const page = await open(context);
    const rule = {
      id: "shop", when: { type: "geofence", ...SHOP, radius_m: 150, on: "enter" },
      do: [
        { type: "notify", title: "At the shop", body: "Open the list" },
        { type: "event", data: { arrived: "shop" } },
        { type: "state", path: ["mode"], value: "shopping" },
        { type: "navigate", hash: "list" },
        { type: "say", text: "You are at the shop" },
      ],
    };
    await welcome(page, [rule]);
    await settle(page);
    expect(await fired(page)).toHaveLength(0);

    await context.setGeolocation(north(50));
    await expect.poll(async () => (await fired(page)).length).toBe(1);
    const [msg] = await fired(page);
    expect(msg).toMatchObject({ t: "rule_fired", rule_id: "shop", detail: { type: "geofence", on: "enter" } });
    expect(msg.cid).toBeTruthy();
    expect(msg.detail.distance_m).toBeGreaterThan(40);
    expect(msg.detail.distance_m).toBeLessThan(60);

    // Actions: notify falls back to notify_local (permission not granted), event, state, navigate, say.
    const r = await page.evaluate(() => {
      const w = window as any;
      return { bus: w.log.bus.filter((b: any) => b.t === "notify_local").map((b: any) => b.p), sent: w.log.sent, mode: w.st.mode, hash: location.hash, spoken: w.__spoken };
    });
    expect(r.bus).toEqual([{ title: "At the shop", body: "Open the list" }]);
    expect(r.sent).toEqual([{ arrived: "shop" }]);
    expect(r.mode).toBe("shopping");
    expect(r.hash).toBe("#list");
    expect(r.spoken).toEqual(["You are at the shop"]);

    // Moving around inside, and into the hysteresis band just outside, does not fire again.
    for (const m of [10, 120, 160, 0]) { await context.setGeolocation(north(m)); await settle(page); }
    expect(await fired(page)).toHaveLength(1);

    // Leaving properly and coming back fires again (not a `once` rule).
    await context.setGeolocation(north(1000)); await settle(page);
    await context.setGeolocation(north(20));
    await expect.poll(async () => (await fired(page)).length).toBe(2);
  });

  test("exit fires only after an observed inside", async ({ context }) => {
    await context.setGeolocation(north(1000));
    const page = await open(context);
    await welcome(page, [{ id: "leave", when: { type: "geofence", ...SHOP, radius_m: 100, on: "exit" }, do: [] }]);
    await settle(page);
    expect(await fired(page)).toHaveLength(0); // first fix outside: no exit
    await context.setGeolocation(north(10)); await settle(page);
    expect(await fired(page)).toHaveLength(0);
    await context.setGeolocation(north(110)); await settle(page); // inside the band
    expect(await fired(page)).toHaveLength(0);
    await context.setGeolocation(north(400));
    await expect.poll(async () => (await fired(page)).length).toBe(1);
    expect((await fired(page))[0]).toMatchObject({ rule_id: "leave", detail: { on: "exit" } });
  });

  test("once rules persist across reloads; changed rule re-arms", async ({ context }) => {
    await context.setGeolocation(north(1000));
    const rule = { id: "o", once: true, when: { type: "geofence", ...SHOP, radius_m: 150, on: "enter" }, do: [{ type: "event" }] };
    const page = await open(context);
    await welcome(page, [rule]);
    await settle(page);
    await context.setGeolocation(north(0));
    await expect.poll(async () => (await fired(page)).length).toBe(1);
    // Default event payload names the rule.
    expect(await page.evaluate(() => (window as any).log.sent[0].rule)).toBe("o");
    await context.setGeolocation(north(1000)); await settle(page);
    await context.setGeolocation(north(0)); await settle(page);
    expect(await fired(page)).toHaveLength(1);

    const page2 = await open(context);
    await welcome(page2, [rule]);
    await page2.waitForTimeout(800);
    expect(await fired(page2)).toHaveLength(0);

    // Same id, different content: fires again.
    await page2.evaluate((r) => (window as any).core.bus.emit("rules", { t: "rules", rules: [r] }), { ...rule, when: { ...rule.when, radius_m: 200 } });
    await expect.poll(async () => (await fired(page2)).length).toBe(1);
  });

  test("rules update replaces watchers; empty rules stop firing", async ({ context }) => {
    await context.setGeolocation(north(1000));
    const page = await open(context);
    await welcome(page, [{ id: "a", when: { type: "geofence", ...SHOP, radius_m: 150, on: "enter" }, do: [] }]);
    await settle(page);
    await page.evaluate(() => (window as any).core.bus.emit("rules", []));
    await context.setGeolocation(north(0)); await settle(page);
    expect(await fired(page)).toHaveLength(0);
  });
});

test.describe("time and interval", () => {
  test("time rule fires at HH:MM on matching days, once per day, survives reload", async ({ context }) => {
    // 2026-11-13 is a Friday; context timezone is UTC.
    await serve(context);
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-11-13T08:59:00Z") });
    await page.goto(URL_);
    await page.evaluate(() => {
      const w = window as any;
      const { core, log } = w.T.makeCore();
      w.core = core; w.log = log;
      w.T.startRules(core);
      core.bus.emit("welcome", { rules: [
        { id: "fri", when: { type: "time", at: "09:00", days: ["fri"] }, do: [{ type: "state", path: "x", value: 1 }] },
        { id: "mon", when: { type: "time", at: "09:00", days: ["mon"] }, do: [] },
        { id: "daily", when: { type: "time", at: "09:01" }, do: [] },
      ] });
    });
    await page.clock.runFor(30_000);
    expect(await fired(page)).toHaveLength(0);
    await page.clock.runFor(60_000);
    expect((await fired(page)).map((m: any) => m.rule_id)).toEqual(["fri"]);
    expect((await fired(page))[0].detail).toMatchObject({ type: "time", at: "09:00" });
    await page.clock.runFor(10 * 60_000);
    expect((await fired(page)).map((m: any) => m.rule_id).sort()).toEqual(["daily", "fri"]);

    // Reload within the grace window the same day: not fired again.
    const page2 = await context.newPage();
    await page2.clock.install({ time: new Date("2026-11-13T09:00:30Z") });
    await page2.goto(URL_);
    await page2.evaluate(() => {
      const w = window as any;
      const { core, log } = w.T.makeCore();
      w.core = core; w.log = log;
      w.T.startRules(core);
      core.bus.emit("welcome", { rules: [{ id: "fri", when: { type: "time", at: "09:00", days: ["fri"] }, do: [] }] });
    });
    await page2.clock.runFor(60_000);
    expect(await fired(page2)).toHaveLength(0);
  });

  test("interval rule fires every n minutes while open", async ({ context }) => {
    await serve(context);
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-11-13T12:00:00Z") });
    await page.goto(URL_);
    await page.evaluate(() => {
      const w = window as any;
      const { core, log } = w.T.makeCore();
      w.core = core; w.log = log;
      w.__spoken = [];
      speechSynthesis.speak = (u: SpeechSynthesisUtterance) => { w.__spoken.push(u.text); };
      w.T.startRules(core);
      core.bus.emit("welcome", { rules: [{ id: "iv", when: { type: "interval", minutes: 2 }, do: [{ type: "say", text: "hi" }] }] });
      core.state.set(["_prefs"], { audio: false });
    });
    await page.clock.runFor(100_000);
    expect(await fired(page)).toHaveLength(0);
    await page.clock.runFor(30_000);
    expect(await fired(page)).toHaveLength(1);
    await page.clock.runFor(2 * 60_000);
    expect(await fired(page)).toHaveLength(2);
    expect((await fired(page))[0].detail).toMatchObject({ type: "interval", minutes: 2 });
    // say honours _prefs.audio === false.
    expect(await page.evaluate(() => (window as any).__spoken)).toEqual([]);
  });
});

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
    const page = await open(context, { features: { transcribe: false, voice: false, push: true, vapid: "BAAA" } });
    const r = await page.evaluate(() => { const p = (window as any).T.setupPush((window as any).core); return { a: p.available, reason: p.reason }; });
    expect(r.a).toBe(false);
    expect(r.reason).toMatch(/Home Screen/);
    await context.close();
  });

  test("Chromium with push configured: available, not subscribed", async ({ context }) => {
    await context.grantPermissions(["notifications"], { origin: ORIGIN }); // headless reports "denied" otherwise
    const page = await open(context, { features: { transcribe: false, voice: false, push: true, vapid: "BAAA" } });
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
    const page = await open(context, { features: { transcribe: false, voice: false, push: true, vapid: "BAAA" } });
    const r = await page.evaluate(() => {
      Object.defineProperty(Notification, "permission", { get: () => "denied" });
      const p = (window as any).T.setupPush((window as any).core);
      return { a: p.available, reason: p.reason };
    });
    expect(r.a).toBe(false);
    expect(r.reason).toMatch(/blocked/);
  });
});
