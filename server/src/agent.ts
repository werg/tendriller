// Agent API (PROTOCOL section 2.2), executed inside the Tendril Durable Object.
import type { Tendril } from "./tendril";
import { validName } from "./tendril";
import { addActivity, listActivity, preview } from "./activity";
import { getEvents } from "./events";
import {
  createVersion, latestFileMap, listVersions, pointers, rollback, servedVersion, storeContent, versionFile, versionFiles,
  fileKey, type VersionFile,
} from "./files";
import { HttpError, intParam, isPlainObject, json, readBody, readJson } from "./http";
import { BLOB_ID_RE, fromBase64, newPageKey, sha256Hex } from "./ids";
import {
  CHECK_TIMEOUT, EVAL_DEFAULT_TIMEOUT, EVAL_MAX_TIMEOUT, LONGPOLL_MAX_WAIT_S, MAX_BLOB, MAX_EVAL_CODE, MAX_FILE, MAX_STATE,
} from "./limits";
import { resolveType } from "./mime";
import { mergePatchToOps, replaceToOps, validateOps } from "./state";
import { normalizeFilePath } from "./urls";

const ROLES = new Set(["owner", "guest", "display"]);

type Handler = (t: Tendril, req: Request, url: URL, by: string, params: string[]) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: Route[] = [];
function route(method: string, pattern: RegExp, handler: Handler) {
  routes.push({ method, pattern, handler });
}

export async function handleAgent(t: Tendril, req: Request, url: URL): Promise<Response> {
  const rest = decodeURIComponent(req.headers.get("x-tendril-rest") ?? "");
  const method = req.method === "HEAD" ? "GET" : req.method;
  const matches = routes.filter((r) => r.pattern.test(rest));
  if (matches.length === 0) throw new HttpError(404, "not_found", `No API route ${rest || "/"}`);
  const r = matches.find((m) => m.method === method);
  if (!r) throw new HttpError(405, "method_not_allowed", `${req.method} not allowed on ${rest || "/"}`);
  const by = await t.authAgent(req);
  const params = r.pattern.exec(rest)!.slice(1);
  return await r.handler(t, req, url, by, params);
}

// ------------------------------------------------------------------ tendril

async function tendrilInfo(t: Tendril) {
  const ownerId = t.db.get<string | null>("owner_account", null);
  const owner = ownerId && t.env.ACCOUNTS ? await t.env.ACCOUNTS.prepare("SELECT provider, login FROM identities WHERE account_id = ? ORDER BY created_at LIMIT 1")
    .bind(ownerId).first<{ provider: string; login: string }>() : null;
  return {
    id: t.tid,
    name: t.db.get("name", "Tendril"),
    page_url: t.mainPageUrl(),
    lifetime: t.db.get("lifetime", "ad_hoc"),
    expires_at: t.expiresAt(),
    owner,
    version: pointers(t),
    devices: t.listDevices(),
    presence: t.presence(),
    wake: t.renderWake(),
    meta: tendrilMeta(t),
  };
}

export function tendrilMeta(t: Tendril) {
  return {
    created_at: t.db.get("created_at", null),
    short_name: t.db.get<string | null>("short_name", null),
    theme_color: t.db.get<string | null>("theme_color", null),
    background_color: t.db.get<string | null>("background_color", null),
    icon: t.db.get<string | null>("icon", null),
  };
}

route("GET", /^$/, async (t) => json(await tendrilInfo(t)));

route("PATCH", /^$/, async (t, req) => {
  const b = await readJson(req, 64 * 1024);
  if (b.name !== undefined) t.db.set("name", validName(b.name));
  if (b.lifetime !== undefined) {
    if (b.lifetime !== "ad_hoc" && b.lifetime !== "resident") throw new HttpError(400, "bad_request", "lifetime must be ad_hoc or resident");
    if (b.lifetime === "resident" && !t.db.get<string | null>("owner_account", null)) throw new HttpError(403, "account_required", "Open the page as its owner before making it resident");
    try {
      await t.env.ACCOUNTS.prepare("UPDATE tendrils SET lifetime = ? WHERE id = ?").bind(b.lifetime, t.tid).run();
    } catch (err) {
      if (String(err).includes("account_residents_full")) throw new HttpError(429, "quota", "Account resident tendril limit reached", { limit: 3 });
      throw err;
    }
    t.db.set("lifetime", b.lifetime);
  }
  if (b.pairing !== undefined) {
    throw new HttpError(400, "bad_request", "Device pairing is unavailable");
  }
  if (b.short_name !== undefined) t.db.set("short_name", b.short_name === null ? null : validName(b.short_name).slice(0, 30));
  for (const k of ["theme_color", "background_color"] as const) {
    if (b[k] === undefined) continue;
    if (b[k] !== null && (typeof b[k] !== "string" || !/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,30})$/.test(b[k]))) {
      throw new HttpError(400, "bad_request", `${k} must be a CSS color like #336699`);
    }
    t.db.set(k, b[k]);
  }
  if (b.icon !== undefined) {
    if (b.icon !== null) {
      const ok = typeof b.icon === "string" && ((BLOB_ID_RE.test(b.icon) && t.db.one("SELECT 1 AS x FROM blobs WHERE id = ?", b.icon)) || /^https:\/\/\S+$/.test(b.icon));
      if (!ok) throw new HttpError(400, "bad_request", "icon must be an existing blob id or an https URL");
    }
    t.db.set("icon", b.icon);
  }
  t.scheduleAlarm();
  return json(await tendrilInfo(t));
});

route("DELETE", /^$/, async (t) => {
  await t.destroy();
  return new Response(null, { status: 204 });
});

route("POST", /^release$/, async (t) => {
  const owner = t.db.get<string | null>("owner_account", null);
  if (!owner) throw new HttpError(409, "unclaimed", "This tendril is not claimed");
  t.db.run("DELETE FROM release_events WHERE at < ?", t.now() - 24 * 60 * 60_000);
  const releases = t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM release_events")?.n ?? 0;
  if (releases >= 2) {
    await t.hold("Three claim release attempts within 24 hours");
    throw new HttpError(403, "held", "Repeated releases held this tendril for review");
  }
  if (t.db.one("SELECT 1 AS x FROM guest_accounts WHERE approved = 1")) {
    throw new HttpError(403, "forbidden", "A tendril with an approved guest cannot be released");
  }
  if (t.storageUsed() > 2 * 1024 * 1024) throw new HttpError(413, "quota", "Reduce storage below the unclaimed limit before release", { limit: 2 * 1024 * 1024, used: t.storageUsed() });
  if (!t.env.ACCOUNTS || !t.env.ADMISSION) throw new HttpError(503, "unavailable");
  const admission = t.env.ADMISSION.get(t.env.ADMISSION.idFromName("global"));
  const reopened = await admission.fetch(new Request("https://admission.internal/reopen", { method: "POST", headers: { "x-tendril-id": t.tid } }));
  if (!reopened.ok) {
    await reopened.body?.cancel();
    const reserved = await admission.fetch(new Request("https://admission.internal/reserve", { method: "POST", headers: { "x-tendril-id": t.tid } }));
    if (!reserved.ok) return reserved;
  }
  try {
    const row = await t.env.ACCOUNTS.prepare("UPDATE tendrils SET owner_account = NULL, claimed_at = NULL WHERE id = ? AND owner_account = ? RETURNING id")
      .bind(t.tid, owner).first();
    if (!row) throw new HttpError(409, "owner_changed", "Owner changed during release");
  } catch (err) {
    await admission.fetch(new Request("https://admission.internal/release", { method: "POST", headers: { "x-tendril-id": t.tid } }));
    throw err;
  }
  t.db.del("owner_account");
  t.db.del("claimed_at");
  t.db.del("owner_label");
  t.db.set("unclaimed_since", t.now());
  t.db.run("INSERT INTO release_events (at) VALUES (?)", t.now());
  t.db.run("DELETE FROM page_sessions");
  for (const { ws } of t.connectedSockets()) ws.close(4003, "claim released");
  t.scheduleAlarm();
  return json({ released: true, expires_at: t.expiresAt() });
});

// ------------------------------------------------------------------ files and versions

route("PUT", /^files\/(.+)$/, async (t, req, url, by, [raw]) => {
  const path = normalizeFilePath(raw);
  if (!path) throw new HttpError(400, "bad_path", "Invalid file path (no '..', no leading '_tendril/', no trailing '/')");
  const body = await readBody(req, t.fileLimit());
  const type = resolveType(path, req.headers.get("Content-Type"));
  const { hash, size } = await storeContent(t, body, type);
  const files = latestFileMap(t);
  files.set(path, { path, hash, type, size });
  const version = await createVersion(t, files, url.searchParams.get("message"), by);
  return json({ version, files: [...files.keys()].sort() });
});

route("POST", /^files$/, async (t, req, url, by) => {
  const b = await readJson(req, t.fileLimit() * 4);
  if (b.files !== undefined && !isPlainObject(b.files)) throw new HttpError(400, "bad_request", "files must be an object of path → content");
  const files = b.replace ? new Map<string, VersionFile>() : latestFileMap(t);
  if (b.delete !== undefined) {
    if (!Array.isArray(b.delete)) throw new HttpError(400, "bad_request", "delete must be an array of paths");
    for (const p of b.delete) files.delete(normalizeFilePath(String(p)) ?? "");
  }
  for (const [raw, v] of Object.entries((b.files ?? {}) as Record<string, unknown>)) {
    const path = normalizeFilePath(raw);
    if (!path) throw new HttpError(400, "bad_path", `Invalid file path: ${raw}`);
    let bytes: Uint8Array;
    let given: string | null = null;
    if (typeof v === "string") bytes = new TextEncoder().encode(v);
    else if (isPlainObject(v) && typeof v.base64 === "string") {
      try {
        bytes = fromBase64(v.base64);
      } catch {
        throw new HttpError(400, "bad_request", `Invalid base64 for ${raw}`);
      }
      given = typeof v.type === "string" ? v.type : null;
    } else throw new HttpError(400, "bad_request", `File ${raw} must be a string or {"base64","type"?}`);
    if (bytes.byteLength > t.fileLimit()) throw new HttpError(413, "too_large", `File ${raw} exceeds ${t.fileLimit()} bytes`);
    const type = resolveType(path, given);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const { hash, size } = await storeContent(t, buf, type);
    files.set(path, { path, hash, type, size });
  }
  const version = await createVersion(t, files, typeof b.message === "string" ? b.message.slice(0, 500) : null, by);
  return json({ version, files: [...files.keys()].sort() });
});

function requestedVersion(t: Tendril, url: URL): number {
  const q = url.searchParams.get("version");
  if (q === null || q === "") return t.db.get<number>("current", 0);
  const n = Number(q);
  if (!Number.isInteger(n) || !t.db.one("SELECT 1 AS x FROM versions WHERE version = ?", n)) throw new HttpError(404, "not_found", `No version ${q}`);
  return n;
}

route("GET", /^files$/, (t, req, url) => {
  const v = requestedVersion(t, url);
  return json({ version: v > 0 ? v : null, files: v > 0 ? versionFiles(t, v) : [] });
});

route("GET", /^files\/(.+)$/, async (t, req, url, by, [raw]) => {
  const v = requestedVersion(t, url);
  const path = normalizeFilePath(raw);
  const f = v > 0 && path ? versionFile(t, v, path) : null;
  if (!f) throw new HttpError(404, "not_found", `No file ${raw} in version ${v || "(none)"}`);
  const obj = await t.env.FILES.get(fileKey(t, f.hash));
  if (!obj) throw new HttpError(500, "internal", "File content missing");
  return new Response(obj.body, { headers: { "Content-Type": f.type, "X-Tendril-Version": String(v) } });
});

route("GET", /^versions$/, (t) => json({ versions: listVersions(t), ...pointers(t), served: servedVersion(t) || null }));

route("POST", /^rollback$/, async (t, req, url, by) => {
  const b = await readJson(req, 4096);
  const v = rollback(t, b.version, by, null);
  return json({ version: v });
});

// ------------------------------------------------------------------ events

route("GET", /^events$/, (t, req, url) => {
  const after = intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER);
  const wait = intParam(url, "wait", 0, 0, LONGPOLL_MAX_WAIT_S);
  const limit = intParam(url, "limit", 100, 1, 500);
  return getEvents(t, url, req.signal, after, wait, limit);
});

// ------------------------------------------------------------------ calling into the page

route("POST", /^eval$/, async (t, req, url, by) => {
  const b = await readJson(req, MAX_EVAL_CODE + 4096);
  if (typeof b.code !== "string" || !b.code) throw new HttpError(400, "bad_request", "code must be a non-empty string");
  if (new TextEncoder().encode(b.code).byteLength > MAX_EVAL_CODE) throw new HttpError(413, "too_large", "code exceeds 256 KB");
  const target = typeof b.device === "string" && b.device ? b.device : "primary";
  const timeout = Math.min(EVAL_MAX_TIMEOUT, Math.max(100, Number(b.timeout_ms) || EVAL_DEFAULT_TIMEOUT));
  const targets = t.targets(target);
  addActivity(t, { kind: "eval", summary: `Agent ran code on ${target === "all" ? `${targets.length} device(s)` : "a device"}: ${preview(b.code)}`, by, device: target === "all" ? null : targets[0][0] });
  const results = await Promise.all(
    targets.map(async ([device, ws]) => ({ device, ...(await t.callDevice(device, ws, (call_id) => ({ t: "eval", call_id, code: b.code }), timeout)) })),
  );
  const clean = results.map(({ timeout: _t, ...r }) => r);
  if (target !== "all") {
    if (results[0].timeout) throw new HttpError(504, "timeout", `No result within ${timeout} ms`);
    return json(clean[0]);
  }
  return json({ ...clean[0], results: clean });
});

route("POST", /^say$/, async (t, req, url, by) => {
  const b = await readJson(req, 64 * 1024);
  if (typeof b.text !== "string" || !b.text) throw new HttpError(400, "bad_request", "text must be a non-empty string");
  t.say(b.text.slice(0, 4000), b.speak !== false, by);
  return json({ ok: true });
});

route("POST", /^status$/, async (t, req) => {
  const b = await readJson(req, 16 * 1024);
  const state = b.state ?? "working";
  if (!["working", "idle", "done"].includes(state)) throw new HttpError(400, "bad_request", "state must be working, idle or done");
  t.db.set("status_override", { state, text: typeof b.text === "string" ? b.text.slice(0, 200) : null, at: t.now() });
  const presence = t.refreshPresence();
  t.scheduleAlarm();
  return json({ presence });
});

route("POST", /^check$/, async (t, req, url, by) => {
  const b = await readJson(req, 4096);
  const target = typeof b.device === "string" && b.device && b.device !== "all" ? b.device : "primary";
  const [[device, ws]] = t.targets(target);
  addActivity(t, { kind: "check", summary: "Agent ran an accessibility check", by, device });
  const r = await t.callDevice(device, ws, (call_id) => ({ t: "check", call_id }), CHECK_TIMEOUT);
  if (r.timeout) throw new HttpError(504, "timeout", "The accessibility check did not finish in time");
  if (!r.ok) return json({ ok: false, device, error: r.error ?? "check failed", violations: [] });
  const raw = Array.isArray(r.value) ? r.value : isPlainObject(r.value) && Array.isArray(r.value.violations) ? r.value.violations : [];
  const violations = raw.filter(isPlainObject).map((v: any) => ({
    id: String(v.id ?? ""),
    impact: v.impact ?? null,
    help: String(v.help ?? ""),
    nodes: Array.isArray(v.nodes) ? v.nodes.length : Number(v.nodes) || 0,
  }));
  return json({ ok: true, device, violations });
});

// ------------------------------------------------------------------ state

route("GET", /^state$/, (t) => json(t.getState()));

route("PUT", /^state$/, async (t, req, url, by) => {
  const b = await readJson(req, MAX_STATE + 1024);
  if (!isPlainObject(b)) throw new HttpError(400, "bad_request", "State must be a JSON object");
  const rev = t.applyState(replaceToOps(t.getState().state, b), `agent:${by}`);
  return json({ rev });
});

route("PATCH", /^state$/, async (t, req, url, by) => {
  const b = await readJson(req, MAX_STATE + 1024);
  if (!isPlainObject(b)) throw new HttpError(400, "bad_request", "Body must be a JSON merge patch object or {\"ops\":[…]}");
  const ops = Array.isArray(b.ops) && Object.keys(b).length === 1 ? validateOps(b.ops) : mergePatchToOps(t.getState().state, b);
  const rev = t.applyState(ops, `agent:${by}`);
  return json({ rev });
});

// ------------------------------------------------------------------ logs, blobs

route("GET", /^logs$/, (t, req, url) => {
  const after = intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(url, "limit", 200, 1, 2000);
  const logs = t.db.all("SELECT * FROM logs WHERE seq > ? ORDER BY seq ASC LIMIT ?", after, limit).map((r) => {
    const l: Record<string, unknown> = { seq: r.seq, ts: r.ts, device: r.device, version: r.version, level: r.level, message: r.message };
    if (r.stack) l.stack = r.stack;
    return l;
  });
  return json({ logs, cursor: logs.length ? logs[logs.length - 1].seq : after });
});

route("PUT", /^blobs$/, async (t, req) => {
  const body = await readBody(req, t.blobLimit());
  const name = req.headers.get("X-Tendril-Name");
  const type = req.headers.get("Content-Type") || "application/octet-stream";
  return json(await t.storeBlob(body, type, name ? name.slice(0, 200) : null, null, "agent"));
});

route("GET", /^blobs$/, (t) =>
  json({ blobs: t.db.all("SELECT id, type, size, name, ts, device FROM blobs ORDER BY ts DESC") }),
);

route("GET", /^blobs\/(b_[a-z2-7]{20})$/, (t, req, url, by, [id]) => t.getBlob(id));

// ------------------------------------------------------------------ devices and links

route("GET", /^devices$/, (t) => json({ devices: t.listDevices() }));

route("PATCH", /^devices\/([^/]+)$/, async (t, req, url, by, [id]) => {
  const b = await readJson(req, 4096);
  const d = t.device(id);
  if (!d) throw new HttpError(404, "not_found", "No such device");
  if (b.name !== undefined) t.db.run("UPDATE devices SET name = ? WHERE id = ?", b.name === null ? null : validName(b.name), id);
  if (b.role !== undefined) {
    throw new HttpError(403, "forbidden", "Agent tokens cannot change device roles");
  }
  return json(t.listDevices().find((x) => x.id === id));
});

route("DELETE", /^devices\/([^/]+)$/, (t, req, url, by, [id]) => {
  if (!t.device(id)) throw new HttpError(404, "not_found", "No such device");
  t.forgetDevice(id);
  return new Response(null, { status: 204 });
});

route("POST", /^links$/, async (t, req) => {
  const b = await readJson(req, 4096);
  if (!ROLES.has(b.role)) throw new HttpError(400, "bad_request", "role must be owner, guest or display");
  if (b.role !== "guest") throw new HttpError(403, "forbidden", "Agents can only create guest invites");
  const expiresIn = b.expires_in === undefined || b.expires_in === null ? null : Number(b.expires_in);
  if (expiresIn !== null && !(expiresIn > 0)) throw new HttpError(400, "bad_request", "expires_in must be a positive number of seconds");
  const label = typeof b.label === "string" ? b.label.slice(0, 100) : null;
  return json(t.renderLink(await t.createLink(b.role, label, expiresIn, true)), 201);
});

route("GET", /^links$/, (t) => json({ links: t.listLinks().filter((l) => l.role !== "display") }));

route("DELETE", /^links\/([^/]+)$/, (t, req, url, by, [id]) => {
  if (id === "l_main") throw new HttpError(400, "cannot_delete", "The main link cannot be deleted; rotate it instead");
  const link = t.db.one<{ role: string }>("SELECT role FROM links WHERE id = ?", id);
  if (!link) throw new HttpError(404, "not_found", "No such link");
  if (link.role === "display") throw new HttpError(403, "forbidden", "Only the owner can manage display links");
  t.db.run("DELETE FROM links WHERE id = ?", id);
  t.db.run("DELETE FROM guest_accounts WHERE link_id = ?", id);
  t.closeLinkSockets(id);
  return new Response(null, { status: 204 });
});

route("POST", /^links\/([^/]+)\/rotate$/, async (t, req, url, by, [id]) => {
  const l = t.db.one<{ id: string; role: string }>("SELECT id, role FROM links WHERE id = ?", id);
  if (!l) throw new HttpError(404, "not_found", "No such link");
  if (l.role === "display") throw new HttpError(403, "forbidden", "Only the owner can manage display links");
  const key = newPageKey();
  t.db.run("UPDATE links SET key = ?, key_hash = ? WHERE id = ?", key, await sha256Hex(key), id);
  t.closeLinkSockets(id);
  addActivity(t, { kind: "link", summary: `Link ${id} rotated; the old URL no longer works`, by });
  const row = t.listLinks().find((x) => x.id === id)!;
  return json(row);
});

// ------------------------------------------------------------------ wake, activity, tokens, rules, notify

route("GET", /^wake$/, (t) => json(t.renderWake()));

route("PUT", /^wake$/, async (t, req) => {
  const b = await readJson(req, 16 * 1024);
  const w = t.wakeConfig();
  if (b.webhook !== undefined) {
    if (b.webhook === null) w.webhook = null;
    else {
      if (!isPlainObject(b.webhook) || typeof b.webhook.url !== "string" || !/^https?:\/\/\S+$/.test(b.webhook.url)) {
        throw new HttpError(400, "bad_request", "webhook must be {url, token?} with an http(s) URL, or null");
      }
      w.webhook = { url: b.webhook.url, token: typeof b.webhook.token === "string" && b.webhook.token ? b.webhook.token : null };
    }
  }
  if (b.schedule_minutes !== undefined) {
    if (b.schedule_minutes === null) w.schedule_minutes = null;
    else {
      const n = Number(b.schedule_minutes);
      if (!(n > 0 && n <= 7 * 24 * 60)) throw new HttpError(400, "bad_request", "schedule_minutes must be between 1 and 10080, or null");
      w.schedule_minutes = n;
    }
  }
  if (b.budget !== undefined) {
    if (!isPlainObject(b.budget)) throw new HttpError(400, "bad_request", "budget must be an object");
    if (b.budget.page_streak !== undefined) {
      const n = Number(b.budget.page_streak);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw new HttpError(400, "bad_request", "page_streak must be an integer 0..1000");
      w.budget.page_streak = n;
    }
  }
  if (b.grace_seconds !== undefined) {
    const n = Number(b.grace_seconds);
    if (!(n >= 10 && n <= 86400)) throw new HttpError(400, "bad_request", "grace_seconds must be between 10 and 86400");
    w.grace_seconds = n;
  }
  t.db.set("wake", w);
  t.refreshPresence();
  t.scheduleAlarm();
  return json(t.renderWake());
});

route("GET", /^activity$/, (t, req, url) => {
  const a = url.searchParams.get("after");
  const limit = intParam(url, "limit", 100, 1, 1000);
  return json(listActivity(t, a === null || a === "" ? 0 : intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER), limit));
});

route("POST", /^activity$/, async (t, req, url, by) => {
  const b = await readJson(req, 16 * 1024);
  if (typeof b.text !== "string" || !b.text.trim()) throw new HttpError(400, "bad_request", "text must be a non-empty string");
  const seq = addActivity(t, { kind: "note", summary: b.text.trim(), by, source: "agent" });
  return json({ seq }, 201);
});

route("POST", /^tokens$/, async (t, req) => {
  const b = await readJson(req, 4096);
  if (typeof b.name !== "string" || !/^[A-Za-z0-9_.@-]{1,64}$/.test(b.name)) throw new HttpError(400, "bad_request", "name must be 1-64 characters of [A-Za-z0-9_.@-]");
  if (t.db.one("SELECT 1 AS x FROM tokens WHERE name = ?", b.name)) throw new HttpError(409, "exists", `A token named ${b.name} exists`);
  const token = await t.addToken(b.name);
  return json({ name: b.name, token }, 201);
});

route("GET", /^tokens$/, (t) => json({ tokens: t.db.all("SELECT name, created_at, last_used FROM tokens ORDER BY created_at ASC") }));

route("DELETE", /^tokens\/([^/]+)$/, (t, req, url, by, [name]) => {
  if (!t.db.one("SELECT 1 AS x FROM tokens WHERE name = ?", name)) throw new HttpError(404, "not_found", "No such token");
  t.db.run("DELETE FROM tokens WHERE name = ?", name);
  t.refreshPresence();
  return new Response(null, { status: 204 });
});

route("GET", /^rules$/, (t) => json({ rules: t.db.get("rules", []) }));

route("PUT", /^rules$/, async (t, req) => {
  const b = await readJson(req, 256 * 1024);
  if (!Array.isArray(b.rules) || !b.rules.every((r: unknown) => isPlainObject(r) && typeof r.id === "string" && r.id)) {
    throw new HttpError(400, "bad_request", "rules must be an array of objects with a string id");
  }
  t.db.set("rules", b.rules);
  t.broadcast({ t: "rules", rules: b.rules });
  return json({ rules: b.rules });
});

route("POST", /^notify$/, async (t, req, url, by) => {
  const b = await readJson(req, 16 * 1024);
  if (typeof b.title !== "string" || !b.title) throw new HttpError(400, "bad_request", "title must be a non-empty string");
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  return json(await t.notify({ title: b.title.slice(0, 200), body: s(b.body)?.slice(0, 1000), url: s(b.url), device: s(b.device), tag: s(b.tag) }, by));
});

