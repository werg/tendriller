import { test, expect } from "@playwright/test";
import { load, calls, cdnReachable, fakeSpeech } from "./helpers";

// A 200x100 image shown in a 400x400 box: contain → 400x200 at y=100; cover → 800x400 at x=-200.
async function imageBox(page, fit: string) {
  await page.evaluate(async (fit) => {
    const c = Object.assign(document.createElement("canvas"), { width: 200, height: 100 });
    c.getContext("2d")!.fillRect(0, 0, 200, 100);
    const img = document.createElement("img");
    img.id = "pic";
    img.alt = "test";
    img.style.cssText = `position:absolute;left:10px;top:20px;width:400px;height:400px;object-fit:${fit}`;
    img.src = c.toDataURL();
    document.getElementById("app")!.appendChild(img);
    await img.decode();
  }, fit);
}
const rect = (page, sel: string) => page.locator(sel).evaluate((n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

test("overlay: layout() maths for contain, cover, fill and position", async ({ page }) => {
  await load(page, "overlay");
  const r = await page.evaluate(() => {
    const L = (window as any).tendrilSnippets.overlay.layout;
    const box = { width: 400, height: 400 }, img = { width: 200, height: 100 };
    return { contain: L(box, img, "contain"), cover: L(box, img, "cover"), fill: L(box, img, "fill"), coverLeft: L(box, img, "cover", "left top") };
  });
  expect(r.contain).toEqual({ x: 0, y: 100, width: 400, height: 200 });
  expect(r.cover).toEqual({ x: -200, y: 0, width: 800, height: 400 });
  expect(r.fill).toEqual({ x: 0, y: 0, width: 400, height: 400 });
  expect(r.coverLeft).toEqual({ x: 0, y: 0, width: 800, height: 400 });
});

test("overlay: contain — normalized box lands on the letterboxed image", async ({ page }) => {
  await load(page, "overlay");
  await imageBox(page, "contain");
  await page.evaluate(() => (window as any).tendrilSnippets.overlay.attach("#pic").draw([{ shape: "box", x: 0.25, y: 0.5, w: 0.5, h: 0.5, text: "here" }]));
  const b = await rect(page, "[data-tendril-overlay] g[data-shape=box] rect");
  // image occupies x 10..410, y 120..320 → box from (110, 220) size 200x100
  expect(b.x).toBeCloseTo(110, 0);
  expect(b.w).toBeCloseTo(200, 0);
  expect(b.h).toBeCloseTo(100, 0);
  expect(b.y).toBeCloseTo(220, 0);
  await expect(page.locator("[data-tendril-overlay] svg")).toHaveAttribute("aria-label", "Annotations: here");
});

test("overlay: cover — circle centre maps through the crop", async ({ page }) => {
  await load(page, "overlay");
  await imageBox(page, "cover");
  const c = await page.evaluate(() => {
    (window as any).tendrilSnippets.overlay.attach("#pic").draw([{ shape: "circle", x: 0.375, y: 0.5, w: 0.05 }]);
    const e = document.querySelector("[data-tendril-overlay] ellipse")!;
    const root = document.querySelector("[data-tendril-overlay]")!.getBoundingClientRect();
    return { cx: root.x + Number(e.getAttribute("cx")), cy: root.y + Number(e.getAttribute("cy")), rx: Number(e.getAttribute("rx")) };
  });
  // displayed image spans x -190..610 (800 wide), y 20..420 → (0.375, 0.5) = (110, 220); rx = 0.025*800
  expect(c.cx).toBeCloseTo(110, 1);
  expect(c.cy).toBeCloseTo(220, 1);
  expect(c.rx).toBeCloseTo(20, 1);
});

test("overlay: follows state _overlay (arrow + label), mirrored preview, then clears", async ({ page }) => {
  await load(page, "overlay");
  await imageBox(page, "fill");
  await page.evaluate(() => {
    (document.getElementById("pic") as HTMLElement).style.transform = "scaleX(-1)";
    (window as any).tendrilSnippets.overlay.watch({ target: "#pic" });
    (window as any).tendril.__agentState([{ op: "set", path: ["_overlay"], value: { shapes: [{ shape: "arrow", x: 0.25, y: 0.5, text: "screw" }, { shape: "label", x: 0.1, y: 0.9, text: "turn left" }] } }]);
  });
  await expect(page.locator("[data-tendril-overlay] g[data-shape=arrow] line")).toHaveCount(1);
  const tipX = await page.locator("[data-tendril-overlay] g[data-shape=arrow] line").getAttribute("x2");
  expect(Number(tipX)).toBeCloseTo(300, 0); // mirrored: 1 - 0.25 of 400 px
  await expect(page.locator("[data-tendril-overlay] svg")).toHaveAttribute("aria-label", "Annotations: screw; turn left");
  await page.evaluate(() => (window as any).tendril.__agentState([{ op: "set", path: ["_overlay"], value: null }]));
  await expect(page.locator("[data-tendril-overlay] g")).toHaveCount(0);
});

test("list: add, tick, edit, remove through state; agent additions render", async ({ page }) => {
  await load(page, "list");
  await page.evaluate(() => (window as any).tendrilSnippets.list.mount("#app", { path: "shopping", title: "Shopping" }));
  const input = page.getByLabel("New item for Shopping");
  await input.fill("milk");
  await input.press("Enter");
  await input.fill("bread");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(2);
  let st = await page.evaluate(() => (window as any).tendril.state.get("shopping"));
  const ids = Object.keys(st);
  expect(Object.values(st).map((v: any) => v.text).sort()).toEqual(["bread", "milk"]);
  ids.forEach((id) => expect(id).toMatch(/^i_/));

  await page.getByRole("checkbox", { name: "milk" }).check();
  st = await page.evaluate(() => (window as any).tendril.state.get("shopping"));
  expect(Object.values(st).find((v: any) => v.text === "milk")).toMatchObject({ done: true });
  const c = await calls(page);
  expect(c.state.at(-1)).toEqual({ op: "set", path: ["shopping", expect.any(String), "done"], value: true });

  await page.getByRole("button", { name: "Edit bread" }).click();
  await page.getByLabel("New text for bread").fill("rye bread");
  await page.getByLabel("New text for bread").press("Enter");
  await expect(page.getByRole("checkbox", { name: "rye bread" })).toBeVisible();

  await page.getByRole("button", { name: "Remove milk" }).click();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  expect(Object.values(await page.evaluate(() => (window as any).tendril.state.get("shopping"))).map((v: any) => v.text)).toEqual(["rye bread"]);

  // the agent adds a record by id
  await page.evaluate(() => (window as any).tendril.__agentState([{ op: "set", path: ["shopping", "i_agent1"], value: { text: "eggs", done: false, ts: Date.now() } }]));
  await expect(page.getByRole("checkbox", { name: "eggs" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Removed milk");
});

test("qr: renders from jsDelivr (qrcode-generator@2)", async ({ page }) => {
  test.skip(!(await cdnReachable()), "jsDelivr not reachable");
  await load(page, "qr");
  const n = await page.evaluate(async () => {
    const svg = await (window as any).tendrilSnippets.qr.render("#app", "https://example.com/t/abc/s/xyz/", { caption: "Scan to join" });
    return Number(svg.dataset.modules);
  });
  expect(n).toBeGreaterThanOrEqual(21);
  await expect(page.getByRole("img", { name: "QR code: https://example.com/t/abc/s/xyz/" })).toBeVisible();
  await expect(page.locator("figcaption")).toContainText("Scan to join");
});

test("qr: renders with a locally provided qrcode global (no CDN)", async ({ page }) => {
  await load(page);
  await page.route("https://cdn.jsdelivr.net/**", (r) => r.abort());
  await page.addScriptTag({ url: "/vendor/qrcode.js" });
  await page.addScriptTag({ url: "/qr.js" });
  const r = await page.evaluate(async () => {
    const svg = await (window as any).tendrilSnippets.qr.render("#app", "hello", { ecc: "L", showText: false });
    const d = svg.querySelector("path").getAttribute("d");
    return { modules: Number(svg.dataset.modules), cells: (d.match(/M/g) || []).length, caption: !!document.querySelector("figcaption") };
  });
  expect(r.modules).toBe(21); // version 1
  expect(r.cells).toBeGreaterThan(100);
  expect(r.caption).toBe(false);
});

test("qr: scan() explains when BarcodeDetector is missing", async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).BarcodeDetector; });
  await load(page, "qr");
  const r = await page.evaluate(async () => {
    const q = (window as any).tendrilSnippets.qr;
    try { await q.scan(document.createElement("canvas")); return "scanned"; } catch (e: any) { return [await q.canScan(), e.message]; }
  });
  expect(r[0]).toBe(false);
  expect(r[1]).toMatch(/cannot scan/);
});

test("ptt: routes to voice.handleUtterance when it handles the text", async ({ page }) => {
  await fakeSpeech(page);
  await load(page, "ptt");
  await page.evaluate(() => {
    const w = window as any;
    w.__handled = [];
    w.tendril.voice = { handleUtterance: async (t: string, via: string) => { w.__handled.push([t, via]); return true; } };
    w.tendrilSnippets.ptt.mount("#app", { label: "Talk" });
  });
  const btn = page.getByRole("button", { name: "Talk" });
  await btn.focus();
  await page.keyboard.press("Enter"); // keyboard toggles on
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => { const sr = (window as any).__sr.last; sr.say("tick", false); });
  await expect(page.getByRole("status")).toHaveText("tick");
  await page.evaluate(() => { const sr = (window as any).__sr.last; sr.say("tick milk", true); });
  await page.keyboard.press("Enter"); // and off
  await expect(page.getByRole("status")).toContainText("done");
  expect(await page.evaluate(() => (window as any).__handled)).toEqual([["tick milk", "voice"]]);
  expect((await calls(page)).send).toEqual([]);
});

test("ptt: falls back to an utterance event (page data) via hold gesture", async ({ page }) => {
  await fakeSpeech(page);
  await load(page, "ptt");
  await page.evaluate(() => (window as any).tendrilSnippets.ptt.mount("#app"));
  const btn = page.getByRole("button", { name: "Hold to talk" });
  const box = (await btn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => (window as any).__sr.last.say("find a diner nearby", true));
  await page.waitForTimeout(500);
  await page.mouse.up();
  await expect(page.getByRole("status")).toContainText("sent to the agent");
  expect((await calls(page)).send).toEqual([{ data: { type: "utterance", text: "find a diner nearby", via: "ptt" }, wake: true }]);
});

test("ptt: without SpeechRecognition records and uses _tendril/transcribe", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
    (window as any).__TENDRIL__ = { id: "t", base: "/", version: 1, ws: "/_tendril/ws", features: { transcribe: true } };
  });
  let posted = 0;
  await page.route("**/_tendril/transcribe", async (r) => {
    posted = r.request().postDataBuffer()?.length || 0;
    await r.fulfill({ json: { text: "hello there" } });
  });
  await load(page, "ptt");
  await page.evaluate(() => (window as any).tendrilSnippets.ptt.mount("#app"));
  const btn = page.getByRole("button", { name: "Hold to talk" });
  await btn.click(); // short tap → toggle on
  await expect(page.getByRole("status")).toHaveText("Recording…");
  await page.waitForTimeout(800);
  await btn.click(); // tap again → stop
  await expect(page.getByRole("status")).toContainText("sent to the agent");
  expect(posted).toBeGreaterThan(0);
  expect((await calls(page)).send[0].data).toEqual({ type: "utterance", text: "hello there", via: "ptt" });
});

test("ptt: disabled with a message when no voice input exists", async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).SpeechRecognition; delete (window as any).webkitSpeechRecognition; });
  await load(page, "ptt");
  await page.evaluate(() => (window as any).tendrilSnippets.ptt.mount("#app"));
  await expect(page.getByRole("button")).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("not available");
});

test("wakeword: matches the phrase, passes the command, restarts after end", async ({ page }) => {
  await fakeSpeech(page);
  await load(page, "wakeword");
  await page.evaluate(() => {
    const w = window as any;
    w.__wakes = [];
    w.__ww = w.tendrilSnippets.wakeword.start({ phrases: ["hey kitchen"], onWake: (m: any) => w.__wakes.push(m) });
    const sr = w.__sr.last;
    sr.say("what a day", true);
    sr.say("Hey, kitchen! add milk", false); // interim: not yet
    sr.say("Hey, kitchen! add milk to the list", true);
    sr.end(); // browser stopped listening
  });
  expect(await page.evaluate(() => (window as any).__wakes)).toEqual([{ phrase: "hey kitchen", command: "add milk to the list", transcript: "Hey, kitchen! add milk to the list" }]);
  await expect.poll(() => page.evaluate(() => (window as any).__sr.starts)).toBe(2);
  await page.evaluate(() => (window as any).__ww.stop());
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as any).__sr.starts)).toBe(2);
});
