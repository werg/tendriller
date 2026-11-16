#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, intFlag } from "../../cli/lib/args.mjs";
import { startServer, preview } from "../lib/preview.mjs";
import { assets, implementation } from "../lib/preview-bundle.mjs";

const usage = "Usage: tendril-preview.mjs <page-directory> [--fixture scenario.json] [--headless] [--out screenshot.png] [--state state.json] [--wait-ms N] [--desktop] [--headed]";
async function main() {
  const { cmd: directory, args, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || directory === "help") { console.log(usage); return; }
  if (!directory || args.length) throw Object.assign(new Error(usage), { exit: 64 });
  for (const key of Object.keys(flags)) if (!["fixture", "headless", "out", "state", "wait-ms", "desktop", "headed"].includes(key))
    throw Object.assign(new Error(`Unknown option --${key}. ${usage}`), { exit: 64 });
  if (!statSync(directory).isDirectory()) throw new Error("Preview needs a directory containing index.html");
  const fixture = flags.fixture ? JSON.parse(readFileSync(flags.fixture, "utf8")) : {};
  const state = flags.state ? JSON.parse(readFileSync(flags.state, "utf8")) : undefined;
  const options = { assets, implementation, fixture, state, out: flags.out, waitMs: intFlag(flags["wait-ms"], "wait-ms", 2500), desktop: !!flags.desktop, headed: !!flags.headed };
  if (options.waitMs < 0) throw Object.assign(new Error("--wait-ms must be nonnegative"), { exit: 64 });
  if (flags.headless) {
    const result = await preview(directory, options);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = result.error ? 2 : 1;
    return;
  }
  const server = await startServer(directory, state, fixture, options);
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, directory: resolve(directory), runtime: "production",
    message: "Local fixture adapter; reopen this canonical URL to select page edits. Ordered fixture steps require --headless." }));
  let stopping = false;
  const stop = async () => { if (!stopping) { stopping = true; await server.stopPreview(); } };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
main().catch(error => { console.error(JSON.stringify({ error: { code: error.code || "preview_failed", message: error.message } })); process.exitCode = error.exit || 1; });
