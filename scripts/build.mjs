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
import { buildOnboardingAssets } from "./onboarding.mjs";
import { buildBootstrap } from "./build-bootstrap.mjs";

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

const releaseSource = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const releaseIdentity = { name: 'release-source', setup(builder) {
  builder.onLoad({ filter: /[/\\]contract[/\\]onboarding\.mjs$/ }, args => ({
    resolveDir: dirname(args.path), contents: readFileSync(args.path, 'utf8').replace("const RELEASE_SOURCE = 'unbuilt';", `const RELEASE_SOURCE = '${releaseSource}';`), loader: 'js',
  }));
} };

export async function buildPublicArtifacts() {
  buildBootstrap();
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (packageVersion !== CORE_RELEASE) throw new Error("Package and public core release identities must agree");
  mkdirSync(dist, { recursive: true });
  for (const name of readdirSync(dist)) {
    const artifact = /^tendriller-(sdk|runtime|engine|tools)-(.+)\.tgz$/.exec(name);
    if (artifact && artifact[2] !== CORE_RELEASE) rmSync(join(dist, name));
  }
  const runtime = join(dist, "runtime"), assets = join(runtime, "assets"), sdk = join(dist, "sdk");
  rmSync(runtime, { recursive: true, force: true });
  rmSync(sdk, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true }); mkdirSync(sdk, { recursive: true });
  const common = { bundle: true, format: "iife", target: "es2022", minify: !watching && !process.env.NO_MINIFY, sourcemap: watching ? "inline" : false, logLevel: "warning" };
  const graphs = {};
  for (const [source, target, format] of [["runtime/src/index.ts", "tendril.js", "iife"], ["runtime/src/kernel.ts", "kernel.mjs", "esm"], ["runtime/src/sw.ts", "sw.js", "iife"], ["runtime/src/voice/index.ts", "voice.mjs", "esm"], ["runtime/src/voice/worker.ts", "voice-worker.js", "iife"], ["runtime/src/voice/pcm-worklet.ts", "voice-pcm-worklet.js", "iife"]]) {
    const result = await build({ ...common, format, entryPoints: [join(root, source)], outfile: join(assets, target), metafile: true });
    const inputs = Object.keys(result.metafile.inputs).map(path => relative(root, join(process.cwd(), path)).replaceAll("\\", "/")).sort();
    graphs[target] = { inputs, bytes: readFileSync(join(assets, target)).length, gzip: gzipSync(readFileSync(join(assets, target))).length };
  }
  writeJson(join(runtime, "inputs.json"), graphs["kernel.mjs"].inputs);
  writeJson(join(runtime, "build-metrics.json"), graphs);
  cpSync(join(root, "node_modules/phonon-tts"), join(assets, "tts"), { recursive: true });
  mkdirSync(join(assets, "brand"), { recursive: true });
  for (const [source, target] of [["tendriller-logo-ai-compressed.png", "logo.png"], ["tendriller-logo-ai.webp", "logo.webp"], ["tendriller-icon-64.png", "icon-64.png"], ["tendriller-icon-180.png", "icon-180.png"], ["tendriller-favicon.ico", "favicon.ico"]])
    copyFileSync(join(root, "docs/assets", source), join(assets, "brand", target));
  const resources = RUNTIME_RESOURCES.map(({url,sha256,type}) => ({url,sha256,type}));
  writeJson(join(assets, "resources.json"), { features: RUNTIME_FEATURES, resources });
  const entries = filesUnder(assets).map(path => { const data = readFileSync(path); return { path: relative(assets, path).replaceAll("\\", "/"), sha256: sha256(data), size: data.length, type: contentType(path), preload: ["tendril.js", "sw.js"].includes(relative(assets, path).replaceAll("\\", "/")) }; });
  const manifest = runtimeManifest({ version: CORE_RELEASE, contract: CONTRACT_VERSION, assets: entries, resources });
  const { id } = manifest;
  writeJson(join(assets, "manifest.json"), manifest);
  // A release bundle contains only current assets. Previously deployed
  // runtime IDs resolve through R2; local watch sessions retain their builds.
  if (process.argv.includes("--clean-public")) rmSync(out, { recursive: true, force: true });
  const immutable = join(out, "_tendril/runtime", id);
  mkdirSync(immutable, { recursive: true }); cpSync(assets, immutable, { recursive: true });
  writeJson(join(root, "server/src/runtime-release.json"), { id, version: CORE_RELEASE, features: RUNTIME_FEATURES });
  // Explicit asset-first exclusions return a static 404 on misses. Restrict
  // them to the complete bundled graph so historical IDs still reach R2.
  // Include previously generated candidate configs, preserving their JSONC.
  for (const name of readdirSync(join(root, 'server')).filter(name => /^wrangler(?:\..+)?\.jsonc$/.test(name))) {
    const path = join(root, 'server', name), previous = readFileSync(path, 'utf8');
    const next = previous.replace(/"!\/_tendril\/runtime\/(?:[a-f0-9]{64}\/)?\*"/g, `"!/_tendril/runtime/${id}/*"`);
    if (next !== previous) writeFileSync(path, next);
  }
  mkdirSync(join(out, "_tendril"), { recursive: true });
  copyFileSync(join(assets, "sw.js"), join(out, "_tendril/sw.js"));
  cpSync(join(assets, "brand"), join(out, "_tendril/brand"), { recursive: true });
  copyFileSync(join(assets, "brand/favicon.ico"), join(out, "favicon.ico"));
  // Only these public root paths bypass the Worker. Scoped page documents,
  // optional resources and the installing service worker keep their auth path.
  writeFileSync(join(out, "_headers"), [
    '/_tendril/runtime/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '  X-Content-Type-Options: nosniff',
    '  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
    '  X-Robots-Tag: noindex, nofollow',
    '/_tendril/brand/*',
    '  Cache-Control: no-cache',
    '  X-Content-Type-Options: nosniff',
    '  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
    '  X-Robots-Tag: noindex, nofollow',
    '/favicon.ico',
    '  Cache-Control: no-cache',
    '  X-Content-Type-Options: nosniff',
    '  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
    '  X-Robots-Tag: noindex, nofollow',
    '',
  ].join('\n'));
  copyFileSync(join(root, "runtime/types/kernel.d.mts"), join(runtime, "kernel.d.mts"));
  copyFileSync(join(root, "runtime/types/voice.d.mts"), join(runtime, "voice.d.mts"));
  const runtimeExports = { "./kernel": { types: "./kernel.d.mts", import: "./assets/kernel.mjs" }, "./voice": { types: "./voice.d.mts", import: "./assets/voice.mjs" }, "./manifest": "./assets/manifest.json", "./assets/*": "./assets/*" };
  writeJson(join(runtime, "package.json"), { name: "@tendriller/runtime", version: CORE_RELEASE, type: "module", description: "Tendriller browser composition, sensors and explicit voice", exports: runtimeExports, files: ["assets", "kernel.d.mts", "voice.d.mts", "inputs.json", "build-metrics.json"], tendriller: { contract: CONTRACT_VERSION, runtime: id } });
  for (const file of readdirSync(join(root, "contract"))) if (/\.(mjs|mts|json)$/.test(file) && !["tsconfig.json", "engine.d.mts", "testing.d.mts"].includes(file)) copyFileSync(join(root, "contract", file), join(sdk, file));
  writeFileSync(join(sdk, 'onboarding.mjs'), readFileSync(join(sdk, 'onboarding.mjs'), 'utf8')
    .replace("const RELEASE_SOURCE = 'unbuilt';", `const RELEASE_SOURCE = '${releaseSource}';`));
  for (const folder of ["session", "collaboration"]) {
    mkdirSync(join(sdk, folder), { recursive: true });
    for (const file of readdirSync(join(root, folder))) if (/\.(mjs|mts)$/.test(file)) {
      const source = readFileSync(join(root, folder, file), 'utf8')
        .replaceAll("'../contract/", "'../").replaceAll('"../contract/', '"../');
      writeFileSync(join(sdk, folder, file), source);
    }
  }
  writeJson(join(sdk, "package.json"), { name: "@tendriller/core", version: CORE_RELEASE, type: "module", description: "Tendriller page-host client and owned application session contract", exports: { ".": { types: "./client.d.mts", import: "./client.mjs" }, "./setup": { types: "./setup.d.mts", import: "./setup.mjs" }, "./pairing": { types: "./pairing.d.mts", import: "./pairing.mjs" }, "./contract": { types: "./index.d.mts", import: "./index.mjs" }, "./onboarding": { types: "./onboarding.d.mts", import: "./onboarding.mjs" }, "./browser": { types: "./browser.d.mts" }, "./voice": { types: "./voice.d.mts" }, "./limits": { types: "./limits.d.mts", import: "./limits.mjs" }, "./application": { types: "./application.d.mts", import: "./application.mjs" }, "./signals": { types: "./signals.d.mts", import: "./signals.mjs" }, "./peers": { types: "./peers.d.mts", import: "./peers.mjs" }, "./assistant": { types: "./assistant.d.mts", import: "./assistant.mjs" }, "./archive": { types: "./archive.d.mts", import: "./archive.mjs" }, "./release-verify": { types: "./release-verify.d.mts", import: "./release-verify.mjs" }, "./probe": { types: "./transport-probe.d.mts", import: "./transport-probe.mjs" }, "./serverless": { types: "./serverless.d.mts", import: "./serverless.mjs" }, "./browser-owner": { types: "./session/browser.d.mts", import: "./session/browser.mjs" }, "./worker-owner": { types: "./session/worker.d.mts", import: "./session/worker.mjs" }, "./native-owner": { types: "./session/native.d.mts", import: "./session/native.mjs" }, "./ipc": { types: "./session/ipc.d.mts", import: "./session/ipc.mjs" }, "./outbox": { types: "./session/outbox.d.mts", import: "./session/outbox.mjs" }, "./participation": { types: "./session/participation.d.mts", import: "./session/participation.mjs" }, "./native-rtc": { types: "./session/native-rtc.d.mts", import: "./session/native-rtc.mjs" }, "./transport-diagnostics": { types: "./session/transport-diagnostics.d.mts", import: "./session/transport-diagnostics.mjs" }, "./diagnostics": { types: "./session/diagnostics.d.mts", import: "./session/diagnostics.mjs" }, "./collaboration": { types: "./collaboration/index.d.mts", import: "./collaboration/index.mjs" }, "./schema": "./v3.json" }, peerDependencies: { "@chronolog/peer-session": "*" }, peerDependenciesMeta: { "@chronolog/peer-session": { optional: true } }, tendriller: { contract: CONTRACT_VERSION } });
  for (const [name, directory] of [["sdk", sdk], ["runtime", runtime]]) {
    const result = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", dist], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
    const target = join(dist, `tendriller-${name}-${CORE_RELEASE}.tgz`);
    copyFileSync(join(dist, result.filename), target);
    if (join(dist, result.filename) !== target) rmSync(join(dist, result.filename));
  }
  for (const name of ["agent.md", "AGENTS.md", "llms.txt"]) copyFileSync(join(root, name), join(out, name));
  const inboxSource = join(root, 'server/inbox');
  const inbox = await build({ entryPoints: [join(inboxSource, 'app.mjs')], bundle: true, write: false, format: 'esm', minify: true });
  writeFileSync(join(out, 'application-inbox.html'), readFileSync(join(inboxSource, 'template.html'), 'utf8')
    .replace('<!-- APP -->', () => '<script type="module">' + inbox.outputFiles[0].text.replace(/<\/script/giu, '<\\/script') + '</script>'));

  for (const directory of ["docs", "legal"]) {
    const target = join(out, directory); rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
    for (const source of filesUnder(join(root, directory)).filter(path => /\.(md|html)$/.test(path) && !path.startsWith(join(root, "docs/tutorial") + "/"))) {
      const destination = join(target, relative(join(root, directory), source));
      mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
    }
  }
  mkdirSync(join(out, "contract"), { recursive: true });
  copyFileSync(join(root, "contract/v3.json"), join(out, "contract/v3.json"));
  buildOnboardingAssets(root, out);
  return manifest;
}

export async function buildEngine() {
  mkdirSync(join(dist, "engine"), { recursive: true });
  const result = await build({ entryPoints: [join(root, "server/src/index.ts")], outfile: join(dist, "engine/worker.mjs"), plugins: [releaseIdentity], bundle: true, platform: "browser", format: "esm", target: "es2022", external: ["cloudflare:workers"], metafile: true, logLevel: "warning" });
  writeJson(join(dist, "engine/inputs.json"), Object.keys(result.metafile.inputs).sort());
}
export async function buildAll() { await buildPublicArtifacts(); if (!process.argv.includes("--artifacts-only")) await buildEngine(); console.log("Built core SDK, runtime and engine artifacts"); }
if (!process.argv.includes("--skip-initial")) await buildAll();
if (watching) {
  let timer, building = false, again = false;
  const rebuild = async () => { if (building) { again = true; return; } building = true; do { again = false; try { await buildAll(); } catch (error) { console.error(error); } } while (again); building = false; };
  const watchers = ["runtime/src", "runtime/resources.mjs", "runtime/types", "server/src", "server/inbox", "contract", "session", "collaboration", "docs", "deploy", "legal", "agent.md", "AGENTS.md", "llms.txt"].map(path => watch(join(root, path), { recursive: true }, (_event, name) => {
    if (name === "runtime-release.json") return;
    clearTimeout(timer); timer = setTimeout(rebuild, 120);
  }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearTimeout(timer); watchers.forEach(watcher => watcher.close()); process.exit(0); });
}
