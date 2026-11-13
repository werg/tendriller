import { test, expect } from "@playwright/test";
import { load, calls, cdnReachable } from "./helpers";

test("camera: capture uploads a JPEG and sends a photo event", async ({ page }) => {
  await load(page, "camera");
  await page.evaluate(() => { document.getElementById("app")!.innerHTML = '<div id="view" style="width:320px;height:240px"></div>'; });
  const shot = await page.evaluate(async () => {
    const w = window as any;
    if (!w.tendrilSnippets.camera.supported()) throw new Error("unsupported");
    const cam = await w.tendrilSnippets.camera.open("#view", { facing: "environment" });
    const r = await cam.capture({ maxWidth: 320, quality: 0.7, send: { note: "drawer" } });
    const hasVideo = !!document.querySelector("#view video[aria-label]");
    cam.close();
    return { id: r.id, url: r.url, width: r.width, height: r.height, hasVideo };
  });
  expect(shot.hasVideo).toBe(true);
  expect(shot.width).toBe(320);
  expect(shot.height).toBeGreaterThan(0);
  const c = await calls(page);
  expect(c.upload).toHaveLength(1);
  expect(c.upload[0].type).toBe("image/jpeg");
  expect(c.upload[0].head.slice(0, 3)).toEqual([0xff, 0xd8, 0xff]);
  expect(shot.id).toBe(c.upload[0].id);
  expect(c.send).toEqual([{ data: { type: "photo", blob: shot.id, url: shot.url, width: shot.width, height: shot.height, note: "drawer" }, wake: true }]);
});

test("camera: permission denied gives a clear message in an alert", async ({ page }) => {
  await load(page, "camera");
  const msg = await page.evaluate(async () => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    document.getElementById("app")!.innerHTML = '<div id="view"></div>';
    try {
      await (window as any).tendrilSnippets.camera.open("#view");
      return "opened?";
    } catch (e: any) {
      return e.message;
    }
  });
  expect(msg).toMatch(/permission was denied/i);
  await expect(page.locator("#view [role=alert]")).toContainText(/permission was denied/i);
});

test("glance: uploads on scene change, not on a static scene", async ({ page }) => {
  await load(page, "glance");
  await page.evaluate(async () => {
    const w = window as any;
    const c = Object.assign(document.createElement("canvas"), { width: 160, height: 120 });
    const g = c.getContext("2d")!;
    const paint = (color: string) => { g.fillStyle = color; g.fillRect(0, 0, 160, 120); };
    paint("#202020");
    document.body.appendChild(c);
    const v = document.createElement("video");
    v.muted = true;
    v.srcObject = c.captureStream(10);
    document.body.appendChild(v);
    await v.play();
    while (!v.videoWidth) await new Promise((r) => setTimeout(r, 20));
    w.__paint = paint;
    w.__shots = [];
    w.__g = await w.tendrilSnippets.glance.start({ video: v, intervalMs: 100, minIntervalMs: 0, threshold: 0.1, onChange: (s: any) => w.__shots.push(s.diff) });
  });
  await page.waitForTimeout(1500); // static scene: only the baseline frame
  expect(await page.evaluate(() => (window as any).__shots.length)).toBe(1);
  // keep repainting so the canvas stream emits frames
  await page.evaluate(() => { const w = window as any; w.__t = setInterval(() => w.__paint("#e0e0e0"), 50); });
  await expect.poll(() => page.evaluate(() => (window as any).__shots.length)).toBe(2);
  await page.waitForTimeout(800); // still the same (bright) scene: no more uploads
  const shots = await page.evaluate(() => { const w = window as any; w.__g.stop(); clearInterval(w.__t); return w.__shots; });
  expect(shots).toHaveLength(2);
  expect(shots[1]).toBeGreaterThan(0.5);
  const c = await calls(page);
  expect(c.upload).toHaveLength(2);
  expect(c.upload[1].head.slice(0, 3)).toEqual([0xff, 0xd8, 0xff]);
  expect(c.send[1].data.type).toBe("glance");
  expect(c.send[1].wake).toBe(false);
});

test("glance: difference() is 0 for identical frames and 1 for opposite", async ({ page }) => {
  await load(page, "glance");
  const r = await page.evaluate(() => {
    const d = (window as any).tendrilSnippets.glance.difference;
    const a = new Float32Array(4).fill(0), b = new Float32Array(4).fill(1);
    return [d(a, a), d(a, b)];
  });
  expect(r).toEqual([0, 1]);
});

test("vad: start and stop on a synthetic tone, with recorded audio", async ({ page }) => {
  await load(page, "vad");
  const events = await page.evaluate(async () => {
    const w = window as any;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    const ev: any[] = [];
    const vad = await w.tendrilSnippets.vad.start({
      stream: dest.stream, record: true, hangoverMs: 300,
      onStart: () => ev.push("start"),
      onStop: (blob: Blob | null, ms: number) => ev.push({ stop: ms, blob: blob ? blob.size : null }),
    });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(500);
    ev.push("tone");
    gain.gain.value = 0.5;
    await wait(800);
    gain.gain.value = 0;
    await wait(1000);
    vad.stop();
    ctx.close();
    return ev;
  });
  expect(events[0]).toBe("tone"); // nothing fired during silence
  expect(events[1]).toBe("start");
  expect(events[2].stop).toBeGreaterThan(400);
  expect(events[2].blob).toBeGreaterThan(0);
});

test("vad: hears the fake microphone", async ({ page }) => {
  await load(page, "vad");
  const max = await page.evaluate(async () => {
    let m = 0;
    const vad = await (window as any).tendrilSnippets.vad.start({ onLevel: (rms: number) => { m = Math.max(m, rms); } });
    await new Promise((r) => setTimeout(r, 1500));
    vad.stop();
    return m;
  });
  expect(max).toBeGreaterThan(0);
});

test("screenshot: take() uploads a PNG of the viewport (html-to-image from CDN)", async ({ page }) => {
  test.skip(!(await cdnReachable()), "jsDelivr not reachable");
  await page.setViewportSize({ width: 400, height: 300 });
  await load(page, "screenshot");
  await page.evaluate(() => { document.getElementById("app")!.innerHTML = '<h1 style="color:#c00">Hello</h1>'; });
  const r = await page.evaluate(async () => {
    const out = await (window as any).tendrilSnippets.screenshot.take({ pixelRatio: 1 });
    return JSON.parse(JSON.stringify(out)); // what an eval caller would receive
  });
  expect(r).toEqual({ width: 400, height: 300, id: expect.stringMatching(/^b_/), url: expect.stringContaining("_tendril/blob/") });
  const c = await calls(page);
  expect(c.upload[0].type).toBe("image/png");
  expect(c.upload[0].head.slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
});
