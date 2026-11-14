// Builds browser assets into server/public, which the Worker serves via the ASSETS binding.
//   runtime/src/index.ts  -> server/public/_tendril/tendril.js
//   runtime/src/sw.ts     -> server/public/_tendril/sw.js
//   snippets/*.js         -> server/public/snippets/  (copied as-is; plain browser JS)
//   agent.md              -> server/public/agent.md
import { build } from "esbuild";
import { cpSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "server/public");
mkdirSync(join(out, "_tendril"), { recursive: true });
// Preserve native ES-module/worker paths and third-party license notices.
rmSync(join(out, "_tendril/tts"), { recursive: true, force: true });
cpSync(join(root, "node_modules/phonon-tts"), join(out, "_tendril/tts"), { recursive: true });
mkdirSync(join(out, "snippets"), { recursive: true });
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

const common = { bundle: true, format: "iife", target: "es2020", minify: !process.env.NO_MINIFY, sourcemap: false, logLevel: "warning" };
await build({ ...common, entryPoints: [join(root, "runtime/src/index.ts")], outfile: join(out, "_tendril/tendril.js") });
await build({ ...common, entryPoints: [join(root, "runtime/src/sw.ts")], outfile: join(out, "_tendril/sw.js") });
await build({ ...common, entryPoints: [join(root, "runtime/src/control/speech-worker.ts")], outfile: join(out, "_tendril/speech-worker.js") });

for (const f of readdirSync(join(root, "snippets"))) {
  if (f.endsWith(".js")) copyFileSync(join(root, "snippets", f), join(out, "snippets", f));
}
if (existsSync(join(root, "agent.md"))) copyFileSync(join(root, "agent.md"), join(out, "agent.md"));
for (const name of ["terms", "privacy", "acceptable-use", "copyright", "law-enforcement"]) {
  const source = join(root, "legal", `${name}.html`);
  if (existsSync(source)) copyFileSync(source, join(out, "legal", `${name}.html`));
}
console.log("built server/public");
