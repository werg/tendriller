import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "../lib/preview.mjs";

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
