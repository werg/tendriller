import { requireCloudflareApplication, selectedApplication } from "./application";
import { retainPublication } from "./files";
// WebSocket protocol, page ↔ Durable Object (PROTOCOL section 7).
import type { Att, DeviceRow, Tendril } from "./tendril";
import { addActivity, countEvent, deleteActivity, listActivity, preview } from "./activity";
import { addEvent } from "./events";
import { listVersions, pointers, reportHealth, rollback, servedVersion } from "./files";
import { HttpError, isPlainObject } from "./http";
import { DEVICE_ID_RE, DEVICE_SECRET_RE, safeEqual, sha256Hex, sixDigits } from "./ids";
import { ADOPT_CODE_TTL, MAX_EVENT_DATA, MAX_LOGS } from "./limits";
import { stateCommand } from "./state-command";
import { getFocus } from "./device-roles";
import { mutate, scopes, preconditions, type ValidatedContext } from "./scopes";
import { synchronizeWorkflows } from "./workflows";
import { serviceDescriptor } from "./descriptor";
import { emitBuiltinRecord, publishFromPage, subscribeStream, unsubscribeStream } from "./streams";
import { assertValid, ContractError } from "../../contract/index.mjs";
import { allows, authorizeSocket } from "./access";
import { pushAvailable, validatePushSubscription, validPushPublicKey } from "./push";

type Msg = Record<string, any>;

interface Ctx {
  t: Tendril;
  ws: WebSocket;
  att: Att & { deviceId: string };
  dev: DeviceRow;
  msg: Msg;
}

const LEVELS = new Set(["log", "info", "warn", "error"]);
const VIA = new Set(["voice", "text", "voice_layer"]);

/**
 * Each socket's messages are processed strictly in arrival order. Handlers await I/O (hashing the
 * device secret in `hello`, R2), and the runtime may yield there; without this chain a request
 * sent right after `hello` could run before `hello` finished and be answered `not_ready`.
 */
const chains = new WeakMap<WebSocket, Promise<void>>();

export function handleWsMessage(t: Tendril, ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
  const next = (chains.get(ws) ?? Promise.resolve()).then(() => processWsMessage(t, ws, raw));
  chains.set(ws, next.catch(() => {}));
  return next;
}

async function processWsMessage(t: Tendril, ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
  if (!t.exists()) {
    ws.close(4004, "tendril deleted");
    return;
  }
  let msg: Msg;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    if (!isPlainObject(msg) || typeof msg.t !== "string") throw new Error("not an object with t");
  } catch {
    t.send(ws, { t: "error", code: "bad_message", message: "Messages must be JSON objects with a string field t" });
    return;
  }
  const att = t.att(ws);
  if (!att) return;
  if (att.deviceId) {
    const second = Math.floor(t.now() / 1000);
    t.db.run(`INSERT INTO ws_rate (device_id, second, count) VALUES (?, ?, 1)
      ON CONFLICT(device_id) DO UPDATE SET second = excluded.second,
      count = CASE WHEN ws_rate.second = excluded.second THEN ws_rate.count + 1 ELSE 1 END`, att.deviceId, second);
    const count = t.db.one<{ count: number }>("SELECT count FROM ws_rate WHERE device_id = ?", att.deviceId)?.count ?? 0;
    if (count > 50) { t.send(ws, { t: "error", code: "rate_limited", message: "Too many messages. Wait a moment and try again.", cid: msg.cid }); return; }
  }
  if (msg.t === "ping") {
    t.send(ws, { t: "pong" });
    return;
  }
  try {
    if (selectedApplication(t).kind === "cloudflare") synchronizeWorkflows(t);
    if (msg.t === "hello") {
      await hello(t, ws, msg);
      return;
    }
    if (!att.deviceId) {
      t.send(ws, { t: "error", code: "not_ready", message: "Send hello first", cid: msg.cid });
      return;
    }
    if (!t.device(att.deviceId)) {
      ws.close(4003, "device removed");
      return;
    }
    const principal = await authorizeSocket(t, ws, { fresh: msg.t === "stream_subscribe" || msg.t === "stream_publish" || msg.t === "state_snapshot" });
    if (!principal) { ws.close(4003, "page access revoked"); return; }
    const current = t.att(ws) as Att & { deviceId: string };
    const dev = { ...t.device(current.deviceId)!, role: principal.role, pending: 0 };
    t.db.run("UPDATE devices SET last_active = ? WHERE id = ?", t.now(), dev.id);
    const handler = HANDLERS[msg.t];
    if (!handler) {
      t.send(ws, { t: "error", code: "unknown_type", message: `Unknown message type ${msg.t}`, cid: msg.cid });
      return;
    }
    if (OWNER_ONLY.has(msg.t) && !allows(principal, "page.owner")) {
      t.send(ws, { t: "error", code: "forbidden", message: `${msg.t} needs an owner device`, cid: msg.cid });
      return;
    }
    if (["send", "state", "state_snapshot", "stream_publish", "stream_subscribe", "capture_complete", "say_rendered"].includes(msg.t)) requireCloudflareApplication(t);
    await handler({ t, ws, att: current, dev, msg });
  } catch (err) {
    const code = err instanceof HttpError || err instanceof ContractError ? err.code : "internal";
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof HttpError) && !(err instanceof ContractError)) console.error("ws handler error", err);
    if (msg.cid !== undefined) t.send(ws, { t: "ack", cid: msg.cid, error: code, message });
    else t.send(ws, { t: "error", code, message });
  }
}

export function handleWsClose(t: Tendril, ws: WebSocket): void {
  if (!t.exists()) return;
  const att = t.att(ws);
  if (!att?.deviceId) return;
  const now = t.now();
  t.db.run("UPDATE devices SET last_seen = ? WHERE id = ?", now, att.deviceId);
  retainPublication(t, att.deviceId!, att.version);
  t.db.set("last_device_seen", now);
  const stillConnected = t.connectedSockets(ws).some((s) => s.att.deviceId === att.deviceId);
  if (!stillConnected) {
    t.failCallsFor(att.deviceId);
    const dev = t.device(att.deviceId);
    if (dev) addEvent(t, { type: "device", data: { action: "left", device: deviceInfo(dev) }, device: dev.id, role: dev.role, wake: false });
  }
  t.scheduleAlarm();
}

function deviceInfo(d: DeviceRow) {
  return { id: d.id, name: d.name ?? null, role: d.role, pending: !!d.pending, ua: d.ua ?? null, link: d.link ?? null };
}

// ------------------------------------------------------------------ hello

async function hello(t: Tendril, ws: WebSocket, msg: Msg): Promise<void> {
  const id = msg.device_id;
  const secret = msg.device_secret;
  if (typeof id !== "string" || !DEVICE_ID_RE.test(id) || typeof secret !== "string" || !DEVICE_SECRET_RE.test(secret)) {
    t.send(ws, { t: "error", code: "bad_hello", message: "hello needs device_id (d_ + 16 chars) and device_secret (32 chars)" });
    ws.close(4400, "bad hello");
    return;
  }
  const hash = await sha256Hex(secret);
  // Upgrade and hello are separate requests: a session, link or account may
  // have been revoked in between. Authorize before disclosing any snapshot.
  const principal = await authorizeSocket(t, ws, { fresh: true, beforeHello: true });
  if (!principal) { ws.close(4003, "page access revoked"); return; }
  const att = t.att(ws)!;
  const now = t.now();
  const name = typeof msg.name === "string" ? msg.name.slice(0, 100) : null;
  const ua = typeof msg.ua === "string" ? msg.ua.slice(0, 400) : null;
  const caps = msg.caps === undefined ? null : JSON.stringify(msg.caps).slice(0, 16_000);
  let dev = t.device(id);
  let isNew = false;
  if (dev) {
    if (!safeEqual(dev.secret_hash, hash)) {
      t.send(ws, { t: "error", code: "device_secret", message: "This device id is registered with a different secret" });
      ws.close(4003, "device secret mismatch");
      return;
    }
    // The browser keeps one device identity across owner and shared links.
    // Persist the current authenticated role so delivery eligibility agrees
    // with the socket's permissions, and drop owner push on a downgrade.
    if (dev.role === "owner" && principal.role !== "owner") t.db.run("DELETE FROM push_subs WHERE device = ?", id);
    t.db.run("UPDATE devices SET name = COALESCE(?, name), ua = COALESCE(?, ua), caps = COALESCE(?, caps), role = ?, pending = 0, link = ?, last_seen = ?, last_active = ? WHERE id = ?",
      name, ua, caps, principal.role, principal.linkId, now, now, id);
  } else {
    isNew = true;
    const role = principal.role;
    t.db.run(
      "INSERT INTO devices (id, secret_hash, name, role, pending, link, ua, caps, created_at, last_seen, last_active) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
      id, hash, name, role, principal.linkId, ua, caps, now, now, now,
    );
    if (role === "owner") t.db.set("had_owner", true);
  }
  dev = t.device(id)!;
  dev = { ...dev, role: principal.role, pending: 0 };
  const wasConnected = t.connectedSockets(ws).some((s) => s.att.deviceId === id);
  const version = Number.isInteger(msg.version) ? msg.version : 0;
  ws.serializeAttachment({ ...att, deviceId: id, version, at: now } satisfies Att);
  retainPublication(t, id, version);

  const { rev, state } = t.getState();
  const welcome: Msg = {
    t: "welcome",
    service: serviceDescriptor(t),
    device_id: id,
    role: dev.role,
    device_purpose: dev.purpose ?? "general",
    focus: dev.role === "owner" && !dev.pending ? getFocus(t) : null,
    pending: !!dev.pending,
    primary: t.primaryDevice() === id,
    tendril: { id: t.tid, name: t.db.get("name", "Tendril") },
    version: { ...pointers(t), served: servedVersion(t) },
    state: selectedApplication(t).kind === "cloudflare" ? state : {},
    rev: selectedApplication(t).kind === "cloudflare" ? rev : 0,
    scopes: selectedApplication(t).kind === "cloudflare" ? scopes(t) : [],
    presence: t.presence(),
    transcript: selectedApplication(t).kind === "cloudflare" ? t.transcript() : [],
    features: t.features(),
    budget: t.wakeConfig().budget,
  };
  t.send(ws, welcome);
  if (selectedApplication(t).kind === "cloudflare" && typeof msg.rev === "number" && msg.rev > rev) {
    // The page claims a revision the server never issued (e.g. after a reset): resync it.
    t.send(ws, { t: "state_reset", state, rev, scopes: scopes(t) });
  }

  if (isNew) {
    addActivity(t, { kind: "device", summary: `New ${dev.role} device ${dev.name ?? id} joined`, device: id });
  }
  if (!wasConnected) addEvent(t, { type: "device", data: { action: "joined", device: deviceInfo(dev) }, device: id, role: dev.role, wake: false });
  t.scheduleAlarm();
}

// ------------------------------------------------------------------ handlers

const OWNER_ONLY = new Set(["rollback", "versions", "activity", "activity_delete", "adopt_code", "devices", "links", "budget", "stream_publish", "push_subscribe", "push_unsubscribe", "push_status", "push_test"]);

const ack = (c: Ctx, extra: Msg = {}) => c.t.send(c.ws, { t: "ack", cid: c.msg.cid, ...extra });

const HANDLERS: Record<string, (c: Ctx) => void | Promise<void>> = {
  stream_subscribe(c) {
    if (typeof c.msg.stream !== "string") throw new HttpError(400, "bad_request", "stream must be a name");
    ack(c, subscribeStream(c.t, c.ws, c.msg.stream, c.msg.after));
  },
  stream_unsubscribe(c) {
    if (typeof c.msg.stream !== "string") throw new HttpError(400, "bad_request", "stream must be a name");
    unsubscribeStream(c.t, c.ws, c.msg.stream); ack(c, { stream: c.msg.stream });
  },
  async stream_publish(c) {
    if (typeof c.msg.stream !== "string") throw new HttpError(400, "bad_request", "stream must be a name");
    ack(c, await publishFromPage(c.t, c.ws, c.msg.stream, { records: c.msg.records }));
  },
  say_rendered(c) {
    const id = c.msg.message_id;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) { if (c.msg.cid) ack(c, { error: "bad_message" }); return; }
    const sent = c.t.db.one("SELECT 1 AS x FROM transcript WHERE src='agent' AND message_id=?", id);
    if (!sent) { if (c.msg.cid) ack(c, { error: "unknown_message" }); return; }
    const existing = c.t.db.one("SELECT 1 AS x FROM activity WHERE kind = 'say_rendered' AND device = ? AND summary = ? LIMIT 1", c.dev.id, `Message ${id} rendered`);
    if (!existing) addActivity(c.t, { kind: "say_rendered", summary: `Message ${id} rendered`, device: c.dev.id });
    if (c.msg.cid) ack(c);
  },
  sensor_usage(c) {
    const allowed = new Set(["camera", "microphone", "screen", "location", "motion"]);
    const input = c.msg.active;
    if (!Array.isArray(input) || input.length > 5 || input.some(k => typeof k !== "string" || !allowed.has(k))) return;
    const active = [...new Set(input)].sort();
    const sig = active.join(",");
    const key = `sensor:${c.dev.id}`;
    if (c.t.db.get<string>(key, "") === sig) return;
    c.t.db.set(key, sig);
    addActivity(c.t, { kind: "sensor", summary: active.length ? `Page used ${active.join(", ")}` : "Page stopped using sensors", device: c.dev.id });
  },
  async send(c) {
    const { t, dev, msg } = c;
    let result: Msg;
    try {
      if (dev.role === "display") throw new HttpError(403, "forbidden", "Display devices cannot send");
      const kind = msg.kind ?? "event";
      if (kind !== "instruction" && kind !== "event") throw new HttpError(400, "bad_request", "Unknown event kind");
      const data = msg.data === undefined ? null : msg.data;
      if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_EVENT_DATA) throw new HttpError(413, "too_large", "Event data exceeds 64 KB");
      const operation = msg.t === "capture_complete" ? "capture" : "event";
      if (operation === 'capture' && kind !== 'event') throw new HttpError(400, 'bad_capture', 'Capture completion creates an application event');
      result = mutate(t, `device:${dev.id}`, msg, { operations: [operation] }, { kind, data, text: msg.text, via: msg.via, wake: msg.wake, gesture: msg.gesture, blob: msg.blob }, context => {
        if (kind === "instruction") {
          if (typeof msg.text !== "string" || !msg.text.trim()) throw new HttpError(400, "bad_request", "instruction needs text");
          return { seq: instruction(c, msg.text.slice(0, 8000), VIA.has(msg.via) ? msg.via : "text", context) };
        }
        if (operation === "capture" && (typeof msg.blob !== "string" || !t.db.one("SELECT id FROM blobs WHERE id=?", msg.blob)))
          throw new HttpError(400, "bad_capture", "Capture completion requires an uploaded blob reference");
        const human = msg.gesture === true && dev.role === "owner" && !dev.pending;
        const ev = addEvent(t, { type: "event", data, context, device: dev.id, role: dev.role, wake: msg.wake !== false, cls: "page", human });
        countEvent(t, dev.id, data);
        return { seq: ev.seq };
      });
    } catch (error) { result = { error: error instanceof HttpError ? error.code : "bad_command", message: error instanceof Error ? error.message : String(error) }; }
    ack(c, result);
  },

  async capture_complete(c) { return HANDLERS.send(c); },

  state_snapshot({ t, ws, msg }) {
    // Authorization completed above. All three fields are read synchronously
    // from one committed state; this read creates no durable command receipt.
    t.send(ws, { t: "state_snapshot", cid: msg.cid, ...t.getState() });
  },

  async state(c) {
    const { t, dev, msg, ws } = c;
    const result = (() => {
      if (dev.role === "display") return { error: "forbidden", message: "Display devices cannot change state" };
      try {
        // Validate the entire write envelope just as the HTTP boundary does.
        // Ignoring an unknown guard would turn a misspelled conditional write
        // into an unconditional mutation.
        const { t: _type, ...input } = msg;
        const command = assertValid("stateUpdate", input);
        if (!("ops" in command)) throw new HttpError(400, "bad_request", "WebSocket state writes require ops");
        return stateCommand(t, `device:${dev.id}`, command, command.ops, ws);
      } catch (err) {
        return { error: err instanceof HttpError || err instanceof ContractError ? err.code : "bad_ops", message: err instanceof Error ? err.message : String(err) };
      }
    })();
    ack(c, { ...result, scopes: scopes(t) });
    if ((result as Msg).error) {
      const { rev, state } = t.getState();
      t.send(ws, { t: "state_reset", state, rev, scopes: scopes(t) });
    }
  },

  eval_result(c) {
    const { t, dev, msg } = c;
    if (typeof msg.call_id !== "string") return;
    const r: { ok: boolean; value?: unknown; error?: string } = { ok: !!msg.ok };
    if (msg.ok) r.value = msg.value === undefined ? null : msg.value;
    else r.error = typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error ?? "error");
    t.resolveCall(msg.call_id, dev.id, r);
  },

  log(c) {
    const { t, dev, att, msg } = c;
    if (!Array.isArray(msg.entries)) return;
    for (const e of msg.entries.slice(0, 200)) {
      if (!isPlainObject(e)) continue;
      const level = LEVELS.has(e.level) ? e.level : "log";
      const message = typeof e.message === "string" ? e.message : JSON.stringify(e.message ?? "");
      const row = t.db.one<{ seq: number }>(
        "INSERT INTO logs (ts, device, version, level, message, stack) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
        typeof e.ts === "number" ? e.ts : t.now(), dev.id, att.version || null, level, message.slice(0, 10_000),
        typeof e.stack === "string" ? e.stack.slice(0, 10_000) : null,
      );
      emitBuiltinRecord(t, "system.logs", row!.seq);
    }
    t.db.run("DELETE FROM logs WHERE seq <= (SELECT seq FROM logs ORDER BY seq DESC LIMIT 1 OFFSET ?)", MAX_LOGS);
  },

  health(c) {
    const { t, dev, msg } = c;
    if (msg.visible !== true) return;
    const version = Number(msg.version);
    if (!Number.isInteger(version) || version <= 0) return;
    reportHealth(t, version, !!msg.ok, Array.isArray(msg.errors) ? msg.errors : [], dev.id);
  },

  async rollback(c) {
    const { t, dev, msg } = c;
    const result = await t.dedupe(dev.id, msg.cid, () => {
      try {
        if (!Number.isSafeInteger(msg.expected_head_revision) || msg.expected_head_revision < 0) throw new HttpError(400, "bad_request", "Capture the publication head revision before choosing a version");
        if (t.db.get<number>("publication_head_revision", 0) !== msg.expected_head_revision) throw new HttpError(409, "publication_conflict", "The publication changed; review its current head");
        return { version: rollback(t, typeof msg.version === "number" ? msg.version : null, null, dev.id), head_revision: t.db.get<number>("publication_head_revision", 0) };
      } catch (err) {
        return { error: err instanceof HttpError ? err.code : "internal", message: err instanceof Error ? err.message : String(err) };
      }
    });
    ack(c, result);
  },

  versions(c) {
    c.t.send(c.ws, { t: "versions", cid: c.msg.cid, versions: listVersions(c.t), head_revision: c.t.db.get<number>("publication_head_revision", 0), ...pointers(c.t) });
  },

  activity(c) {
    const after = typeof c.msg.after === "number" ? c.msg.after : null;
    const { entries, cursor } = listActivity(c.t, after, 200);
    c.t.send(c.ws, { t: "activity", cid: c.msg.cid, entries, cursor });
  },

  async activity_delete(c) {
    const seq = Number(c.msg.seq);
    const ok = Number.isInteger(seq) && (await deleteActivity(c.t, seq));
    ack(c, ok ? { seq } : { error: "not_found", message: "No such activity entry" });
  },

  async adopt_code(c) {
    const { t } = c;
    const code = `${t.tid}-${sixDigits()}`;
    const expires_at = t.now() + ADOPT_CODE_TTL;
    t.db.set("adopt", { hash: await sha256Hex(code), expires_at, attempts: 0 });
    addActivity(t, { kind: "adopt_code", summary: "An owner created a code to connect a new agent", device: c.dev.id });
    t.send(c.ws, { t: "adopt_code", cid: c.msg.cid, code, expires_at });
  },

  devices(c) {
    c.t.send(c.ws, { t: "devices", cid: c.msg.cid, devices: c.t.listDevices() });
  },

  async links(c) {
    const { t, msg } = c;
    let created: unknown;
    if (isPlainObject(msg.create)) {
      const role = msg.create.role;
      if (!["owner", "guest", "display"].includes(role)) {
        ack(c, { error: "bad_request", message: "role must be owner, guest or display" });
        return;
      }
      const exp = typeof msg.create.expires_in === "number" && msg.create.expires_in > 0 ? msg.create.expires_in : null;
      created = t.renderLink(await t.createLink(role, typeof msg.create.label === "string" ? msg.create.label.slice(0, 100) : null, exp));
      addActivity(t, { kind: "link", summary: `An owner created a ${role} link`, device: c.dev.id });
    }
    const out: Msg = { t: "links", cid: msg.cid, links: t.listLinks() };
    if (created) out.created = created;
    t.send(c.ws, out);
  },

  budget(c) {
    const { t, msg } = c;
    const w = t.wakeConfig();
    const n = Number(msg.page_streak);
    if (msg.page_streak !== undefined && Number.isInteger(n) && n >= 0) w.budget.page_streak = Math.min(w.budget.page_streak, n);
    t.db.set("wake", w);
    ack(c, { budget: w.budget });
  },

  async push_subscribe(c) {
    const { t, dev, msg } = c;
    if (!pushAvailable(t.env)) throw new HttpError(503, "push_unavailable", "Push notifications are not configured on this server");
    const valid = validatePushSubscription(msg.subscription, t.now());
    if (!valid || !(await validPushPublicKey(valid))) throw new HttpError(400, "bad_subscription", "A valid public HTTPS push endpoint and browser subscription keys are required");
    // Another tab may have visited a display link using this browser identity
    // since this owner socket's hello. Its authenticated owner request wins.
    t.db.run("UPDATE devices SET role = 'owner', pending = 0, link = ? WHERE id = ?", c.att.linkId, dev.id);
    t.db.run("INSERT OR REPLACE INTO push_subs (device, sub, created_at) VALUES (?, ?, ?)", dev.id, JSON.stringify(valid), t.now());
    ack(c, { subscribed: true });
  },

  push_status(c) {
    // Do not disclose push endpoints or keys over the socket.
    const record = c.t.db.one<{ sub: string }>("SELECT sub FROM push_subs WHERE device = ?", c.dev.id);
    let sub: ReturnType<typeof validatePushSubscription> = null;
    try { if (record) sub = validatePushSubscription(JSON.parse(record.sub), c.t.now()); } catch { /* legacy invalid subscription */ }
    ack(c, { available: pushAvailable(c.t.env), subscribed: !!sub && sub.endpoint === c.msg.endpoint });
  },

  push_unsubscribe(c) {
    c.t.db.run("DELETE FROM push_subs WHERE device = ?", c.dev.id);
    ack(c, { subscribed: false });
  },

  async push_test(c) {
    if (!pushAvailable(c.t.env)) throw new HttpError(503, "push_unavailable", "Push notifications are not configured on this server");
    const sub = c.t.db.one<{ sub: string }>("SELECT sub FROM push_subs WHERE device = ?", c.dev.id);
    if (!sub) { ack(c, { sent: 0, failed: 0, reason: "not_subscribed" }); return; }
    const result = await c.t.notify({
      title: "Tendriller test notification",
      body: "This device can receive agent notifications even when the page is closed.",
      device: c.dev.id, tag: "tendriller-test",
    }, "device:notification-test", { broadcastLocal: false });
    ack(c, { sent: result.sent, failed: result.failed,
      status: result.deliveries[0]?.status ?? null });
  },

};

/** Authored text or speech input: an instruction from owners, data from anyone else. */
function instruction(c: Ctx, text: string, via: string, context: ValidatedContext): number {
  const { t, dev, ws, msg } = c;
  const isOwner = dev.role === "owner" && !dev.pending;
  const entry = t.addTranscript("user", text, { cid: msg.cid, device: dev.id });
  // Include the sender so its optimistic chat row can become a delivered row.
  t.broadcast({ ...entry, t: "instruction_echo", via });
  if (isOwner) {
    const ev = addEvent(t, { type: "instruction", data: { text, via }, context, device: dev.id, role: dev.role, wake: true, cls: "owner" });
    addActivity(t, { kind: "instruction", summary: `Instruction (${via}): ${preview(text, 300)}`, device: dev.id });
    return ev.seq;
  }
  const ev = addEvent(t, { type: "event", data: { text, via }, context, device: dev.id, role: dev.role, wake: c.msg.wake !== false, cls: "page" });
  addActivity(t, { kind: "guest_text", summary: `Text from a ${dev.role} device (${via}): ${preview(text, 300)}`, device: dev.id });
  return ev.seq;
}

