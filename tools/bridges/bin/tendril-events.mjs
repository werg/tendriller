#!/usr/bin/env node
// Downloadable entry point; build.mjs bundles the shared implementation.
import { readFileSync } from "node:fs";
import { parseArgs, intFlag } from "../../cli/lib/args.mjs";
import { pendingEvents, acknowledgeEvents } from "../lib/pending-events.mjs";
import { ApiError, client } from "../../cli/lib/api.mjs";

const usage = `Usage: tendril-events <private-handle.json> [pending | ack <seq> | send --wake]
  pending [--limit N] [--checkpoint-file PATH]  Read events after the last handled sequence; no automatic acknowledgement.
  ack <seq> [--checkpoint-file PATH]           Acknowledge completely handled events only.
  send --wake                                  Send one rate-limited delivery probe to wake the receiver.
  --pretty                                     Indent JSON.

The private checkpoint defaults to <private-handle.json>.events.json. It stores
handled_cursor and delivered_cursor separately; pending may replay until ack.
Only delivery probes are automatically acknowledged. Keep handle/checkpoint private.`;
try {
  const { cmd: file, args, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || file === "help") { process.stdout.write(usage + "\n"); }
  else {
    if (!file) throw Object.assign(new Error(usage), { exit: 64 });
    const [command = "pending", sequence] = args;
    if (!["pending", "ack", "send"].includes(command) || args.length !== (command === "ack" ? 2 : 1)
      || (command === "send" && !flags.wake)) throw Object.assign(new Error(usage), { exit: 64 });
    for (const flag of Object.keys(flags)) {
      if (!["limit", "checkpoint-file", "pretty", "wake"].includes(flag)
        || (command === "ack" && flag === "limit") || (command === "send" && !["wake", "pretty"].includes(flag))
        || (command !== "send" && flag === "wake"))
        throw Object.assign(new Error(`Unsupported option --${flag}. ${usage}`), { exit: 64 });
    }
    let cfg;
    try { cfg = JSON.parse(readFileSync(file, "utf8")); }
    catch { throw new Error("Cannot read the private handle file as JSON"); }
    if (typeof cfg?.api !== "string" || !cfg.api || typeof cfg?.token !== "string" || !cfg.token)
      throw new Error("The private handle file must contain api and token");
    const checkpoint = flags["checkpoint-file"] || `${file}.events.json`;
    const initialCursor = 0;
    const result = command === "send"
      ? { ...await client(cfg).post("/wake/probe", {}), diagnostic: "delivery_probe" }
      : command === "pending"
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
