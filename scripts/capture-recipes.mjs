// Capture real starter pages with the compiled production runtime. Run in CI or
// an environment that permits Chromium; never substitute illustrations.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "../cli/lib/preview.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(resolve(root, "recipes/catalog.json"), "utf8"));
const output = resolve(root, process.argv[2] || "test-results/catalog/previews");
mkdirSync(output, { recursive: true });
const manifest = { format: "tendriller-starter-previews", version: 1, captured_at: new Date().toISOString(), runtime: "production", previews: [] };
for (const recipe of catalog.recipes.filter(item => item.kind === "workflow" && item.preview)) {
  const fixture = JSON.parse(readFileSync(resolve(root, recipe.preview.fixture), "utf8"));
  const result = await preview(resolve(root, recipe.path), {
    fixture, state: fixture.state, width: 390, height: 844, waitMs: 100,
    eval: `
      await document.fonts.ready;
      window.scrollTo(0, 0);
      const viewport = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth > viewport + 1) {
        const overflowing = [...document.querySelectorAll("main, main *")].filter(element => {
          const box = element.getBoundingClientRect();
          return box.width && (box.left < -1 || box.right > viewport + 1);
        }).slice(0, 6).map(element => element.id || element.className || element.tagName);
        throw new Error("Horizontal overflow at " + viewport + "px: " + overflowing.join(", "));
      }
    `, out: resolve(output, `${recipe.id}.png`),
  });
  manifest.previews.push({ id: recipe.id, source: recipe.path, fixture: recipe.preview.fixture,
    image: `${recipe.id}.png`, ok: result.ok, uncaught: result.uncaught || [], trace: result.fixture_trace || [], message: result.message });
  writeFileSync(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (!result.ok) { console.error(`Could not capture ${recipe.id}: ${result.message || JSON.stringify(result.uncaught)}`); process.exitCode = 1; }
  else console.log(`Captured ${recipe.id}`);
}
