#!/usr/bin/env node
// Tendriller reference CLI. Zero dependencies, Node >= 18. See cli/README.md.
import { readFileSync, existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs, toPath, parseJsonArg, intFlag } from "../lib/args.mjs";
import {
  resolveConfig, saveConfig, removeConfig, serverBase, cursorPath, readCursor, writeCursor,
} from "../lib/config.mjs";
import { request, client, ApiError, sleep } from "../lib/api.mjs";
import { pack, guessType } from "../lib/pack.mjs";
import { terminalQr } from "../lib/qr.mjs";

const HELP = `tendril <command> [args] [--tendril <name>] [--pretty]

Create / attach
  new [name] [--resident] [--pairing open|required] [--as <config-name>]
  adopt <code> [--as <config-name>]
  info                         tendril handle, versions, devices, presence, wake
  meta [--name N] [--short-name S] [--icon <blob id|https url>] [--theme-color C]
       [--background-color C] [--lifetime ad_hoc|resident] [--pairing open|required]
  rm --yes                     delete the tendril and everything in it

Content
  push <dir|file> [--message M] [--no-replace] [--as <path>] [--no-wait] [--timeout S]
  files | versions | rollback [version]
  upload <file> [--name N]     store a blob (e.g. an icon) -> {id,url}
  preview <dir> [--out png] [--wait-ms N] [--eval JS] [--state file.json] [--desktop] [--headed]

Talk to the page
  eval <js> | eval -f <file> | eval -   [--device primary|all|<id>] [--timeout-ms N]
  say <text> [--no-speak]
  status <working|idle|done> [text]
  notify <title> [body] [--url U] [--device D] [--tag T]
  check [--device D]           accessibility audit (axe-core) in the page

Hear from the page
  events [--wait N] [--after C] [--limit N] [--peek] [--follow [--wakes]]
  wait [--timeout S]           block until a wake event, print events JSON, exit 0
  logs [--after C] [--follow]
  activity [--after C] [--note TEXT]

State, devices, sharing, wake
  state get [path] | set <path> <json> | delete <path> | patch <json> | put <json>
  devices | devices approve <id> [role] | devices rm <id>
  link <owner|guest|display> [--label L] [--expires S] | link list | link rm <id> | link rotate
  tokens | tokens new <name> | tokens rm <name>
  rules | rules set <json|@file>
  wake [--webhook URL [--token T] | --off] [--schedule N|off] [--page-streak N] [--grace S]

Config: TENDRIL_API + TENDRIL_TOKEN, or --tendril <name> (~/.config/tendril/<name>.json,
written by new/adopt), TENDRIL_SERVER (default http://localhost:8787), TENDRIL_CREATE_KEY.
JSON arguments may be @file. Output is JSON; --pretty indents it.`;

let PRETTY = false;
const out = (x) => process.stdout.write((PRETTY ? JSON.stringify(x, null, 2) : JSON.stringify(x)) + "\n");
const note = (s) => process.stderr.write(s + "\n");
const fail = (msg, code = 1) => { const e = new Error(msg); e.exit = code; throw e; };

function jsonArg(s, what) {
  if (s === undefined) fail(`missing ${what}`);
  if (s.startsWith("@")) return JSON.parse(readFileSync(s.slice(1), "utf8"));
  return parseJsonArg(s);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function printHandle(h, saved) {
  out({ ...h, config: saved ? saved.name : undefined, config_file: saved ? saved.path : undefined });
  const qr = terminalQr(h.page_url);
  note(`\nPage URL (give this to the user): ${h.page_url}`);
  if (qr) note(qr);
  if (saved) note(`Saved to ${saved.path}. Use: tendril --tendril ${saved.name} <command>`);
}

async function waitForHealth(api, version, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  let last;
  for (;;) {
    last = await api.get("/versions");
    const v = (last.versions || []).find((x) => x.version === version);
    if (v && v.status !== "pending") return { entry: v, list: last };
    if (Date.now() > deadline) return { entry: v, list: last, timedOut: true };
    await sleep(1000);
  }
}

const commands = {
  async new(args, f) {
    const server = serverBase(process.env, f);
    const body = { name: args[0] || f.name || undefined };
    if (f.resident) body.lifetime = "resident";
    if (f.lifetime) body.lifetime = f.lifetime;
    if (f.pairing) body.pairing = f.pairing;
    const key = f["create-key"] || process.env.TENDRIL_CREATE_KEY;
    const h = await request(`${server}/api/tendrils`, { method: "POST", json: body, token: key });
    const saved = saveConfig(h, f.as || args[0] || h.name, process.env, server);
    printHandle(h, saved);
  },

  async adopt(args, f) {
    if (!args[0]) fail("usage: tendril adopt <code>");
    const server = serverBase(process.env, f);
    const h = await request(`${server}/api/adopt`, { method: "POST", json: { code: args[0] } });
    const saved = saveConfig(h, f.as || h.name, process.env, server);
    printHandle(h, saved);
  },

  async info(args, f, api) { out(await api.get("")); },

  async meta(args, f, api) {
    const map = { name: "name", "short-name": "short_name", icon: "icon", "theme-color": "theme_color",
      "background-color": "background_color", lifetime: "lifetime", pairing: "pairing" };
    const body = {};
    for (const [k, v] of Object.entries(map)) if (f[k] !== undefined) body[v] = f[k];
    if (f.resident) body.lifetime = "resident";
    if (!Object.keys(body).length) fail("nothing to change; see tendril --help");
    out(await api.patch("", body));
  },

  async rm(args, f, api, cfg) {
    if (!f.yes) fail("this deletes the tendril and all its data; repeat with --yes");
    await api.del("");
    removeConfig(cfg);
    out({ ok: true, deleted: cfg.id });
  },

  async push(args, f, api) {
    const target = args[0];
    if (!target || !existsSync(target)) fail("usage: tendril push <dir|file>");
    const body = pack(target, { as: f.as, merge: !!f["no-replace"], message: f.message });
    const r = await api.post("/files", body);
    const result = { version: r.version, files: r.files };
    if (f["no-wait"]) return out({ ...result, status: "pending" });
    const { entry, list, timedOut } = await waitForHealth(api, r.version, intFlag(f.timeout, "timeout", 20));
    result.status = entry ? entry.status : "unknown";
    result.healthy = result.status === "healthy" ? true : result.status === "failed" ? false : null;
    if (entry?.errors?.length) result.errors = entry.errors;
    if (list) result.current = list.current;
    if (timedOut) result.note = "still pending: no device has loaded this version yet (open the page) or it is still starting";
    out(result);
    if (result.status === "failed") process.exitCode = 3;
  },

  async files(args, f, api) { out(await api.get("/files" + (f.version ? `?version=${f.version}` : ""))); },
  async versions(args, f, api) { out(await api.get("/versions")); },
  async rollback(args, f, api) { out(await api.post("/rollback", args[0] ? { version: Number(args[0]) } : {})); },

  async upload(args, f, api) {
    if (!args[0]) fail("usage: tendril upload <file>");
    const headers = { "content-type": guessType(args[0]), "x-tendril-name": f.name || basename(args[0]) };
    out(await api.raw("/blobs", { method: "PUT", body: readFileSync(args[0]), headers }));
  },

  async eval(args, f, api) {
    let code = args.join(" ");
    if (f.file) code = readFileSync(f.file, "utf8");
    else if (code === "-") code = await readStdin();
    if (!code.trim()) fail("usage: tendril eval <js> | -f file | -");
    const body = { code };
    if (f.device) body.device = f.device;
    if (f["timeout-ms"]) body.timeout_ms = Number(f["timeout-ms"]);
    const r = await api.post("/eval", body);
    out(r);
    if (r && r.ok === false) process.exitCode = 1;
  },

  async say(args, f, api) {
    if (!args.length) fail("usage: tendril say <text>");
    out(await api.post("/say", { text: args.join(" "), speak: !f["no-speak"] }));
  },

  async status(args, f, api) {
    const body = {};
    if (args[0]) body.state = args[0];
    if (args.length > 1) body.text = args.slice(1).join(" ");
    out(await api.post("/status", body));
  },

  async notify(args, f, api) {
    if (!args[0]) fail("usage: tendril notify <title> [body]");
    const body = { title: args[0] };
    if (args.length > 1) body.body = args.slice(1).join(" ");
    for (const k of ["url", "device", "tag"]) if (f[k]) body[k] = f[k];
    out(await api.post("/notify", body));
  },

  async check(args, f, api) { out(await api.post("/check", f.device ? { device: f.device } : {})); },

  async events(args, f, api, cfg) {
    const cpath = cursorPath(cfg, f);
    const explicit = f.after !== undefined;
    let after = explicit ? Number(f.after) : readCursor(cpath);
    const limit = f.limit ? `&limit=${Number(f.limit)}` : "";
    const save = (c) => { if (!explicit && !f.peek) writeCursor(cpath, c); };
    if (!f.follow) {
      const r = await api.get(`/events?after=${after}&wait=${intFlag(f.wait, "wait", 0)}${limit}`);
      save(r.cursor);
      return out(r);
    }
    const w = Math.min(25, intFlag(f.wait, "wait", 5));
    for (let backoff = 1000; ;) {
      try {
        let r = await api.get(`/events?after=${after}&wait=${w}${limit}`);
        if (!r.events?.length) r = await api.get(`/events?after=${after}&wait=0${limit}`);
        for (const e of r.events || []) if (!f.wakes || e.wake) out(e);
        if (typeof r.cursor === "number") { after = r.cursor; save(after); }
        backoff = 1000;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 404)) throw e;
        note(`events: ${e.message}; retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  },

  async wait(args, f, api, cfg) {
    const cpath = cursorPath(cfg, f);
    const deadline = f.timeout ? Date.now() + Number(f.timeout) * 1000 : Infinity;
    for (let backoff = 2000; ;) {
      if (Date.now() > deadline) { out({ timeout: true, cursor: readCursor(cpath) }); process.exitCode = 2; return; }
      const after = readCursor(cpath);
      try {
        const r = await api.get(`/events?after=${after}&wait=25`);
        backoff = 2000;
        if (r.events && r.events.length && !r.timeout) {
          writeCursor(cpath + ".prev", after);
          writeCursor(cpath, r.cursor);
          const owner = r.events.filter((e) => e.type === "instruction" && e.role === "owner").length;
          note(`tendril: ${r.events.length} event(s), ${owner} owner instruction(s); cursor ${after} -> ${r.cursor}`);
          return out(r);
        }
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 404)) throw e;
        note(`wait: ${e.message}; retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  },

  async logs(args, f, api) {
    let after = Number(f.after || 0);
    if (!f.follow) return out(await api.get(`/logs?after=${after}${f.limit ? `&limit=${Number(f.limit)}` : ""}`));
    for (;;) {
      const r = await api.get(`/logs?after=${after}`);
      for (const l of r.logs || []) out(l);
      if (typeof r.cursor === "number") after = r.cursor;
      await sleep(2000);
    }
  },

  async activity(args, f, api) {
    if (f.note) return out(await api.post("/activity", { text: f.note }));
    out(await api.get(`/activity?after=${Number(f.after || 0)}${f.limit ? `&limit=${Number(f.limit)}` : ""}`));
  },

  async state(args, f, api) {
    const [sub, a, b] = args;
    switch (sub || "get") {
      case "get": {
        const r = await api.get("/state");
        if (!a) return out(r);
        let v = r.state;
        for (const k of toPath(a)) v = v == null ? undefined : v[k];
        return out(v === undefined ? null : v);
      }
      case "set": return out(await api.patch("/state", { ops: [{ op: "set", path: toPath(a), value: jsonArg(b, "value") }] }));
      case "delete": return out(await api.patch("/state", { ops: [{ op: "delete", path: toPath(a) }] }));
      case "patch": return out(await api.patch("/state", jsonArg(a, "merge patch")));
      case "put": return out(await api.put("/state", jsonArg(a, "state object")));
      default: fail("usage: tendril state get [path] | set <path> <json> | delete <path> | patch <json> | put <json>");
    }
  },

  async devices(args, f, api) {
    const [sub, id, role] = args;
    if (!sub) return out(await api.get("/devices"));
    if (sub === "approve") return out(await api.patch(`/devices/${id}`, { role: role || "owner" }));
    if (sub === "rename") return out(await api.patch(`/devices/${id}`, { name: role }));
    if (sub === "rm") { await api.del(`/devices/${id}`); return out({ ok: true }); }
    fail("usage: tendril devices [approve <id> [role] | rename <id> <name> | rm <id>]");
  },

  async link(args, f, api) {
    const [sub, id] = args;
    if (!sub || sub === "list") return out(await api.get("/links"));
    if (sub === "rm") { await api.del(`/links/${id}`); return out({ ok: true }); }
    if (sub === "rotate") return out(await api.post(`/links/${id || "l_main"}/rotate`, {}));
    if (!["owner", "guest", "display"].includes(sub)) fail("usage: tendril link <owner|guest|display> [--label L] [--expires S]");
    const body = { role: sub };
    if (f.label) body.label = f.label;
    if (f.expires) body.expires_in = Number(f.expires);
    const r = await api.post("/links", body);
    out(r);
    const qr = r.url && terminalQr(r.url);
    if (qr) note(qr);
  },

  async tokens(args, f, api) {
    const [sub, name] = args;
    if (!sub) return out(await api.get("/tokens"));
    if (sub === "new") return out(await api.post("/tokens", { name }));
    if (sub === "rm") { await api.del(`/tokens/${encodeURIComponent(name)}`); return out({ ok: true }); }
    fail("usage: tendril tokens [new <name> | rm <name>]");
  },

  async rules(args, f, api) {
    if (!args[0]) return out(await api.get("/rules"));
    if (args[0] === "set") {
      const v = jsonArg(args[1], "rules");
      return out(await api.put("/rules", Array.isArray(v) ? { rules: v } : v));
    }
    fail("usage: tendril rules [set <json|@file>]");
  },

  async wake(args, f, api) {
    const body = {};
    if (f.off) body.webhook = null;
    if (f.webhook) body.webhook = f.token ? { url: f.webhook, token: f.token } : { url: f.webhook };
    if (f.schedule !== undefined) body.schedule_minutes = f.schedule === "off" ? null : Number(f.schedule);
    if (f["page-streak"] !== undefined) {
      body.budget = { page_streak: Number(f["page-streak"]) };
    }
    if (f.grace) body.grace_seconds = Number(f.grace);
    out(Object.keys(body).length ? await api.put("/wake", body) : await api.get("/wake"));
  },

  async preview(args, f) {
    if (!args[0] || !existsSync(args[0])) fail("usage: tendril preview <dir>");
    const dir = statSync(args[0]).isDirectory() ? args[0] : fail("preview needs a directory with index.html");
    const { preview } = await import("../lib/preview.mjs");
    const r = await preview(dir, {
      out: f.out, waitMs: f["wait-ms"] ? Number(f["wait-ms"]) : undefined, eval: f.eval,
      state: f.state ? JSON.parse(readFileSync(f.state, "utf8")) : undefined,
      desktop: !!f.desktop, headed: !!f.headed,
      width: f.width ? Number(f.width) : undefined, height: f.height ? Number(f.height) : undefined,
    });
    out(r);
    if (!r.ok) process.exitCode = r.error ? 2 : 1;
  },
};

const NO_CONFIG = new Set(["new", "adopt", "preview"]);

async function main() {
  let parsed;
  try { parsed = parseArgs(process.argv.slice(2)); } catch (e) { note(e.message); process.exit(64); }
  const { cmd, args, flags } = parsed;
  PRETTY = !!flags.pretty;
  if (!cmd || flags.help || cmd === "help") { process.stdout.write(HELP + "\n"); return; }
  const fn = commands[cmd];
  if (!fn) { note(`unknown command "${cmd}"\n\n${HELP}`); process.exit(64); }
  try {
    let cfg, api;
    if (!NO_CONFIG.has(cmd)) { cfg = resolveConfig(flags); api = client(cfg); }
    await fn(args, flags, api, cfg);
  } catch (e) {
    if (e instanceof ApiError) {
      process.stderr.write(JSON.stringify({ status: e.status, ...(e.body || { error: { message: e.message } }) }) + "\n");
      process.exit(e.status === 409 ? 4 : 1);
    }
    note(`tendril: ${e.message}`);
    process.exit(e.exit || 1);
  }
}

main();
