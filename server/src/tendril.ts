// The Tendril Durable Object: owns all per-tendril state and logic.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { addActivity, preview, pruneActivity } from "./activity";
import { handleAgent } from "./agent";
import { Db } from "./db";
import { pageStreak, pruneEvents, runWebhook, type Waiter, type WebhookJob } from "./events";
import { checkHealthTimeouts, fileKey, nextHealthDeadline } from "./files";
import { HttpError, json, readJson, toErrorResponse } from "./http";
import { newBlobId, newCallId, newLinkId, newPageKey, newToken, sha256Hex, safeEqual } from "./ids";
import type { Features } from "./inject";
import {
  ACTIVITY_RETENTION, KEEP_VERSIONS,
  AD_HOC_IDLE, ADOPT_MAX_ATTEMPTS, DAY, DEDUPE_RETENTION, DEFAULT_GRACE_S, DEFAULT_PAGE_STREAK,
  MAX_STATE, MAX_TRANSCRIPT, PRESENCE_TICK,
} from "./limits";
import { handlePage } from "./page";
import { computePresence, nextPresenceChange, type Presence, type PresenceFacts } from "./presence";
import { pushAvailable, sendWebPush, vapidPublicKey } from "./push";
import { applyOps, type StateOp } from "./state";
import { apiUrl, pageUrl, publicBase } from "./urls";
import { voiceAvailable } from "./voice";
import { handleWsClose, handleWsMessage } from "./ws";

export type Role = "owner" | "guest" | "display";

/** Per-socket attachment (survives hibernation). */
export interface Att {
  linkId: string;
  deviceId: string | null;
  version: number;
  at: number;
}

export interface DeviceRow {
  id: string;
  secret_hash: string;
  name: string | null;
  role: Role;
  pending: number;
  pair_code: string | null;
  link: string | null;
  ua: string | null;
  caps: string | null;
  created_at: number;
  last_seen: number | null;
  last_active: number | null;
}

export interface CallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  timeout?: boolean;
}

interface PendingCall {
  deviceId: string;
  resolve: (r: CallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WakeConfig {
  webhook: { url: string; token: string | null } | null;
  schedule_minutes: number | null;
  budget: { page_streak: number };
  grace_seconds: number;
}

export interface StatusOverride {
  state: "working" | "idle" | "done";
  text: string | null;
  at: number;
}

export interface Link {
  id: string;
  key: string;
  role: Role;
  label: string | null;
  created_at: number;
  expires_at: number | null;
}

export const DEFAULT_WAKE: WakeConfig = {
  webhook: null,
  schedule_minutes: null,
  budget: { page_streak: DEFAULT_PAGE_STREAK },
  grace_seconds: DEFAULT_GRACE_S,
};

export class Tendril extends DurableObject<Env> {
  declare public env: Env;
  declare public ctx: DurableObjectState<{}>;
  db: Db;
  waiters = new Set<Waiter>();
  releaseTimer: ReturnType<typeof setTimeout> | null = null;
  calls = new Map<string, PendingCall>();
  /** Test hook: milliseconds added to the clock. */
  skew = 0;
  private lastPresence: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Db(ctx.storage.sql);
    this.db.init();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  now(): number {
    return Date.now() + this.skew;
  }

  get tid(): string {
    return this.db.get<string>("id", "");
  }

  exists(): boolean {
    return this.tid !== "";
  }

  // ---------------------------------------------------------------- dispatch

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const kind = url.pathname.split("/")[1];
    try {
      if (kind === "create") return await this.create(req);
      if (kind === "adopt") return await this.adopt(req);
      if (!this.exists()) throw new HttpError(404, "not_found", "No such tendril");
      if (kind === "agent") return await handleAgent(this, req, url);
      if (kind === "page") return await handlePage(this, req, url);
      throw new HttpError(404, "not_found");
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await handleWsMessage(this, ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
    handleWsClose(this, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    handleWsClose(this, ws);
  }

  // ---------------------------------------------------------------- create / adopt

  private async create(req: Request): Promise<Response> {
    if (this.exists()) throw new HttpError(409, "exists");
    const id = req.headers.get("x-tendril-id")!;
    const body = await readJson(req, 64 * 1024);
    const name = body.name === undefined ? "Tendril" : validName(body.name);
    const lifetime = body.lifetime ?? "ad_hoc";
    if (lifetime !== "ad_hoc" && lifetime !== "resident") throw new HttpError(400, "bad_request", "lifetime must be ad_hoc or resident");
    const pairing = body.pairing ?? "open";
    if (pairing !== "open" && pairing !== "required") throw new HttpError(400, "bad_request", "pairing must be open or required");
    const now = this.now();
    this.db.set("id", id);
    this.db.set("name", name);
    this.db.set("lifetime", lifetime);
    this.db.set("pairing", pairing);
    this.db.set("created_at", now);
    this.db.set("rev", 0);
    this.db.set("state", {});
    this.db.set("next_cleanup", now + DAY);
    const token = await this.addToken("main");
    const key = newPageKey();
    this.db.run(
      "INSERT INTO links (id, key, key_hash, role, label, created_at, expires_at) VALUES ('l_main', ?, ?, 'owner', 'main', ?, NULL)",
      key, await sha256Hex(key), now,
    );
    addActivity(this, { kind: "created", summary: `Tendril "${name}" created (${lifetime})` });
    this.scheduleAlarm();
    return json(this.handle(token), 201);
  }

  private async adopt(req: Request): Promise<Response> {
    if (!this.exists()) throw new HttpError(404, "invalid_code", "Unknown or expired adopt code");
    const body = await readJson(req, 4096);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const a = this.db.get<{ hash: string; expires_at: number; attempts: number } | null>("adopt", null);
    if (!a || a.expires_at < this.now()) {
      this.db.del("adopt");
      throw new HttpError(404, "invalid_code", "Unknown or expired adopt code");
    }
    if (!safeEqual(await sha256Hex(code), a.hash)) {
      a.attempts += 1;
      if (a.attempts >= ADOPT_MAX_ATTEMPTS) this.db.del("adopt");
      else this.db.set("adopt", a);
      throw new HttpError(404, "invalid_code", "Unknown or expired adopt code");
    }
    this.db.del("adopt");
    this.db.run("DELETE FROM tokens");
    const token = await this.addToken("main");
    this.db.del("last_checkin");
    this.db.del("wake_pending_since");
    this.db.del("status_override");
    addActivity(this, { kind: "adopted", summary: "A new agent session adopted this tendril; earlier agent tokens were revoked" });
    this.refreshPresence();
    this.scheduleAlarm();
    return json(this.handle(token));
  }

  async addToken(name: string): Promise<string> {
    const token = newToken();
    this.db.run("INSERT INTO tokens (name, hash, created_at, last_used) VALUES (?, ?, ?, NULL)", name, await sha256Hex(token), this.now());
    return token;
  }

  handle(token: string) {
    return {
      id: this.tid,
      name: this.db.get("name", "Tendril"),
      page_url: this.mainPageUrl(),
      api: apiUrl(this.env, this.tid),
      token,
      agent_md: `${publicBase(this.env)}/agent.md`,
      lifetime: this.db.get("lifetime", "ad_hoc"),
      expires_at: this.expiresAt(),
    };
  }

  mainPageUrl(): string {
    const l = this.db.one<{ key: string }>("SELECT key FROM links WHERE id = 'l_main'");
    return pageUrl(this.env, this.tid, l!.key);
  }

  linkUrl(key: string): string {
    return pageUrl(this.env, this.tid, key);
  }

  expiresAt(): number | null {
    if (this.db.get<string>("lifetime", "ad_hoc") === "resident") return null;
    const alive = this.connectedSockets().length > 0 ? this.now() : 0;
    const last = Math.max(this.db.get<number>("created_at", 0), this.db.get<number>("last_checkin", 0), this.db.get<number>("last_device_seen", 0), alive);
    return last + AD_HOC_IDLE;
  }

  // ---------------------------------------------------------------- agent auth and check-in

  /** Authenticates the agent token; every authenticated call is a check-in. Returns the token name. */
  async authAgent(req: Request): Promise<string> {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "");
    if (!m) throw new HttpError(401, "unauthorized", "Missing Authorization: Bearer <token>");
    const hash = await sha256Hex(m[1]);
    const row = this.db.one<{ name: string; hash: string }>("SELECT name, hash FROM tokens WHERE hash = ?", hash);
    if (!row || !safeEqual(row.hash, hash)) throw new HttpError(401, "unauthorized", "Invalid or revoked token");
    this.checkin(row.name);
    return row.name;
  }

  checkin(tokenName: string): void {
    const now = this.now();
    this.db.set("last_checkin", now);
    this.db.run("UPDATE tokens SET last_used = ? WHERE name = ?", now, tokenName);
    this.db.del("wake_pending_since");
    this.refreshPresence();
    this.scheduleAlarm();
  }

  // ---------------------------------------------------------------- configuration

  features(): Features {
    return { transcribe: !!this.env.AI, voice: voiceAvailable(this.env), push: pushAvailable(this.env), vapid: vapidPublicKey(this.env) };
  }

  wakeConfig(): WakeConfig {
    const w = this.db.get<Partial<WakeConfig>>("wake", {});
    const budget = { page_streak: typeof w.budget?.page_streak === "number" ? w.budget.page_streak : DEFAULT_PAGE_STREAK };
    return { ...DEFAULT_WAKE, ...w, budget };
  }

  renderWake() {
    const w = this.wakeConfig();
    return {
      webhook: w.webhook ? { url: w.webhook.url, has_token: !!w.webhook.token } : null,
      schedule_minutes: w.schedule_minutes,
      budget: w.budget,
      grace_seconds: w.grace_seconds,
      withheld: this.db.get<number>("withheld", 0),
      page_streak: pageStreak(this),
    };
  }

  // ---------------------------------------------------------------- presence

  presenceFacts(): PresenceFacts {
    const w = this.wakeConfig();
    const withheld = this.db.get<number>("withheld", 0);
    return {
      now: this.now(),
      tokens: this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM tokens")!.n,
      lastCheckin: this.db.get<number | null>("last_checkin", null),
      longPollHeld: this.waiters.size > 0,
      webhook: !!w.webhook,
      scheduleMinutes: w.schedule_minutes,
      wakePendingSince: this.db.get<number | null>("wake_pending_since", null),
      graceSeconds: w.grace_seconds,
      status: this.db.get<StatusOverride | null>("status_override", null),
      withheld,
    };
  }

  presence(): Presence {
    return computePresence(this.presenceFacts());
  }

  /**
   * Recomputes presence and broadcasts it to pages if it changed. A moving `last_seen` alone
   * (every check-in moves it) only triggers a broadcast when it crosses into a new minute.
   */
  refreshPresence(): Presence {
    const p = this.presence();
    const key = JSON.stringify({ ...p, last_seen: p.last_seen === null ? null : Math.floor(p.last_seen / 60_000) });
    if (key !== this.lastPresence) {
      this.lastPresence = key;
      this.broadcast({ t: "presence", ...p });
    }
    return p;
  }

  // ---------------------------------------------------------------- sockets

  att(ws: WebSocket): Att | null {
    try {
      return (ws.deserializeAttachment() as Att | null) ?? null;
    } catch {
      return null;
    }
  }

  /** Sockets that completed `hello`. */
  connectedSockets(except?: WebSocket): { ws: WebSocket; att: Att & { deviceId: string } }[] {
    const out: { ws: WebSocket; att: Att & { deviceId: string } }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const att = this.att(ws);
      if (att?.deviceId) out.push({ ws, att: att as Att & { deviceId: string } });
    }
    return out;
  }

  /** One socket per connected device: the most recently connected one. */
  deviceSockets(except?: WebSocket): Map<string, WebSocket> {
    const best = new Map<string, { ws: WebSocket; at: number }>();
    for (const { ws, att } of this.connectedSockets(except)) {
      const cur = best.get(att.deviceId);
      if (!cur || att.at >= cur.at) best.set(att.deviceId, { ws, at: att.at });
    }
    return new Map([...best].map(([k, v]) => [k, v.ws]));
  }

  send(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket gone */
    }
  }

  /** Sends to every connected device socket, optionally filtered by device row. */
  broadcast(msg: unknown, filter?: (dev: DeviceRow) => boolean, except?: WebSocket): void {
    const s = JSON.stringify(msg);
    const devCache = new Map<string, DeviceRow | null>();
    for (const { ws, att } of this.connectedSockets(except)) {
      if (filter) {
        if (!devCache.has(att.deviceId)) devCache.set(att.deviceId, this.device(att.deviceId));
        const dev = devCache.get(att.deviceId);
        if (!dev || !filter(dev)) continue;
      }
      try {
        ws.send(s);
      } catch {
        /* socket gone */
      }
    }
  }

  broadcastOwners(msg: unknown, except?: WebSocket): void {
    this.broadcast(msg, (d) => d.role === "owner" && !d.pending, except);
  }

  // ---------------------------------------------------------------- devices

  device(id: string): DeviceRow | null {
    return this.db.one<DeviceRow>("SELECT * FROM devices WHERE id = ?", id);
  }

  primaryDevice(): string | null {
    const ids = [...this.deviceSockets().keys()];
    if (ids.length === 0) return null;
    const rows = ids.map((id) => this.device(id)).filter((d): d is DeviceRow => !!d);
    const score = (d: DeviceRow) => d.last_active ?? d.last_seen ?? 0;
    rows.sort((a, b) => score(b) - score(a));
    const owner = rows.find((d) => d.role === "owner" && !d.pending);
    return (owner ?? rows[0])?.id ?? null;
  }

  renderDevice(d: DeviceRow, connected: Set<string>, primary: string | null) {
    return {
      id: d.id,
      name: d.name ?? null,
      role: d.role,
      pending: !!d.pending,
      connected: connected.has(d.id),
      primary: d.id === primary,
      last_seen: connected.has(d.id) ? this.now() : d.last_seen,
      ua: d.ua ?? null,
      link: d.link ?? null,
    };
  }

  listDevices() {
    const connected = new Set(this.deviceSockets().keys());
    const primary = this.primaryDevice();
    return this.db.all<DeviceRow>("SELECT * FROM devices ORDER BY created_at ASC").map((d) => this.renderDevice(d, connected, primary));
  }

  /** Sets a device's role (approving a pairing = role owner). Notifies its sockets. */
  setDeviceRole(id: string, role: Role, by: string | null): void {
    const d = this.device(id);
    if (!d) throw new HttpError(404, "not_found", "No such device");
    this.db.run("UPDATE devices SET role = ?, pending = 0, pair_code = NULL WHERE id = ?", role, id);
    for (const { ws, att } of this.connectedSockets()) if (att.deviceId === id) this.send(ws, { t: "role", role, pending: false });
    addActivity(this, { kind: "device", summary: `Device ${d.name ?? id} set to ${role}`, device: id, by });
  }

  forgetDevice(id: string): void {
    for (const { ws, att } of this.connectedSockets()) {
      if (att.deviceId === id) {
        try {
          ws.close(4003, "device removed");
        } catch {
          /* gone */
        }
      }
    }
    this.db.run("DELETE FROM devices WHERE id = ?", id);
    this.db.run("DELETE FROM push_subs WHERE device = ?", id);
  }

  lastDeviceSeen(): number | null {
    const row = this.db.one<{ m: number | null }>("SELECT MAX(last_seen) AS m FROM devices");
    return row?.m ?? null;
  }

  // ---------------------------------------------------------------- calls into the page

  /** Sends a call message to one device socket and resolves with its eval_result. */
  callDevice(deviceId: string, ws: WebSocket, build: (callId: string) => object, timeoutMs: number): Promise<CallResult> {
    return new Promise((resolve) => {
      const callId = newCallId();
      const timer = setTimeout(() => {
        this.calls.delete(callId);
        resolve({ ok: false, error: "timeout", timeout: true });
      }, timeoutMs);
      this.calls.set(callId, { deviceId, resolve, timer });
      this.send(ws, build(callId));
    });
  }

  resolveCall(callId: string, deviceId: string, r: CallResult): void {
    const c = this.calls.get(callId);
    if (!c || c.deviceId !== deviceId) return;
    this.calls.delete(callId);
    clearTimeout(c.timer);
    c.resolve(r);
  }

  failCallsFor(deviceId: string): void {
    for (const [id, c] of this.calls) {
      if (c.deviceId !== deviceId) continue;
      this.calls.delete(id);
      clearTimeout(c.timer);
      c.resolve({ ok: false, error: "device disconnected" });
    }
  }

  /** Resolves an eval/check target to device sockets, or throws offline/not_found. */
  targets(target: string): [string, WebSocket][] {
    const socks = this.deviceSockets();
    if (target === "all") {
      if (socks.size === 0) this.throwOffline();
      return [...socks];
    }
    if (target === "primary") {
      const p = this.primaryDevice();
      if (!p) this.throwOffline();
      return [[p!, socks.get(p!)!]];
    }
    const ws = socks.get(target);
    if (ws) return [[target, ws]];
    const d = this.device(target);
    if (!d) throw new HttpError(404, "not_found", `No device ${target}`);
    throw new HttpError(409, "offline", `Device ${target} is not connected${d.last_seen ? `; last seen at ${new Date(d.last_seen).toISOString()}` : ""}`, {
      last_seen: d.last_seen ?? null,
    });
  }

  private throwOffline(): never {
    const last = this.lastDeviceSeen();
    throw new HttpError(409, "offline", last ? `No device connected; last seen at ${new Date(last).toISOString()}` : "No device has opened the page yet", { last_seen: last });
  }

  // ---------------------------------------------------------------- state

  getState(): { rev: number; state: Record<string, unknown> } {
    return { rev: this.db.get<number>("rev", 0), state: this.db.get<Record<string, unknown>>("state", {}) };
  }

  /** Applies ops (LWW per path, in server order), bumps rev, broadcasts. */
  applyState(ops: StateOp[], by: string, except?: WebSocket): number {
    const { rev, state } = this.getState();
    if (ops.length === 0) return rev;
    const next = applyOps(structuredClone(state), ops);
    const serialized = JSON.stringify(next);
    if (serialized.length > MAX_STATE) throw new HttpError(413, "too_large", "State would exceed 1 MB");
    const nrev = rev + 1;
    this.db.set("state", next);
    this.db.set("rev", nrev);
    this.broadcast({ t: "state", ops, rev: nrev, by }, undefined, except);
    return nrev;
  }

  // ---------------------------------------------------------------- blobs

  blobKey(id: string): string {
    return `t/${this.tid}/blobs/${id}`;
  }

  async storeBlob(body: ArrayBuffer, type: string, name: string | null, device: string | null, source: "page" | "agent") {
    const id = newBlobId();
    await this.env.FILES.put(this.blobKey(id), body, { httpMetadata: { contentType: type } });
    this.db.run("INSERT INTO blobs (id, type, size, name, ts, device, source) VALUES (?, ?, ?, ?, ?, ?, ?)", id, type, body.byteLength, name, this.now(), device, source);
    return { id, url: `_tendril/blob/${id}` };
  }

  async getBlob(id: string): Promise<Response> {
    const row = this.db.one<{ type: string; name: string | null }>("SELECT type, name FROM blobs WHERE id = ?", id);
    if (!row) throw new HttpError(404, "not_found", "No such blob");
    const obj = await this.env.FILES.get(this.blobKey(id));
    if (!obj) throw new HttpError(404, "not_found", "Blob content missing");
    return new Response(obj.body, { headers: { "Content-Type": row.type || "application/octet-stream", "Cache-Control": "private, max-age=31536000, immutable" } });
  }

  async deleteBlob(id: string): Promise<void> {
    this.db.run("DELETE FROM blobs WHERE id = ?", id);
    await this.env.FILES.delete(this.blobKey(id));
  }

  // ---------------------------------------------------------------- transcript, say, notify

  addTranscript(src: "agent" | "user", text: string): number {
    const ts = this.now();
    this.db.run("INSERT INTO transcript (ts, src, text) VALUES (?, ?, ?)", ts, src, text.slice(0, 4000));
    this.db.run("DELETE FROM transcript WHERE seq <= (SELECT seq FROM transcript ORDER BY seq DESC LIMIT 1 OFFSET ?)", MAX_TRANSCRIPT);
    return ts;
  }

  transcript() {
    return this.db
      .all<{ ts: number; src: string; text: string }>("SELECT * FROM (SELECT * FROM transcript ORDER BY seq DESC LIMIT 50) ORDER BY seq ASC")
      .map((r) => ({ ts: r.ts, from: r.src as "agent" | "user", text: r.text }));
  }

  say(text: string, speak: boolean, by: string | null): void {
    const ts = this.addTranscript("agent", text);
    this.broadcast({ t: "say", text, speak, ts });
    addActivity(this, { kind: "say", summary: `Agent said: ${preview(text)}`, by });
  }

  async notify(n: { title: string; body?: string; url?: string; device?: string; tag?: string }, by: string | null) {
    const payload = { title: n.title, body: n.body ?? "", url: n.url ?? this.mainPageUrl(), tag: n.tag ?? null, tendril: this.tid };
    const subs = this.db.all<{ device: string; sub: string }>(
      "SELECT p.device, p.sub FROM push_subs p JOIN devices d ON d.id = p.device WHERE d.role = 'owner' AND d.pending = 0" + (n.device ? " AND d.id = ?" : ""),
      ...(n.device ? [n.device] : []),
    );
    let sent = 0;
    let failed = 0;
    for (const s of subs) {
      let res: { ok: boolean; status: number; gone: boolean };
      try {
        res = await sendWebPush(this.env, JSON.parse(s.sub), payload, { ttl: 86400, urgency: "high" });
      } catch {
        res = { ok: false, status: 0, gone: false };
      }
      if (res.ok) sent++;
      else failed++;
      if (res.gone) this.db.run("DELETE FROM push_subs WHERE device = ?", s.device);
    }
    this.broadcast({ t: "notify_local", title: n.title, body: n.body ?? "" }, (d) => d.role === "owner" && !d.pending && (!n.device || d.id === n.device));
    addActivity(this, { kind: "notify", summary: `Notification: ${preview(n.title)} (${sent} sent, ${failed} failed)`, by });
    return { sent, failed };
  }

  // ---------------------------------------------------------------- dedupe

  /** Runs `fn` once per (device, cid) within 24 h; replays the stored result for duplicates. */
  async dedupe<T>(deviceId: string, cid: unknown, fn: () => T | Promise<T>): Promise<T> {
    if (typeof cid !== "string" || cid === "" || cid.length > 128) return await fn();
    const key = `${deviceId}:${cid}`;
    const row = this.db.one<{ result: string }>("SELECT result FROM dedupe WHERE key = ?", key);
    if (row) return JSON.parse(row.result) as T;
    const result = await fn();
    this.db.run("INSERT OR REPLACE INTO dedupe (key, ts, result) VALUES (?, ?, ?)", key, this.now(), JSON.stringify(result ?? null));
    return result;
  }

  // ---------------------------------------------------------------- links

  async createLink(role: Role, label: string | null, expiresIn: number | null): Promise<Link> {
    const id = newLinkId();
    const key = newPageKey();
    const now = this.now();
    const expires = expiresIn ? now + expiresIn * 1000 : null;
    this.db.run("INSERT INTO links (id, key, key_hash, role, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, key, await sha256Hex(key), role, label, now, expires);
    return { id, key, role, label, created_at: now, expires_at: expires };
  }

  renderLink(l: Link) {
    return { id: l.id, url: this.linkUrl(l.key), role: l.role, label: l.label ?? null, created_at: l.created_at, expires_at: l.expires_at ?? null };
  }

  listLinks() {
    return this.db.all<Link>("SELECT * FROM links ORDER BY created_at ASC").map((l) => this.renderLink(l));
  }

  /** Closes sockets that came in through a link (after delete or rotation). */
  closeLinkSockets(linkId: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.att(ws)?.linkId === linkId) {
        try {
          ws.close(4001, "link revoked");
        } catch {
          /* gone */
        }
      }
    }
  }

  async linkForKey(key: string): Promise<Link | null> {
    const hash = await sha256Hex(key);
    const l = this.db.one<Link & { key_hash: string }>("SELECT * FROM links WHERE key_hash = ?", hash);
    if (!l || !safeEqual(l.key_hash, hash)) return null;
    if (l.expires_at !== null && l.expires_at < this.now()) return null;
    return l;
  }

  // ---------------------------------------------------------------- alarm

  scheduleAlarm(): void {
    if (!this.exists()) return;
    const now = this.now();
    const times: number[] = [];
    const job = this.db.get<WebhookJob | null>("webhook_job", null);
    if (job) times.push(job.due);
    const hd = nextHealthDeadline(this);
    if (hd !== null) times.push(hd);
    const sockets = this.connectedSockets().length > 0;
    if (sockets) times.push(now + PRESENCE_TICK);
    const facts = this.presenceFacts();
    if (sockets || facts.webhook) {
      const pc = nextPresenceChange(facts);
      if (pc !== null) times.push(pc);
    }
    if (!sockets) {
      const exp = this.expiresAt();
      if (exp !== null) times.push(exp);
    }
    times.push(this.db.get<number>("next_cleanup", now + DAY));
    const next = Math.min(...times);
    void this.ctx.storage.setAlarm(Math.max(next - this.skew, Date.now() + 1)).catch(() => {});
  }

  async alarm(): Promise<void> {
    if (!this.exists()) return;
    const now = this.now();
    checkHealthTimeouts(this);
    await runWebhook(this);

    // Grace expired after a delivered wake: retry the webhook once.
    const facts = this.presenceFacts();
    const w = this.wakeConfig();
    if (facts.wakePendingSince !== null && now - facts.wakePendingSince >= w.grace_seconds * 1000 && w.webhook) {
      if (this.db.get<number | null>("grace_retried", null) !== facts.wakePendingSince && !this.db.get("webhook_job", null)) {
        this.db.set("grace_retried", facts.wakePendingSince);
        const maxSeq = this.db.one<{ m: number | null }>("SELECT MAX(seq) AS m FROM events")?.m ?? 0;
        this.db.set("webhook_job", { due: now, attempt: 0, seq: maxSeq } satisfies WebhookJob);
        await runWebhook(this);
      }
    }

    if (this.db.get<number>("next_cleanup", 0) <= now) await this.cleanup();

    const sockets = this.connectedSockets().length > 0;
    if (sockets) this.db.set("last_device_seen", now);
    else {
      const exp = this.expiresAt();
      if (exp !== null && exp <= now) {
        await this.destroy();
        return;
      }
    }
    this.refreshPresence();
    this.scheduleAlarm();
  }

  async cleanup(): Promise<void> {
    const now = this.now();
    pruneEvents(this);
    pruneActivity(this);
    await this.pruneBlobs(now);
    await this.pruneVersions();
    this.db.run("DELETE FROM dedupe WHERE ts < ?", now - DEDUPE_RETENTION);
    this.db.run("DELETE FROM links WHERE expires_at IS NOT NULL AND expires_at < ?", now);
    const a = this.db.get<{ expires_at: number } | null>("adopt", null);
    if (a && a.expires_at < now) this.db.del("adopt");
    this.db.set("next_cleanup", now + DAY);
  }

  /**
   * Photos, clips and other page uploads expire with the activity record (30 days). Agent
   * uploads and the install icon stay until deleted explicitly.
   */
  async pruneBlobs(now: number): Promise<void> {
    const icon = this.db.get<string | null>("icon", null);
    const old = this.db.all<{ id: string }>("SELECT id FROM blobs WHERE source = 'page' AND ts < ? AND id IS NOT ?", now - ACTIVITY_RETENTION, icon);
    for (const { id } of old) await this.deleteBlob(id);
  }

  /**
   * Keeps the newest KEEP_VERSIONS versions plus the current and healthy ones, then deletes file
   * bodies in R2 that no remaining version references.
   */
  async pruneVersions(): Promise<void> {
    const keep = new Set<number>(this.db.all<{ version: number }>("SELECT version FROM versions ORDER BY version DESC LIMIT ?", KEEP_VERSIONS).map((r) => r.version));
    for (const k of ["current", "healthy", "latest"]) keep.add(this.db.get<number>(k, 0));
    const drop = this.db.all<{ version: number }>("SELECT version FROM versions").map((r) => r.version).filter((v) => !keep.has(v));
    if (drop.length === 0) return;
    const before = new Set(this.db.all<{ hash: string }>("SELECT DISTINCT hash FROM version_files").map((r) => r.hash));
    for (const v of drop) {
      this.db.run("DELETE FROM version_files WHERE version = ?", v);
      this.db.run("DELETE FROM versions WHERE version = ?", v);
    }
    const after = new Set(this.db.all<{ hash: string }>("SELECT DISTINCT hash FROM version_files").map((r) => r.hash));
    const gone = [...before].filter((h) => !after.has(h));
    for (const hash of gone) await this.env.FILES.delete(fileKey(this, hash));
  }

  // ---------------------------------------------------------------- deletion

  async destroy(): Promise<void> {
    const id = this.tid;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4004, "tendril deleted");
      } catch {
        /* gone */
      }
    }
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(json({ error: { code: "not_found", message: "Tendril deleted" } }, 404));
    }
    this.waiters.clear();
    for (const [, c] of this.calls) {
      clearTimeout(c.timer);
      c.resolve({ ok: false, error: "tendril deleted" });
    }
    this.calls.clear();
    if (id) {
      let cursor: string | undefined;
      do {
        const list = await this.env.FILES.list({ prefix: `t/${id}/`, cursor, limit: 1000 });
        if (list.objects.length) await this.env.FILES.delete(list.objects.map((o) => o.key));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.db.clearCache();
    this.db.init();
    this.lastPresence = null;
  }
}

export function validName(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 100) throw new HttpError(400, "bad_request", "name must be a non-empty string of at most 100 characters");
  return v.trim();
}

