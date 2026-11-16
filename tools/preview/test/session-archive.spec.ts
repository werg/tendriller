import { test, expect, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startRecipe } from "./recipe-fixtures";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const at = 1794744000000;
const cases = [
  { recipe: "field-notebook", scope: "notebook", state: { notebook: { entries: { seed: { id: "seed", note: "A record worth keeping", tags: [], created_at: at, status: "accepted" } } } }, after: "Your first observation starts the trail" },
  { recipe: "hands-free-guide", scope: "guide", state: { guide_progress: { current: "show", completed: { prepare: at } } }, after: "0 of 3 steps complete" },
  { recipe: "multi-device-workshop", scope: "workshop", state: { workshop: { step: { id: "seed", title: "A previous workshop", instruction: "Keep its receipt" }, receipts: { seed: { d_demo: { device: "d_demo", status: "confirmed", at } } } } }, after: "Ask the agent to set a workshop step" },
  { recipe: "hardware-experiment", scope: "experiment", state: { experiment: { runs: { seed: { id: "seed", source: "simulation", unit: "C", count: 1, started_at: at, series: [], interventions: [] } } } }, after: "No source connected" },
  { recipe: "approval-remote", scope: "decisions", state: {}, after: "You’re all caught up." },
];

async function installArchives(page: Page, server: any, scope: string) {
  const saved: any[] = [], posts: any[] = [];
  let conflict = false;
  await page.route("**/_tendril/workflows/sessions/*", async route => {
    const operation = new URL(route.request().url()).pathname.split('/').at(-1);
    const command = route.request().postDataJSON(), body = command.data;
    if (operation === "archivePreview") return route.fulfill({ json: { scope, generation: server.preview.scopes[0].generation, state_revision: server.preview.rev, interaction_revision: 4, counts: { records: 1 } } });
    if (operation === "archives") return route.fulfill({ json: { archives: saved.map(archive => ({ id: archive.id, scope, title: archive.title, created_at: at, bytes: 500 })) } });
    if (operation === "archiveGet") return route.fulfill({ json: saved.find(archive => body.id === archive.id) });
    if (operation === "decisions") return route.fulfill({ json: { decisions: [] } });
    if (operation === "archive") {
      posts.push(command);
      if (conflict || body.expected_state_revision !== server.preview.rev || body.expected_interaction_revision !== 4)
        return route.fulfill({ status: 409, json: { error: { code: "version_conflict", message: "This session changed. Review it again before archiving." } } });
      if (command.expected_generations['sessions:' + scope] !== server.preview.scopes[0].generation)
        return route.fulfill({ status: 409, json: { error: { code: 'stale_generation', message: 'The captured generation changed.' } } });
      const archive = { format: "tendriller-session-archive", version: 2, id: `archive-${saved.length + 1}`, scope, title: body.title, created_at: at, shared_state: structuredClone(server.preview.state) };
      saved.push(archive);
      server.preview.setScopes(server.preview.scopes.map((value: any) => ({ ...value, generation: 'new-generation' })));
      if (scope !== "decisions") server.preview.updateState([{ op: "set", path: [scope === "guide" ? "guide_progress" : scope], value: {} }]);
      return route.fulfill({ json: { archive, scope: server.preview.scopes[0], state_revision: server.preview.rev, interaction_revision: 5 } });
    }
    return route.fulfill({ status: 400, json: { error: { code: 'fixture_undefined', message: 'Declare this operation in the test fixture.' } } });
  });
  return { saved, posts, setConflict(value: boolean) { conflict = value; } };
}

for (const item of cases) test(`${item.recipe}: archive downloads the previous session and leaves a usable fresh workflow`, async ({ page }) => {
  const server = await startRecipe(item.recipe, item.state, { http: [{ method: "POST", path: "/_tendril/workflows/sessions/decisions", json: { decisions: [] } }] });
  try {
    const store = await installArchives(page, server, item.scope);
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.tendril.connected);
    await page.locator("#session-tools summary").first().click();
    await expect(page.getByRole("button", { name: "Review archive and new session", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Review archive and new session", exact: true }).click();
    await expect(page.locator(".archive-review")).toBeVisible();
    expect(store.posts).toHaveLength(0);
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Archive and start new session", exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe(`${item.scope}-archive-1.json`);
    await expect(page.getByText(item.after, { exact: false }).first()).toBeVisible();
    expect(store.saved).toHaveLength(1); expect(store.posts[0].cid).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.saved[0].shared_state).toMatchObject(item.state);
    await page.reload(); await page.waitForFunction(() => window.tendril.connected);
    await page.locator("#session-tools summary").first().click();
    await expect(page.getByRole("button", { name: "Download archive", exact: true })).toBeVisible();
    server.preview.setRole("display"); await page.waitForFunction(() => window.tendril.device.role === "display");
    await expect(page.locator("#session-tools")).toBeHidden();
    await expect(page.locator("#session-tools article")).toHaveCount(0);
  } finally { await page.close(); await server.stopPreview(); }
});

test("notebook archive blocks unfinished input and preserves the session on a revision conflict", async ({ page }) => {
  const server = await startRecipe("field-notebook", cases[0].state);
  try {
    const store = await installArchives(page, server, "notebook");
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.tendril.connected);
    await page.locator("#note").fill("Keep this unfinished thought"); await page.locator("#session-tools summary").first().click();
    const prepare = page.getByRole("button", { name: "Review archive and new session", exact: true }); await expect(prepare).toBeEnabled(); await prepare.click();
    await expect(page.locator("#session-tools [role=status]")).toContainText("Save or clear your unfinished observation");
    expect(store.posts).toHaveLength(0); await expect(page.locator("#note")).toHaveValue("Keep this unfinished thought");
    await page.locator("#note").fill(""); await prepare.click(); store.setConflict(true);
    await page.getByRole("button", { name: "Archive and start new session", exact: true }).click();
    await expect(page.locator("#session-tools [role=status]")).toContainText("This session changed");
    await expect(page.locator("#timeline")).toContainText("A record worth keeping"); expect(store.saved).toHaveLength(0);
  } finally { await page.close(); await server.stopPreview(); }
});

test("hardware keeps all five reports and blocks another run instead of evicting one", async ({ page }) => {
  const runs = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`run${i}`, { id: `run${i}`, source: "simulation", unit: "C", count: 1, started_at: at + i, series: [], interventions: [] }]));
  const server = await startRecipe("hardware-experiment", { experiment: { runs } });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.tendril.connected);
    await expect(page.locator("#simulate")).toBeDisabled(); await expect(page.locator("#retention")).toContainText("none are silently removed");
    expect(await page.evaluate(() => Object.keys(window.tendril.state.get("experiment.runs")))).toHaveLength(5);
  } finally { await page.close(); await server.stopPreview(); }
});
