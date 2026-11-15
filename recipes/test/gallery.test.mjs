import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { build } from "esbuild";

const catalog = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
const built = await build({ entryPoints: [new URL("../../server/src/recipe-gallery.ts", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false });
const gallery = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("six complete starters have reproducible preview sources and permission expectations", () => {
  const workflows = catalog.recipes.filter(item => item.kind === "workflow");
  assert.equal(workflows.length, 6);
  for (const item of workflows) {
    assert.ok(item.permissions.length); assert.ok(item.request.length);
    for (const file of item.files) assert.ok(existsSync(new URL(`../../${item.path}/${file}`, import.meta.url)), file);
    for (const file of [item.agent, item.contract, item.scenario, item.preview.fixture, item.preview.image]) assert.ok(existsSync(new URL(`../../${file}`, import.meta.url)), file);
    const fixture = JSON.parse(readFileSync(new URL(`../../${item.preview.fixture}`, import.meta.url), "utf8"));
    assert.ok(fixture.steps.length); assert.equal(item.preview.image, `recipes/previews/${item.id}.png`);
  }
  assert.ok(catalog.recipes.filter(item => item.kind === "example").every(item => item.support.includes("Focused input example")));
});

test("gallery requests retain the current service origin and require a verified receiver", async () => {
  const html = await gallery.starterGallery("https://staging.example.test").text();
  assert.equal((html.match(/data-request=/g) || []).length, 6);
  for (const item of gallery.completeStarters) {
    assert.ok(html.includes(`id="${item.id}"`));
    assert.ok(html.includes(`https://staging.example.test/${item.path}/AGENT.md`));
  }
  assert.ok(html.includes("Attach and verify this conversation"));
  assert.ok(html.includes("Input example"));
  assert.ok(html.includes("navigator.clipboard.writeText"));
  assert.ok(html.includes("input.select()"));
});

test("starter source manifests include the page's local scripts and module imports", () => {
  for (const item of catalog.recipes.filter(item => item.kind === "workflow")) {
    for (const file of item.files) {
      const source = readFileSync(new URL(`../../${item.path}/${file}`, import.meta.url), "utf8");
      const references = file.endsWith(".html")
        ? [...source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1])
        : [...source.matchAll(/\b(?:from|import)\s*["'](\.[^"']+)["']/g)].map(match => match[1]);
      for (const reference of references) {
        if (/^(?:_tendril\/|\/|https?:)/.test(reference)) continue;
        const relative = reference.replace(/^\.\//, "");
        assert.ok(item.files.includes(relative), `${item.id}/${file} depends on ${relative}, missing from the source manifest`);
      }
    }
  }
});

test("copyable starter requests are escaped in HTML instead of becoming markup", async () => {
  const html = await gallery.starterGallery('https://example.test/</textarea><script>alert("x")</script>').text();
  assert.ok(!html.includes('<script>alert("x")</script>'));
  assert.ok(html.includes("&lt;/textarea&gt;&lt;script&gt;"));
});
