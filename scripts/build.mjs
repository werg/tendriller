// Builds browser assets into server/public, which the Worker serves via the ASSETS binding.
//   runtime/src/index.ts  -> server/public/_tendril/tendril.js
//   runtime/src/sw.ts     -> server/public/_tendril/sw.js
//   snippets/*.js         -> server/public/snippets/  (copied as-is; plain browser JS)
//   agent.md              -> server/public/agent.md
import { build } from "esbuild";
import { cpSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync, watch, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "server/public");
const watching = process.argv.includes("--watch");

export async function buildAll() {
const schemaPath = join(root, "contract/index.mjs");
const { schemaDocument, schemas } = await import(pathToFileURL(schemaPath).href + `?mtime=${statSync(schemaPath).mtimeMs}`);
mkdirSync(join(out, "_tendril"), { recursive: true });
// Preserve native ES-module/worker paths and third-party license notices.
rmSync(join(out, "_tendril/tts"), { recursive: true, force: true });
cpSync(join(root, "node_modules/phonon-tts"), join(out, "_tendril/tts"), { recursive: true });
mkdirSync(join(out, "snippets"), { recursive: true });
rmSync(join(out, "recipes"), { recursive: true, force: true });
cpSync(join(root, "recipes"), join(out, "recipes"), { recursive: true,
  filter: (source) => !basename(source).startsWith(".") });
mkdirSync(join(out, "_tendril/brand"), { recursive: true });
for (const [source, target] of [
  ["tendriller-logo-ai-compressed.png", "logo.png"],
  ["tendriller-logo-ai.webp", "logo.webp"],
  ["tendriller-icon-64.png", "icon-64.png"],
  ["tendriller-icon-180.png", "icon-180.png"],
  ["tendriller-favicon.ico", "favicon.ico"],
]) copyFileSync(join(root, "docs/assets", source), join(out, "_tendril/brand", target));
rmSync(join(out, "legal"), { recursive: true, force: true });
mkdirSync(join(out, "legal"), { recursive: true });

const common = { bundle: true, format: "iife", target: "es2020", minify: !watching && !process.env.NO_MINIFY, sourcemap: watching ? "inline" : false, logLevel: "warning" };
await build({ ...common, entryPoints: [join(root, "runtime/src/index.ts")], outfile: join(out, "_tendril/tendril.js") });
await build({ ...common, entryPoints: [join(root, "runtime/src/sw.ts")], outfile: join(out, "_tendril/sw.js") });
await build({ ...common, entryPoints: [join(root, "runtime/src/control/speech-worker.ts")], outfile: join(out, "_tendril/speech-worker.js") });

for (const f of readdirSync(join(root, "snippets"))) {
  if (f.endsWith(".js")) copyFileSync(join(root, "snippets", f), join(out, "snippets", f));
}
if (existsSync(join(root, "agent.md"))) copyFileSync(join(root, "agent.md"), join(out, "agent.md"));
for (const name of ["codex-bridge", "openclaw-bridge", "hermes-bridge", "tendril-wait", "tendril-watch"]) {
  await build({ entryPoints: [join(root, `cli/bin/${name}.mjs`)], outfile: join(out, `${name}.mjs`),
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" });
}
copyFileSync(join(root, "cli/scripts/tendril-wait.sh"), join(out, "tendril-wait.sh"));
await build({ entryPoints: [join(root, "cli/bin/claude-channel.mjs")], outfile: join(out, "claude-channel.mjs"), bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "warning" });
for (const name of ["terms", "privacy", "acceptable-use", "copyright", "law-enforcement"]) {
  const source = join(root, "legal", `${name}.html`);
  if (existsSync(source)) copyFileSync(source, join(out, "legal", `${name}.html`));
}
mkdirSync(join(out, "contract"), { recursive: true });
writeFileSync(join(out, "contract/v1.json"), JSON.stringify(schemaDocument, null, 2) + "\n");
writeFileSync(join(out, "recipes/ui-schema.json"), JSON.stringify({ $schema: schemaDocument.$schema, title: "Tendriller agent-editable interface", ...schemas.interface }, null, 2) + "\n");
await build({ entryPoints: [join(root, "server/src/state.ts")], outfile: join(out, "_preview/state.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" });
console.log("built server/public");
}

if (!process.argv.includes("--skip-initial")) await buildAll();
if (watching) {
  let timer, building = false, again = false;
  async function rebuild() {
    if (building) { again = true; return; }
    building = true;
    do {
      again = false;
      try { await buildAll(); } catch (error) { console.error("Build failed; watching for a correction:", error.message); }
    } while (again);
    building = false;
  }
  const watchers = ["runtime/src", "server/src/state.ts", "server/src/http.ts", "snippets", "recipes", "contract", "cli/bin", "cli/lib", "cli/scripts", "legal", "docs/assets", "agent.md"].map(path =>
    watch(join(root, path), { recursive: true }, (_event, file) => {
      if (file && /(?:^|\/)(?:node_modules|test-results|\.preview)/.test(String(file))) return;
      clearTimeout(timer); timer = setTimeout(rebuild, 120);
    }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); process.exit(0); });
  console.log("Watching runtime, snippets, recipes, contract, bridges and assets.");
}
