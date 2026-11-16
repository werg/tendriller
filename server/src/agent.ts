// Agent API (PROTOCOL section 2.2), executed inside the Tendril Durable Object.
import { assertValid } from "../../contract/index.mjs";
import type { Tendril } from "./tendril";
import { validName } from "./tendril";
import { addActivity, listActivity, preview } from "./activity";
import { addEvent, getEvents, markWakeDelivered } from "./events";
import { validSecret } from "./mcpEvents";
import {
  createVersion, latestFileMap, listVersions, pointers, rollback, servedVersion, storeContent, versionFile, versionFiles,
  fileKey, type VersionFile,
} from "./files";
import { HttpError, intParam, isPlainObject, json, readBody, readJson } from "./http";
import { BLOB_ID_RE, fromBase64, newPageKey, newSocketTicket, randomB32, safeEqual, sha256Hex, SOCKET_TICKET_RE } from "./ids";
import {
  CHECK_TIMEOUT, EVAL_DEFAULT_TIMEOUT, EVAL_MAX_TIMEOUT, HOUR, LONGPOLL_MAX_WAIT_S, MAX_BLOB, MAX_EVAL_CODE, MAX_FILE, MAX_STATE,
} from "./limits";
import { resolveType } from "./mime";
import { validateOps } from "./state";
import { mutate, preconditions } from "./scopes";
import { handleScopes, handleWorkflows } from "./workflows";
import { serviceDescriptor } from "./descriptor";
import { blobInfo, setBlobRetention } from "./blob-retention";
import { apiUrl, normalizeFilePath } from "./urls";
import { EXPERIENCE_ROUTE, handleExperience } from "./experience-routes";
import { deviceConfiguration, updateDevice } from "./device-roles";
import { CONSUMER_ROUTE, handleConsumers } from "./consumers";
import { STREAM_ROUTE, handleProducer, handleStreams } from "./streams";
import { authenticateAgent, authenticateAgentToken, requireAccess } from "./access";
import { pushAvailable, validatePushSubscription } from "./push";

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
  // Publishing machine data does not authenticate/check in a conversation.
  // Scope producers before routing any ordinary agent API.
  if (/^Bearer\s+tp_/i.test(req.headers.get("Authorization") ?? "")) return handleProducer(t, req, rest);
  if (STREAM_ROUTE.test(rest) || CONSUMER_ROUTE.test(rest) || EXPERIENCE_ROUTE.test(rest) || /^(?:scopes|workflows)(?:\/|$)/.test(rest)) {
    const principal = await authenticateAgent(t, req);
    requireAccess(principal, "agent.manage");
    t.checkin(principal.name);
    if (/^scopes(?:\/|$)/.test(rest)) return handleScopes(t, req, rest, principal);
    if (/^workflows(?:\/|$)/.test(rest)) return handleWorkflows(t, req, rest, principal);
    if (STREAM_ROUTE.test(rest)) return handleStreams(t, req, url, rest, principal);
    if (CONSUMER_ROUTE.test(rest)) return handleConsumers(t, req, url, rest);
    return handleExperience(t, req, url, principal.name, rest);
  }
  const matches = routes.filter((r) => r.pattern.test(rest));
  if (matches.length === 0) throw new HttpError(404, "not_found", `No API route ${rest || "/"}`);
  const r = matches.find((m) => m.method === method);
  if (!r) throw new HttpError(405, "method_not_allowed", `${req.method} not allowed on ${rest || "/"}`);
  // The wake socket authenticates itself: it accepts the page token or a listen-only ticket.
  if (rest === "events/socket" && method === "GET") return await agentSocket(t, req, url);
  const principal = await authenticateAgent(t, req);
  requireAccess(principal, "agent.manage");
  t.checkin(principal.name);
  const params = r.pattern.exec(rest)!.slice(1);
  return await r.handler(t, req, url, principal.name, params);
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
    mode: t.db.get("mode", "interactive"),
    expires_at: t.expiresAt(),
    owner,
    version: pointers(t),
    devices: t.listDevices(),
    presence: t.presence(),
    wake: t.renderWake(),
    agent_delivery: deliveryFeedback(t),
    meta: tendrilMeta(t),
  };
}

function deliveryFeedback(t: Tendril) {
  const facts = t.presenceFacts();
  const mode = facts.agentSocket ? "live_socket" : facts.longPollHeld ? "live_poll" : facts.webhook ? "wake_configured" : "none";
  return {
    mode,
    live_listener: facts.agentSocket || facts.longPollHeld,
    reminder: mode === "none"
      ? "No event listener or wake endpoint is active. Attach a receiver that resumes this same agent conversation, then run two POST A/wake/probe diagnostics in this conversation before promising live replies."
      : mode === "live_socket"
        ? "Keep the agent socket connected and the host adapter running. Read events on each wake, reply in this conversation, and acknowledge after handling."
        : "Keep polling after every response, or ensure the configured wake handler stays available. A single poll does not keep an agent listening.",
  };
}

function requireFirstPageReceiver(t: Tendril): void {
  if (t.db.get<string>("mode", "interactive") === "dashboard") return;
  if (latestFileMap(t).has("index.html")) return;
  const facts = t.presenceFacts();
  if (facts.agentSocket || facts.longPollHeld || facts.webhook) return;
  throw new HttpError(428, "listener_required",
    "Attach this conversation with a verified host wake path: a persistent agent WebSocket at A/events/socket, continuous GET A/events?after=<cursor>&wait=300 plus same-session delivery, or PUT A/wake with a persistent receiver. A one-off poll or agent token is not a listener; run two POST A/wake/probe diagnostics before promising live replies.");
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
route("GET", /^service$/, t => json(serviceDescriptor(t)));

/** Lifetime of a listen-only socket ticket. It only has to survive until the socket opens. */
export const SOCKET_TICKET_TTL_MS = 10 * 60_000;

// Registered for method matching; handleAgent dispatches it to agentSocket before token auth.
route("GET", /^events\/socket$/, () => {
  throw new HttpError(500, "internal", "agent socket dispatch");
});

/**
 * Exchanges the page token for a single-use, listen-only ticket that opens the wake socket.
 * Hosts whose socket configuration is visible in a transcript (for example a tool call that
 * names the subprotocols) pass the ticket instead of the page token. The ticket cannot read
 * events or call any other route; the socket it opens closes when the page token is revoked.
 */
route("POST", /^events\/socket\/ticket$/, async (t, req, url) => {
  const after = url.searchParams.has("after") ? intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER) : null;
  const tokenHash = await sha256Hex(/^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "")![1]);
  const now = t.now();
  t.db.run("DELETE FROM socket_tickets WHERE expires_at <= ?", now);
  const live = t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM socket_tickets")?.n ?? 0;
  if (live >= 20) throw new HttpError(429, "rate_limited", "Too many unused socket tickets; open a socket or wait for them to expire");
  const ticket = newSocketTicket();
  const expiresAt = now + SOCKET_TICKET_TTL_MS;
  t.db.run("INSERT INTO socket_tickets (hash, token_hash, expires_at) VALUES (?, ?, ?)", await sha256Hex(ticket), tokenHash, expiresAt);
  const socketUrl = `${apiUrl(t.env, t.tid).replace(/^http/, "ws")}/events/socket`;
  return json({
    ticket,
    expires_at: expiresAt,
    socket_url: after !== null ? `${socketUrl}?after=${after}` : socketUrl,
    protocols: ["tendriller.agent.v2", ticket],
  }, 201);
});

/** Resolves the socket credential to the page token's hash: a listen-only ticket or the token itself. */
async function socketTokenHash(t: Tendril, req: Request): Promise<string> {
  const ticket = req.headers.get("x-tendril-socket-ticket");
  if (ticket !== null) {
    if (!SOCKET_TICKET_RE.test(ticket)) throw new HttpError(401, "unauthorized", "Invalid socket ticket");
    const hash = await sha256Hex(ticket);
    const row = t.db.one<{ hash: string; token_hash: string; expires_at: number }>(
      "SELECT hash, token_hash, expires_at FROM socket_tickets WHERE hash = ?", hash);
    // Single use: a ticket is spent whether or not the socket stays open.
    if (row) t.db.run("DELETE FROM socket_tickets WHERE hash = ?", hash);
    if (!row || !safeEqual(row.hash, hash) || row.expires_at <= t.now()) throw new HttpError(401, "unauthorized", "Invalid, used or expired socket ticket");
    const token = t.db.one<{ name: string }>("SELECT name FROM tokens WHERE hash = ?", row.token_hash);
    if (!token) throw new HttpError(401, "unauthorized", "The token behind this ticket was revoked");
    t.checkin(token.name);
    return row.token_hash;
  }
  const token = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) throw new HttpError(401, "unauthorized");
  const principal = await authenticateAgentToken(t, token);
  t.checkin(principal.name);
  return principal.credentialHash;
}

async function agentSocket(t: Tendril, req: Request, url: URL): Promise<Response> {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required");
  if (!(req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim()).includes("tendriller.agent.v2"))
    throw new HttpError(400, "bad_request", "Unsupported agent socket protocol");
  const tokenHash = await socketTokenHash(t, req);
  const after = url.searchParams.has("after") ? intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER) : null;
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  t.ctx.acceptWebSocket(server, ["agent"]);
  server.serializeAttachment({ kind: "agent", tokenHash, connectedAt: t.now() });
  addActivity(t, { kind: "agent_socket", summary: "Agent receiver socket connected" });
  // Catch-up: a receiver that re-arms with its cursor learns at once about anything it missed
  // while it was disconnected, instead of waiting for the next event.
  if (after !== null) {
    const pending = t.db.one<{ m: number | null }>("SELECT MAX(seq) AS m FROM events WHERE wake = 1 AND seq > ?", after)?.m ?? null;
    if (pending !== null) { t.send(server, { t: "wake", seq: pending }); markWakeDelivered(t); }
  }
  t.refreshPresence();
  t.scheduleAlarm();
  return new Response(null, { status: 101, webSocket: client,
    headers: { "Sec-WebSocket-Protocol": "tendriller.agent.v2" } });
}

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
  // A later owner must never inherit the previous owner's push endpoints.
  // These are independent of active page sockets and otherwise survive release.
  t.db.run("DELETE FROM push_subs");
  for (const { ws } of t.connectedSockets()) ws.close(4003, "claim released");
  t.scheduleAlarm();
  return json({ released: true, expires_at: t.expiresAt() });
});

// ------------------------------------------------------------------ files and versions

route("PUT", /^files\/(.+)$/, async (t, req, url, by, [raw]) => {
  const path = normalizeFilePath(raw);
  if (!path) throw new HttpError(400, "bad_path", "Invalid file path (no '..', no leading '_tendril/', no trailing '/')");
  if (path === "index.html") requireFirstPageReceiver(t);
  const body = await readBody(req, t.fileLimit());
  const type = resolveType(path, req.headers.get("Content-Type"));
  const { hash, size } = await storeContent(t, body, type);
  const files = latestFileMap(t);
  files.set(path, { path, hash, type, size });
  const version = await createVersion(t, files, url.searchParams.get("message"), by);
  return json({ version, files: [...files.keys()].sort(), agent_delivery: deliveryFeedback(t) });
});

route("POST", /^files$/, async (t, req, url, by) => {
  const b = await readJson(req, t.fileLimit() * 4);
  if (b.files !== undefined && !isPlainObject(b.files)) throw new HttpError(400, "bad_request", "files must be an object of path → content");
  if (isPlainObject(b.files) && Object.hasOwn(b.files, "index.html")) requireFirstPageReceiver(t);
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
  return json({ version, files: [...files.keys()].sort(), agent_delivery: deliveryFeedback(t) });
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
  if (Number(url.searchParams.get("wait")) > LONGPOLL_MAX_WAIT_S) {
    throw new HttpError(400, "bad_request", `wait may be at most ${LONGPOLL_MAX_WAIT_S} seconds`);
  }
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
  const b = assertValid("say", await readJson(req, 64 * 1024));
  if (typeof b.text !== "string" || !b.text) throw new HttpError(400, "bad_request", "text must be a non-empty string");
  const replyTo = b.in_reply_to === undefined ? null : Number(b.in_reply_to);
  if (replyTo !== null && (!Number.isInteger(replyTo) || replyTo < 1 || !t.db.one("SELECT 1 AS x FROM events WHERE seq = ?", replyTo)))
    throw new HttpError(400, "bad_request", "in_reply_to must identify an existing event sequence");
  for (const field of ["device", "speak_on"] as const) if (b[field] !== undefined && typeof b[field] !== "string")
    throw new HttpError(400, "bad_request", `${field} must be a device id`);
  const messageId = t.say(b.text.slice(0, 4000), b.speak !== false, by, replyTo, { device: b.device, speak_on: b.speak_on });
  return json({ ok: true, message_id: messageId, in_reply_to: replyTo });
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

for (const method of ["PUT", "PATCH"]) route(method, /^state$/, async (t, req, url, by) => {
  const body = assertValid("stateUpdate", await readJson(req, MAX_STATE + 16384));
  const ops = validateOps("state" in body ? [{ op: "set", path: [], value: body.state }] : body.ops);
  const command = preconditions(body);
  return json(mutate(t, `agent:${by}`, command, { paths: ops.map(op => op.path), operations: ["state"] }, ops,
    () => ({ rev: t.applyState(ops, `agent:${by}`, undefined, command), scopes: t.getState().scopes })));
});
route("POST", /^events$/, async (t, req, url, by) => {
  const body = await readJson(req, 65536 + 16384);
  if (new TextEncoder().encode(JSON.stringify(body.data ?? null)).byteLength > 65536) throw new HttpError(413, "too_large", "Event data exceeds 64 KB");
  return json(mutate(t, `agent:${by}`, body, { operations: ["event"] }, body.data, context => {
    const event = addEvent(t, { type: "event", data: body.data, context, by: `agent:${by}`, role: null, wake: false });
    return { seq: event.seq };
  }));
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

// One ordered view of the page → agent → page path. Each entry retains its source
// cursor so the developer can fetch the full event, activity, or log when needed.
route("GET", /^journey$/, (t, req, url) => {
  const since = intParam(url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(url, "limit", 100, 1, 300);
  const events = t.db.all<{ seq: number; ts: number; type: string; device: string | null; role: string | null; wake: number; withheld: number }>(
    "SELECT seq,ts,type,device,role,wake,withheld FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?", since, limit)
    .map((e) => ({ source: "event", ...e }));
  const activity = t.db.all<{ seq: number; ts: number; kind: string; summary: string; device: string | null }>(
    "SELECT seq,ts,kind,summary,device FROM activity WHERE ts >= ? ORDER BY ts DESC LIMIT ?", since, limit)
    .map((a) => ({ source: "activity", ...a }));
  const logs = t.db.all<{ seq: number; ts: number; level: string; message: string; device: string | null }>(
    "SELECT seq,ts,level,message,device FROM logs WHERE ts >= ? ORDER BY ts DESC LIMIT ?", since, limit)
    .map((l) => ({ source: "log", ...l }));
  const entries = [...events, ...activity, ...logs].sort((a, b) => a.ts - b.ts || a.seq - b.seq).slice(-limit);
  return json({ entries, presence: t.presence(), agent_cursor: t.db.get<number>("agent_cursor", 0) });
});

route("PUT", /^blobs$/, async (t, req) => {
  const body = await readBody(req, t.blobLimit());
  const name = req.headers.get("X-Tendril-Name");
  const type = req.headers.get("Content-Type") || "application/octet-stream";
  return json(await t.storeBlob(body, type, name ? name.slice(0, 200) : null, null, "agent"));
});

route("GET", /^blobs$/, (t) =>
  json({ blobs: t.db.all<{ id: string }>("SELECT id FROM blobs ORDER BY ts DESC").map((row) => blobInfo(t, row.id)) }),
);

route("GET", /^blobs\/(b_[a-z2-7]{20})$/, (t, req, url, by, [id]) => t.getBlob(id));
route("GET", /^blobs\/(b_[a-z2-7]{20})\/info$/, (t, req, url, by, [id]) => json(blobInfo(t, id)));
route("PATCH", /^blobs\/(b_[a-z2-7]{20})$/, async (t, req, url, by, [id]) =>
  json(setBlobRetention(t, id, await readJson(req, 4096), by)));

// ------------------------------------------------------------------ devices and links

route("GET", /^devices$/, (t) => json(deviceConfiguration(t)));

// A fresh browser-side report for connected devices, with the last handshake probe
// as a useful (but explicitly stale) fallback for disconnected devices.
route("GET", /^capabilities$/, async (t) => {
  const sockets = t.deviceSockets();
  const devices = await Promise.all(t.db.all<import("./tendril").DeviceRow>("SELECT * FROM devices ORDER BY created_at ASC").map(async (d) => {
    const socket = sockets.get(d.id);
    let last_handshake: unknown = null;
    try { last_handshake = d.caps ? JSON.parse(d.caps) : null; } catch { /* malformed old probe */ }
    if (!socket) return { id: d.id, name: d.name, connected: false, source: "handshake", captured_at: d.last_seen, report: last_handshake };
    const live = await t.callDevice(d.id, socket, (call_id) => ({ t: "eval", call_id, code: "return await tendril.capabilities()" }), 5000);
    return { id: d.id, name: d.name, connected: true, source: live.ok ? "live" : "handshake",
      captured_at: live.ok ? t.now() : d.last_seen, report: live.ok ? live.value : last_handshake,
      ...(live.ok ? {} : { error: live.error || "unavailable" }) };
  }));
  return json({ devices });
});

route("PATCH", /^devices\/([^/]+)$/, async (t, req, url, by, [id]) => {
  const b = await readJson(req, 4096);
  return json(updateDevice(t, id, b, by));
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

// Diagnostic only: a token holder can exercise the real wake path without
// impersonating an owner. The resumed agent acknowledges after reading it.
interface DeliveryProbe { nonce: string; seq: number; created_at: number; ack_at: number | null }
function probe(t: Tendril, nonce?: string): DeliveryProbe {
  const p = t.db.get<DeliveryProbe | null>("delivery_probe", null);
  if (!p || (nonce !== undefined && p.nonce !== nonce) || t.now() - p.created_at > 10 * 60_000)
    throw new HttpError(404, "not_found", "Delivery probe is unknown or expired");
  return p;
}
function probeUrls(t: Tendril, nonce: string) {
  const status_url = `${apiUrl(t.env, t.tid)}/wake/probe/${nonce}`;
  return { status_url, ack_url: `${status_url}/ack` };
}
route("GET", /^wake\/probe$/, (t) => {
  const p = probe(t);
  return json({ ...p, ...probeUrls(t, p.nonce) });
});
route("POST", /^wake\/probe$/, (t) => {
  const now = t.now();
  const old = t.db.get<{ window: number; count: number }>("delivery_probe_budget", { window: now, count: 0 });
  const budget = now - old.window >= HOUR ? { window: now, count: 0 } : old;
  if (budget.count >= 5) throw new HttpError(429, "rate_limited", "At most five delivery probes per page per hour");
  budget.count++;
  t.db.set("delivery_probe_budget", budget);
  const nonce = randomB32(20);
  const event = addEvent(t, {
    type: "event", data: { kind: "delivery_probe", nonce, ...probeUrls(t, nonce) }, role: null,
    by: "agent_probe", wake: true, cls: "page", force: true,
  });
  const p: DeliveryProbe = { nonce, seq: event.seq, created_at: now, ack_at: null };
  t.db.set("delivery_probe", p);
  return json({ ...p, ...probeUrls(t, nonce) }, 201);
});
route("GET", /^wake\/probe\/([a-z2-7]{20})$/, (t, _req, _url, _by, [nonce]) => json({ ...probe(t, nonce), ...probeUrls(t, nonce) }));
route("POST", /^wake\/probe\/([a-z2-7]{20})\/ack$/, (t, _req, _url, _by, [nonce]) => {
  const p = probe(t, nonce);
  if (t.db.get<number>("agent_cursor", 0) < p.seq) throw new HttpError(409, "not_read", "Read the diagnostic event before acknowledging it");
  if (p.ack_at === null) { p.ack_at = t.now(); t.db.set("delivery_probe", p); }
  return json({ ...p, ...probeUrls(t, nonce) });
});

route("PUT", /^wake$/, async (t, req) => {
  const b = await readJson(req, 16 * 1024);
  const w = t.wakeConfig();
  if (b.webhook !== undefined) {
    if (b.webhook === null) w.webhook = null;
    else {
      if (!isPlainObject(b.webhook) || typeof b.webhook.url !== "string" || !/^https?:\/\/\S+$/.test(b.webhook.url)) {
        throw new HttpError(400, "bad_request", "webhook must be {url, token?} with an http(s) URL, or null");
      }
      const auth = b.webhook.auth ?? "bearer";
      if (!["bearer", "standard_webhooks", "timestamp_hmac_sha256"].includes(auth)) throw new HttpError(400, "bad_request", "webhook.auth must be bearer, standard_webhooks, or timestamp_hmac_sha256");
      const token = typeof b.webhook.token === "string" && b.webhook.token ? b.webhook.token : null;
      if (auth !== "bearer" && !token) throw new HttpError(400, "bad_request", "Signed webhooks require a secret in webhook.token");
      if (auth === "standard_webhooks" && !validSecret(token)) throw new HttpError(400, "bad_request", "Standard Webhooks secret must be whsec_ plus base64 of 24–64 bytes");
      w.webhook = { url: b.webhook.url, token, auth };
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

// The agent can inspect readiness without spending a notification or learning
// private endpoint/auth keys. Only active owner subscriptions are counted.
route("GET", /^notify$/, (t) => {
  const devices = t.db.all<{ device: string; name: string | null; sub: string }>(
    "SELECT p.device, d.name, p.sub FROM push_subs p JOIN devices d ON d.id=p.device WHERE d.role='owner' AND d.pending=0 ORDER BY p.device",
  ).filter(row => {
    try { return !!validatePushSubscription(JSON.parse(row.sub), t.now()); } catch { return false; }
  }).map(row => ({ id: row.device, name: row.name }));
  const limit = 20;
  const used = t.db.one<{ count: number }>("SELECT count FROM notify_rate WHERE hour=?", Math.floor(t.now() / HOUR))?.count ?? 0;
  return json({ available: pushAvailable(t.env), subscribed_devices: devices, count: devices.length,
    quota: { limit, used, remaining: Math.max(0, limit - used) } });
});

route("POST", /^notify$/, async (t, req, url, by) => {
  const b = await readJson(req, 16 * 1024);
  if (typeof b.title !== "string" || !b.title) throw new HttpError(400, "bad_request", "title must be a non-empty string");
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  return json(await t.notify({ title: b.title.slice(0, 200), body: s(b.body)?.slice(0, 1000), url: s(b.url), device: s(b.device), tag: s(b.tag) }, by));
});

