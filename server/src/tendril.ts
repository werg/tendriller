import { lifetimeChangePending, recoverLifetimeChange } from './lifetime';
import { isPeerSocket, handlePeerMessage, closePeer, nextPeerDeadline, expirePeers } from './peers';
import { isRelaySocket, handleRelayMessage, closeRelay, nextRelayDeadline, expireRelays } from './peer-relay';
import { isInvitationSocket, handleInvitationMessage } from './peer-invitations';
import { applicationSelection } from '../../contract/application.mjs';
import { selectedApplication } from './application';
import { RESOURCE_LIMITS } from '../../contract/limits.mjs';
import runtimeRelease from './runtime-release.json';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { accountSuspendedNotice, ownerNotice, reporterAcknowledgement } from './abuse/notices';
import { requireWritesOpen } from './service-state';
import { addActivity, pruneActivity } from './activity';
import { handleAgent } from './agent';
import { handleMcp } from './mcp';
import { Db } from './db';
import { admitPageTraffic } from './traffic-budget';
import { Transactions, type CommitEffect } from './transactions';
import { deleteUnreferencedContent } from './files';
import { HttpError, json, readJson, toErrorResponse } from './http';
import { newLinkId, newPageKey, newToken, sha256Hex, safeEqual } from './ids';
import type { Features } from './inject';
import { AD_HOC_IDLE, ADOPT_MAX_ATTEMPTS, DAY, MB, HOUR } from './limits';
import { handlePage } from './page';
import { apiUrl, pageUrl, publicBase } from './urls';
import { authenticateAgent, authenticateAgentToken, authenticatePage, pageAccessAllowed, readPageSession } from './access';
import type { Role } from '../../contract/index.mjs';
export type { Role } from '../../contract/index.mjs';

export interface Link {
  id: string;
  key: string;
  role: Role;
  label: string | null;
  created_at: number;
  expires_at: number | null;
  created_by_agent?: number;
}

export class Tendril extends DurableObject<Env> {
  declare public env: Env;
  declare public ctx: DurableObjectState<{}>;
  db: Db;
  private transactions: Transactions;
  contentOperations = new Map<string, Promise<unknown>>();
  /** Test hook: milliseconds added to the clock. */
  skew = 0;

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

  /** Bound work before SQL or participant handling. Rate limits are approximate per Cloudflare location. */
  private async admitTraffic(kind: string): Promise<void> {
    if (kind !== "agent" && kind !== "page") return;
    await admitPageTraffic(this.env, this.tid, this.db.get<string | null>("owner_account", null));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const kind = url.pathname.split("/")[1];
    try {
      if (kind === "create") return await this.create(req);
      if (kind === "adopt") return await this.adopt(req);
      if (!this.exists()) throw new HttpError(404, "not_found", "No such tendril");
      await this.admitTraffic(kind);
      if (kind === "agent" || kind === "page" || kind === "claim") {
        await recoverLifetimeChange(this);
        const owner = this.db.get<string | null>("owner_account", null);
        if (owner) {
          if (!await pageAccessAllowed(this)) {
            this.db.set("disabled", true);
            this.db.set("disabled_at", this.db.get<number | null>("disabled_at", null) ?? this.now());
            this.scheduleAlarm();
            throw new HttpError(403, "disabled", "This tendril is unavailable");
          }
        }
      }
      if (this.db.get<boolean>("disabled", false) && (kind === "agent" || kind === "page")) {
        throw new HttpError(403, "disabled", "This tendril is unavailable");
      }
      if (kind === "agent" || kind === "page") this.db.set("last_access", this.now());
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
        if (body.disabled) for (const ws of this.ctx.getWebSockets()) ws.close(4003, "page held");
        this.scheduleAlarm();
        return json({ ok: true });
      }
      if (kind === "abuse" && url.pathname === "/abuse/preview" && req.method === "GET") {
        return json({ id: this.tid, name: this.db.get("name", "Tendril"),
          versions: this.db.all("SELECT version, created_at, risk_score, risk_flags FROM versions ORDER BY version DESC LIMIT 20"),
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
        if (url.pathname === "/account/activity" && req.method === "GET") return json({
          events: this.db.all("SELECT ts, kind, summary FROM activity ORDER BY seq DESC LIMIT 200"),
        });
        if (url.pathname === "/account/export" && req.method === "GET") return json({
          id: this.tid, name: this.db.get("name", "Tendril"), lifetime: this.db.get("lifetime", "ad_hoc"),
          versions: this.db.all("SELECT version, created_at, message FROM versions ORDER BY version"),
          version_files: this.db.all("SELECT version, path, hash, type, size FROM version_files ORDER BY version, path"),
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
    try { await this.admitTraffic("agent"); }
    catch { ws.close(1013, "Page traffic limit reached; reconnect shortly"); return; }
    if (isRelaySocket(ws)) { handleRelayMessage(this, ws, message); return; }
    if (isInvitationSocket(ws)) { handleInvitationMessage(this, ws, message); return; }
    if (isPeerSocket(ws)) { await handlePeerMessage(this, ws, message); return; }
    ws.close(1008, "Unsupported participant transport");
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch {}
    if (isPeerSocket(ws)) closePeer(this, ws);
    if (isRelaySocket(ws)) closeRelay(this, ws);
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    if (isRelaySocket(ws)) { closeRelay(this, ws); return; }
    if (isPeerSocket(ws)) closePeer(this, ws);
    else try { ws.close(1011, "Participant transport failed"); } catch {}
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
    this.db.set("application", applicationSelection(body.application ?? { id: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("") }));
    this.db.set("created_at", now);
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
    addActivity(this, { kind: "adopted", summary: "A new agent session adopted this tendril; earlier agent tokens were revoked" });
    this.scheduleAlarm();
    return json(this.handle(token));
  }

  async addToken(name: string): Promise<string> {
    const token = newToken();
    this.db.run("INSERT INTO tokens (name, hash, created_at, last_used) VALUES (?, ?, ?, NULL)", name, await sha256Hex(token), this.now());
    return token;
  }

  handle(token: string) {
    const application = selectedApplication(this);
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
      unclaimed_limits: { request_body_bytes: RESOURCE_LIMITS.unclaimed_body_bytes },
      next_step: "Give the human owner page_url. They must open it in a visible browser tab and sign in with their verified owner identity to claim the page within 24 hours; an agent cannot claim for them. Configure Chronolog authority after claiming the page, then publish signed page code. Once claimed, set lifetime to resident for a long-lived page.",
      application,
      agent_setup: {
        application: application.id,
        next_step: "Open the public Chronolog application session. Commands, queries, durable events and ephemeral signals use that session. Connect this host as the filtered control participant for membership, discovery, recovery and signed page-code publication.",
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
    const last = Math.max(this.db.get<number>("created_at", 0), this.db.get<number>("last_access", 0));
    return last + AD_HOC_IDLE;
  }

  // ---------------------------------------------------------------- agent authentication

  /** Resolves identity only. Request handlers explicitly record agent activity. */
  async authAgent(req: Request): Promise<string> {
    return (await authenticateAgent(this, req)).name;
  }

  /** Resolves a host agent's identity without changing stored activity. */
  async authToken(token: string): Promise<string> {
    return (await authenticateAgentToken(this, token)).name;
  }

  features(): Features {
    return { shared_by: this.db.get<string>('owner_label', 'Tendriller user'), ...runtimeRelease.features };
  }

  fileLimit(): number {
    return this.db.get<string | null>("owner_account", null) ? RESOURCE_LIMITS.file_bytes : RESOURCE_LIMITS.unclaimed_file_bytes;
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
      if ((ws.deserializeAttachment() as { principal?: { linkId?: string } } | null)?.principal?.linkId === linkId) {
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
    const now = this.now(), times = [this.db.get<number>('next_cleanup', now + DAY)];
    const peerDue = nextPeerDeadline(this), expires = this.expiresAt();
    if (peerDue !== null) times.push(peerDue);
    const relayDue = nextRelayDeadline(this);
    if (relayDue !== null) times.push(relayDue);
    if (expires !== null) times.push(expires);
    if (lifetimeChangePending(this)) times.push(now + 5000);
    void this.ctx.storage.setAlarm(Math.max(Math.min(...times) - this.skew, Date.now() + 1)).catch(() => {});
  }

  async alarm(): Promise<void> {
    if (!this.exists()) return;
    try { await recoverLifetimeChange(this); }
    catch (error) { console.error('Lifetime recovery remains pending', error); }
    expirePeers(this);
    await expireRelays(this);
    if (this.db.get<number>('next_cleanup', 0) <= this.now()) await this.cleanup();
    const expires = this.expiresAt();
    if (expires !== null && expires <= this.now()) { await this.destroy(); return; }
    this.scheduleAlarm();
  }

  async cleanup(): Promise<void> {
    const now = this.now();
    pruneActivity(this);
    // Signed publication metadata and code are retained together. Their bounded
    // protocol history is never pruned by application recovery or page health.
    await this.pruneOrphanFiles(now);
    await this.reconcileStorage();
    this.db.run('DELETE FROM links WHERE expires_at IS NOT NULL AND expires_at < ?', now);
    this.db.run('DELETE FROM guest_accounts WHERE link_id NOT IN (SELECT id FROM links)');
    this.db.run('DELETE FROM page_sessions WHERE expires_at < ?', now);
    const adoption = this.db.get<{ expires_at: number } | null>('adopt', null);
    if (adoption && adoption.expires_at < now) this.db.del('adopt');
    this.db.set('next_cleanup', now + DAY);
  }

  async pruneOrphanFiles(now: number): Promise<void> {
    const rows = this.db.all<{ hash: string }>(`SELECT s.hash FROM stored_files s
      WHERE s.created_at < ? AND NOT EXISTS (SELECT 1 FROM version_files v WHERE v.hash = s.hash)`, now - HOUR);
    for (const { hash } of rows) {
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
