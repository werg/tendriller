// Build the application-neutral engine and its public SDK/runtime artifacts.
import { build } from "esbuild";
import { cpSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync, watch, writeFileSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { CORE_RELEASE, CONTRACT_VERSION } from "../contract/index.mjs";
import { RUNTIME_FEATURES, RUNTIME_RESOURCES } from "../runtime/resources.mjs";
import { runtimeManifest } from "./runtime-manifest.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "server/public");
const dist = join(root, "dist");
const watching = process.argv.includes("--watch");
const sha256 = data => createHash("sha256").update(data).digest("hex");
export function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]);
}
const contentType = path => ({ ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".wasm": "application/wasm", ".txt": "text/plain", ".md": "text/markdown" }[path.slice(path.lastIndexOf("."))] || "application/octet-stream");
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

export async function buildPublicArtifacts() {
  mkdirSync(dist, { recursive: true });
  const runtime = join(dist, "runtime"), assets = join(runtime, "assets"), sdk = join(dist, "sdk");
  rmSync(runtime, { recursive: true, force: true });
  rmSync(sdk, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true }); mkdirSync(sdk, { recursive: true });
  const common = { bundle: true, format: "iife", target: "es2022", minify: !watching && !process.env.NO_MINIFY, sourcemap: watching ? "inline" : false, logLevel: "warning" };
  const graphs = {};
  for (const [source, target, format] of [["runtime/src/index.ts", "tendril.js", "iife"], ["runtime/src/kernel.ts", "kernel.mjs", "esm"], ["runtime/src/sw.ts", "sw.js", "iife"], ["runtime/src/voice/index.ts", "voice.mjs", "esm"], ["runtime/src/voice/worker.ts", "voice-worker.js", "iife"]]) {
    const result = await build({ ...common, format, entryPoints: [join(root, source)], outfile: join(assets, target), metafile: true });
    const inputs = Object.keys(result.metafile.inputs).map(path => relative(root, join(process.cwd(), path)).replaceAll("\\", "/")).sort();
    graphs[target] = { inputs, bytes: readFileSync(join(assets, target)).length, gzip: gzipSync(readFileSync(join(assets, target))).length };
  }
  writeJson(join(runtime, "inputs.json"), graphs["kernel.mjs"].inputs);
  writeJson(join(runtime, "build-metrics.json"), graphs);
  cpSync(join(root, "node_modules/phonon-tts"), join(assets, "tts"), { recursive: true });
  for (const [source, target] of [["axe.min.js", "axe.min.js"], ["LICENSE", "axe-LICENSE.txt"], ["LICENSE-3RD-PARTY.txt", "axe-LICENSE-3RD-PARTY.txt"]])
    copyFileSync(join(root, "node_modules/axe-core", source), join(assets, target));
  mkdirSync(join(assets, "brand"), { recursive: true });
  for (const [source, target] of [["tendriller-logo-ai-compressed.png", "logo.png"], ["tendriller-logo-ai.webp", "logo.webp"], ["tendriller-icon-64.png", "icon-64.png"], ["tendriller-icon-180.png", "icon-180.png"], ["tendriller-favicon.ico", "favicon.ico"]])
    copyFileSync(join(root, "docs/assets", source), join(assets, "brand", target));
  const resources = RUNTIME_RESOURCES.map(({url,sha256,type}) => ({url,sha256,type}));
  writeJson(join(assets, "resources.json"), { features: RUNTIME_FEATURES, resources });
  const entries = filesUnder(assets).map(path => { const data = readFileSync(path); return { path: relative(assets, path).replaceAll("\\", "/"), sha256: sha256(data), size: data.length, type: contentType(path), preload: ["tendril.js", "sw.js"].includes(relative(assets, path).replaceAll("\\", "/")) }; });
  const manifest = runtimeManifest({ version: CORE_RELEASE, contract: CONTRACT_VERSION, assets: entries, resources });
  const { id } = manifest;
  writeJson(join(assets, "manifest.json"), manifest);
  // A release is copied to a content-addressed directory. Rebuilding never replaces
  // bytes reachable by an earlier publication's runtime URL.
  const immutable = join(out, "_tendril/runtime", id);
  mkdirSync(immutable, { recursive: true }); cpSync(assets, immutable, { recursive: true });
  writeJson(join(root, "server/src/runtime-release.json"), { id, version: CORE_RELEASE, features: RUNTIME_FEATURES });
  mkdirSync(join(out, "_tendril"), { recursive: true });
  copyFileSync(join(assets, "sw.js"), join(out, "_tendril/sw.js"));
  cpSync(join(assets, "brand"), join(out, "_tendril/brand"), { recursive: true });
  await build({ stdin: { contents: 'export { applyOps, validateOps } from "./server/src/state.ts"; export { historyPage, historyGap, mergeHistoryGaps } from "./server/src/streams/history.ts"; export { captureContext, matchesContext, requiredScopes } from "./runtime/src/generations.ts";', resolveDir: root, loader: "js" }, outfile: join(runtime, "preview-support.mjs"), bundle: true, platform: "neutral", format: "esm", target: "es2022", logLevel: "warning" });
  copyFileSync(join(root, "preview-support/index.d.mts"), join(runtime, "preview-support.d.mts"));
  copyFileSync(join(root, "preview-support/kernel.d.mts"), join(runtime, "kernel.d.mts"));
  copyFileSync(join(root, "preview-support/voice.d.mts"), join(runtime, "voice.d.mts"));
  const runtimeExports = { "./kernel": { types: "./kernel.d.mts", import: "./assets/kernel.mjs" }, "./voice": { types: "./voice.d.mts", import: "./assets/voice.mjs" }, "./preview-support": { types: "./preview-support.d.mts", import: "./preview-support.mjs" }, "./manifest": "./assets/manifest.json", "./assets/*": "./assets/*" };
  if (existsSync(join(root, "runtime/src/preview.ts"))) {
    await build({ entryPoints: [join(root, "runtime/src/preview.ts")], outfile: join(runtime, "preview.mjs"), bundle: true, platform: "neutral", format: "esm", target: "es2022", logLevel: "warning" });
    copyFileSync(join(root, "preview-support/preview.d.mts"), join(runtime, "preview.d.mts"));
    runtimeExports["./preview"] = { types: "./preview.d.mts", import: "./preview.mjs" };
  }
  writeJson(join(runtime, "package.json"), { name: "@tendriller/runtime", version: CORE_RELEASE, type: "module", description: "Released Tendriller runtime and public preview primitives", exports: runtimeExports, files: ["assets", "preview-support.mjs", "preview-support.d.mts", "preview.mjs", "preview.d.mts", "kernel.d.mts", "voice.d.mts", "inputs.json", "build-metrics.json"], tendriller: { contract: CONTRACT_VERSION, runtime: id } });
  for (const file of readdirSync(join(root, "contract"))) if (/\.(mjs|mts|json)$/.test(file) && !["tsconfig.json", "engine.d.mts", "testing.d.mts"].includes(file)) copyFileSync(join(root, "contract", file), join(sdk, file));
  writeJson(join(sdk, "package.json"), { name: "@tendriller/core", version: CORE_RELEASE, type: "module", description: "Tendriller public client, protocol and trusted host interfaces", exports: { ".": { types: "./client.d.mts", import: "./client.mjs" }, "./contract": { types: "./index.d.mts", import: "./index.mjs" }, "./browser": { types: "./browser.d.mts" }, "./voice": { types: "./voice.d.mts" }, "./host": { types: "./host.d.mts" }, "./limits": { types: "./limits.d.mts", import: "./limits.mjs" }, "./scopes": { types: "./scopes.d.mts", import: "./scopes.mjs" }, "./schema": "./v2.json" }, tendriller: { contract: CONTRACT_VERSION } });
  for (const [name, directory] of [["sdk", sdk], ["runtime", runtime]]) {
    const result = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", dist], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
    const target = join(dist, `tendriller-${name}-${CORE_RELEASE}.tgz`);
    copyFileSync(join(dist, result.filename), target);
    if (join(dist, result.filename) !== target) rmSync(join(dist, result.filename));
  }
  for (const name of ["agent.md", "llms.txt"]) copyFileSync(join(root, name), join(out, name));
  for (const directory of ["docs", "legal"]) {
    const target = join(out, directory); rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
    for (const source of filesUnder(join(root, directory)).filter(path => /\.(md|html)$/.test(path))) {
      const destination = join(target, relative(join(root, directory), source));
      mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
    }
  }
  mkdirSync(join(out, "contract"), { recursive: true });
  copyFileSync(join(root, "contract/v2.json"), join(out, "contract/v2.json"));
  return manifest;
}

export async function buildEngine() {
  mkdirSync(join(dist, "engine"), { recursive: true });
  const result = await build({ entryPoints: [join(root, "server/src/index.ts")], outfile: join(dist, "engine/worker.mjs"), bundle: true, platform: "browser", format: "esm", target: "es2022", external: ["cloudflare:workers"], metafile: true, logLevel: "warning" });
  writeJson(join(dist, "engine/inputs.json"), Object.keys(result.metafile.inputs).sort());
}
export async function buildAll() { await buildPublicArtifacts(); if (!process.argv.includes("--artifacts-only")) await buildEngine(); console.log("Built core SDK, runtime and engine artifacts"); }
if (!process.argv.includes("--skip-initial")) await buildAll();
if (watching) {
  let timer, building = false, again = false;
  const rebuild = async () => { if (building) { again = true; return; } building = true; do { again = false; try { await buildAll(); } catch (error) { console.error(error); } } while (again); building = false; };
  const watchers = ["runtime/src", "runtime/resources.mjs", "server/src", "contract", "preview-support", "docs", "legal", "agent.md", "llms.txt"].map(path => watch(join(root, path), { recursive: true }, (_event, name) => {
    if (name === "runtime-release.json") return;
    clearTimeout(timer); timer = setTimeout(rebuild, 120);
  }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearTimeout(timer); watchers.forEach(watcher => watcher.close()); process.exit(0); });
}
