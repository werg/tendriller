import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { startServer } from "../../cli/lib/preview.mjs";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export async function openRecipe(page: Page, recipe: string, state: object = {}) {
  const scenario = JSON.parse(readFileSync(resolve(root, "recipes", recipe, "scenario.json"), "utf8"));
  const server = await startServer(resolve(root, "recipes", recipe), state, scenario);
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    await page.waitForFunction(() => window.tendril?.connected);
    await expect(page.locator("main")).toBeVisible();
    return { server, url, async close() { await page.close(); await server.stopPreview(); } };
  } catch (error) { await server.stopPreview(); throw error; }
}

export async function savedForOffline(page: Page) {
  await page.waitForFunction(async () => {
    if (!navigator.serviceWorker.controller) return false;
    const meta = await (await caches.open("tendril-meta")).match(new URL("_tendril/__meta", location.href).href);
    if (!meta) return false;
    const { id, version } = await meta.json();
    const cache = await caches.open(`tendril-${id}-v${version}`);
    return !!await cache.match(location.origin + "/") && !!await cache.match(new URL("_tendril/tendril.js", location.href).href);
  });
}
