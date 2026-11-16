#!/usr/bin/env node
// Optional Tendriller operational CLI. Uses the public core contract.
import { randomUUID, createHash } from "node:crypto";
import { checkService } from "../lib/service.mjs";
import { CONTRACT_VERSION } from "@tendriller/core/contract";
import { readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { basename, resolve, join, dirname } from "node:path";
import { parseArgs, toPath, parseJsonArg, intFlag } from "../lib/args.mjs";
import {
  resolveConfig, saveConfig, removeConfig, serverBase, configDir, cursorPath, readCursor, writeCursor, checkpointPath,
} from "../lib/config.mjs";
import { request, client, ApiError, sleep } from "../lib/api.mjs";
import { pendingEvents, acknowledgeEvents } from "../../bridges/lib/pending-events.mjs";
import { pack, guessType } from "../lib/pack.mjs";
import { uploadBlob, downloadBlob, blobInfo } from "../lib/blobs.mjs";
import { putSharedFile, getSharedFile, deleteSharedFile, listSharedFiles, fileHistory } from "../lib/shared-files.mjs";
import { publishFiles, rollbackPublication } from "../lib/publications.mjs";
import { changeTimer } from "../lib/timers.mjs";
import { terminalQr } from "../lib/qr.mjs";

const MAX_TRANSFER_BYTES = 5 * 1024 * 1024;
function readTransferFile(path) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Transfer source must be a regular file, not a symlink");
  if (stats.size > MAX_TRANSFER_BYTES) throw new Error(`Transfer source exceeds the effective ${MAX_TRANSFER_BYTES} byte limit`);
  return readFileSync(path);
}

const HELP = `tendril <command> [args] [--tendril <name>] [--pretty]

Create / attach
  new [name] --owner <verified-email> [--mode interactive|dashboard] [--as <config-name>]
  adopt <code> [--as <config-name>]
  info                         tendril handle, versions, devices, presence, wake
  meta [--name N] [--short-name S] [--icon <blob id|https url>] [--theme-color C]
       [--background-color C] [--lifetime ad_hoc|resident]
  rm --yes                     delete the tendril and everything in it

Content
  push <dir|file> [--message M] [--no-replace] [--as <path>] [--entry <html-path>] [--no-wait] [--timeout S]
  publications | publication <version> | rollback <version> [--expected-head N] [--resume-file PATH]
  blob upload <file> [--name N] [--type T] [--resume-file PATH]
  blob download <id> <destination> [--overwrite] | blob info <id>
  blob list [--after <blob-id>] [--limit N]
  blob pin <id> --keep true|false [--cid C --generations JSON]
  file put <path> <file> [--revision N] [--resume-file PATH]
  file get <path> <destination> [--overwrite] | file list | file history <path>
  file delete <path> [--revision N] [--resume-file PATH] [--cid C --generations JSON]

Talk to the page
  eval <js> | eval -f <file> | eval -   [--device primary|all|<id>] [--timeout-ms N]
  say <text> [--no-speak] [--in-reply-to SEQ] [--device ID|all] [--speak-on ID|primary|none]
  status <working|idle|done> [text]
  notify <title> [body] [--url U] [--device D] [--tag T]
  notifications                push readiness, subscribed devices and quota (no notification sent)
  check [--device D]           accessibility audit (axe-core) in the page

Hear from the page
  pending [--limit N]          read pending input; auto-handle delivery probes only
  ack <sequence>              save handled progress after replies/updates succeed
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
  wake [--webhook URL [--token T] | --off] [--schedule N|off] [--page-streak N] [--grace S]

Durable work and trusted extensions
  timers [list|history] | timers add <json|@file>
  timers update <id> <json|@file> --revision N | timers cancel <id> --revision N | timers rm <id> --revision N
       [--cid C --scope ID --generations JSON --resume-file PATH]
  session [get] | session set <json|@file>
  bundle export [new-file.json] [--include-data] | bundle stage <file.json>
  bundle publish --expected-head N | bundle discard
  remix --owner EMAIL [--name N] [--include-data] [--as CONFIG]
  workflow <module> <operation> [json]  explicit trusted workflow command
  scopes list|register|rotate|remove     authoritative generation controls

Config: TENDRIL_API + TENDRIL_TOKEN, or --tendril <name> (~/.config/tendril/<name>.json,
written by new/adopt), TENDRIL_SERVER (default https://tendriller.dev; use --server for local development), TENDRIL_OWNER.
Creation is ad_hoc. After the owner opens the page, use meta --lifetime resident to keep it.
Guest invites need owner approval. Display links are created in the service utility.
JSON arguments may be @file. Output is JSON; --pretty indents it.`;

let PRETTY = false;
const out = (x) => process.stdout.write((PRETTY ? JSON.stringify(x, null, 2) : JSON.stringify(x)) + "\n");
const note = (s) => process.stderr.write(s + "\n");
const fail = (msg, code = 1) => { const e = new Error(msg); e.exit = code; throw e; };
function boundedInteger(value, name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const number = intFlag(value, name, fallback);
  if (number < min || number > max) fail(`--${name} must be an integer from ${min} to ${max}`, 64);
  return number;
}
const retryable = e => !(e instanceof ApiError) || [408, 425, 429].includes(e.status) || e.status >= 500;

function transferRecord(cfg, what, key, flag) {
  if (flag) return resolve(flag);
  const path = join(configDir(), "transfers",
    createHash("sha256").update(`${cfg.api}\0${what}\0${key}`).digest("hex") + ".json");
  mkdirSync(dirname(path), { recursive:true, mode:0o700 });
  return path;
}
function generationsOf(flags) { return flags.generations ? jsonArg(flags.generations, "generation preconditions") : {}; }
function revisionOf(flags) { return flags.revision === undefined ? undefined : boundedInteger(flags.revision,"revision",0,0); }

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
  note(h.mode === "dashboard" ? `\nDashboard URL: ${h.page_url}` : `\nPage URL (share after verifying the live listener): ${h.page_url}`);
  if (qr) note(qr);
  if (saved) note(`Saved to ${saved.path}. Use: tendril --tendril ${saved.name} <command>`);
}

async function waitForHealth(api, version, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  let last;
  for (;;) {
    last = await api.get("/publications");
    const v = (last.versions || []).find((x) => x.version === version);
    if (v && v.status !== "pending") return { entry: v, list: last };
    if (Date.now() > deadline) return { entry: v, list: last, timedOut: true };
    await sleep(1000);
  }
}

const commandMetadata = f => ({ cid: f.cid || randomUUID(), expected_generations: f.generations ? jsonArg(f.generations, "generation preconditions") : {}, ...(f.scope ? { scope: f.scope } : {}) });

const commands = {
  async new(args, f) {
    for (const key of Object.keys(f)) if (!["owner", "as", "name", "server", "mode", "lifetime", "pretty"].includes(key)) fail(`new does not support --${key}`, 64);
    const server = serverBase(process.env, f);
    if (f.resident || (f.lifetime !== undefined && f.lifetime !== "ad_hoc")) fail("Create an ad_hoc page first. After the owner opens it, run meta --lifetime resident.", 64);
    const owner = String(f.owner || process.env.TENDRIL_OWNER || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner) || owner.length > 254) fail("new requires --owner <verified-email> (or TENDRIL_OWNER). Use an email verified by GitHub or Google.", 64);
    if (f.mode !== undefined && !["interactive", "dashboard"].includes(f.mode)) fail("--mode must be interactive or dashboard; both support streams, and interactive requires an agent listener", 64);
    const body = { name: args[0] || f.name || undefined, owner, lifetime: "ad_hoc" };
    if (f.mode !== undefined) body.mode = f.mode;
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
    for (const key of Object.keys(f)) if (!["name","short-name","icon","theme-color","background-color","lifetime","pretty","tendril"].includes(key)) fail(`meta does not support --${key}`,64);
    const map = { name: "name", "short-name": "short_name", icon: "icon", "theme-color": "theme_color",
      "background-color": "background_color", lifetime: "lifetime" };
    const body = {};
    for (const [k, v] of Object.entries(map)) if (f[k] !== undefined) body[v] = f[k];
    if (!Object.keys(body).length) fail("nothing to change; see tendril --help");
    out(await api.patch("", body));
  },

  async rm(args, f, api, cfg) {
    if (!f.yes) fail("this deletes the tendril and all its data; repeat with --yes");
    await api.del("");
    removeConfig(cfg);
    out({ ok: true, deleted: cfg.id });
  },

  async push(args, f, api, cfg) {
    const target = args[0];
    if (!target || !existsSync(target)) fail("usage: tendril push <dir|file>");
    const body = pack(target, { as: f.as, entry: f.entry, merge: !!f["no-replace"], message: f.message });
    const generations = generationsOf(f);
    const intent = JSON.stringify({target:resolve(target),entry:body.entry,message:body.message??null,
      merge:!!f["no-replace"],generations,scope:f.scope??null,cid:f.cid??null,
      files:body.files.map(({path,size,sha256,type})=>({path,size,sha256,type}))});
    const r = await publishFiles(api, body, { merge: !!f["no-replace"], generations, scope:f.scope,
      cid:f.cid, resumeFile:transferRecord(cfg,"push",intent,f["resume-file"]), maxBytes:5 * 1024 * 1024,
      concurrency: boundedInteger(f.concurrency, "concurrency", 3, 1, 8) });
    const result = { version: r.version, head_revision:r.head_revision, files: r.files, reused:r.reused };
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

  async publications(args, f, api) { out(await api.get("/publications")); },
  async publication(args, f, api) {
    if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) fail("usage: tendril publication <version>", 64);
    out(await api.get(`/publications/${args[0]}`));
  },
  async rollback(args, f, api, cfg) {
    if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) fail("usage: tendril rollback <version>", 64);
    const version = boundedInteger(args[0], "version", undefined, 1);
    const expectedHeadRevision = f["expected-head"] === undefined ? undefined : boundedInteger(f["expected-head"], "expected-head", undefined, 0);
    const generations = generationsOf(f);
    const intent = JSON.stringify({version,expectedHeadRevision:expectedHeadRevision??null,generations,scope:f.scope??null,cid:f.cid??null});
    out(await rollbackPublication(api, version, { expectedHeadRevision, generations, scope:f.scope, cid:f.cid,
      resumeFile:transferRecord(cfg,"rollback",intent,f["resume-file"]) }));
  },

  async blob(args, f, api, cfg) {
    const [verb, value, target] = args;
    if (verb === "list" && args.length === 1) {
      const limit = boundedInteger(f.limit, "limit", 100, 1, 1000);
      if (f.after !== undefined && !/^b_[a-z2-7]{20}$/.test(f.after)) fail("--after must be a blob ID", 64);
      return out(await api.get(`/blobs?limit=${limit}${f.after ? `&after=${encodeURIComponent(f.after)}` : ""}`));
    }
    if (verb === "info" && value && args.length === 2) return out(await blobInfo(api,value));
    if (verb === "upload" && value && args.length === 2) {
      const name = f.name || basename(value), type = f.type || guessType(value);
      const bytes = readTransferFile(value);
      const intent = JSON.stringify({local:resolve(value),name,type,cid:f.cid??null,
        sha256:createHash("sha256").update(bytes).digest("hex")});
      const record = transferRecord(cfg,"blob",intent,f["resume-file"]);
      return out(await uploadBlob(api,bytes,{type,name,
        cid:f.cid,resumeFile:record,maxBytes:MAX_TRANSFER_BYTES}));
    }
    if (verb === "download" && value && target && args.length === 3)
      return out(await downloadBlob(api,value,target,{overwrite:!!f.overwrite}));
    if (verb === "pin" && value && args.length === 2) {
      if (f.keep !== "true" && f.keep !== "false") fail("blob pin needs --keep true|false",64);
      return out(await api.put(`/blobs/${encodeURIComponent(value)}/pin`,{...commandMetadata(f),keep:f.keep === "true"}));
    }
    fail("usage: tendril blob upload|download|info|list|pin",64);
  },

  async file(args, f, api, cfg) {
    const [verb, path, local] = args;
    if (verb === "list" && args.length === 1) return out(await listSharedFiles(api));
    if (verb === "history" && path && args.length === 2) return out(await fileHistory(api,path));
    if (verb === "get" && path && local && args.length === 3)
      return out(await getSharedFile(api,path,local,{overwrite:!!f.overwrite}));
    if (verb === "put" && path && local && args.length === 3) {
      const bytes = readTransferFile(local), type = f.type || guessType(local);
      const expectedRevision = revisionOf(f), expectedGenerations = generationsOf(f);
      const intent = JSON.stringify({path,local:resolve(local),name:basename(local),type,
        sha256:createHash("sha256").update(bytes).digest("hex"),
        expectedRevision:expectedRevision??null,expectedGenerations,scope:f.scope??null,cid:f.cid??null});
      const record = transferRecord(cfg,"file",intent,f["resume-file"]);
      return out(await putSharedFile(api,path,bytes,{localName:basename(local),
        type,expectedRevision,cid:f.cid,expectedGenerations,scope:f.scope,
        resumeFile:record,maxBytes:MAX_TRANSFER_BYTES}));
    }
    if (verb === "delete" && path && args.length === 2) {
      const expectedRevision = revisionOf(f), expectedGenerations = generationsOf(f);
      const intent = JSON.stringify({path,expectedRevision:expectedRevision??null,expectedGenerations,scope:f.scope??null,cid:f.cid??null});
      return out(await deleteSharedFile(api,path,{cid:f.cid,expectedRevision,expectedGenerations,scope:f.scope,
        resumeFile:transferRecord(cfg,"file-delete",intent,f["resume-file"])}));
    }
    fail("usage: tendril file put|get|list|history|delete",64);
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

  async notifications(args, f, api) {
    if (args.length) fail("usage: tendril notifications", 64);
    out(await api.get("/notify"));
  },

  async notify(args, f, api) {
    if (!args[0]) fail("usage: tendril notify <title> [body]");
    const body = { title: args[0] };
    if (args.length > 1) body.body = args.slice(1).join(" ");
    for (const k of ["url", "device", "tag"]) if (f[k]) body[k] = f[k];
    out(await api.post("/notify", body));
  },

  async check(args, f, api) { out(await api.post("/check", f.device ? { device: f.device } : {})); },

  async pending(args, f, _api, cfg) {
    if (args.length) fail("usage: tendril pending [--limit N] [--checkpoint-file PATH]", 64);
    for (const key of Object.keys(f)) if (!["limit", "checkpoint-file", "tendril", "pretty"].includes(key)) fail(`pending does not support --${key}`, 64);
    out(await pendingEvents(cfg, checkpointPath(cfg, f), { limit: intFlag(f.limit, "limit", 100), initialCursor: 0 }));
  },

  async ack(args, f, _api, cfg) {
    if (args.length !== 1) fail("usage: tendril ack <sequence> [--checkpoint-file PATH]", 64);
    for (const key of Object.keys(f)) if (!["checkpoint-file", "tendril", "pretty"].includes(key)) fail(`ack does not support --${key}`, 64);
    out(await acknowledgeEvents(cfg, checkpointPath(cfg, f), Number(args[0]), { initialCursor: 0 }));
  },

  async events(args, f, api, cfg) {
    const cpath = cursorPath(cfg, f);
    const explicit = f.after !== undefined;
    let after = explicit ? boundedInteger(f.after, "after", 0, 0) : readCursor(cpath);
    const limit = f.limit !== undefined ? `&limit=${boundedInteger(f.limit, "limit", 100, 1, 500)}` : "";
    const wait = boundedInteger(f.wait, "wait", f.follow ? 300 : 0, 0, 300);
    const save = (c) => { if (!explicit && !f.peek) writeCursor(cpath, c); };
    if (!f.follow) {
      const r = await api.get(`/events?after=${after}&wait=${wait}${limit}`);
      save(r.cursor);
      return out(r);
    }
    const w = wait;
    for (let backoff = 1000; ;) {
      try {
        let r = await api.get(`/events?after=${after}&wait=${w}${limit}`, { signal: AbortSignal.timeout(w * 1000 + 30000) });
        if (!r.events?.length) r = await api.get(`/events?after=${after}&wait=0${limit}`);
        for (const e of r.events || []) if (!f.wakes || e.wake) out(e);
        if (typeof r.cursor === "number") { after = r.cursor; save(after); }
        backoff = 1000;
      } catch (e) {
        if (!retryable(e)) throw e;
        note(`events: ${e.message}; retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  },

  async wait(args, f, api, cfg) {
    const cpath = cursorPath(cfg, f);
    const deadline = f.timeout !== undefined ? Date.now() + boundedInteger(f.timeout, "timeout", 0, 0) * 1000 : Infinity;
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
        if (!retryable(e)) throw e;
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
      case "set": return out(await api.patch("/state", { ...commandMetadata(f), ops: [{ op: "set", path: toPath(a), value: jsonArg(b, "value") }] }));
      case "delete": return out(await api.patch("/state", { ...commandMetadata(f), ops: [{ op: "delete", path: toPath(a) }] }));
      case "patch": return out(await api.patch("/state", { ...commandMetadata(f), ops: jsonArg(a, "state operations") }));
      case "put": return out(await api.put("/state", { ...commandMetadata(f), state: jsonArg(a, "state object") }));
      default: fail("usage: tendril state get [path] | set <path> <json> | delete <path> | patch <json> | put <json>");
    }
  },

  async devices(args, f, api) {
    const [sub, id, ...name] = args;
    if (!sub) return out(await api.get("/devices"));
    if (sub === "approve") fail("Agent tokens cannot approve devices or change roles. The owner approves signed-in guests in the service utility.", 64);
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

  async timers(args, f, api, cfg) {
    const [sub = "list", id, settings] = args;
    const reading = sub === "list" || sub === "history";
    const allowed = ["pretty", "tendril", ...(reading ? [] : ["cid", "scope", "generations", "resume-file", "revision"])];
    for (const key of Object.keys(f)) if (!allowed.includes(key)) fail(`timers ${sub} does not support --${key}`, 64);
    if (reading) {
      if (args.length > 1) fail(`timers ${sub} takes no additional arguments`, 64);
      return out(await api.get(sub === "list" ? "/timers" : "/timers/history"));
    }
    if (!["add", "update", "cancel", "rm"].includes(sub)) fail("unknown timers command; see tendril --help", 64);
    if (!id || args.length !== (sub === "update" ? 3 : 2)) fail("usage: timers add <json> | update <id> <json> --revision N | cancel <id> --revision N | rm <id> --revision N", 64);
    if (sub === "add" && f.revision !== undefined) fail("timers add does not take --revision", 64);
    if (sub !== "add" && f.revision === undefined) fail("Review timers list and supply --revision N for the timer you intend to change", 64);
    const operation = sub === "add" ? "create" : sub === "rm" ? "delete" : "update";
    const timer = sub === "add" ? undefined : id;
    const body = sub === "add" ? jsonArg(id, "timer settings") : sub === "update" ? jsonArg(settings, "timer changes") : sub === "cancel" ? { state: "cancelled" } : {};
    const options = { cid: f.cid, scope: f.scope, expectedGenerations: generationsOf(f),
      expectedRevision: f.revision === undefined ? undefined : boundedInteger(f.revision, "revision", undefined, 1) };
    const intent = JSON.stringify({ operation, timer: timer ?? null, settings: body, ...options });
    return out(await changeTimer(api, operation, timer, body, { ...options, destination: cfg.api,
      resumeFile: transferRecord(cfg, "timer", intent, f["resume-file"]) }));
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
      const head = intFlag(f["expected-head"], "expected-head");
      if (!Number.isSafeInteger(head) || head < 0) fail("Review the prepared copy, then use bundle publish --expected-head <head-revision>", 64);
      return out(await api.post("/bundle/publish", { ...commandMetadata(f), expected_head_revision: head }));
    }
    if (sub === "discard") { await api.del("/bundle"); return out({ discarded: true }); }
    fail("usage: tendril bundle export [new-file.json] [--include-data] | stage <file.json> | publish --expected-head N | discard", 64);
  },

  async remix(args, f, api, cfg) {
    const owner = String(f.owner || process.env.TENDRIL_OWNER || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) fail("remix requires --owner <verified-email> (or TENDRIL_OWNER)", 64);
    const handle = await api.post("/remix", { owner, ...(f.name ? { name: f.name } : {}), include_data: f["include-data"] === true });
    const saved = saveConfig(handle, f.as || handle.id, process.env, new URL(cfg.api).origin);
    printHandle(handle, saved);
    note("The independent copy is prepared. Open its page, attach the receiver, then publish the bundle with --expected-head 0.");
  },

  async scopes(args, f, api) {
    const [operation = "list", id, body] = args;
    if (operation === "list") return out(await api.get("/scopes"));
    if (!id) fail("scopes register|rotate|remove <id> [json]");
    const path = "/scopes/" + encodeURIComponent(id), metadata = commandMetadata(f);
    if (operation === "register") return out(await api.put(path, { ...metadata, ...jsonArg(body, "scope binding") }));
    if (operation === "rotate") return out(await api.post(path + "/rotate", metadata));
    if (operation === "remove") return out(await api.del(path, { json: metadata }));
    fail("scopes list|register|rotate|remove");
  },
  async workflow(args, f, api, cfg) {
    const [module, operation, data = "{}"] = args;
    if (!module || !operation) fail("workflow <module> <operation> [json] [--scope ID --generations JSON --cid ID]");
    await checkService(cfg.api, { requirements: { contract: CONTRACT_VERSION, workflows: { [module]: { interface_version: String(f["interface-version"] || "1"), schema_version: String(f["schema-version"] || "1") } } } });
    out(await api.post(`/workflows/${encodeURIComponent(module)}/${encodeURIComponent(operation)}`, { ...commandMetadata(f), data: jsonArg(data, "workflow data") }));
  },

  async capabilities(args, f, api) { out(await api.get("/capabilities")); },

  async link(args, f, api) {
    const [sub, id] = args;
    if (!sub || sub === "list") return out(await api.get("/links"));
    if (sub === "rm") {
      if (!id) fail("usage: tendril link rm <id>", 64);
      await api.del(`/links/${encodeURIComponent(id)}`); return out({ ok: true });
    }
    if (sub === "rotate") return out(await api.post(`/links/${encodeURIComponent(id || "l_main")}/rotate`, {}));
    if (sub === "owner" || sub === "display") fail("Agents can create guest invitations only. Use the service utility to create display links; the existing main link is the owner link.", 64);
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


};

const NO_CONFIG = new Set(["new", "adopt"]);

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
    if (e.code) process.stderr.write(JSON.stringify({ error: { code: e.code, message: e.message } }) + "\n");
    else note(`tendril: ${e.message}`);
    process.exit(e.exit || 1);
  }
}

main();
