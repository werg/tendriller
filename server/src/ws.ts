// WebSocket protocol, page ↔ Durable Object (PROTOCOL section 7).
import type { Att, DeviceRow, Role, Tendril } from "./tendril";
import { addActivity, countEvent, deleteActivity, listActivity, preview } from "./activity";
import { addEvent } from "./events";
import { listVersions, markServed, pointers, reportHealth, rollback, servedVersion, versionStatus } from "./files";
import { HttpError, isPlainObject } from "./http";
import { DEVICE_ID_RE, DEVICE_SECRET_RE, safeEqual, sha256Hex, sixDigits } from "./ids";
import { ADOPT_CODE_TTL, MAX_EVENT_DATA, MAX_LOGS } from "./limits";
import { validateOps } from "./state";

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
    if (count > 50) { t.send(ws, { t: "error", code: "rate_limited", message: "Too many messages" }); return; }
  }
  if (msg.t === "ping") {
    t.send(ws, { t: "pong" });
    return;
  }
  try {
    if (msg.t === "hello") {
      await hello(t, ws, att, msg);
      return;
    }
    if (!att.deviceId) {
      t.send(ws, { t: "error", code: "not_ready", message: "Send hello first", cid: msg.cid });
      return;
    }
    const stored = t.device(att.deviceId);
    if (!stored) {
      ws.close(4003, "device removed");
      return;
    }
    if (!att.sessionRole || (att.sessionRole === "owner" && att.accountId !== t.db.get<string | null>("owner_account", null))
      || (att.sessionRole === "guest" && !t.db.one("SELECT 1 AS x FROM guest_accounts WHERE account_id = ? AND link_id = ? AND approved = 1", att.accountId, att.linkId))) {
      ws.close(4003, "page role revoked");
      return;
    }
    if (t.db.get<boolean>("disabled", false)) { ws.close(4003, "page held"); return; }
    if (!att.checkedAt || t.now() - att.checkedAt > 1000) {
      const status = await t.env.ACCOUNTS.prepare(`SELECT t.state, a.suspended_at AS owner_suspended,
        v.suspended_at AS viewer_suspended, v.deleting_at AS viewer_deleting
        FROM tendrils t LEFT JOIN accounts a ON a.id = t.owner_account
        LEFT JOIN accounts v ON v.id = ? WHERE t.id = ?`)
        .bind(att.accountId ?? null, t.tid).first<{ state: string; owner_suspended: number | null;
          viewer_suspended: number | null; viewer_deleting: number | null }>();
      if (!status || status.state !== "active" || status.owner_suspended || status.viewer_suspended || status.viewer_deleting) {
        ws.close(4003, "page unavailable"); return;
      }
      ws.serializeAttachment({ ...att, checkedAt: t.now() });
    }
    const dev = att.sessionRole ? { ...stored, role: att.sessionRole, pending: 0 } : stored;
    t.db.run("UPDATE devices SET last_active = ? WHERE id = ?", t.now(), dev.id);
    const handler = HANDLERS[msg.t];
    if (!handler) {
      t.send(ws, { t: "error", code: "unknown_type", message: `Unknown message type ${msg.t}`, cid: msg.cid });
      return;
    }
    if (OWNER_ONLY.has(msg.t) && !(dev.role === "owner" && !dev.pending)) {
      t.send(ws, { t: "error", code: "forbidden", message: `${msg.t} needs an owner device`, cid: msg.cid });
      return;
    }
    await handler({ t, ws, att: att as Att & { deviceId: string }, dev, msg });
  } catch (err) {
    const code = err instanceof HttpError ? err.code : "internal";
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof HttpError)) console.error("ws handler error", err);
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

async function hello(t: Tendril, ws: WebSocket, att: Att, msg: Msg): Promise<void> {
  const id = msg.device_id;
  const secret = msg.device_secret;
  if (typeof id !== "string" || !DEVICE_ID_RE.test(id) || typeof secret !== "string" || !DEVICE_SECRET_RE.test(secret)) {
    t.send(ws, { t: "error", code: "bad_hello", message: "hello needs device_id (d_ + 16 chars) and device_secret (32 chars)" });
    ws.close(4400, "bad hello");
    return;
  }
  const link = t.db.one<{ id: string; role: Role; expires_at: number | null }>("SELECT id, role, expires_at FROM links WHERE id = ?", att.linkId);
  if (!link || (link.expires_at !== null && link.expires_at < t.now())) {
    ws.close(4001, "link revoked");
    return;
  }
  const hash = await sha256Hex(secret);
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
    t.db.run("UPDATE devices SET name = COALESCE(?, name), ua = COALESCE(?, ua), caps = COALESCE(?, caps), last_seen = ?, last_active = ? WHERE id = ?", name, ua, caps, now, now, id);
  } else {
    isNew = true;
    const role: Role = att.sessionRole ?? link.role;
    t.db.run(
      "INSERT INTO devices (id, secret_hash, name, role, pending, link, ua, caps, created_at, last_seen, last_active) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
      id, hash, name, role, link.id, ua, caps, now, now, now,
    );
    if (role === "owner") t.db.set("had_owner", true);
  }
  dev = t.device(id)!;
  if (att.sessionRole) dev = { ...dev, role: att.sessionRole, pending: 0 };
  const wasConnected = t.connectedSockets(ws).some((s) => s.att.deviceId === id);
  const version = Number.isInteger(msg.version) ? msg.version : 0;
  ws.serializeAttachment({ ...att, deviceId: id, version, at: now } satisfies Att);

  const { rev, state } = t.getState();
  const welcome: Msg = {
    t: "welcome",
    device_id: id,
    role: dev.role,
    pending: !!dev.pending,
    primary: t.primaryDevice() === id,
    tendril: { id: t.tid, name: t.db.get("name", "Tendril") },
    version: { ...pointers(t), served: servedVersion(t) },
    state,
    rev,
    presence: t.presence(),
    transcript: t.transcript(),
    rules: t.db.get("rules", []),
    features: t.features(),
    budget: t.wakeConfig().budget,
  };
  t.send(ws, welcome);
  if (typeof msg.rev === "number" && msg.rev > rev) {
    // The page claims a revision the server never issued (e.g. after a reset): resync it.
    t.send(ws, { t: "state_reset", state, rev });
  }

  if (version > 0 && versionStatus(t, version) === "pending") markServed(t, version);
  if (isNew) {
    addActivity(t, { kind: "device", summary: `New ${dev.role} device ${dev.name ?? id} joined`, device: id });
  }
  if (!wasConnected) addEvent(t, { type: "device", data: { action: "joined", device: deviceInfo(dev) }, device: id, role: dev.role, wake: false });
  t.scheduleAlarm();
}

// ------------------------------------------------------------------ handlers

const OWNER_ONLY = new Set(["rollback", "versions", "activity", "activity_delete", "adopt_code", "devices", "links", "budget"]);

const ack = (c: Ctx, extra: Msg = {}) => c.t.send(c.ws, { t: "ack", cid: c.msg.cid, ...extra });

const HANDLERS: Record<string, (c: Ctx) => void | Promise<void>> = {
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
    const result = await t.dedupe(dev.id, msg.cid, () => {
      if (dev.role === "display") return { error: "forbidden", message: "Display devices cannot send" };
      const kind = msg.kind ?? "event";
      if (kind === "instruction") {
        if (typeof msg.text !== "string" || !msg.text.trim()) return { error: "bad_request", message: "instruction needs text" };
        const via = VIA.has(msg.via) ? msg.via : "text";
        return { seq: instruction(c, msg.text.slice(0, 8000), via) };
      }
      if (kind !== "event") return { error: "bad_request", message: `Unknown kind ${kind}` };
      const data = msg.data === undefined ? null : msg.data;
      if (JSON.stringify(data).length > MAX_EVENT_DATA) return { error: "too_large", message: "Event data exceeds 64 KB" };
      // A real user gesture on an owner device counts as a person, not a page loop (PROTOCOL 8.2).
      const human = msg.gesture === true && dev.role === "owner" && !dev.pending;
      const ev = addEvent(t, { type: "event", data, device: dev.id, role: dev.role, wake: msg.wake !== false, cls: "page", human });
      countEvent(t, dev.id, data);
      return { seq: ev.seq };
    });
    ack(c, result);
  },

  async state(c) {
    const { t, dev, msg, ws } = c;
    const result = await t.dedupe(dev.id, msg.cid, () => {
      if (dev.role === "display") return { error: "forbidden", message: "Display devices cannot change state" };
      try {
        const ops = validateOps(msg.ops);
        return { rev: t.applyState(ops, `device:${dev.id}`, ws) };
      } catch (err) {
        return { error: err instanceof HttpError ? err.code : "bad_ops", message: err instanceof Error ? err.message : String(err) };
      }
    });
    ack(c, result);
    if ((result as Msg).error) {
      const { rev, state } = t.getState();
      t.send(ws, { t: "state_reset", state, rev });
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
      t.db.run(
        "INSERT INTO logs (ts, device, version, level, message, stack) VALUES (?, ?, ?, ?, ?, ?)",
        typeof e.ts === "number" ? e.ts : t.now(), dev.id, att.version || null, level, message.slice(0, 10_000),
        typeof e.stack === "string" ? e.stack.slice(0, 10_000) : null,
      );
    }
    t.db.run("DELETE FROM logs WHERE seq <= (SELECT seq FROM logs ORDER BY seq DESC LIMIT 1 OFFSET ?)", MAX_LOGS);
  },

  health(c) {
    const { t, dev, msg } = c;
    const version = Number(msg.version);
    if (!Number.isInteger(version) || version <= 0) return;
    reportHealth(t, version, !!msg.ok, Array.isArray(msg.errors) ? msg.errors : [], dev.id);
  },

  async rollback(c) {
    const { t, dev, msg } = c;
    const result = await t.dedupe(dev.id, msg.cid, () => {
      try {
        return { version: rollback(t, typeof msg.version === "number" ? msg.version : null, null, dev.id) };
      } catch (err) {
        return { error: err instanceof HttpError ? err.code : "internal", message: err instanceof Error ? err.message : String(err) };
      }
    });
    ack(c, result);
  },

  versions(c) {
    c.t.send(c.ws, { t: "versions", cid: c.msg.cid, versions: listVersions(c.t), ...pointers(c.t) });
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
    if (!isPlainObject(msg.subscription) || typeof msg.subscription.endpoint !== "string") {
      ack(c, { error: "bad_request", message: "subscription must be a PushSubscription JSON object" });
      return;
    }
    const sub = JSON.stringify(msg.subscription);
    if (sub.length > 8000) {
      ack(c, { error: "too_large", message: "subscription too large" });
      return;
    }
    t.db.run("INSERT OR REPLACE INTO push_subs (device, sub, created_at) VALUES (?, ?, ?)", dev.id, sub, t.now());
    ack(c, {});
  },

  push_unsubscribe(c) {
    c.t.db.run("DELETE FROM push_subs WHERE device = ?", c.dev.id);
    ack(c, {});
  },

  async rule_fired(c) {
    const { t, dev, msg } = c;
    const result = await t.dedupe(dev.id, msg.cid, () => {
      if (dev.role === "display") return { error: "forbidden", message: "Display devices cannot send" };
      const data = { rule_id: String(msg.rule_id ?? ""), detail: msg.detail ?? null };
      if (JSON.stringify(data).length > MAX_EVENT_DATA) return { error: "too_large", message: "detail exceeds 64 KB" };
      const ev = addEvent(t, { type: "rule", data, device: dev.id, role: dev.role, wake: true, cls: "page" });
      addActivity(t, { kind: "rule", summary: `Device rule "${data.rule_id}" fired`, device: dev.id });
      return { seq: ev.seq };
    });
    ack(c, result);
  },

};

/** Speech or text from the control/voice layer: an instruction from owners, data from anyone else. */
function instruction(c: Ctx, text: string, via: string): number {
  const { t, dev, ws } = c;
  const isOwner = dev.role === "owner" && !dev.pending;
  const ts = t.addTranscript("user", text);
  t.broadcast({ t: "instruction_echo", text, via, device: dev.id, ts }, undefined, ws);
  if (isOwner) {
    const ev = addEvent(t, { type: "instruction", data: { text, via }, device: dev.id, role: dev.role, wake: true, cls: "owner" });
    addActivity(t, { kind: "instruction", summary: `Instruction (${via}): ${preview(text, 300)}`, device: dev.id });
    return ev.seq;
  }
  const ev = addEvent(t, { type: "event", data: { text, via }, device: dev.id, role: dev.role, wake: c.msg.wake !== false, cls: "page" });
  addActivity(t, { kind: "guest_text", summary: `Text from a ${dev.role} device (${via}): ${preview(text, 300)}`, device: dev.id });
  return ev.seq;
}

