#!/usr/bin/env node
// Downloadable entry point; build.mjs bundles the shared implementation.
import { readFileSync } from "node:fs";
import { parseArgs, intFlag } from "../../cli/lib/args.mjs";
import { pendingEvents, acknowledgeEvents } from "../lib/pending-events.mjs";
import { ApiError } from "../../cli/lib/api.mjs";

const usage = "Usage: tendril-events.mjs <private-handle.json> [pending | ack <seq>] [--limit N] [--checkpoint-file PATH] [--pretty]";
try {
  const { cmd: file, args, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || file === "help") { process.stdout.write(usage + "\n"); }
  else {
    if (!file) throw Object.assign(new Error(usage), { exit: 64 });
    const [command = "pending", sequence] = args;
    if (!["pending", "ack"].includes(command) || args.length > (command === "ack" ? 2 : 1)
      || (command === "ack" && sequence === undefined)) throw Object.assign(new Error(usage), { exit: 64 });
    for (const flag of Object.keys(flags)) {
      if (!["limit", "checkpoint-file", "pretty"].includes(flag) || (command === "ack" && flag === "limit"))
        throw Object.assign(new Error(`Unsupported option --${flag}. ${usage}`), { exit: 64 });
    }
    let cfg;
    try { cfg = JSON.parse(readFileSync(file, "utf8")); }
    catch { throw new Error("Cannot read the private handle file as JSON"); }
    if (typeof cfg?.api !== "string" || !cfg.api || typeof cfg?.token !== "string" || !cfg.token)
      throw new Error("The private handle file must contain api and token");
    const checkpoint = flags["checkpoint-file"] || `${file}.events.json`;
    const initialCursor = 0;
    const result = command === "pending"
      ? await pendingEvents(cfg, checkpoint, { limit: intFlag(flags.limit, "limit", 100), initialCursor })
      : await acknowledgeEvents(cfg, checkpoint, Number(sequence), { initialCursor });
    process.stdout.write(JSON.stringify(result, null, flags.pretty ? 2 : undefined) + "\n");
  }
} catch (e) {
  const result = e instanceof ApiError ? { status: e.status, ...(e.body || { error: { message: e.message } }) }
    : { error: { code: e.code || "event_command_failed", message: e.message } };
  process.stderr.write(JSON.stringify(result) + "\n");
  process.exitCode = e.exit || 1;
}
