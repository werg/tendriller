// Builds browser assets into server/public, which the Worker serves via the ASSETS binding.
//   runtime/src/index.ts  -> server/public/_tendril/tendril.js
//   runtime/src/sw.ts     -> server/public/_tendril/sw.js
//   snippets/*.js         -> server/public/snippets/  (copied as-is; plain browser JS)
//   agent.md              -> server/public/agent.md
import { build } from "esbuild";
import { cpSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "server/public");
mkdirSync(join(out, "_tendril"), { recursive: true });
mkdirSync(join(out, "snippets"), { recursive: true });

const common = { bundle: true, format: "iife", target: "es2020", minify: !process.env.NO_MINIFY, sourcemap: false, logLevel: "warning" };
await build({ ...common, entryPoints: [join(root, "runtime/src/index.ts")], outfile: join(out, "_tendril/tendril.js") });
await build({ ...common, entryPoints: [join(root, "runtime/src/sw.ts")], outfile: join(out, "_tendril/sw.js") });

for (const f of readdirSync(join(root, "snippets"))) {
  if (f.endsWith(".js")) copyFileSync(join(root, "snippets", f), join(out, "snippets", f));
}
if (existsSync(join(root, "agent.md"))) copyFileSync(join(root, "agent.md"), join(out, "agent.md"));
console.log("built server/public");
