import { isPeerSocket, handlePeerMessage, closePeer } from "./peers";
import { applicationSelection } from "../../contract/application.mjs";
import runtimeRelease from "./runtime-release.json";
// The Tendril Durable Object: owns all per-tendril state and logic.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { accountSuspendedNotice, ownerNotice, reporterAcknowledgement } from "./abuse/notices";
import { requireWritesOpen } from "./service-state";
import { addActivity, preview, pruneActivity } from "./activity";
import { handleAgent } from "./agent";
import { synchronizeWorkflows } from "./workflows";
import { handleMcp } from "./mcp";
import { mcpJobDue, mcpSubs, pruneMcpSubs, runMcpEvents } from "./mcpEvents";
import { Db } from "./db";
import { Transactions, type CommitEffect } from "./transactions";
import { speechTarget, type DevicePurpose } from "./device-roles";
import { nextTimerDeadline, runTimers } from "./timers";
import { cancelTimerNotifications, nextNotificationDeadline, pruneTimerHistory, runTimerNotifications } from "./timer-notifications";
import { pageStreak, pruneEvents, runWebhook, type Waiter, type WebhookJob } from "./events";
import { deleteUnreferencedContent, fileKey, storeContent } from "./files";
import { pruneFileHistory } from "./storage";
import { HttpError, json, readJson, toErrorResponse } from "./http";
import { newBlobId, newCallId, newLinkId, newPageKey, newToken, sha256Hex, safeEqual } from "./ids";
import type { Features } from "./inject";
import {
  ACTIVITY_RETENTION, KEEP_VERSIONS,
  AD_HOC_IDLE, ADOPT_MAX_ATTEMPTS, DAY, DEDUPE_RETENTION, DEFAULT_GRACE_S, DEFAULT_PAGE_STREAK,
  MAX_STATE, MAX_TRANSCRIPT, PRESENCE_TICK, MB, HOUR,
} from "./limits";
import { handlePage } from "./page";
import { computePresence, nextPresenceChange, type Presence, type PresenceFacts } from "./presence";
import { pushAvailable, sendWebPush, vapidPublicKey, type NotifyDeliveryOptions, type NotifyDeliveryResult } from "./push";
import { applyCheckedOps, checkState, validateOps, validateStateChecks, statePaths, type StateOp } from "./state";
import { checkGenerations, scopes, type Preconditions } from "./scopes";
import { blobReference } from "./blob-retention";
import { apiUrl, pageUrl, publicBase } from "./urls";
import { handleWsClose, handleWsMessage } from "./ws";
import { emitBuiltinRecord, emitBuiltinSignal, pruneStreams } from "./streams";
import { authenticateAgent, authenticateAgentToken, authenticatePage, pageAccessAllowed, readPageSession, socketPrincipal } from "./access";

import type { Role, DeviceInfo, StateChecks } from "../../contract/index.mjs";
export type { Role } from "../../contract/index.mjs";

/** Per-socket attachment (survives hibernation). */
export interface Att {
  linkId: string;
  deviceId: string | null;
  version: number;
  at: number;
  accountId?: string | null;
  sessionRole?: Role | null;
  checkedAt?: number;
  sessionHash?: string | null;
  /** Per-stream live cursor; retained in the hibernating socket attachment. */
  streams?: Record<string, number>;
}

export interface DeviceRow {
  id: string;
  secret_hash: string;
  name: string | null;
  role: Role;
  purpose: DevicePurpose;
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
  webhook: { url: string; token: string | null; auth?: "bearer" | "standard_webhooks" | "timestamp_hmac_sha256" } | null;
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
  created_by_agent?: number;
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
  private transactions: Transactions;
  waiters = new Set<Waiter>();
  releaseTimer: ReturnType<typeof setTimeout> | null = null;
  calls = new Map<string, PendingCall>();
  contentOperations = new Map<string, Promise<unknown>>();
  /** Test hook: milliseconds added to the clock. */
  skew = 0;
  private lastPresence: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Db(ctx.storage);
    this.db.init();
    this.transactions = new Transactions(ctx.storage, () => this.db.clearCache(), work => ctx.waitUntil(work));
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  now(): number {
    return Date.now() + this.skew;
  }

  transaction<T>(write: () => T): T { return this.transactions.run(write); }

  afterCommit(effect: CommitEffect): void { this.transactions.afterCommit(effect); }

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
      if (kind === "agent" || kind === "page" || kind === "claim") {
        const owner = this.db.get<string | null>("owner_account", null);
        if (owner) {
          if (!await pageAccessAllowed(this)) {
            this.db.set("disabled", true);
            this.db.set("disabled_at", this.db.get<number | null>("disabled_at", null) ?? this.now());
            cancelTimerNotifications(this, null, "Delivery stopped because the page or owner account is unavailable.");
            this.scheduleAlarm();
            throw new HttpError(403, "disabled", "This tendril is unavailable");
          }
        }
      }
      if (this.db.get<boolean>("disabled", false) && (kind === "agent" || kind === "page")) {
        throw new HttpError(403, "disabled", "This tendril is unavailable");
      }
      synchronizeWorkflows(this);
      if (kind === "claim") return await this.handleClaim(req, url);
      if (kind === "abuse" && url.pathname === "/abuse/report" && req.method === "POST") {
        const body = await readJson(req, 4096);
        if ((body.source !== "external" && body.source !== "page") ||
          (body.account_id !== null && typeof body.account_id !== "string") ||
          typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 2000) throw new HttpError(400, "bad_request");
        await this.recordReport(body.source, body.account_id, body.reason.trim());
        return json({ ok: true });
      }
      if (kind === "abuse" && url.pathname === "/abuse/state" && req.method === "POST") {
        const body = await readJson(req, 4096);
        if (body.disabled !== true && body.disabled !== false) throw new HttpError(400, "bad_request");
        this.db.set("disabled", body.disabled);
        if (body.disabled) this.db.set("disabled_at", this.db.get<number | null>("disabled_at", null) ?? this.now());
        else this.db.del("disabled_at");
        if (body.disabled) cancelTimerNotifications(this, null, "Delivery stopped because this page was held.");
        if (body.disabled) for (const ws of this.ctx.getWebSockets()) ws.close(4003, "page held");
        this.scheduleAlarm();
        return json({ ok: true });
      }
      if (kind === "abuse" && url.pathname === "/abuse/preview" && req.method === "GET") {
        return json({ id: this.tid, name: this.db.get("name", "Tendril"),
          versions: this.db.all("SELECT version, created_at, status, risk_score, risk_flags FROM versions ORDER BY version DESC LIMIT 20"),
          files: this.db.all("SELECT version, path, type, size FROM version_files ORDER BY version DESC, path LIMIT 200"),
          activity: this.db.all("SELECT ts, kind, summary FROM activity ORDER BY seq DESC LIMIT 30") });
      }
      if (kind === "account" && req.headers.get("x-account-id") && req.headers.get("x-account-id") === this.db.get<string | null>("owner_account", null)) {
        if (url.pathname === "/account/summary" && req.method === "GET") return json({
          name: this.db.get("name", "Tendril"), page_url: this.mainPageUrl(),
          version: this.db.get("current", 0), held: this.db.get("disabled", false),
          bytes: this.db.one<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM stored_files")?.n ?? 0,
          agents: this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM tokens")?.n ?? 0,
          guests_waiting: this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM guest_accounts WHERE approved = 0")?.n ?? 0,
          last_activity: this.db.one<{ ts: number; summary: string }>("SELECT ts, summary FROM activity ORDER BY seq DESC LIMIT 1"),
        });
        if (url.pathname === "/account/sensors" && req.method === "GET") return json({
          devices: this.listDevices(),
          events: this.db.all("SELECT ts, device, summary FROM activity WHERE kind = 'sensor' ORDER BY seq DESC LIMIT 200"),
        });
        if (url.pathname === "/account/export" && req.method === "GET") return json({
          id: this.tid, name: this.db.get("name", "Tendril"), lifetime: this.db.get("lifetime", "ad_hoc"),
          state: this.db.get("state", {}),
          versions: this.db.all("SELECT version, created_at, status, message FROM versions ORDER BY version"),
          version_files: this.db.all("SELECT version, path, hash, type, size FROM version_files ORDER BY version, path"),
          blobs: this.db.all("SELECT id, sha256, type, size, name, ts FROM blobs ORDER BY ts"),
          file_refs: this.db.all("SELECT * FROM file_refs ORDER BY path"),
          publication_blobs: this.db.all("SELECT * FROM publication_blobs ORDER BY version,path"),
          stored_files: this.db.all("SELECT hash, size FROM stored_files ORDER BY hash"),
        });
        if (url.pathname === "/account/delete" && req.method === "POST") { await this.destroy(); return json({ ok: true }); }
      }
      if (kind === "agent") {
        if (req.method !== "GET" && req.method !== "HEAD") await requireWritesOpen(this.env);
        const rest = decodeURIComponent(req.headers.get("x-tendril-rest") ?? "");
        if (rest === "mcp" || rest.startsWith("mcp/")) return await handleMcp(this, req, rest);
        return await handleAgent(this, req, url);
      }
      if (kind === "page") {
        if (req.method !== "GET" && req.method !== "HEAD" || req.headers.get("Upgrade")?.toLowerCase() === "websocket") await requireWritesOpen(this.env);
        return await handlePage(this, req, url);
      }
      throw new HttpError(404, "not_found");
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (isPeerSocket(ws)) { await handlePeerMessage(this, ws, message); return; }
    if (this.isAgentSocket(ws)) {
      // Normally answered by Durable Object's hibernation auto-response; also handle
      // a forwarded heartbeat without treating a keepalive as an application write.
      if (message === '{"t":"ping"}') { this.send(ws, { t: "pong" }); return; }
      ws.close(1008, "Agent socket is receive-only"); return;
    }
    await handleWsMessage(this, ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
    if (isPeerSocket(ws)) { closePeer(this, ws); return; }
    if (this.isAgentSocket(ws)) {
      const att = ws.deserializeAttachment() as { connectedAt?: number } | null;
      const elapsed = typeof att?.connectedAt === "number" && Number.isFinite(att.connectedAt)
        ? `, connected for ${Math.max(0, Math.round((this.now() - att.connectedAt) / 1000))}s` : "";
      const detail = reason ? `, reason ${JSON.stringify(reason.slice(0, 100))}` : "";
      addActivity(this, { kind: "agent_socket", summary: `Agent receiver socket closed (code ${code}${detail}${elapsed})` });
      this.refreshPresence(); this.scheduleAlarm();
    } else handleWsClose(this, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (isPeerSocket(ws)) { closePeer(this, ws); return; }
    if (this.isAgentSocket(ws)) { this.refreshPresence(); this.scheduleAlarm(); }
    else handleWsClose(this, ws);
  }

  // ---------------------------------------------------------------- create / adopt

  private async create(req: Request): Promise<Response> {
    if (this.exists()) throw new HttpError(409, "exists");
    const id = req.headers.get("x-tendril-id")!;
    const body = await readJson(req, 64 * 1024);
    const name = body.name === undefined ? "Tendril" : validName(body.name);
    const owner = validIntendedOwner(body.owner);
    const lifetime = body.lifetime ?? "ad_hoc";
    const mode = body.mode ?? "interactive";
    if (mode !== "interactive" && mode !== "dashboard") throw new HttpError(400, "bad_request", "mode must be interactive or dashboard");
    if (lifetime !== "ad_hoc" && lifetime !== "resident") throw new HttpError(400, "bad_request", "lifetime must be ad_hoc or resident");
    if (lifetime === "resident") throw new HttpError(400, "bad_request", "Claim the page before making it resident");
    if (body.pairing !== undefined) throw new HttpError(400, "bad_request", "Device pairing is unavailable");
    const now = this.now();
    this.db.set("id", id);
    this.db.set("name", name);
    if (owner) this.db.set("intended_owner", owner);
    this.db.set("lifetime", lifetime);
    this.db.set("mode", mode);
    this.db.set("application", applicationSelection(body.application, `cf:${id}`));
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
      mode: this.db.get("mode", "interactive"),
      expires_at: this.expiresAt(),
      next_step: "Give the human owner page_url. They must open it in a visible browser tab and sign in with their verified owner identity to claim the page within 24 hours; an agent cannot claim for them. Publication health stays pending until a visible tab loads the new version. Once claimed, set lifetime to resident for a long-lived page.",
      agent_setup: {
        event_delivery: "not_configured",
        next_step: this.db.get<string>("mode", "interactive") === "dashboard"
          ? "This dashboard may publish without an agent listener. Configure scoped producers and stream subscriptions; producer activity does not establish conversational agent delivery."
          : `Attach this agent conversation to a wake path: the bundled host bridge using a hibernating WebSocket at ${apiUrl(this.env, this.tid)}/events/socket, a verified webhook at ${apiUrl(this.env, this.tid)}/wake, or a continuous long poll when the host has no socket client. Store the event cursor and run two POST A/wake/probe diagnostics before promising live replies. A token or background receiver alone does not wake a conversation.`,
      },
    };
  }

  mainPageUrl(): string {
    const l = this.db.one<{ key: string }>("SELECT key FROM links WHERE id = 'l_main'");
    return pageUrl(this.env, this.tid, l!.key);
  }

  async pageSession(req: Request): Promise<{ account_id: string; role: Role } | null> {
    return readPageSession(this, req);
  }

  async recordReport(source: "page" | "external", accountId: string | null, reason: string): Promise<void> {
    const now = this.now();
    await this.env.ACCOUNTS.prepare("INSERT INTO reports (id, tendril_id, account_id, source, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), this.tid, accountId, source, reason, now).run();
    if (accountId) {
      const count = await this.env.ACCOUNTS.prepare("SELECT COUNT(*) AS n FROM reports WHERE tendril_id = ? AND account_id = ? AND created_at > ?")
        .bind(this.tid, accountId, now - DAY).first<{ n: number }>();
      if (count?.n === 1) this.ctx.waitUntil(reporterAcknowledgement(this.env, accountId, this.tid));
    }
    const index = await this.env.ACCOUNTS.prepare("SELECT owner_account, creator_ip FROM tendrils WHERE id = ?")
      .bind(this.tid).first<{ owner_account: string | null; creator_ip: string | null }>();
    if (!index) return;
    if (!index.owner_account) {
      if (index.creator_ip) await this.env.ACCOUNTS.prepare("INSERT OR REPLACE INTO blocks (kind, value, reason, expires_at) VALUES ('ip', ?, 'reported unclaimed tendril', ?)")
        .bind(index.creator_ip, now + DAY).run();
      await this.env.ACCOUNTS.prepare("INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, 'automatic', 'delete_unclaimed', ?, ?, ?)")
        .bind(crypto.randomUUID(), this.tid, `Reported via ${source}`, now).run();
      await this.destroy();
      return;
    }
    if (this.db.get<boolean>("disabled", false)) return;
    const rows = await this.env.ACCOUNTS.prepare(`SELECT DISTINCT r.account_id FROM reports r
      JOIN accounts a ON a.id = r.account_id WHERE r.tendril_id = ? AND r.disqualified = 0 AND r.created_at > ?
      AND a.created_at < ? AND r.account_id != ?`)
      .bind(this.tid, now - DAY, now - 7 * DAY, index.owner_account).all<{ account_id: string }>();
    const reporters = new Set<string>();
    for (const row of rows.results) {
      const invited = this.db.one("SELECT 1 AS x FROM guest_accounts WHERE account_id = ?", row.account_id);
      reporters.add(invited ? "owner_invitees" : row.account_id);
    }
    if (reporters.size >= 3) await this.hold("Three established-account reports within 24 hours");
  }

  async hold(reason: string): Promise<void> {
    if (this.db.get<boolean>("disabled", false)) return;
    const now = this.now();
    const owner = this.db.get<string | null>("owner_account", null);
    await this.env.ACCOUNTS.batch([
      this.env.ACCOUNTS.prepare("UPDATE tendrils SET state = 'held' WHERE id = ?").bind(this.tid),
      this.env.ACCOUNTS.prepare("INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, 'automatic', 'hold', ?, ?, ?)")
        .bind(crypto.randomUUID(), this.tid, reason, now),
    ]);
    this.db.set("disabled", true);
    this.db.set("disabled_at", now);
    cancelTimerNotifications(this, null, "Delivery stopped because this page was held.");
    for (const ws of this.ctx.getWebSockets()) ws.close(4003, "page held");
    this.scheduleAlarm();
    addActivity(this, { kind: "disabled", summary: `Page held: ${reason}` });
    if (!owner) return;
    this.ctx.waitUntil(ownerNotice(this.env, owner, this.tid, "held", reason));
    const holds = await this.env.ACCOUNTS.prepare(`SELECT COUNT(DISTINCT a.subject) AS n FROM audit_log a
      JOIN tendrils t ON t.id = a.subject WHERE a.action = 'hold' AND a.created_at > ?
      AND t.owner_account = ? AND t.state = 'held'`)
      .bind(now - 30 * DAY, owner).first<{ n: number }>();
    if ((holds?.n ?? 0) < 3) return;
    const suspended = await this.env.ACCOUNTS.prepare("UPDATE accounts SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL RETURNING id")
      .bind(now, owner).first();
    if (!suspended) return;
    await this.env.ACCOUNTS.batch([
      this.env.ACCOUNTS.prepare("INSERT INTO audit_log (id, actor, action, subject, reason, created_at) VALUES (?, 'automatic', 'suspend', ?, ?, ?)")
        .bind(crypto.randomUUID(), owner, "Three unreversed holds within 30 days", now),
    ]);
    this.ctx.waitUntil(accountSuspendedNotice(this.env, owner, "Three unreversed holds within 30 days"));
    // The D1 trigger queues every page. Reconciliation retries Durable Object closure.
  }

  /** Count distinct visitors on young pages without retaining raw IP addresses. */
  async recordVisitorSignal(kind: "guest" | "display", value: string): Promise<void> {
    if (!value || !this.db.get<string | null>("owner_account", null) ||
      this.db.get<number>("created_at", 0) <= this.now() - 7 * DAY) return;
    const salt = this.db.get<string | null>("signal_salt", null) ?? newPageKey();
    if (!this.db.get<string | null>("signal_salt", null)) this.db.set("signal_salt", salt);
    const hash = await sha256Hex(`${salt}:${value}`);
    const since = this.now() - 10 * 60_000;
    this.db.run("DELETE FROM visitor_signals WHERE first_seen < ?", since);
    this.db.run("INSERT OR IGNORE INTO visitor_signals (kind, value_hash, first_seen) VALUES (?, ?, ?)", kind, hash, this.now());
    const count = this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM visitor_signals WHERE kind = ? AND first_seen >= ?", kind, since)?.n ?? 0;
    const limit = kind === "guest" ? 8 : 20;
    if (count >= limit) await this.hold(kind === "guest"
      ? "Eight distinct guest sign-ins within ten minutes on a young tendril"
      : "Twenty distinct display visitors within ten minutes on a young tendril");
  }

  private async handleClaim(req: Request, url: URL): Promise<Response> {
    if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "disabled", "This tendril is unavailable");
    const key = req.headers.get("x-tendril-key") ?? "";
    const link = await this.linkForKey(key);
    if (!link) throw new HttpError(404, "not_found", "Unknown or expired link");
    if (url.pathname === "/claim/info" && req.method === "GET") {
      return json({ claimed: !!this.db.get<string | null>("owner_account", null),
        expected: maskOwner(this.db.get<string | null>("intended_owner", null)), role: link.role });
    }
    if (url.pathname === "/claim/guest-status" && req.method === "GET") {
      if (link.role !== "guest") throw new HttpError(403, "forbidden");
      const account = req.headers.get("x-account-id");
      if (!account) throw new HttpError(403, "forbidden");
      const row = this.db.one<{ approved: number }>("SELECT approved FROM guest_accounts WHERE account_id = ? AND link_id = ?", account, link.id);
      return json({ status: row?.approved === 1 ? "approved" : row?.approved === -1 ? "declined" : row ? "pending" : "none" });
    }
    if (url.pathname === "/claim/check" && req.method === "GET") {
      const { principal } = await authenticatePage(this, req, link);
      if (principal.role === "display") {
        await this.recordVisitorSignal("display", req.headers.get("x-visitor-ip") ?? "");
        if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "disabled");
      }
      return json({ role: principal.role });
    }
    if (url.pathname === "/claim/session" && req.method === "POST") {
      const b = await readJson(req, 4096);
      if (typeof b.account_id !== "string" || typeof b.hash !== "string" || !/^[a-f0-9]{64}$/.test(b.hash)) throw new HttpError(403, "forbidden");
      if (b.role === "owner" && (link.role !== "owner" || b.account_id !== this.db.get<string | null>("owner_account", null))) throw new HttpError(403, "forbidden");
      if (b.role === "guest" && (link.role !== "guest" || !this.db.one("SELECT 1 AS x FROM guest_accounts WHERE account_id = ? AND link_id = ? AND approved = 1", b.account_id, link.id))) throw new HttpError(403, "forbidden");
      if (b.role !== "owner" && b.role !== "guest") throw new HttpError(403, "forbidden");
      this.db.run("INSERT INTO page_sessions (hash, account_id, role, expires_at) VALUES (?, ?, ?, ?)", b.hash, b.account_id, b.role, this.now() + 30 * DAY);
      return json({ ok: true });
    }
    if (url.pathname === "/claim/guest" && req.method === "POST") {
      const b = await readJson(req, 4096);
      if (link.role !== "guest" || !this.db.get<string | null>("owner_account", null) || typeof b.account_id !== "string") throw new HttpError(403, "forbidden");
      this.db.run("INSERT OR IGNORE INTO guest_accounts (account_id, link_id, approved, created_at) VALUES (?, ?, ?, ?)",
        b.account_id, link.id, link.created_by_agent ? 0 : 1, this.now());
      const row = this.db.one<{ approved: number }>("SELECT approved FROM guest_accounts WHERE account_id = ? AND link_id = ?", b.account_id, link.id);
      await this.recordVisitorSignal("guest", b.account_id);
      if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "disabled");
      if (row?.approved === -1) throw new HttpError(403, "declined", "The owner declined this invitation");
      return json({ approved: row?.approved === 1 });
    }
    if (url.pathname === "/claim/owner" && req.method === "POST") {
      const b = await readJson(req, 8192);
      if (link.role !== "owner" || typeof b.account_id !== "string" || !Array.isArray(b.identities)) throw new HttpError(403, "forbidden");
      const current = this.db.get<string | null>("owner_account", null);
      if (current && current !== b.account_id) throw new HttpError(403, "claimed", "Another account owns this tendril");
      const expected = this.db.get<string | null>("intended_owner", null);
      if (!current && expected && !ownerMatches(expected, b.identities)) throw new HttpError(403, "wrong_owner", "This tendril was made for another account");
      if (!current) {
        let row: unknown;
        try {
          row = await this.env.ACCOUNTS.prepare("UPDATE tendrils SET owner_account = ?, claimed_at = ? WHERE id = ? AND owner_account IS NULL RETURNING id")
            .bind(b.account_id, this.now(), this.tid).first();
        } catch (err) {
          if (String(err).includes("account_tendrils_full")) throw new HttpError(429, "quota", "Account tendril limit reached", { limit: 20 });
          if (String(err).includes("account_full")) throw new HttpError(413, "quota", "Account storage limit reached", { limit: 200 * MB });
          throw err;
        }
        if (!row) throw new HttpError(409, "claimed", "This tendril was claimed already");
        // Defense in depth for pages released by older deployments, before
        // release cleared old push credentials. A new claim never inherits them.
        this.db.run("DELETE FROM push_subs");
        this.db.set("owner_account", b.account_id);
        this.db.set("claimed_at", this.now());
        const label = (b.identities as { login?: unknown }[]).find((i) => typeof i?.login === "string")?.login;
        if (typeof label === "string") this.db.set("owner_label", label.slice(0, 80));
        const creator = await this.env.ACCOUNTS.prepare("SELECT creator_ip FROM tendrils WHERE id = ?")
          .bind(this.tid).first<{ creator_ip: string | null }>();
        if (creator?.creator_ip) {
          const pattern = await this.env.ACCOUNTS.prepare(`SELECT COUNT(DISTINCT owner_account) AS n FROM tendrils
            WHERE creator_ip = ? AND claimed_at > ? AND owner_account IS NOT NULL`)
            .bind(creator.creator_ip, this.now() - DAY).first<{ n: number }>();
          if ((pattern?.n ?? 0) >= 10) await this.hold("Ten different accounts claimed pages from one creator address within 24 hours");
        }
        const risk = this.db.one<{ risk_score: number }>("SELECT risk_score FROM versions WHERE version = ?", this.db.get("current", 0))?.risk_score ?? 0;
        if (risk >= 5) {
          const account = await this.env.ACCOUNTS.prepare("SELECT created_at FROM accounts WHERE id = ?").bind(b.account_id)
            .first<{ created_at: number }>();
          if (account && account.created_at > this.now() - 7 * DAY) {
            await this.hold("High static screening score on claim");
          }
        }
      }
      await this.env.ADMISSION.get(this.env.ADMISSION.idFromName("global"))
        .fetch(new Request("https://admission.internal/release", { method: "POST", headers: { "x-tendril-id": this.tid } }));
      this.scheduleAlarm();
      if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "held", "This page was held after screening. The owner can appeal.");
      return json({ role: "owner" });
    }
    throw new HttpError(404, "not_found");
  }

  linkUrl(key: string): string {
    return pageUrl(this.env, this.tid, key);
  }

  expiresAt(): number | null {
    if (this.db.get<boolean>("disabled", false)) {
      return (this.db.get<number | null>("disabled_at", null) ?? this.db.get<number>("created_at", this.now())) + 90 * DAY;
    }
    if (!this.db.get<string | null>("owner_account", null)) {
      return this.db.get<number>("unclaimed_since", this.db.get<number>("created_at", 0)) + DAY;
    }
    if (this.db.get<string>("lifetime", "ad_hoc") === "resident") return null;
    const alive = this.connectedSockets().length > 0 || this.agentSockets().length > 0 ? this.now() : 0;
    const last = Math.max(this.db.get<number>("created_at", 0), this.db.get<number>("last_checkin", 0), this.db.get<number>("last_device_seen", 0),
      this.db.get<string>("mode", "interactive") === "dashboard" ? this.db.get<number>("last_producer_seen", 0) : 0, alive);
    return last + AD_HOC_IDLE;
  }

  // ---------------------------------------------------------------- agent auth and check-in

  /** Resolves identity only. Request handlers explicitly record agent activity. */
  async authAgent(req: Request): Promise<string> {
    return (await authenticateAgent(this, req)).name;
  }

  /** Resolves identity without changing presence or pending wake state. */
  async authToken(token: string): Promise<string> {
    return (await authenticateAgentToken(this, token)).name;
  }

  checkin(tokenName: string): void {
    this.transaction(() => {
      const now = this.now();
      this.db.set("last_checkin", now);
      this.db.run("UPDATE tokens SET last_used = ? WHERE name = ?", now, tokenName);
      this.db.del("wake_pending_since");
      this.refreshPresence();
      this.scheduleAlarm();
    });
  }

  // ---------------------------------------------------------------- configuration

  features(): Features {
    return { push: pushAvailable(this.env), vapid: vapidPublicKey(this.env),
      shared_by: this.db.get<string>("owner_label", "Tendriller user"),
      ...runtimeRelease.features };
  }

  wakeConfig(): WakeConfig {
    const w = this.db.get<Partial<WakeConfig>>("wake", {});
    const budget = { page_streak: typeof w.budget?.page_streak === "number" ? w.budget.page_streak : DEFAULT_PAGE_STREAK };
    return { ...DEFAULT_WAKE, ...w, budget };
  }

  renderWake() {
    const w = this.wakeConfig();
    return {
      webhook: w.webhook ? { url: w.webhook.url, has_token: !!w.webhook.token, auth: w.webhook.auth ?? "bearer" } : null,
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
      agentSocket: this.agentSockets().length > 0,
      webhook: !!w.webhook || mcpSubs(this).length > 0,
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
    this.afterCommit(() => {
      // Presence includes transactional metadata and live connection facts. Only
      // publish its committed value; several changes may coalesce into one signal.
      const current = this.presence();
      const key = JSON.stringify({ ...current, last_seen: current.last_seen === null ? null : Math.floor(current.last_seen / 60_000) });
      if (key === this.lastPresence) return;
      this.transaction(() => {
        this.broadcast({ t: "presence", ...current });
        emitBuiltinSignal(this, "system.presence", "presence", current);
        this.afterCommit(() => { this.lastPresence = key; });
      });
    });
    return p;
  }

  // ---------------------------------------------------------------- sockets

  isAgentSocket(ws: WebSocket): boolean {
    return (ws.deserializeAttachment() as { kind?: string } | null)?.kind === "agent";
  }

  agentSockets(): WebSocket[] {
    return this.ctx.getWebSockets("agent").filter((ws) => {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) return false;
      const att = ws.deserializeAttachment() as { tokenHash?: string } | null;
      const valid = !!att?.tokenHash && !!this.db.one("SELECT 1 AS x FROM tokens WHERE hash = ?", att.tokenHash);
      if (!valid) { this.afterCommit(() => ws.close(4003, "Agent token revoked")); return false; }
      return true;
    });
  }

  notifyAgentSockets(seq: number): boolean {
    const sockets = this.agentSockets();
    for (const ws of sockets) this.send(ws, { t: "wake", seq });
    return sockets.length > 0;
  }

  att(ws: WebSocket): Att | null {
    try {
      return (ws.deserializeAttachment() as Att | null) ?? null;
    } catch {
      return null;
    }
  }

  /** Sockets that completed `hello` and still have local page access. */
  connectedSockets(except?: WebSocket): { ws: WebSocket; att: Att & { deviceId: string } }[] {
    const out: { ws: WebSocket; att: Att & { deviceId: string } }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const att = this.att(ws);
      if (!att?.deviceId) continue;
      if (!socketPrincipal(this, ws)) {
        this.afterCommit(() => ws.close(4003, "Page access revoked"));
        continue;
      }
      out.push({ ws, att: att as Att & { deviceId: string } });
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
    const serialized = JSON.stringify(msg);
    this.afterCommit(() => {
      try {
        if (this.att(ws)?.deviceId && !socketPrincipal(this, ws)) { ws.close(4003, "Page access revoked"); return; }
        ws.send(serialized);
      } catch { /* socket gone */ }
    });
  }

  /** Sends to every connected device socket, optionally filtered by device row. */
  broadcast(msg: unknown, filter?: (dev: DeviceRow) => boolean, except?: WebSocket): void {
    const s = JSON.stringify(msg);
    this.afterCommit(() => {
      const devCache = new Map<string, DeviceRow | null>();
      for (const { ws, att } of this.connectedSockets(except)) {
        if (filter) {
          if (!devCache.has(att.deviceId)) devCache.set(att.deviceId, this.device(att.deviceId));
          const stored = devCache.get(att.deviceId);
          if (!stored) continue;
          const dev = att.sessionRole ? { ...stored, role: att.sessionRole, pending: 0 } : stored;
          if (!filter(dev)) continue;
        }
        try { ws.send(s); } catch { /* socket gone */ }
      }
    });
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

  renderDevice(d: DeviceRow, connected: Set<string>, primary: string | null): DeviceInfo {
    return {
      id: d.id,
      name: d.name ?? null,
      role: d.role,
      purpose: d.purpose ?? "general",
      pending: !!d.pending,
      connected: connected.has(d.id),
      primary: d.id === primary,
      last_seen: connected.has(d.id) ? this.now() : d.last_seen,
      ua: d.ua ?? null,
      link: d.link ?? null,
    };
  }

  listDevices(): DeviceInfo[] {
    const sockets = this.deviceSockets();
    const connected = new Set(sockets.keys());
    const primary = this.primaryDevice();
    return this.db.all<DeviceRow>("SELECT * FROM devices ORDER BY created_at ASC").map((d) => {
      const socket = sockets.get(d.id), sessionRole = socket ? this.att(socket)?.sessionRole : null;
      return this.renderDevice(sessionRole ? { ...d, role: sessionRole, pending: 0 } : d, connected, primary);
    });
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

  getState() {
    return { rev: this.db.get<number>("rev", 0), state: this.db.get<Record<string, unknown>>("state", {}), scopes: scopes(this) };
  }

  /** Checks the authoritative pre-mutation snapshot and applies the whole batch. */
  applyState(ops: StateOp[], by: string, except?: WebSocket, guards: Pick<Preconditions, "scope" | "expected_generations"> & StateChecks = { expected_generations: {} }): number {
    const checked = validateOps(ops), checks = validateStateChecks(guards);
    return this.transaction(() => {
      checkGenerations(this, guards, { paths: statePaths(checked, checks), operations: ["state"] });
      const { state, rev } = this.getState();
      checkState(state, rev, checks);
      return this.applyStateTransaction(checked, by, except);
    });
  }

  private applyStateTransaction(ops: StateOp[], by: string, except?: WebSocket): number {
    const { rev, state } = this.getState();
    if (ops.length === 0) return rev;
    const next = applyCheckedOps(state, rev, ops);
    const serialized = JSON.stringify(next);
    if (new TextEncoder().encode(serialized).byteLength > MAX_STATE) throw new HttpError(413, "too_large", "State would exceed 1 MB");
    const nrev = rev + 1;
    this.db.set("state", next);
    this.db.set("rev", nrev);
    this.broadcast({ t: "state", ops, rev: nrev, by, scopes: scopes(this) }, undefined, except);
    emitBuiltinSignal(this, "system.state", "state", { ops, rev: nrev, by }, by);
    addActivity(this, { kind: "state", summary: `Shared state revision ${nrev} applied (${ops.length} changes)`, by });
    return nrev;
  }

  // ---------------------------------------------------------------- blobs

  blobKey(id: string): string {
    const row = this.db.one<{ sha256: string }>("SELECT sha256 FROM blobs WHERE id = ?", id);
    if (!row) throw new HttpError(404, "not_found", "No such blob");
    return fileKey(this, row.sha256);
  }

  fileLimit(): number {
    return this.db.get<string | null>("owner_account", null) ? 5 * MB : MB;
  }

  blobLimit(): number {
    return this.db.get<string | null>("owner_account", null) ? 5 * MB : MB;
  }

  storageUsed(): number {
    return this.db.one<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM stored_files")?.n ?? 0;
  }

  checkLocalStorage(additional: number): void {
    const limit = this.db.get<string | null>("owner_account", null) ? 25 * MB : 2 * MB;
    const used = this.storageUsed();
    if (used + additional > limit) throw new HttpError(413, "quota", "Tendril storage limit reached", { limit, used });
  }

  reserveStoredFile(hash: string, size: number, riskScore: number): boolean {
    const stored = this.db.one<{ size: number }>("SELECT size FROM stored_files WHERE hash=?", hash);
    if (stored) {
      if (stored.size !== size) throw new HttpError(422, "digest_size_mismatch", "Stored content has a different size");
      return false;
    }
    this.checkLocalStorage(size);
    this.db.run("INSERT INTO stored_files (hash, size, created_at, risk_score, status) VALUES (?, ?, ?, ?, 'writing')",
      hash, size, this.now(), riskScore);
    return true;
  }

  async reserveGlobalBytes(bytes: number): Promise<void> {
    if (!this.env.ACCOUNTS) throw new HttpError(503, "unavailable", "Accounts database is not configured");
    try {
      const row = await this.env.ACCOUNTS.prepare("UPDATE tendrils SET reserved = reserved + ? WHERE id = ? RETURNING reserved")
        .bind(bytes, this.tid).first();
      if (!row) throw new HttpError(503, "unavailable", "Tendril index is missing");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("service_full")) throw new HttpError(507, "service_full", "Service storage is full");
      if (message.includes("account_full")) throw new HttpError(413, "quota", "Account storage limit reached", { limit: 200 * MB });
      throw err;
    }
  }

  async releaseGlobalBytes(bytes: number): Promise<void> {
    await this.env.ACCOUNTS.prepare("UPDATE tendrils SET reserved = MAX(0, reserved - ?) WHERE id = ?")
      .bind(bytes, this.tid).run();
  }

  async reconcileStorage(): Promise<void> {
    const actual = this.storageUsed();
    await this.env.ACCOUNTS.prepare("UPDATE tendrils SET reserved = ? WHERE id = ? AND reserved != ?")
      .bind(actual, this.tid, actual).run();
  }

  async storeBlob(body: ArrayBuffer, type: string, name: string | null, device: string | null, source: "page" | "agent", keep = false) {
    const id = newBlobId();
    await storeContent(this, body, type, hash => {
      this.db.run("INSERT INTO blobs (id, sha256, type, size, name, ts, device, source, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, hash, type, body.byteLength, name, this.now(), device, source, keep ? 1 : 0);
    });
    return blobReference(this, id);
  }

  async getBlob(id: string, rangeHeader?: string | null, head = false, inline = false): Promise<Response> {
    const row = this.db.one<{ type: string; name: string | null; size: number }>("SELECT type, name, size FROM blobs WHERE id = ?", id);
    if (!row) throw new HttpError(404, "not_found", "No such blob");
    let range: { offset: number; length: number } | undefined;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match || (!match[1] && !match[2])) throw new HttpError(416, "bad_range", "Only one byte range is supported");
      const start = match[1] ? Number(match[1]) : Math.max(0, row.size - Number(match[2]));
      const end = match[1] ? (match[2] ? Number(match[2]) : row.size - 1) : row.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= row.size)
        throw new HttpError(416, "bad_range", "Requested byte range is unavailable");
      range = { offset: start, length: Math.min(end, row.size - 1) - start + 1 };
    }
    const obj = await this.env.FILES.get(this.blobKey(id), range ? { range } : undefined);
    if (!obj || !("body" in obj)) throw new HttpError(404, "not_found", "Blob content missing");
    const filename = encodeURIComponent(new TextDecoder().decode(new TextEncoder().encode(row.name || id)))
      .replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const headers = new Headers({ "Content-Type": row.type || "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable", "Accept-Ranges": "bytes",
      "Content-Length": String(range?.length ?? row.size), "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
      "Content-Security-Policy": "default-src 'none'; sandbox" });
    if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`);
    return new Response(head ? null : obj.body, { status: range ? 206 : 200, headers });
  }

  async deleteBlob(id: string): Promise<void> {
    const hash = this.db.one<{ sha256: string }>("SELECT sha256 FROM blobs WHERE id = ?", id)?.sha256;
    if (this.db.one("SELECT 1 AS present FROM file_refs WHERE blob_id=? LIMIT 1", id) ||
        this.db.one("SELECT 1 AS present FROM file_ref_changes WHERE blob_id=? LIMIT 1", id) ||
        this.db.one("SELECT 1 AS present FROM publication_blobs WHERE blob_id=? LIMIT 1", id)) return;
    if (this.db.get<{ media: string[] } | null>("staged_bundle", null)?.media.includes(id)) return;
    this.db.run("DELETE FROM blobs WHERE id = ?", id);
    if (hash) await deleteUnreferencedContent(this, hash);
  }

  // ---------------------------------------------------------------- transcript, say, notify

  addTranscript(src: "agent" | "user", text: string, context: { cid?: string; device?: string; in_reply_to?: number | null } = {}) {
    return this.transaction(() => this.appendTranscript(src, text, context));
  }

  private appendTranscript(src: "agent" | "user", text: string, context: { cid?: string; device?: string; in_reply_to?: number | null }) {
    const ts = this.now(), message_id = crypto.randomUUID();
    const row = this.db.one<{ seq: number }>("INSERT INTO transcript (message_id, ts, src, text, cid, device, in_reply_to) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
      message_id, ts, src, text.slice(0, 4000), context.cid ?? null, context.device ?? null, context.in_reply_to ?? null);
    this.db.run("DELETE FROM transcript WHERE seq <= (SELECT seq FROM transcript ORDER BY seq DESC LIMIT 1 OFFSET ?)", MAX_TRANSCRIPT);
    emitBuiltinRecord(this, "system.transcript", row!.seq);
    return { message_id, ts, from: src, text: text.slice(0, 4000), ...context };
  }

  transcript() {
    return this.db
      .all<{ message_id: string; ts: number; src: string; text: string; cid: string | null; device: string | null; in_reply_to: number | null }>("SELECT * FROM (SELECT * FROM transcript ORDER BY seq DESC LIMIT 50) ORDER BY seq ASC")
      .map((r) => ({ message_id: r.message_id, ts: r.ts, from: r.src as "agent" | "user", text: r.text,
        ...(r.cid ? { cid: r.cid } : {}), ...(r.device ? { device: r.device } : {}), ...(r.in_reply_to !== null ? { in_reply_to: r.in_reply_to } : {}) }));
  }

  say(text: string, speak: boolean, by: string | null, replyTo: number | null = null, routing: { device?: string; speak_on?: string } = {}): string {
    if (routing.device && routing.device !== "all" && !this.device(routing.device)) throw new HttpError(404, "not_found", "No such destination device");
    const origin = replyTo ? this.db.one<{ device: string | null }>("SELECT device FROM events WHERE seq=?", replyTo)?.device : null;
    const speaker = speak ? speechTarget(this, routing.speak_on, routing.device && routing.device !== "all" ? routing.device : origin) : null;
    const entry = this.addTranscript("agent", text, { in_reply_to: replyTo });
    const messageId = entry.message_id;
    const sockets = this.deviceSockets();
    for (const { ws, att } of this.connectedSockets()) {
      const present = !routing.device || routing.device === "all" || att.deviceId === routing.device;
      const play = att.deviceId === speaker && sockets.get(att.deviceId) === ws;
      if (!present && !play) continue;
      this.send(ws, { t: "say", text, present, speak: play,
        ts: entry.ts, message_id: messageId, ...(replyTo !== null ? { in_reply_to: replyTo } : {}), ...(speaker !== null ? { speak_on: speaker } : {}) });
    }
    addActivity(this, { kind: "say", summary: `Message ${messageId}${replyTo ? ` in reply to event #${replyTo}` : ""}: ${preview(text)}`, by });
    return messageId;
  }

  async notify(n: { title: string; body?: string; url?: string; device?: string; tag?: string }, by: string | null, options: NotifyDeliveryOptions = {}): Promise<NotifyDeliveryResult> {
    if (!this.db.get<string | null>("owner_account", null)) throw new HttpError(403, "unclaimed", "Unclaimed tendrils cannot send notifications");
    const hour = Math.floor(this.now() / HOUR);
    const allowed = this.db.one<{ count: number }>(`INSERT INTO notify_rate (hour, count) VALUES (?, 1)
      ON CONFLICT(hour) DO UPDATE SET count = count + 1 WHERE count < 20 RETURNING count`, hour);
    if (!allowed) throw new HttpError(429, "quota", "Notification limit reached", { limit: 20, used: 20 });
    const payload = { title: n.title, body: n.body ?? "", url: n.url ?? this.mainPageUrl(), tag: n.tag ?? null, tendril: this.tid };
    const selected = options.devices ? new Set(options.devices) : null;
    const subs = this.db.all<{ device: string; sub: string }>(
      "SELECT p.device, p.sub FROM push_subs p JOIN devices d ON d.id = p.device WHERE d.role = 'owner' AND d.pending = 0" + (n.device ? " AND d.id = ?" : ""),
      ...(n.device ? [n.device] : []),
    ).filter(sub => !selected || selected.has(sub.device));
    let sent = 0;
    let failed = 0;
    const deliveries: NonNullable<NotifyDeliveryResult["deliveries"]> = [];
    // Revoked subscriptions and devices that lost owner access cannot receive a
    // retry, even when they appeared in the previous attempt's target list.
    if (selected) for (const device of selected) if (!subs.some(sub => sub.device === device)) {
      failed++; deliveries.push({ device, ok: false, status: 410, gone: true });
    }
    for (const s of subs) {
      let res: { ok: boolean; status: number; gone: boolean };
      try {
        res = options.signal?.aborted ? { ok: false, status: 0, gone: false }
          : await sendWebPush(this.env, JSON.parse(s.sub), payload, { ttl: 86400, urgency: "high", signal: options.signal });
      } catch {
        res = { ok: false, status: 0, gone: false };
      }
      if (res.ok) sent++;
      else failed++;
      deliveries.push({ device: s.device, ...res });
      if (res.gone) this.db.run("DELETE FROM push_subs WHERE device = ? AND sub = ?", s.device, s.sub);
    }
    // The same browser should not receive a system push and a second local
    // notification when its page happens to be open. Local delivery is only
    // the fallback for connected owner devices without provider acceptance.
    if (options.broadcastLocal !== false) {
      const accepted = new Set(deliveries.filter(delivery => delivery.ok).map(delivery => delivery.device));
      this.broadcast({ t: "notify_local", title: n.title, body: n.body ?? "" },
        (d) => d.role === "owner" && !d.pending && (!n.device || d.id === n.device) && !accepted.has(d.id));
    }
    addActivity(this, { kind: "notify", summary: `Notification: ${preview(n.title)} (${sent} sent, ${failed} failed)`, by });
    return { sent, failed, deliveries };
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

  async createLink(role: Role, label: string | null, expiresIn: number | null, fromAgent = false): Promise<Link> {
    if (role === "display") {
      const n = this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM links WHERE role = 'display'")?.n ?? 0;
      if (n >= 3) throw new HttpError(413, "quota", "At most three display links are allowed", { limit: 3, used: n });
    }
    const id = newLinkId();
    const key = newPageKey();
    const now = this.now();
    const expires = expiresIn ? now + expiresIn * 1000 : null;
    this.db.run("INSERT INTO links (id, key, key_hash, role, label, created_at, expires_at, created_by_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, key, await sha256Hex(key), role, label, now, expires, fromAgent ? 1 : 0);
    return { id, key, role, label, created_at: now, expires_at: expires, created_by_agent: fromAgent ? 1 : 0 };
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
    this.afterCommit(() => this.scheduleCommittedAlarm());
  }

  private scheduleCommittedAlarm(): void {
    if (!this.exists()) return;
    const now = this.now();
    const times: number[] = [];
    const job = this.db.get<WebhookJob | null>("webhook_job", null);
    if (job) times.push(job.due);
    const mcpDue = mcpJobDue(this);
    if (mcpDue !== null) times.push(mcpDue);
    const timerDue = nextTimerDeadline(this);
    if (timerDue !== null) times.push(timerDue);
    const notificationDue = nextNotificationDeadline(this);
    if (notificationDue !== null) times.push(notificationDue);
    const sockets = this.connectedSockets().length > 0;
    if (sockets) times.push(now + PRESENCE_TICK);
    const facts = this.presenceFacts();
    if (sockets || facts.agentSocket || facts.webhook) {
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
    await runTimers(this);
    await runTimerNotifications(this);
    await runWebhook(this);
    await runMcpEvents(this);

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
    pruneStreams(this);
    pruneActivity(this);
    pruneMcpSubs(this);
    pruneTimerHistory(this);
    this.transaction(() => pruneFileHistory(this));
    await this.pruneVersions();
    await this.pruneBlobs(now);
    await this.pruneOrphanFiles(now);
    await this.reconcileStorage();
    this.db.run("DELETE FROM dedupe WHERE ts < ?", now - DEDUPE_RETENTION);
    this.db.run("DELETE FROM links WHERE expires_at IS NOT NULL AND expires_at < ?", now);
    this.db.run("DELETE FROM guest_accounts WHERE link_id NOT IN (SELECT id FROM links)");
    this.db.run("DELETE FROM ws_rate WHERE second < ?", Math.floor(now / 1000) - 60);
    this.db.run("DELETE FROM notify_rate WHERE hour < ?", Math.floor(now / HOUR) - 24);
    const a = this.db.get<{ expires_at: number } | null>("adopt", null);
    if (a && a.expires_at < now) this.db.del("adopt");
    this.db.set("next_cleanup", now + DAY);
  }

  /**
   * Unreferenced uploads expire after 30 days. Pins, the install icon, retained file
   * history and publication references retain their bytes until those roots are removed.
   */
  async pruneBlobs(now: number): Promise<void> {
    const icon = this.db.get<string | null>("icon", null);
    const old = this.db.all<{ id: string }>("SELECT id FROM blobs WHERE pinned = 0 AND ts < ? AND id IS NOT ?", now - ACTIVITY_RETENTION, icon);
    for (const { id } of old) await this.deleteBlob(id);
  }

  /**
   * Keeps the newest KEEP_VERSIONS versions plus the current and healthy ones, then deletes file
   * bodies in R2 that no remaining version references.
   */
  async pruneVersions(): Promise<void> {
    const keep = new Set<number>(this.db.all<{ version: number }>("SELECT version FROM versions ORDER BY version DESC LIMIT ?", KEEP_VERSIONS).map((r) => r.version));
    for (const k of ["current", "healthy", "latest"]) keep.add(this.db.get<number>(k, 0));
    this.db.run("DELETE FROM publication_leases WHERE expires_at < ?", this.now());
    for (const lease of this.db.all<{ version: number }>("SELECT DISTINCT version FROM publication_leases")) keep.add(lease.version);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as {version?: number} | null;
      if (attachment?.version) keep.add(attachment.version);
    }
    const drop = this.db.all<{ version: number }>("SELECT version FROM versions").map((r) => r.version).filter((v) => !keep.has(v));
    if (drop.length === 0) return;
    const before = new Set(this.db.all<{ hash: string }>("SELECT DISTINCT hash FROM version_files").map((r) => r.hash));
    for (const v of drop) {
      this.db.run("DELETE FROM version_files WHERE version = ?", v);
      this.db.run("DELETE FROM versions WHERE version = ?", v);
      this.db.run("DELETE FROM publication_leases WHERE version = ?", v);
      this.db.run("DELETE FROM publication_blobs WHERE version = ?", v);
    }
    const after = new Set(this.db.all<{ hash: string }>("SELECT DISTINCT hash FROM version_files").map((r) => r.hash));
    const prepared = new Set(this.db.get<{ files: { hash: string }[] } | null>("staged_bundle", null)?.files.map(f => f.hash) ?? []);
    const gone = [...before].filter((h) => !after.has(h) && !prepared.has(h));
    for (const hash of gone) await deleteUnreferencedContent(this, hash);
  }

  async pruneOrphanFiles(now: number): Promise<void> {
    const prepared = new Set(this.db.get<{ files: { hash: string }[] } | null>("staged_bundle", null)?.files.map(f => f.hash) ?? []);
    const rows = this.db.all<{ hash: string }>(`SELECT s.hash FROM stored_files s
      WHERE s.created_at < ? AND NOT EXISTS (SELECT 1 FROM version_files v WHERE v.hash = s.hash)`, now - HOUR);
    for (const { hash } of rows) {
      if (prepared.has(hash)) continue;
      await deleteUnreferencedContent(this, hash, now - HOUR);
    }
  }

  // ---------------------------------------------------------------- deletion

  async destroy(): Promise<void> {
    const id = this.tid;
    const releaseAdmission = !!id && !this.db.get<string | null>("owner_account", null);
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
    if (id) {
      await this.env.ACCOUNTS.prepare("DELETE FROM tendrils WHERE id = ?").bind(id).run();
    }
    if (releaseAdmission) {
      await this.env.ADMISSION.get(this.env.ADMISSION.idFromName("global")).fetch(new Request("https://admission.internal/release", {
        method: "POST", headers: { "x-tendril-id": id },
      }));
    }
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

function validIntendedOwner(value: unknown): string {
  if (typeof value !== "string" || value.length > 254) throw new HttpError(400, "bad_request", "Invalid owner");
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (email.test(value)) return value.toLowerCase();
  throw new HttpError(400, "bad_request", "Owner must be a verified email address");
}

function maskOwner(owner: string | null): string | null {
  if (!owner) return null;
  const i = owner.indexOf("@");
  if (i > 0) return `${owner[0]}***${owner.slice(i)}`;
  return `${owner.slice(0, owner.indexOf(":"))}:${owner[owner.indexOf(":") + 1]}***`;
}

function ownerMatches(owner: string, identities: unknown[]): boolean {
  return identities.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const identity = raw as { provider?: unknown; login?: unknown; emails?: unknown };
    const emails = Array.isArray(identity.emails) ? identity.emails.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase()) : [];
    return emails.includes(owner);
  });
}

