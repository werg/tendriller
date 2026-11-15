import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost:7781";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const PAGE_BODY = `
<main id="content" style="font:16px system-ui;padding:24px">
  <h1 style="margin:0 0 12px">Shopping list</h1>
  <ul><li>Milk</li><li>Eggs</li><li>Bread</li><li>Coffee</li></ul>
  <p>The agent's own page content.</p>
</main>`;

async function load(page: Page, opts: Record<string, unknown> = {}, body = PAGE_BODY) {
  const entry = readFileSync(join(here, ".build/entry.js"), "utf8");
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/entry.js") return route.fulfill({ body: entry, contentType: "text/javascript" });
    if (url.pathname.includes("/_tendril/blob/")) return route.fulfill({ body: PNG, contentType: "image/png" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<script>window.__TEST_OPTS__=${JSON.stringify(opts)};</script><script src="/entry.js"></script></head><body>${body}</body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/t/abc/s/key/`);
  await expect(page.locator("tendril-control")).toHaveCount(1);
}

const presenceBtn = (page: Page) => page.locator("tendril-control .presence");
const live = (page: Page) => page.locator("tendril-control .sr[role=status]");
const openSheet = async (page: Page) => { await presenceBtn(page).click(); await expect(page.locator("#tendril-sheet")).toBeVisible(); };
const calls = (page: Page) => page.evaluate(() => (window as any).__fake.calls);

test("browser voice is immediate and voice controls update device settings", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await load(page);
  await openSheet(page);
  await page.getByRole("tab", { name: "Settings and history", exact: true }).click();
  await page.getByText("Display and sound", { exact: true }).click();
  const voice = page.getByLabel("Spoken voice", { exact: true });
  await expect(voice).toHaveValue("browser");
  await voice.selectOption("browser");
  await expect(page.getByText("Using the browser voice.", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Try neural voice", exact: true }).click();
  await expect(voice).toHaveValue("neural");
  await page.getByRole("button", { name: "Test voice", exact: true }).click();
  expect((await calls(page)).utterances).toEqual([{text:"Hello! I'm your Tendriller voice.",via:"tts"}]);
  await page.getByRole("button", { name: "Stop speaking", exact: true }).click();
  expect((await calls(page)).emitted.some((e: any) => e.t === "tts:stop")).toBe(true);
  expect((await calls(page)).state).toEqual([]);
  expect(await page.locator("#tendril-sheet").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("renders without touching page layout", async ({ page }) => {
  // Same page without the control, for comparison.
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${PAGE_BODY}</body></html>`);
  const before = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, r: JSON.stringify(document.getElementById("content")!.getBoundingClientRect()) }));
  await load(page);
  await expect(presenceBtn(page)).toBeVisible();
  const after = await page.evaluate(() => {
    const host = document.querySelector("tendril-control") as HTMLElement;
    const r = host.getBoundingClientRect();
    return { h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, r: JSON.stringify(document.getElementById("content")!.getBoundingClientRect()), host: [r.width, r.height], pos: getComputedStyle(host).position };
  });
  expect(after.h).toBe(before.h);
  expect(after.w).toBe(before.w);
  expect(after.r).toBe(before.r);
  expect(after.host).toEqual([0, 0]);
  expect(after.pos).toBe("fixed");
  // Page CSS doesn't leak in.
  await page.addStyleTag({ content: "button { background: red !important; font-size: 40px !important; } * { color: lime !important }" });
  const bg = await presenceBtn(page).evaluate((b) => getComputedStyle(b).fontSize);
  expect(parseFloat(bg)).toBeLessThan(20);
});

test("re-attaches if page code removes it", async ({ page }) => {
  await load(page);
  await page.evaluate(() => document.querySelector("tendril-control")!.remove());
  await expect(page.locator("tendril-control")).toHaveCount(1);
  await page.evaluate(() => { document.body.innerHTML = "<p>replaced</p>"; });
  await expect(page.locator("tendril-control")).toHaveCount(1);
  await expect(presenceBtn(page)).toBeVisible();
});

test("presence states and aria-live announcements", async ({ page }) => {
  await load(page);
  const label = page.locator("tendril-control .presence .label");
  await expect(label).toHaveText("Agent ready");
  const set = (p: object) => page.evaluate((p) => (window as any).__fake.setPresence(p), p);

  await set({ state: "working", text: "Working" });
  await expect(label).toHaveText("Working");
  await expect(live(page)).toContainText("Working");
  await expect(page.locator("tendril-control .presence .orb")).toHaveAttribute("data-state", "working");

  await set({ state: "listening", text: "listening" });
  await expect(label).toHaveText("Done");
  await expect(live(page)).toContainText("Done");

  await set({ state: "scheduled", schedule_minutes: 5, text: "checks every 5 min" });
  await expect(label).toHaveText("Checks every 5 min");

  await set({ state: "away", last_seen: Date.now() - 3 * 86400000 });
  await expect(label).toHaveText("Away");
  await expect(live(page)).toContainText("Last heard from 3 days ago");

  await set({ state: "not_responding" });
  await expect(label).toHaveText("Not responding");

  await set({ state: "no_agent", last_seen: null });
  await expect(label).toHaveText("No agent");

  await page.evaluate(() => (window as any).__fake.setConnected(false));
  await expect(label).toHaveText("Offline");
  await expect(live(page)).toContainText("Offline");
  // Accessible name carries the status (never colour alone).
  await expect(presenceBtn(page)).toHaveAttribute("aria-label", /Agent status: Offline/);
});

test("text instruction path: voice layer declines, core.instruction is called", async ({ page }) => {
  await load(page);
  await openSheet(page);
  const box = page.getByRole("textbox", { name: "Message to the agent" });
  await expect(box).toBeFocused();
  await box.fill("add oat milk");
  await box.press("Enter");
  await expect(page.locator("tendril-control .hint")).toHaveText("Sent.");
  const c = await calls(page);
  expect(c.utterances).toEqual([]);
  expect(c.instruction).toEqual([{ text: "add oat milk", via: "text" }]);
  await expect(page.locator("tendril-control .log li.user")).toContainText("add oat milk");
  await expect(page.locator("tendril-control .log li.user .who")).toHaveText("You");
  // Echo from the server replaces the local entry instead of duplicating it.
  await page.evaluate(() => (window as any).__fake.emit("instruction_echo", { text: "add oat milk", via: "text", ts: Date.now() }));
  await expect(page.locator("tendril-control .log li.user")).toHaveCount(1);
  await page.evaluate(() => (window as any).__fake.emit("say", { text: "Added oat milk.", ts: Date.now() }));
  await expect(page.locator("tendril-control .log li.agent")).toContainText("Added oat milk.");
});

test("queued instruction loses the sending label when its delayed acknowledgement arrives", async ({ page }) => {
  await load(page, { instructionQueued: true });
  await openSheet(page);
  const box = page.getByRole("textbox", { name: "Message to the agent" });
  await box.fill("check the oven");
  await box.press("Enter");
  await expect(page.locator("tendril-control .log li.user .who")).toHaveText("You (sending…)");
  await page.evaluate(() => (window as any).__fake.emit("instruction_ack", { text: "check the oven", cid: "instruction-1" }));
  await expect(page.locator("tendril-control .log li.user .who")).toHaveText("You");
  await page.evaluate(() => (window as any).__fake.emit("instruction_echo", { text: "check the oven", device: "d_me", ts: Date.now() + 60_000 }));
  await expect(page.locator("tendril-control .log li.user")).toHaveCount(1);
});

test("typed owner instructions stay explicit and withheld delivery is explained", async ({ page }) => {
  await load(page); await openSheet(page);
  const box = page.getByRole("textbox", { name: "Message to the agent" });
  await box.fill("do the big thing"); await box.press("Enter");
  expect((await calls(page)).instruction).toEqual([{ text: "do the big thing", via: "text" }]);
  await page.evaluate(() => (window as any).__fake.setPresence({ withheld: 1 }));
  await expect(page.locator("tendril-control .hint")).toHaveText("The agent will see this at its next check.");
});

test("owner vs guest vs display visibility", async ({ page }) => {
  await load(page, { role: "owner" });
  await openSheet(page);
  await expect(page.getByRole("button", { name: "Go back" }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Settings and history" }).click();
  await expect(page.getByText("Activity record")).toBeVisible();
  await page.getByRole("tab", { name: "Talk", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message to the agent" })).toBeVisible();

  await page.evaluate(() => (window as any).__fake.setRole("guest"));
  await expect(page.getByText("Activity record")).toBeHidden();
  await expect(page.getByRole("button", { name: "Go back", exact: true })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Message to the agent" })).toBeVisible();
  await expect(page.locator("tendril-control .hint")).toContainText("guest");
  await page.getByRole("textbox", { name: "Message to the agent" }).fill("hello from the back seat");
  await page.getByRole("textbox", { name: "Message to the agent" }).press("Enter");
  await expect(page.locator("tendril-control .hint")).toHaveText("Sent to the page as a guest message.");

  await page.evaluate(() => (window as any).__fake.setRole("display"));
  await expect(page.getByRole("textbox", { name: "Message to the agent" })).toBeHidden();
  await expect(page.getByText("Display and sound")).toBeHidden();
  await expect(page.locator("tendril-control .pill .mic")).toBeHidden();
});

test("go back: button and control:go_back bus event", async ({ page }) => {
  await load(page, { replies: { rollback: { t: "ack", version: 2 } } });
  await openSheet(page);
  await page.getByRole("button", { name: "Go back" }).first().click();
  await expect(page.locator("tendril-control .hint")).toHaveText("Showing version 2.");
  await page.evaluate(() => (window as any).__fake.emit("control:go_back", { version: 1 }));
  await expect.poll(async () => (await calls(page)).request.filter((r: any) => r.t === "rollback")).toEqual([{ t: "rollback" }, { t: "rollback", version: 1 }]);
  const emitted = (await calls(page)).emitted.filter((e: any) => e.t === "control:go_back_result");
  expect(emitted[0].p).toEqual({ ok: true, version: 2 });
});

test("versions list picks a specific version", async ({ page }) => {
  const now = Date.now();
  await load(page, { replies: { versions: { t: "versions", current: 3, versions: [
    { version: 3, created_at: now - 60000, status: "healthy", message: "bigger buttons", files: 1 },
    { version: 2, created_at: now - 3600000, status: "healthy", message: "list view", files: 1 },
    { version: 1, created_at: now - 7200000, status: "failed", files: 1 },
  ] }, rollback: { version: 2 } } });
  await openSheet(page);
  await page.getByRole("tab", { name: "Settings and history", exact: true }).click();
  await page.getByText("Earlier versions").click();
  await expect(page.getByText("showing now")).toBeVisible();
  await page.getByRole("button", { name: "Show version 2" }).click();
  await expect.poll(async () => (await calls(page)).request.at(-1)).toEqual({ t: "rollback", version: 2 });
});

test("pending guest stays read-only for owner administration", async ({ page }) => {
  await load(page, { role: "guest", pending: true });
  await expect(page.locator("tendril-control .presence .label")).toHaveText("Waiting for approval");
  await openSheet(page);
  await expect(page.getByRole("tab", { name: "Share and devices" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Go back", exact: true })).toBeHidden();
});

test("connect an agent shows the adoption code", async ({ page }) => {
  await load(page, { replies: { adopt_code: { t: "adopt_code", code: "abc234def567-381920", expires_at: Date.now() + 600000 } } });
  await openSheet(page);
  await page.getByRole("tab", { name: "Share and devices", exact: true }).click();
  await page.getByText("Connect an agent").click();
  await page.getByRole("button", { name: "Get a code" }).click();
  await expect(page.locator("#tendril-adopt .code")).toHaveText("abc234def567-381920");
  await expect(page.getByRole("button", { name: "Copy resume prompt" })).toBeVisible();
});

test("add a device renders a QR code for a new link", async ({ page }) => {
  await load(page, { replies: { links: { t: "links", links: [], created: { id: "l_x", url: "http://localhost:7781/t/abc/s/displaykey/", role: "display", expires_at: null } } } });
  await openSheet(page);
  await page.getByRole("tab", { name: "Share and devices", exact: true }).click();
  await page.getByText("Add a device").click();
  await page.getByRole("button", { name: "Big screen (display)" }).click();
  const qr = page.locator("#tendril-add svg.qr");
  await expect(qr).toBeVisible();
  expect(((await qr.locator("path").getAttribute("d")) || "").length).toBeGreaterThan(500);
  await expect(page.locator("#tendril-add .url").first()).toHaveText("http://localhost:7781/t/abc/s/displaykey/");
  const req = (await calls(page)).request.at(-1);
  expect(req.t).toBe("links");
  expect(req.create.role).toBe("display");
});

test("activity record with thumbnails and delete", async ({ page }) => {
  await load(page, { replies: { activity: { t: "activity", entries: [
    { seq: 5, ts: Date.now() - 60000, kind: "blob", summary: "Photo sent", device: "d_me", blob: "b_abc", source: "server" },
    { seq: 6, ts: Date.now() - 30000, kind: "note", summary: "Added three items", device: null, source: "agent" },
  ] }, activity_delete: { t: "ack" } } });
  await openSheet(page);
  await page.getByRole("tab", { name: "Settings and history", exact: true }).click();
  await page.getByText("Activity record").click();
  await expect(page.locator("#tendril-activity img.thumb")).toHaveAttribute("src", "/t/abc/s/key/_tendril/blob/b_abc");
  await expect(page.getByText("reported by the agent")).toBeVisible();
  await expect(page.getByText("can't remove what the agent has already read")).toBeVisible();
  await page.getByRole("button", { name: "Delete: Photo sent" }).click();
  await expect(page.getByText("Photo sent")).toBeHidden();
  expect((await calls(page)).request.at(-1)).toEqual({ t: "activity_delete", seq: 5 });
});

test("preferences are written to state and applied", async ({ page }) => {
  await load(page);
  await openSheet(page);
  await page.getByRole("tab", { name: "Settings and history", exact: true }).click();
  await page.getByText("Display and sound").click();
  await page.getByText("Large", { exact: true }).click();
  await page.getByLabel("High contrast").check();
  await page.getByLabel("Sounds and spoken replies").uncheck();
  await page.getByLabel("Language").selectOption("de-DE");
  const c = await calls(page);
  expect(c.state).toEqual([
    { path: ["_prefs", "text_size"], value: "large" },
    { path: ["_prefs", "contrast"], value: "high" },
    { path: ["_prefs", "audio"], value: false },
    { path: ["_prefs", "language"], value: "de-DE" },
  ]);
  const ds = await page.evaluate(() => ({ ...document.documentElement.dataset }));
  expect(ds).toMatchObject({ tendrilTextSize: "large", tendrilContrast: "high" });
  await expect(page.locator("tendril-control .root")).toHaveAttribute("data-size", "large");
  const fs = await presenceBtn(page).evaluate((b) => parseFloat(getComputedStyle(b).fontSize));
  expect(fs).toBeGreaterThan(16);
});

test("sensor indicator appears for camera, location and motion; stop switch stops them", async ({ page }) => {
  await load(page);
  const chip = page.locator("tendril-control .chip.sensors");
  await expect(chip).toBeHidden();
  await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    (window as any).__stream = s;
  });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Camera in use");
  await expect(live(page)).toContainText("Camera in use");
  await page.evaluate(() => {
    (window as any).__watch = navigator.geolocation.watchPosition(() => {});
    (window as any).__motionCalls = 0;
    window.addEventListener("devicemotion", () => { (window as any).__motionCalls++; });
  });
  await expect(chip).toContainText("Camera, Location, Motion sensors in use");
  await chip.getByRole("button", { name: /Stop/ }).click();
  await expect(chip).toBeHidden();
  // (Chromium may fire one real devicemotion event on its own, so compare around a dispatch.)
  const state = await page.evaluate(() => {
    const before = (window as any).__motionCalls;
    window.dispatchEvent(new Event("devicemotion"));
    return { track: (window as any).__stream.getTracks()[0].readyState, motion: (window as any).__motionCalls - before };
  });
  expect(state).toEqual({ track: "ended", motion: 0 });
  await expect(live(page)).toContainText("All sensors stopped");
  // Stopping a track from page code clears the indicator too.
  await page.evaluate(async () => { (window as any).__s2 = await navigator.mediaDevices.getUserMedia({ audio: true }); });
  await expect(chip).toContainText("Microphone in use");
  await page.evaluate(() => (window as any).__s2.getTracks().forEach((t: MediaStreamTrack) => t.stop()));
  await expect(chip).toBeHidden();
  // The legacy callback API (and anything recording from it, e.g. MediaRecorder) is tracked too.
  const legacy = await page.evaluate(() => typeof (navigator as any).webkitGetUserMedia === "function");
  if (legacy) {
    await page.evaluate(() => new Promise<void>((res) => (navigator as any).webkitGetUserMedia({ audio: true }, (s: MediaStream) => {
      (window as any).__rec = new MediaRecorder(s); (window as any).__rec.start(); (window as any).__s3 = s; res();
    }, () => res())));
    await expect(chip).toContainText("Microphone in use");
    await page.evaluate(() => (window as any).__s3.getTracks().forEach((t: MediaStreamTrack) => t.stop()));
    await expect(chip).toBeHidden();
  }
});

test("hide() keeps the sensor indicator visible; position() moves the dock", async ({ page }) => {
  await load(page);
  await page.evaluate(() => (window as any).__fake.api.position("top-left"));
  const box = await presenceBtn(page).boundingBox();
  expect(box!.x).toBeLessThan(40);
  expect(box!.y).toBeLessThan(40);
  await page.evaluate(() => (window as any).__fake.api.hide());
  await expect(presenceBtn(page)).toBeHidden();
  await page.evaluate(async () => { await navigator.mediaDevices.getUserMedia({ video: true }); });
  await expect(page.locator("tendril-control .chip.sensors")).toBeVisible();
  await page.evaluate(() => (window as any).__fake.api.show());
  await expect(presenceBtn(page)).toBeVisible();
});

test("keyboard navigation keeps settings separate and restores the opener", async ({ page }) => {
  await load(page); await presenceBtn(page).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Message to the agent" })).toBeFocused();
  await page.getByRole("tab", { name: "Talk", exact: true }).focus();
  await page.keyboard.press("ArrowRight"); await expect(page.getByRole("tab", { name: "Share and devices" })).toBeFocused();
  await page.keyboard.press("End"); await expect(page.getByRole("tab", { name: "Settings and history" })).toBeFocused();
  await page.locator("tendril-control summary", { hasText: "Display and sound" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("group", { name: "Text size", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.locator("#tendril-sheet")).toBeHidden(); await expect(presenceBtn(page)).toBeFocused();
});

test("speech consent traps focus, supports Escape and restores focus", async ({ page }) => {
  await load(page); await openSheet(page);
  const prepare = page.getByRole("button", { name: "Prepare voice", exact: true }); await prepare.click();
  const modal = page.getByRole("dialog", { name: "Set up private speech", exact: true }); await expect(modal).toBeVisible();
  await expect(page.getByRole("button", { name: "Download and continue" })).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await expect(page.getByRole("button", { name: "Use typing" })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "Download and continue" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(modal).toHaveCount(0); await expect(prepare).toBeFocused();
  expect(await page.locator('#content').evaluate(el => (el as HTMLElement).inert)).toBe(false);
});

test("muted agent replies are announced and conversation history is available", async ({ page }) => {
  const transcript = Array.from({ length: 10 }, (_, i) => ({ ts: Date.now() - 1000 * (10-i), from: 'agent', text: `Earlier reply ${i}` }));
  await load(page, { state: { _prefs: { audio: false } }, transcript }); await openSheet(page);
  await expect(page.locator('tendril-control .log li')).toHaveCount(6);
  await page.getByRole('button', { name: 'Show earlier messages (10)' }).click(); await expect(page.locator('tendril-control .log li')).toHaveCount(10);
  await page.evaluate(() => (window as any).__fake.emit('say', { text: 'Your capture is ready', speak: false }));
  await expect(live(page)).toHaveText('Agent: Your capture is ready');
});

test("a rejected instruction restores editable text without promising a retry", async ({ page }) => {
  await load(page, { instructionError: 'Page quota reached' }); await openSheet(page);
  const input = page.getByRole('textbox', { name: 'Message to the agent' }); await input.fill('Retain my message'); await input.press('Enter');
  await expect(input).toHaveValue('Retain my message');
  await expect(page.locator('tendril-control .hint')).toContainText('Not sent: Page quota reached');
  await expect(page.locator('tendril-control .hint')).not.toContainText('will be retried');
});

test("a later queued rejection preserves the new composer draft and removes its sending row", async ({ page }) => {
  await load(page, { instructionQueued: true }); await openSheet(page);
  const input = page.getByRole('textbox', { name: 'Message to the agent' }); await input.fill('Queued message'); await input.press('Enter');
  await expect(page.locator('tendril-control .hint')).toContainText('Saved on this device');
  await input.fill('A different unfinished thought');
  await page.evaluate(() => (window as any).__fake.emit('instruction_rejected', { cid: 'instruction-1', text: 'Queued message', message: 'Page quota reached' }));
  await expect(input).toHaveValue('A different unfinished thought\n\nQueued message');
  await expect(page.locator('tendril-control .log')).not.toContainText('You (sending');
  await expect(page.locator('tendril-control .hint')).toContainText('Not sent: Page quota reached');
});

test("touch targets are at least 44px", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await load(page);
  await openSheet(page);
  const small = await page.evaluate(() => {
    const root = document.querySelector("tendril-control")!.shadowRoot!;
    return [...root.querySelectorAll("button, summary, textarea")]
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => { const r = e.getBoundingClientRect(); return { t: e.getAttribute("aria-label") || e.textContent, w: r.width, h: r.height }; })
      .filter((r) => r.w < 44 || r.h < 44);
  });
  expect(small).toEqual([]);
});

test.describe("screenshots", () => {
  const now = Date.now();
  const rich = {
    transcript: [
      { ts: now - 90000, from: "user", text: "What's left on the shopping list?" },
      { ts: now - 80000, from: "agent", text: "Milk, eggs, bread and coffee. Want me to sort them by aisle?" },
      { ts: now - 30000, from: "user", text: "Yes please" },
    ],
    presence: { state: "working", text: "Sorting the list by aisle", last_seen: now, schedule_minutes: null, withheld: 0, wake: "long_poll" },
  };
  test("light, desktop, sheet open", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1100, height: 760 });
    await load(page, rich);
    await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }));
    await page.screenshot({ path: join(here, "screenshots/light-collapsed.png") });
    await openSheet(page);
    await page.screenshot({ path: join(here, "screenshots/light-desktop-open.png") });
  });
  test("dark, phone, collapsed and open", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 375, height: 740 });
    await load(page, { ...rich, presence: { ...rich.presence, state: "listening" } }, PAGE_BODY.replace('style="', 'style="background:#111;color:#eee;min-height:100vh;'));
    await page.evaluate(() => (window as any).__fake.emit("say", { text: "Sorted by aisle. Dairy first.", ts: Date.now() }));
    await page.screenshot({ path: join(here, "screenshots/dark-phone-collapsed.png") });
    await openSheet(page);
    await page.getByRole("tab", { name: "Settings and history", exact: true }).click();
    await page.getByText("Display and sound").click();
    await page.screenshot({ path: join(here, "screenshots/dark-phone-open.png") });
  });
});
