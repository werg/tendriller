import { test, expect } from "@playwright/test";
import { load, calls } from "./helpers";

test("probe: returns a JSON-serialisable capability summary", async ({ page }) => {
  await load(page, "probe");
  const p = await page.evaluate(async () => JSON.parse(JSON.stringify(await (window as any).tendrilSnippets.probe.run())));
  expect(typeof p.ua).toBe("string");
  expect(p.secure).toBe(true);
  expect(p.geolocation.available).toBe(true);
  expect(p.camera.available).toBe(true);
  expect(p.mediaDevices.cameras).toBeGreaterThan(0);
  expect(p.screen.viewportWidth).toBeGreaterThan(0);
  for (const k of ["motion", "speechRecognition", "wakeLock", "bluetooth", "serial", "usb", "midi", "gamepad", "barcodeDetector", "share", "clipboard", "vibrate", "webgl", "webgpu", "standalone", "touch"]) expect(p).toHaveProperty(k);
});

test("geo: distance, bearing and route step progress", async ({ page }) => {
  await load(page, "geo");
  const r = await page.evaluate(() => {
    const geo = (window as any).tendrilSnippets.geo;
    const a = { lat: 52.52, lon: 13.405 }, b = { lat: 52.53, lon: 13.405 }, c = { lat: 52.52, lon: 13.42 };
    const steps = [{ lat: 52.5, lon: 13.4, text: "Turn left" }, { lat: 52.501, lon: 13.4, text: "Turn right" }, { lat: 52.502, lon: 13.4, text: "Arrive" }];
    const seen: any[] = [];
    const route = geo.route(steps, { arriveRadius: 20, onStep: (p: any) => seen.push(p.index) });
    const p0 = route.update({ lat: 52.4995, lon: 13.4 });          // ~56 m before step 0
    const p1 = route.update({ lat: 52.50005, lon: 13.4 });         // within 20 m of step 0
    const p1b = route.update({ lat: 52.5003, lon: 13.4 });         // en route: no change
    const p3 = route.update({ lat: 52.50201, lon: 13.4 });         // skipped step 1, reached the end
    return { ab: geo.distance(a, b), north: geo.bearing(a, b), east: geo.bearing(a, c), compass: geo.compass(geo.bearing(a, c)), p0, p1, p1b, p3, seen };
  });
  expect(r.ab).toBeGreaterThan(1110);
  expect(r.ab).toBeLessThan(1114);
  expect(r.north).toBeCloseTo(0, 3);
  expect(r.east).toBeCloseTo(90, 0);
  expect(r.compass).toBe("E");
  expect(r.p0.index).toBe(0);
  expect(r.p0.distanceToNext).toBeGreaterThan(50);
  expect(r.p0.distanceToNext).toBeLessThan(60);
  expect(r.p1.index).toBe(1);
  expect(r.p1.step.text).toBe("Turn right");
  expect(r.p1b.distanceToNext).toBeGreaterThan(70);
  expect(r.p3.done).toBe(true);
  expect(r.seen).toEqual([1, 3]);
  const sent = (await calls(page)).send;
  expect(sent).toEqual([
    { data: { type: "route_step", index: 1, text: "Turn right", total: 3 }, wake: false },
    { data: { type: "route_done", total: 3 }, wake: false },
  ]);
});

test("geo: watch() delivers browser positions and filters inaccurate fixes", async ({ page, context }) => {
  await context.setGeolocation({ latitude: 48.8584, longitude: 2.2945, accuracy: 10 });
  await load(page, "geo");
  await page.evaluate(() => {
    const w = window as any;
    w.__pos = [];
    w.__w = w.tendrilSnippets.geo.watch({ maxAccuracy: 50, onPosition: (p: any) => w.__pos.push(p) });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__pos.length)).toBeGreaterThan(0);
  const first = await page.evaluate(() => (window as any).__pos[0]);
  expect(first.lat).toBeCloseTo(48.8584, 4);
  expect(first.accuracy).toBe(10);
  await context.setGeolocation({ latitude: 48.86, longitude: 2.29, accuracy: 500 }); // too vague: ignored
  await page.waitForTimeout(500);
  await context.setGeolocation({ latitude: 48.87, longitude: 2.3, accuracy: 5 });
  await expect.poll(() => page.evaluate(() => (window as any).__pos.at(-1).lat)).toBeCloseTo(48.87, 4);
  expect(await page.evaluate(() => (window as any).__pos.some((p: any) => p.accuracy === 500))).toBe(false);
});

test("motion: button() asks for permission from a tap where the browser requires it", async ({ page, context }) => {
  await context.grantPermissions(["accelerometer", "gyroscope", "magnetometer"]);
  await load(page, "motion");
  const needs = await page.evaluate(() => (window as any).tendrilSnippets.motion.needsPermission());
  await page.evaluate(() => { (window as any).__perm = (window as any).tendrilSnippets.motion.button("#app", { label: "Enable motion" }); });
  if (needs) await page.getByRole("button", { name: "Enable motion" }).click();
  expect(await page.evaluate(() => (window as any).__perm)).toBe(needs ? "granted" : "not-needed");
  await expect(page.getByRole("button")).toHaveCount(0);
});

test("motion: counts steps and shakes from motion events", async ({ page }) => {
  await load(page, "motion");
  const r = await page.evaluate(async () => {
    const m = (window as any).tendrilSnippets.motion;
    let steps = 0, shakes = 0;
    const run = m.start({ smoothing: 1, onStep: (n: number) => (steps = n), onShake: () => shakes++ });
    const fire = (z: number, t: number) => dispatchEvent(Object.assign(new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: { x: 0, y: 0, z } }), {}));
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) { fire(9.81, 0); await wait(5); }  // settle
    for (let s = 0; s < 4; s++) {                                    // four steps, 350 ms apart
      fire(12.5, 0); await wait(20); fire(9.81, 0); await wait(350);
    }
    for (let i = 0; i < 4; i++) { fire(35, 0); await wait(30); fire(-15, 0); await wait(30); } // shake
    run.stop();
    return { steps, shakes };
  });
  expect(r.steps).toBeGreaterThanOrEqual(4);
  expect(r.shakes).toBeGreaterThanOrEqual(1);
});

test("wakelock: reports support and renders accessible toggles", async ({ page }) => {
  await load(page, "wakelock");
  await page.evaluate(() => (window as any).tendrilSnippets.wakelock.button("#app"));
  const btn = page.getByRole("button", { name: "Keep screen on" });
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  const ok = await page.evaluate(() => (window as any).tendrilSnippets.wakelock.supported());
  expect(typeof ok).toBe("boolean");
  if (ok) {
    await btn.click();
    // Headless Chromium may refuse the lock; either way the state must be consistent.
    const active = await page.evaluate(() => (window as any).tendrilSnippets.wakelock.active);
    await expect(btn).toHaveAttribute("aria-pressed", String(active));
  }
});

test("serial and bluetooth: clean 'unsupported' when the APIs are absent", async ({ page }) => {
  await page.addInitScript(() => {
    delete (Navigator.prototype as any).serial;
    delete (Navigator.prototype as any).bluetooth;
  });
  await load(page, "serial", "bluetooth");
  const r = await page.evaluate(async () => {
    const { serial, bluetooth } = (window as any).tendrilSnippets;
    const err = async (f: () => Promise<any>) => { try { await f(); return null; } catch (e: any) { return e.message; } };
    return {
      s: serial.supported(), sr: serial.unsupportedReason(), se: await err(() => serial.connect()),
      b: bluetooth.supported(), br: bluetooth.unsupportedReason(), be: await err(() => bluetooth.connect({ services: ["heart_rate"] })),
      ba: await bluetooth.available(),
    };
  });
  expect(r.s).toBe(false);
  expect(r.sr).toMatch(/Web Serial is not available.*Chrome or Edge/);
  expect(r.se).toBe(r.sr);
  expect(r.b).toBe(false);
  expect(r.br).toMatch(/Web Bluetooth is not available/);
  expect(r.be).toBe(r.br);
  expect(r.ba).toBe(false);
});

test("serial: line reader/writer against a fake port", async ({ page }) => {
  await load(page, "serial");
  const r = await page.evaluate(async () => {
    const written: string[] = [];
    let push: (s: string) => void = () => {};
    const port = {
      async open() {},
      async close() {},
      readable: new ReadableStream({ start(c) { push = (s) => c.enqueue(new TextEncoder().encode(s)); } }),
      writable: new WritableStream({ write(chunk) { const s = new TextDecoder().decode(chunk); written.push(s); if (s === "PING\n") setTimeout(() => push("PO"), 5), setTimeout(() => push("NG\r\nextra\n"), 10); } }),
    };
    Object.defineProperty(navigator, "serial", { value: { requestPort: async () => port, getPorts: async () => [port] }, configurable: true });
    const lines: string[] = [];
    const s = (window as any).tendrilSnippets.serial;
    const p = await s.connect({ onLine: (l: string) => lines.push(l) });
    const reply = await p.request("PING");
    await new Promise((r) => setTimeout(r, 30));
    return { reply, lines, written, current: s.current === p };
  });
  expect(r.reply).toBe("PONG");
  expect(r.lines).toEqual(["PONG", "extra"]);
  expect(r.written).toEqual(["PING\n"]);
  expect(r.current).toBe(true);
});
