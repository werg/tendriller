// Install the actual packed artifact into a project outside the checkout. This
// deliberately omits devDependencies: repo-relative imports cannot hide a broken
// distribution, and preview's transport must be an ordinary dependency.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = mkdtempSync(join(tmpdir(), "tendriller-consumer-"));
const env = { ...process.env, TENDRIL_CONFIG_DIR: join(workspace, "config") };
delete env.NODE_PATH;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command, args, cwd = workspace) => execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
try {
  const packedOutput = run(npm, ["pack", "--json", "--pack-destination", workspace], root);
  // npm forwards prepack's build output before its JSON on some npm versions.
  const jsonStart = packedOutput.search(/^\[\s*\{/m);
  assert.ok(jsonStart >= 0, "npm pack did not report a tarball");
  const packed = JSON.parse(packedOutput.slice(jsonStart))[0];
  assert.ok(packed.files.some(file => file.path === "server/public/_tendril/tendril.js"), "tarball must contain built runtime assets");
  assert.ok(packed.files.some(file => file.path === "server/public/_preview/state.mjs"), "tarball must contain the compiled state implementation");
  assert.ok(!packed.files.some(file => /(?:^|\/)(?:\.env|\.dev\.vars|\.e2e-auth\.json|test-results)(?:\/|$)/.test(file.path)), "private environment/diagnostic files must not be packed");
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "tendriller-consumer-smoke", private: true, type: "module" }));
  run(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", join(workspace, packed.filename)]);
  const installed = join(workspace, "node_modules/tendriller");
  const bin = join(installed, "cli/bin/tendril.mjs");
  assert.match(run(process.execPath, [bin, "--help"]), /scaffold/);
  const catalog = JSON.parse(run(process.execPath, [bin, "recipes"]));
  const recipes = catalog.recipes || catalog;
  for (const name of ["approval-remote", "field-notebook", "hands-free-guide", "multi-device-workshop", "hardware-experiment", "facilitated-session"]) {
    assert.ok(recipes.some(recipe => recipe.id === name), `packed catalog is missing ${name}`);
    run(process.execPath, [bin, "scaffold", name, join(workspace, name)]);
    for (const file of ["index.html", "AGENT.md", "contract.json", "scenario.json"])
      assert.ok(readFileSync(join(workspace, name, file)).length, `${name}/${file} is missing`);
  }
  writeFileSync(join(workspace, "consumer.mts"), `
import { createClient } from "tendriller";
import { assertValid, type RuntimeApi, type SendResult } from "tendriller/contract";
import type {} from "tendriller/browser";
const client = createClient({ api: "https://example.test/api/t/test", token: "private" });
void client.readEvents({ after: 0 });
// @ts-expect-error handling needs an explicit cursor.
void client.readEvents({});
declare const page: RuntimeApi<{ count: number }>;
const count: number = page.state.get().count;
const result: SendResult = await page.send({ count });
if (result.status === "accepted") { const seq: number = result.seq; void seq; }
// @ts-expect-error queued inputs do not have a server sequence.
if (result.status === "queued") result.seq;
window.tendril.on("say", message => { const text: string = message.text; void text; });
assertValid("create", { owner: "owner@example.test" });
`);
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "es2022", "--module", "nodenext", "--moduleResolution", "nodenext", "--lib", "es2023,dom", "consumer.mts"]);
  writeFileSync(join(workspace, "consumer.mjs"), `
import assert from "node:assert/strict";
import { createClient } from "tendriller";
import { assertValid } from "tendriller/contract";
import schema from "tendriller/schema" with { type: "json" };
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const client = createClient({ api: "https://example.test/api/t/test", token: "private" }, { fetch: async () => new Response(JSON.stringify({ events: [], cursor: 2, withheld: 0 })) });
assert.deepEqual(await client.readEvents({ after: 2 }), { events: [], cursor: 2, withheld: 0 });
assert.equal(assertValid("create", { owner: "owner@example.test" }).owner, "owner@example.test");
assert.ok(schema.$defs);
const { startServer, loadPlaywright } = await import(pathToFileURL(join(process.cwd(), "node_modules/tendriller/cli/lib/preview.mjs")));
assert.equal(loadPlaywright(), null, "the fresh project must not silently find the checkout's browser tools");
const server = await startServer(join(process.cwd(), "field-notebook"));
try {
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /window.__TENDRIL__/);
  for (const asset of ["/_tendril/tendril.js", "/_tendril/sw.js", "/_tendril/axe.min.js", "/_tendril/axe-LICENSE.txt", "/_tendril/speech-worker.js", "/_tendril/tts/index.js", "/_tendril/snippets/input-kit.js", "/app.js", "/model.mjs"]) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.arrayBuffer()).byteLength > 0, asset);
  }
} finally { await server.stopPreview(); }
`);
  run(process.execPath, ["consumer.mjs"]);
  let missingOutput;
  try { run(process.execPath, [bin, "preview", join(workspace, "field-notebook")]); assert.fail("missing optional browser tooling must exit 2"); }
  catch (error) { assert.equal(error.status, 2); missingOutput = error.stdout; }
  const missingBrowser = JSON.parse(missingOutput.trim());
  assert.equal(missingBrowser.error, "playwright_missing");
  console.log("Consumer smoke passed: packed exports/types, CLI, six scaffolds, and HTTP preview assets; missing optional Playwright is explicit.");
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
}
