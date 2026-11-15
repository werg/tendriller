import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { openRecipe } from "./helpers";

const workflows = ["approval-remote", "field-notebook", "hands-free-guide", "multi-device-workshop", "hardware-experiment", "facilitated-session"];
const state = (recipe: string) => recipe === "field-notebook" ? {
  notebook: { entries: { first: { id: "first", note: "Leaves beside the path", tags: ["garden"], created_at: 1700000000000, interpretation: "Compare the leaf edges on the next visit." } } },
} : recipe === "multi-device-workshop" ? {
  workshop: { title: "Build the paper bridge", step: { id: "fold", title: "Fold the support", instruction: "Fold the sheet along its long edge." } },
} : {};

async function audit(page: Page, info: TestInfo, stage: string) {
  const result = await page.evaluate(async () => {
    // Theme changes can update text before an animated background reaches its
    // final color. Audit the settled UI, without waiting on perpetual status
    // animations or replacing browser rendering with a fixed delay.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const transitions = document.getAnimations().filter(animation => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === "running" && typeof end === "number" && Number.isFinite(end);
    });
    await Promise.all(transitions.map(animation => animation.finished.catch(() => {})));
    const axe = (window as any).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return { version: axe.version, violations: result.violations.map((violation: any) => ({ id: violation.id, impact: violation.impact,
      help: violation.help, nodes: violation.nodes.map((node: any) => ({ target: node.target, summary: node.failureSummary })) })) };
  });
  await info.attach(`accessibility-${stage}`, { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.version).toBe("4.10.3");
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
}

async function activate(page: Page, selector: string) {
  const control = page.locator(selector);
  await control.focus();
  await expect(control).toBeFocused();
  await control.press("Enter");
}

for (const recipe of workflows) test(`${recipe}: accessible content, disclosures and keyboard outcome in light/dark`, async ({ page }, info) => {
  const external: string[] = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.hostname !== "127.0.0.1") { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  const app = await openRecipe(page, recipe, state(recipe));
  try {
    if (recipe === "approval-remote") await expect(page.locator("#decisions")).toContainText("Update the project guide");
    if (recipe === "field-notebook") await expect(page.locator("#timeline")).toContainText("Compare the leaf edges");
    if (recipe === "hands-free-guide") await expect(page.locator("#step-title")).toHaveText("Set out what you need");
    // Keep the locator set stable as opening a disclosure changes [open].
    // Hidden saved-response sections are not currently interactive.
    for (const summary of await page.locator("main details > summary").all()) {
      if (!await summary.isVisible() || await summary.evaluate(node => (node.parentElement as HTMLDetailsElement).open)) continue;
      await summary.focus(); await summary.press("Enter");
      await expect(summary.locator("..")).toHaveAttribute("open", "");
    }
    await page.addScriptTag({ url: app.url + "_tendril/axe.min.js" });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await audit(page, info, `initial-${colorScheme}`);
    }
    if (recipe === "approval-remote") {
      await page.locator("#note-decision_preview").fill("Keep the current introduction.");
      await activate(page, "[data-choice=revise]");
      await expect(page.locator("#decisions")).toContainText("Revision requested");
    } else if (recipe === "field-notebook") {
      await page.locator("#note").fill("Another observation, submitted with the keyboard");
      await activate(page, "#send");
      await expect(page.locator("#status")).toContainText("Observation received");
    } else if (recipe === "hands-free-guide") {
      await activate(page, "#done");
      await expect(page.locator("#status")).toContainText("Checkpoint saved");
    } else if (recipe === "multi-device-workshop") {
      await activate(page, "#pause");
      await expect(page.locator("#pause-banner")).toBeVisible();
      await expect(page.locator("#start-camera")).toBeDisabled();
    } else if (recipe === "hardware-experiment") {
      await activate(page, "#simulate");
      await expect(page.locator("#count")).toHaveText(/^[1-9]\d* samples$/);
      await activate(page, "#stop"); await activate(page, "#send");
      await expect(page.locator("#status")).toContainText("received");
    } else {
      await page.locator("#answer").fill("One quiet morning for focused work");
      await activate(page, "#send");
      await expect(page.locator("#status")).toContainText("Private response saved");
    }
    await page.emulateMedia({ colorScheme: "light" });
    await audit(page, info, "after-keyboard-action");
    expect(external, "the accessibility gate must not fetch its checker or models from a CDN").toEqual([]);
  } finally { await app.close(); }
});
