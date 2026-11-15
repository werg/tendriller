#!/usr/bin/env node
// Tendriller reference CLI. Zero dependencies, Node >= 18. See cli/README.md.
import { readFileSync, writeFileSync, existsSync, statSync, cpSync, mkdirSync } from "node:fs";
import { basename, resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, toPath, parseJsonArg, intFlag } from "../lib/args.mjs";
import {
  resolveConfig, saveConfig, removeConfig, serverBase, cursorPath, readCursor, writeCursor,
} from "../lib/config.mjs";
import { request, client, ApiError, sleep } from "../lib/api.mjs";
import { pack, guessType } from "../lib/pack.mjs";
import { terminalQr } from "../lib/qr.mjs";

const HELP = `tendril <command> [args] [--tendril <name>] [--pretty]

Create / attach
  new [name] --owner <verified-email> [--as <config-name>]
  adopt <code> [--as <config-name>]
  info                         tendril handle, versions, devices, presence, wake
  meta [--name N] [--short-name S] [--icon <blob id|https url>] [--theme-color C]
       [--background-color C] [--lifetime ad_hoc|resident]
  rm --yes                     delete the tendril and everything in it

Content
  push <dir|file> [--message M] [--no-replace] [--as <path>] [--no-wait] [--timeout S]
  files | versions | rollback [version]
  upload <file> [--name N]     store a blob (e.g. an icon) -> {id,url}
  blobs | blobs info <id> | blobs keep <id> | blobs expire <id>
  preview <dir> [--fixture scenario.json] [--out png] [--wait-ms N] [--eval JS] [--state file.json] [--desktop] [--headed]
  recipes                      list complete starter pages
  scaffold <recipe> <dir>      copy a starter page for editing

Talk to the page
  eval <js> | eval -f <file> | eval -   [--device primary|all|<id>] [--timeout-ms N]
  say <text> [--no-speak] [--in-reply-to SEQ] [--device ID|all] [--speak-on ID|primary|none]
  status <working|idle|done> [text]
  notify <title> [body] [--url U] [--device D] [--tag T]
  check [--device D]           accessibility audit (axe-core) in the page

Hear from the page
  events [--wait N] [--after C] [--limit N] [--peek] [--follow [--wakes]]
  wait [--timeout S]           block until a wake event, print events JSON, exit 0
  logs [--after C] [--follow]
  activity [--after C] [--note TEXT]
  journey [--since UNIX_MS]     ordered event/read/reply/error timeline

State, devices, sharing, wake
  state get [path] | set <path> <json> | delete <path> | patch <json> | put <json>
  devices | devices rename <id> <name> | devices purpose <id> <purpose> | devices rm <id>
  focus [<device-id>|off] [--ttl SECONDS]
  capabilities                 live browser and hardware report per device
  link guest [--label L] [--expires S] | link list | link rm <id> | link rotate [id]
  tokens | tokens new <name> | tokens rm <name>
  rules | rules set <json|@file>
  wake [--webhook URL [--token T] | --off] [--schedule N|off] [--page-streak N] [--grace S]

Durable work and complete workflows
  timers [list|history] | timers add <json|@file> | timers update <id> <json|@file>
  timers cancel <id> | timers rm <id>
  session [get] | session set <json|@file>
  bundle export [new-file.json] [--include-data] | bundle stage <file.json>
  bundle publish --expected-version N | bundle discard
  remix --owner EMAIL [--name N] [--include-data] [--as CONFIG]
  decisions [list] | decisions new <json|@file> | decisions update <id> <json|@file>
  responses                    private participant answers (agent access)

Config: TENDRIL_API + TENDRIL_TOKEN, or --tendril <name> (~/.config/tendril/<name>.json,
written by new/adopt), TENDRIL_SERVER (default http://localhost:8787), TENDRIL_OWNER.
Creation is ad_hoc. After the owner opens the page, use meta --lifetime resident to keep it.
Guest invites need owner approval. Display links are created in the owner page control.
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
  note(`\nPage URL (share after verifying the live listener): ${h.page_url}`);
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
    if (f["create-key"] !== undefined) fail("--create-key is retired. Create with --owner <verified-email>; no creation token is used.", 64);
    if (f.pairing !== undefined) fail("--pairing is retired. The owner signs in, and approves guest invitations in the page control.", 64);
    if (f.resident || (f.lifetime !== undefined && f.lifetime !== "ad_hoc")) fail("Create an ad_hoc page first. After the owner opens it, run meta --lifetime resident.", 64);
    const owner = String(f.owner || process.env.TENDRIL_OWNER || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner) || owner.length > 254) fail("new requires --owner <verified-email> (or TENDRIL_OWNER). Use an email verified by GitHub or Google.", 64);
    const body = { name: args[0] || f.name || undefined, owner, lifetime: "ad_hoc" };
    const h = await request(`${server}/api/tendrils`, { method: "POST", json: body });
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
    if (f.pairing !== undefined) fail("--pairing is retired. Guest access is approved by the owner in the page control.", 64);
    const map = { name: "name", "short-name": "short_name", icon: "icon", "theme-color": "theme_color",
      "background-color": "background_color", lifetime: "lifetime" };
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

  async blobs(args, f, api) {
    const [sub, id] = args;
    if (!sub) return out(await api.get("/blobs"));
    if (!id || !/^b_[a-z2-7]{20}$/.test(id)) fail("usage: tendril blobs [info|keep|expire <blob-id>]", 64);
    if (sub === "info") return out(await api.get(`/blobs/${id}/info`));
    if (sub === "keep" || sub === "expire") return out(await api.patch(`/blobs/${id}`, { keep: sub === "keep" }));
    fail("usage: tendril blobs [info|keep|expire <blob-id>]", 64);
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
    out(await api.post("/say", { text: args.join(" "), speak: !f["no-speak"],
      ...(f["in-reply-to"] ? { in_reply_to: Number(f["in-reply-to"]) } : {}),
      ...(f.device ? { device: f.device } : {}), ...(f["speak-on"] ? { speak_on: f["speak-on"] } : {}) }));
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
    const w = Math.min(300, intFlag(f.wait, "wait", 300));
    for (let backoff = 1000; ;) {
      try {
        let r = await api.get(`/events?after=${after}&wait=${w}${limit}`, { signal: AbortSignal.timeout(w * 1000 + 30000) });
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
      if (Date.now() >= deadline) { out({ timeout: true, cursor: readCursor(cpath) }); process.exitCode = 2; return; }
      const after = readCursor(cpath);
      try {
        const waitSeconds = Math.min(300, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
        const r = await api.get(`/events?after=${after}&wait=${waitSeconds}`, { signal: AbortSignal.timeout(waitSeconds * 1000 + 30000) });
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
  async journey(args, f, api) { out(await api.get(`/journey?since=${Number(f.since || 0)}${f.limit ? `&limit=${Number(f.limit)}` : ""}`)); },

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
    const [sub, id, ...name] = args;
    if (!sub) return out(await api.get("/devices"));
    if (sub === "approve") fail("Agent tokens cannot approve devices or change roles. The owner approves signed-in guests in the page control.", 64);
    if (!id) fail("devices needs a device id", 64);
    if (sub === "rename") {
      if (!name.join(" ").trim()) fail("usage: tendril devices rename <id> <name>", 64);
      return out(await api.patch(`/devices/${encodeURIComponent(id)}`, { name: name.join(" ") }));
    }
    if (sub === "purpose") {
      const purpose = name[0];
      if (!["general", "camera", "controller", "display", "speaker"].includes(purpose) || name.length !== 1)
        fail("purpose must be general, camera, controller, display or speaker; it does not change access permissions", 64);
      return out(await api.patch(`/devices/${encodeURIComponent(id)}`, { purpose }));
    }
    if (sub === "rm") { await api.del(`/devices/${encodeURIComponent(id)}`); return out({ ok: true }); }
    fail("usage: tendril devices [rename <id> <name> | purpose <id> <purpose> | rm <id>]", 64);
  },

  async focus(args, f, api) {
    if (!args[0]) return out(await api.get("/focus"));
    out(await api.post("/focus", { device: args[0] === "off" ? null : args[0], ...(f.ttl !== undefined ? { ttl_seconds: intFlag(f.ttl, "ttl") } : {}) }));
  },

  async timers(args, f, api) {
    const [sub = "list", id, settings] = args;
    if (sub === "list") return out(await api.get("/timers"));
    if (sub === "history") return out(await api.get("/timers/history"));
    if (sub === "add") return out(await api.post("/timers", jsonArg(id, "timer settings")));
    if (!id) fail("usage: tendril timers [list|history|add <json>|update <id> <json>|cancel <id>|rm <id>]", 64);
    const path = `/timers/${encodeURIComponent(id)}`;
    if (sub === "update") return out(await api.patch(path, jsonArg(settings, "timer changes")));
    if (sub === "cancel") return out(await api.patch(path, { state: "cancelled" }));
    if (sub === "rm") { await api.del(path); return out({ ok: true, removed: id }); }
    fail("unknown timers command; see tendril --help", 64);
  },

  async session(args, f, api) {
    if (!args[0] || args[0] === "get") return out(await api.get("/session"));
    if (args[0] === "set") return out(await api.put("/session", jsonArg(args[1], "session brief")));
    fail("usage: tendril session [get|set <json|@file>]", 64);
  },

  async bundle(args, f, api) {
    const [sub, file] = args;
    if (sub === "export") {
      const bundle = await api.get(`/bundle?include_data=${f["include-data"] === true}`);
      if (!file) return out(bundle);
      writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return out({ saved: resolve(file), includes_data: f["include-data"] === true });
    }
    if (sub === "stage") {
      if (!file) fail("usage: tendril bundle stage <file.json>", 64);
      return out(await api.put("/bundle", JSON.parse(readFileSync(file, "utf8"))));
    }
    if (sub === "publish") {
      const version = Number(f["expected-version"]);
      if (!Number.isSafeInteger(version) || version < 0) fail("Review the prepared copy, then use bundle publish --expected-version <current-version>", 64);
      return out(await api.post("/bundle/publish", { expected_version: version }));
    }
    if (sub === "discard") { await api.del("/bundle"); return out({ discarded: true }); }
    fail("usage: tendril bundle export [new-file.json] [--include-data] | stage <file.json> | publish --expected-version N | discard", 64);
  },

  async remix(args, f, api, cfg) {
    const owner = String(f.owner || process.env.TENDRIL_OWNER || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) fail("remix requires --owner <verified-email> (or TENDRIL_OWNER)", 64);
    const handle = await api.post("/remix", { owner, ...(f.name ? { name: f.name } : {}), include_data: f["include-data"] === true });
    const saved = saveConfig(handle, f.as || handle.id, process.env, new URL(cfg.api).origin);
    printHandle(handle, saved);
    note("The independent copy is prepared. Open its page, attach the receiver, then publish the bundle with --expected-version 0.");
  },

  async decisions(args, f, api) {
    const [sub = "list", id, settings] = args;
    if (sub === "list") return out(await api.get("/decisions"));
    if (sub === "new") return out(await api.post("/decisions", jsonArg(id, "proposal")));
    if (sub === "update" && id) return out(await api.patch(`/decisions/${encodeURIComponent(id)}`, jsonArg(settings, "proposal changes with expected_version")));
    fail("usage: tendril decisions [list|new <json|@file>|update <id> <json|@file>]; owners respond on the page", 64);
  },

  async responses(args, f, api) { out(await api.get("/responses")); },

  async capabilities(args, f, api) { out(await api.get("/capabilities")); },

  async link(args, f, api) {
    const [sub, id] = args;
    if (!sub || sub === "list") return out(await api.get("/links"));
    if (sub === "rm") {
      if (!id) fail("usage: tendril link rm <id>", 64);
      await api.del(`/links/${encodeURIComponent(id)}`); return out({ ok: true });
    }
    if (sub === "rotate") return out(await api.post(`/links/${encodeURIComponent(id || "l_main")}/rotate`, {}));
    if (sub === "owner" || sub === "display") fail("Agents can create guest invitations only. Use the owner page control to create display links; the existing main link is the owner link.", 64);
    if (sub !== "guest") fail("usage: tendril link guest [--label L] [--expires S] | list | rm <id> | rotate [id]", 64);
    const body = { role: sub };
    if (f.label) body.label = f.label;
    if (f.expires !== undefined) {
      body.expires_in = Number(f.expires);
      if (!Number.isFinite(body.expires_in) || body.expires_in <= 0) fail("--expires must be a positive number of seconds", 64);
    }
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
      fixture: f.fixture ? JSON.parse(readFileSync(f.fixture, "utf8")) : undefined,
      desktop: !!f.desktop, headed: !!f.headed,
      width: f.width ? Number(f.width) : undefined, height: f.height ? Number(f.height) : undefined,
    });
    out(r);
    if (!r.ok) process.exitCode = r.error ? 2 : 1;
  },
  async recipes() {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../recipes");
    out(JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")));
  },
  async scaffold(args) {
    const [name, target] = args;
    if (!name || !target) fail("usage: tendril scaffold <recipe> <dir>");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../recipes");
    const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));
    if (!catalog.recipes.some((r) => r.id === name)) fail(`unknown recipe: ${name}`);
    if (existsSync(target)) fail(`target already exists: ${target}`);
    mkdirSync(target, { recursive: true });
    cpSync(join(root, name), target, { recursive: true });
    out({ recipe: name, path: resolve(target), next: `tendril preview ${target}` });
  },
};

const NO_CONFIG = new Set(["new", "adopt", "preview", "recipes", "scaffold"]);

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
