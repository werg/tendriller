import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startRecipe } from "./recipe-fixtures";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const photo = { name: "field-observation.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") };
let server: any;
test.beforeEach(async () => {
  server = await startRecipe("field-notebook", { notebook: { entries: { seed: {
    id: "seed", created_at: Date.now() - 1000, note: "A new leaf beside the path", tags: ["garden"], status: "accepted", interpretation: "An early observation",
  } } } });
});
test.afterEach(async () => { await server?.stopPreview(); });
const url = () => `http://127.0.0.1:${server.address().port}/`;
async function open(page) { await page.goto(url()); await page.waitForFunction(() => window.tendril.connected); await expect(page.locator("#compose")).toBeVisible(); }

test("an interpretation editor survives agent updates and its Save button works after focus leaves the textarea", async ({ page }) => {
  await open(page);
  const entry = page.locator('.entry[data-id="seed"]');
  await entry.locator("summary").click();
  const editor = entry.getByRole("textbox", { name: "Interpretation for this observation" });
  await editor.fill("My considered interpretation");
  await page.evaluate(() => { (window as any).__editor = document.querySelector('.entry[data-id="seed"] textarea'); });
  server.preview.updateState([{ op: "set", path: ["notebook", "title"], value: "An updated title" }]);
  await expect(editor).toBeFocused(); await expect(editor).toHaveValue("My considered interpretation");
  await entry.getByRole("button", { name: "Save interpretation" }).click();
  await expect.poll(() => server.preview.state.notebook.entries.seed.interpretation).toBe("My considered interpretation");
  const localInterpretation = () => page.evaluate(() => {
    const cfg = window.__TENDRIL__; return JSON.parse(localStorage.getItem(`tendriller:notebook:${cfg.id}:${cfg.base}:interpretation:seed`) || "null");
  });
  expect(await localInterpretation()).toBe("My considered interpretation");
  server.preview.updateState([{ op: "set", path: ["notebook", "entries", "seed", "interpretation"], value: "My considered interpretation" }]);
  await expect.poll(localInterpretation).toBeNull();
  expect(await page.evaluate(() => (window as any).__editor === document.querySelector('.entry[data-id="seed"] textarea'))).toBe(true);
  await page.locator("#note").focus();
  await expect(entry.locator("details")).toHaveAttribute("open", "");
  await expect(entry.locator(".interpretation")).toHaveText("My considered interpretation");
});

test("a pending photo save locks its snapshot, then permits a fresh draft that survives reload", async ({ page }) => {
  await open(page);
  let release!: () => void, requested = false;
  const paused = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/_tendril/blob", async route => { requested = true; await paused; await route.continue(); });
  await page.locator("#note").fill("The observation being saved");
  await page.locator("#photo").setInputFiles(photo);
  await page.locator("#send").click();
  try {
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator("#note")).toBeDisabled(); await expect(page.locator("#tags")).toBeDisabled();
    await expect(page.locator("#photo")).toBeDisabled(); await expect(page.locator("#remove-photo")).toBeDisabled();
  } finally { release(); }
  await expect(page.locator("#status")).toContainText("Observation received");
  await expect(page.locator("#note")).toBeEnabled(); await expect(page.locator("#note")).toHaveValue("");
  await page.locator("#note").fill("A different unfinished observation"); await page.reload();
  await expect(page.locator("#note")).toHaveValue("A different unfinished observation");
  expect(server.preview.events.filter((event: any) => event.data?.type === "notebook.observation")).toHaveLength(1);
});

test("a selected photo defers publication and the explicit Apply action works after removal", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]); await context.setGeolocation({ latitude: 52.52, longitude: 13.405, accuracy: 20 });
  await open(page); await page.locator("#note").fill("Still thinking about this place");
  await page.locator("#locate").click(); await expect(page.locator("#location-review")).toBeVisible();
  await page.locator("#photo").setInputFiles(photo);
  expect(await page.evaluate(() => {
    const event = new CustomEvent("tendril:before-reload", { cancelable: true, detail: { version: 2, apply: () => { (window as any).__applied = true; } } });
    window.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(true);
  const apply = page.getByRole("button", { name: "Apply page update", exact: true }); await expect(apply).toBeDisabled();
  await page.locator("#remove-photo").click(); await expect(apply).toBeEnabled(); await apply.click();
  expect(await page.evaluate(() => (window as any).__applied)).toBe(true);
  await page.reload(); await expect(page.locator("#note")).toHaveValue("Still thinking about this place");
  await expect(page.locator("#location-detail")).toContainText("52.52000, 13.40500"); await expect(page.locator("#include-location")).toBeChecked();
  expect(server.preview.events.filter((event: any) => event.data?.type === "notebook.observation")).toHaveLength(0);
});

test("an offline photo and its note recover after reload and reach the agent once", async ({ page }) => {
  await open(page); server.preview.setOnline(false); await page.waitForFunction(() => !window.tendril.connected);
  await page.locator("#note").fill("This photo belongs with this note"); await page.locator("#photo").setInputFiles(photo); await page.locator("#send").click();
  await expect(page.locator("#status")).toContainText("Saved on this device");
  await page.reload(); await expect(page.locator("#timeline")).toContainText("This photo belongs with this note");
  server.preview.setOnline(true);
  await expect.poll(() => server.preview.events.filter((event: any) => event.data?.type === "notebook.observation").length, { timeout: 15000 }).toBe(1);
  const event = server.preview.events.find((event: any) => event.data?.type === "notebook.observation");
  expect(event.data.entry.note).toBe("This photo belongs with this note"); expect(event.data.blob).toMatch(/^b_/);
  await expect.poll(() => server.preview.state.notebook.entries[event.data.observation_id]?.photo?.id).toBe(event.data.blob);
  await page.reload(); await page.waitForFunction(() => window.tendril.connected);
  expect(server.preview.events.filter((event: any) => event.data?.type === "notebook.observation")).toHaveLength(1);
});

test("an accepted input keeps its local backup through optimistic state writes until the agent confirms it", async ({ page }) => {
  await open(page); await page.locator("#note").fill("Keep this observation recoverable"); await page.locator("#send").click();
  await expect(page.locator("#status")).toContainText("Observation received");
  const event = server.preview.events.find((event: any) => event.data?.type === "notebook.observation"), id = event.data.observation_id;
  const backup = () => page.evaluate(id => {
    const cfg = window.__TENDRIL__; return JSON.parse(localStorage.getItem(`tendriller:notebook:${cfg.id}:${cfg.base}:pending`) || "{}")[id] || null;
  }, id);
  expect(await backup()).toMatchObject({ note: "Keep this observation recoverable", status: "accepted" });
  // An authoritative reset can reject an optimistic shared edit. The original
  // input remains visible from its local backup until an agent stores the entry.
  server.preview.broadcast({ t: "state_reset", state: { notebook: { entries: {} } }, rev: server.preview.rev + 1 });
  await expect(page.locator("#timeline")).toContainText("Keep this observation recoverable");
  expect(await backup()).toMatchObject({ note: "Keep this observation recoverable" });
  server.preview.updateState([{ op: "set", path: ["notebook", "entries", id], value: { ...event.data.entry, status: "accepted", interpretation: "Stored by the agent" } }]);
  await expect.poll(backup).toBeNull();
  await expect(page.locator("#timeline")).toContainText("Stored by the agent");
});

test("switching to a display or guest hides local unsent records, even with an editor focused", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const cfg = window.__TENDRIL__;
    localStorage.setItem(`tendriller:notebook:${cfg.id}:${cfg.base}:pending`, JSON.stringify({ unsent: { id: "unsent", created_at: Date.now(), note: "An unsent local observation", status: "rejected" } }));
  });
  await page.reload(); await page.waitForFunction(() => window.tendril.connected);
  await expect(page.locator("#timeline")).toContainText("An unsent local observation");
  await page.locator('.entry[data-id="seed"] summary').click(); await page.getByRole("textbox", { name: "Interpretation for this observation" }).focus();
  server.preview.setRole("display"); await page.waitForFunction(() => window.tendril.device.role === "display");
  await expect(page.locator("#compose")).toBeHidden(); await expect(page.locator("#timeline")).not.toContainText("An unsent local observation");
  await expect(page.locator("#timeline")).toContainText("A new leaf beside the path"); await expect(page.locator("#timeline textarea")).toHaveCount(0);
  server.preview.setRole("guest"); await page.waitForFunction(() => window.tendril.device.role === "guest");
  await expect(page.locator("#timeline")).not.toContainText("An unsent local observation"); await expect(page.locator("#compose")).toBeHidden();
});
