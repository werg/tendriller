import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  await build({
    entryPoints: [join(here, "entry.ts")],
    outfile: join(here, ".build/entry.js"),
    bundle: true, format: "iife", target: "es2020", logLevel: "warning",
  });
}
