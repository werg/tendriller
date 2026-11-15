import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview, startServer } from "../lib/preview.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(readFileSync(resolve(root, "recipes/catalog.json"), "utf8"));
for (const recipe of catalog.recipes.filter((item: any) => item.scenario)) {
  test(`${recipe.id}: the complete page-to-agent scenario`, async ({}, info) => {
    const fixture = JSON.parse(readFileSync(resolve(root, recipe.scenario), "utf8"));
    const result = await preview(resolve(root, recipe.path), { fixture, out: info.outputPath("workflow.png"), waitMs: 100 });
    await info.attach("workflow", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(result.uncaught, result.message).toEqual([]);
    expect(result.ok, JSON.stringify(result.fixture_trace)).toBe(true);
    expect(result.runtime).toBe("production");
    expect(result.fixture_trace.length).toBe(fixture.steps.length);
    expect(result.mocked_http.every((entry: any) => entry.matched)).toBe(true);
  });
}

test("hardware experiment cards, chart and live statistics fit a phone viewport", async ({ page }) => {
  const server = await startServer(resolve(root, "recipes/hardware-experiment"));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.tendril.connected);
    await page.locator("#unit").fill("celsius-from-window-probe");
    await page.locator("#simulate").click();
    await expect(page.locator("#count")).toHaveText(/^[1-9]\d* samples$/);
    await page.locator("#stop").click();
    await expect(page.locator("#stats")).toContainText("celsius-from-window-probe");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const overflowing = [...document.querySelectorAll(".grid > *, .card, .metric, #plot, button, input, select, textarea")]
          .filter(element => {
            const rect = element.getBoundingClientRect();
            return rect.width && (rect.left < -1 || rect.right > viewport + 1);
          })
          .map(element => element.id || element.className || element.tagName);
        return { viewport, pageWidth: document.documentElement.scrollWidth, overflowing };
      });
      expect(geometry.overflowing, `Overflow at ${width}px`).toEqual([]);
      expect(geometry.pageWidth, `Document overflow at ${width}px`).toBeLessThanOrEqual(geometry.viewport + 1);
    }
  } finally {
    await page.close();
    await server.stopPreview();
  }
});

test("workshop hides absent media and display-only actions despite layout styles", async ({ page }) => {
  const server = await startServer(resolve(root, "recipes/multi-device-workshop"), {
    workshop: { step: { id: "fold", title: "Fold the support", instruction: "Fold the sheet in half." } },
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.tendril.connected);
    await expect(page.locator("#frame-note")).toHaveText("No photo shared yet.");
    await expect(page.locator("#frame")).toBeHidden();
    await expect(page.locator("#video")).toBeHidden();
    await expect(page.locator("#actions")).toBeVisible();
    await expect(page.locator("#camera-card")).toBeVisible();
    server.preview.setRole("display");
    await page.waitForFunction(() => window.tendril.device.role === "display");
    await expect(page.locator("#actions")).toBeHidden();
    await expect(page.locator("#camera-card")).toBeHidden();
    await expect(page.locator("#step-title")).toHaveText("Fold the support");
  } finally {
    await page.close();
    await server.stopPreview();
  }
});
