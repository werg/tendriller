import { isDiscoverySocket, closeDiscoverySocket } from './discovery';
import { isSetupWatch, notifySetupChanged } from './setup-watch';
import { applicationPrepared, withAuthorityMutation } from './authority';
import { attestGrantedAgent, issueAgentAttestation, ownerAdmissionEmail } from './admissions';
import { isPublicationWatch, notifyPublicationWatchers } from "./publication-watch";
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
import { mcpRequest } from './mcp-participant';
import { requireWritesOpen } from './service-state';
import { addActivity, pruneActivity } from './activity';
import { handleAgent } from './agent';
import { Db } from './db';
import { DeadlineAlarm } from './alarm';
import { admitPageTraffic } from './traffic-budget';
import { Transactions, type CommitEffect } from './transactions';
import { deleteUnreferencedContent } from './files';
import { HttpError, json, readJson, toErrorResponse } from './http';
import { parseShareExpiry } from './sharing';
import { AGENT_PUBLIC_KEY_RE, AGENT_WRAP_KEY_RE, handleAgentGrants, mirroredAgents, notifyAgentHub, notifyGrantedAgents, validAgentBio, validAgentHandle, writeLocalGrant } from './agent-grants';
import { AGENT_ID_RE, newLinkId, newPageKey, sha256Hex, safeEqual } from './ids';
import type { Features } from './inject';
import { ACCESS_WRITE_INTERVAL, ACCOUNT_STORAGE_LIMIT, AD_HOC_IDLE, DAY, HOUR, PAGE_LIMIT, RESIDENT_LIMIT } from './limits';
import { accountLimits } from './service-state';
import { handlePage, pageAccessDenied } from './page';
import { agentPageApi, pageUrl, publicBase } from './urls';
import { AGENT_HEADER, AGENT_SCOPES, authenticateLocalPage, currentPrincipal, pagePolicy, readPageSession } from './access';
import { agentPageSummary } from './agent';
import { claimCreatorAgents } from './agents';
import type { Role } from '../../contract/index.mjs';
export type { Role } from '../../contract/index.mjs';

export interface Link {
  id: string;
  key: string;
  role: Role;
  label: string | null;
  expected_email?: string | null;
  created_at: number;
  expires_at: number | null;
  created_by_agent?: number;
}

export class Tendril extends DurableObject<Env> {
  declare public env: Env;
  declare public ctx: DurableObjectState<{}>;
  db: Db;
  private transactions: Transactions;
  private alarms: DeadlineAlarm;
  private handlingAlarm = false;
  private mcpTail: Promise<unknown> = Promise.resolve();
  contentOperations = new Map<string, Promise<unknown>>();
  private ownerClaimTail: Promise<void> = Promise.resolve();
  /** Test hook: milliseconds added to the clock. */
  skew = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Db(ctx.storage, key => {
      if (key !== 'current') return;
      notifyPublicationWatchers(this);
      this.afterCommit(() => notifyGrantedAgents(this, 'publication', { version: this.db.get('current', 0) }));
    });
    this.db.init();
    this.transactions = new Transactions(ctx.storage, () => this.db.clearCache(), work => ctx.waitUntil(work));
    this.alarms = new DeadlineAlarm(ctx.storage);
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

  /** Reserve a full idle window with at most one timestamp write per minute. */
  recordAccess(): void {
    if (!this.db.get<string | null>("owner_account", null)
      || this.db.get<string>("lifetime", "ad_hoc") !== "ad_hoc") return;
    // Round upward so eviction can never shorten the full inactivity window.
    // last_access is its durable upper bound, with at most one minute of grace.
    const through = (Math.floor(this.now() / ACCESS_WRITE_INTERVAL) + 1) * ACCESS_WRITE_INTERVAL;
    if (this.db.get<number>("last_access", 0) < through) this.db.set("last_access", through);
  }

  async checkPagePolicy(visitor: string | null = null) {
    const status = await pagePolicy(this, visitor);
    if (status === "page" && this.db.get<string | null>("owner_account", null)) {
      this.db.set("disabled", true);
      this.db.set("disabled_at", this.db.get<number | null>("disabled_at", null) ?? this.now());
      this.scheduleAlarm();
    }
    return status;
  }

  // ---------------------------------------------------------------- dispatch

  /** Agent/control admission precedes handling; page admission charges after authentication. */
  private async admitTraffic(kind: string): Promise<void> {
    if (kind !== "agent" && kind !== "mcp") return;
    await admitPageTraffic(this.env, this.tid, this.db.get<string | null>("owner_account", null));
  }

  serializeMcp<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mcpTail.then(work);
    this.mcpTail = result.catch(() => {});
    return result;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const kind = url.pathname.split("/")[1];
    try {
      if (kind === "create") return await this.create(req);
      if (!this.exists()) {
        if (kind === "page") return pageAccessDenied(401);
        throw new HttpError(404, "not_found", "No such tendril");
      }
      await this.admitTraffic(kind);
      if (kind === "agent" || kind === "page" || kind === "claim") {
        await recoverLifetimeChange(this);
        const owner = this.db.get<string | null>("owner_account", null);
        if (owner && kind !== "page" && url.pathname !== "/claim/check") {
          if (await this.checkPagePolicy() === "page") {
            throw new HttpError(403, "disabled", "This tendril is unavailable");
          }
        }
      }
      if (this.db.get<boolean>("disabled", false) && (kind === "agent" || kind === "page")) {
        if (kind === "page") return pageAccessDenied(403);
        throw new HttpError(403, "disabled", "This tendril is unavailable");
      }
      // Request handlers record activity only after their admission succeeds.
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
      if (kind === 'mcp' && req.method === 'POST') return await mcpRequest(this, req);
      if (kind === 'agent-grant') return await handleAgentGrants(this, req, url);
      if (kind === 'agent-summary') {
        const agentId = req.headers.get(AGENT_HEADER) ?? '';
        if (!AGENT_ID_RE.test(agentId)) throw new HttpError(400, 'invalid_agent');
        return json(agentPageSummary(this, agentId));
      }
      if (kind === "account" && req.headers.get("x-account-id") && req.headers.get("x-account-id") === this.db.get<string | null>("owner_account", null)) {
        if (url.pathname === "/account/summary" && req.method === "GET") return json({
          name: this.db.get("name", "Tendril"), page_url: this.mainPageUrl(),
          icon: this.db.get<string | null>("icon", null), theme_color: this.db.get<string | null>("theme_color", null),
          version: this.db.get("current", 0), held: this.db.get("disabled", false),
          bytes: this.storageUsed(),
          agents: (this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM agent_grants")?.n ?? 0)
            + (this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_connections")?.n ?? 0),
          primary_agent_id: this.db.get<string | null>("primary_agent_id", null),
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
        if (url.pathname === "/account/invite" && req.method === "POST") {
          await requireWritesOpen(this.env);
          if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "disabled", "This page is unavailable");
          const accountId = req.headers.get("x-account-id")!;
          const owns = () => {
            if (this.db.get<string | null>("owner_account", null) !== accountId) throw new HttpError(403, "forbidden");
          };
          const body = await readJson(req, 4096);
          if (body.role !== "guest" && body.role !== "display") throw new HttpError(400, "bad_request", "role must be guest or display");
          const label = typeof body.label === "string" ? body.label.trim().slice(0, 100) || null : null;
          const email = validOptionalEmail(body.email);
          const view = typeof body.view === "string" ? body.view.trim() || null : null;
          const link = await this.createLink(body.role, label, parseShareExpiry(body.expires_in), false, () => {
            owns();
            const total = this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM links")?.n ?? 0;
            if (total >= 50) throw new HttpError(429, "link_limit", "At most 50 links are allowed per page");
          }, email, view);
          addActivity(this, { kind: "link", summary: `Created ${body.role} link${label ? ` (${label})` : ""}${email ? ` for ${email}` : ""}`, by: `owner:${accountId}` });
          return json(this.renderLink(link), 201);
        }
      }
      if (kind === "agent") {
        if (req.method !== "GET" && req.method !== "HEAD") await requireWritesOpen(this.env);
        return await handleAgent(this, req, url);
      }
      if (kind === "page") {
        return await handlePage(this, req, url);
      }
      throw new HttpError(404, "not_found");
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (isDiscoverySocket(ws)) { ws.close(1008, 'Discovery watch is receive-only'); return; }
    if (isSetupWatch(ws)) { ws.close(1008, 'Setup watch is receive-only'); return; }
    if (isPublicationWatch(ws)) { ws.close(1008, "Publication watch is receive-only"); return; }
    if (isRelaySocket(ws)) { await handleRelayMessage(this, ws, message); return; }
    // Relay packets have separate packet/byte/credit bounds. Their unchanged
    // local credentials are cached; cold or invalidated credentials need SQL.
    try { await this.admitTraffic("agent"); }
    catch { ws.close(1013, "Page traffic limit reached; reconnect shortly"); return; }
    if (isInvitationSocket(ws)) { handleInvitationMessage(this, ws, message); return; }
    if (isPeerSocket(ws)) { await handlePeerMessage(this, ws, message); return; }
    ws.close(1008, "Unsupported participant transport");
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (isDiscoverySocket(ws)) closeDiscoverySocket(this, ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch {}
    if (isPeerSocket(ws)) closePeer(this, ws);
    if (isRelaySocket(ws)) closeRelay(this, ws);
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    if (isDiscoverySocket(ws)) { closeDiscoverySocket(this, ws); try { ws.close(1011); } catch {} return; }
    if (isRelaySocket(ws)) { closeRelay(this, ws); return; }
    if (isPeerSocket(ws)) closePeer(this, ws);
    else try { ws.close(1011, "Participant transport failed"); } catch {}
  }

  // ---------------------------------------------------------------- create / adopt

  /**
   * Called by the service router after it indexed the page in D1. The creating
   * agent receives the full creator grant; a claimed agent's page starts owned.
   */
  private async create(req: Request): Promise<Response> {
    if (this.exists()) throw new HttpError(409, "exists");
    const id = req.headers.get("x-tendril-id")!;
    const agentId = req.headers.get(AGENT_HEADER) ?? "", publicKey = req.headers.get("x-tendril-agent-key") ?? "";
    const wrapKey = req.headers.get("x-tendril-agent-wrap-key") ?? "";
    if (!AGENT_ID_RE.test(agentId) || !AGENT_PUBLIC_KEY_RE.test(publicKey) || !AGENT_WRAP_KEY_RE.test(wrapKey)) throw new HttpError(400, "invalid_agent");
    const handle = validAgentHandle(req.headers.get("x-tendril-agent-handle") ?? "");
    const bio = validAgentBio(req.headers.get("x-tendril-agent-bio") ?? "");
    const account = req.headers.get("x-account-id");
    const body = await readJson(req, 64 * 1024);
    const name = body.name === undefined ? "Tendril" : validName(body.name);
    const owner = account ? null : validIntendedOwner(body.owner);
    const label = account ? await this.env.ACCOUNTS.prepare("SELECT login FROM identities WHERE account_id = ? ORDER BY created_at LIMIT 1")
      .bind(account).first<{ login: string }>() : null;
    const now = this.now();
    const key = newPageKey(), keyHash = await sha256Hex(key);
    const grant = this.transaction(() => {
      this.db.set("id", id);
      this.db.set("name", name);
      if (owner) this.db.set("intended_owner", owner);
      if (account) {
        this.db.set("owner_account", account);
        this.db.set("claimed_at", now);
        if (label) this.db.set("owner_label", label.login.slice(0, 80));
      }
      this.db.set("lifetime", "ad_hoc");
      this.db.set("application", applicationSelection(body.application ?? { id: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("") }));
      this.db.set("created_at", now);
      this.db.set("next_cleanup", now + DAY);
      this.db.run(
        "INSERT INTO links (id, key, key_hash, role, label, created_at, expires_at) VALUES ('l_main', ?, ?, 'owner', 'main', ?, NULL)",
        key, keyHash, now,
      );
      addActivity(this, { kind: "created", summary: `Tendril "${name}" created by @${handle}` });
      return writeLocalGrant(this, agentId, handle, bio, publicKey, wrapKey, [...AGENT_SCOPES], "creator");
    });
    // The creator grant carries host evidence for the agent's keys from the start.
    await attestGrantedAgent(this, agentId);
    if (account) this.recordAccess();
    this.scheduleAlarm();
    return json({ ...this.pageResult(), scopes: grant.scopes, revision: grant.revision, granted_by: grant.granted_by }, 201);
  }

  /** The agent-facing description of a newly created page. Contains no credential. */
  pageResult() {
    const application = selectedApplication(this);
    const claimed = this.db.get<string | null>("owner_account", null) !== null;
    return {
      id: this.tid,
      name: this.db.get("name", "Tendril"),
      page_url: this.mainPageUrl(),
      api: agentPageApi(this.env, this.tid),
      lifetime: this.db.get("lifetime", "ad_hoc"),
      claimed,
      expires_at: this.expiresAt(),
      application,
      agent_md: `${publicBase(this.env)}/agent.md`,
      build_guide: `${publicBase(this.env)}/docs/BUILD_AN_APP.md`,
      next_step: claimed
        ? "This page is already owned by your account. Configure authority, publish the signed app and give the owner page_url."
        : "Prepare and publish the signed app now; do not wait for claim. Give the human owner page_url. Their sign-in within 24 hours claims this page and this agent for their account.",
    };
  }

  mainPageUrl(): string {
    const key = this.db.cached('links:main-key', () =>
      this.db.one<{ key: string }>("SELECT key FROM links WHERE id = 'l_main'")!.key);
    return pageUrl(this.env, this.tid, key);
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
    if (url.pathname === "/claim/agent-owner" && req.method === "POST") {
      // Internal only: an agent this page's creator grant names was just claimed by
      // signing in to another of its pages. The ordinary owner claim still checks the
      // intended owner email against the same signed-in identities.
      const agentId = req.headers.get(AGENT_HEADER) ?? "";
      const b = await readJson(req, 8192);
      const creator = this.db.one<{ granted_by: string }>("SELECT granted_by FROM agent_grants WHERE agent_id = ?", agentId);
      if (creator?.granted_by !== "creator" || typeof b.account_id !== "string" || !Array.isArray(b.identities)) throw new HttpError(403, "forbidden");
      if (this.db.get<string | null>("owner_account", null)) return json({ role: "owner", claimed: false });
      const claim = this.ownerClaimTail.then(() => this.claimOwner(b.account_id as string, b.identities as unknown[]));
      this.ownerClaimTail = claim.then(() => undefined, () => undefined);
      return claim;
    }
    const key = req.headers.get("x-tendril-key") ?? "";
    const link = await this.linkForKey(key);
    if (!link) throw new HttpError(404, "not_found", "Unknown or expired link");
    if (url.pathname === "/claim/info" && req.method === "GET") {
      return json({ claimed: !!this.db.get<string | null>("owner_account", null),
        expected: link.role === "guest" ? maskOwner(link.expected_email ?? null) : maskOwner(this.db.get<string | null>("intended_owner", null)),
        role: link.role });
    }
    if (url.pathname === "/claim/guest-status" && req.method === "GET") {
      if (link.role !== "guest") throw new HttpError(403, "forbidden");
      const account = req.headers.get("x-account-id");
      if (!account) throw new HttpError(403, "forbidden");
      const row = this.db.one<{ approved: number }>("SELECT approved FROM guest_accounts WHERE account_id = ? AND link_id = ?", account, link.id);
      return json({ status: row?.approved === 1 ? "approved" : row?.approved === -1 ? "declined" : row ? "pending" : "none" });
    }
    if (url.pathname === "/claim/check" && req.method === "GET") {
      const { principal } = await authenticateLocalPage(this, req, link);
      if (principal.role === "display") {
        await this.recordVisitorSignal("display", req.headers.get("x-visitor-ip") ?? "");
        if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "disabled");
      }
      const status = await this.checkPagePolicy(principal.role === "display" ? null : principal.accountId);
      if (status === "page") throw new HttpError(403, "disabled");
      if (status === "visitor" || !currentPrincipal(this, principal, key)) throw new HttpError(401, "unauthorized");
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
      const b = await readJson(req, 8192);
      if (link.role !== "guest" || !this.db.get<string | null>("owner_account", null) || typeof b.account_id !== "string") throw new HttpError(403, "forbidden");
      if (link.expected_email) {
        if (!Array.isArray(b.identities) || !ownerMatches(link.expected_email, b.identities)) {
          throw new HttpError(403, "wrong_guest_email", "This invitation is for a different email address");
        }
      }
      this.db.run("INSERT OR IGNORE INTO guest_accounts (account_id, link_id, approved, created_at) VALUES (?, ?, 1, ?)",
        b.account_id, link.id, this.now());
      const row = this.db.one<{ approved: number }>("SELECT approved FROM guest_accounts WHERE account_id = ? AND link_id = ?", b.account_id, link.id);
      await this.recordVisitorSignal("guest", b.account_id);
      if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "disabled");
      if (row?.approved === -1) throw new HttpError(403, "declined", "This invitation was revoked");
      return json({ approved: row?.approved === 1 });
    }
    if (url.pathname === "/claim/owner" && req.method === "POST") {
      const b = await readJson(req, 8192);
      if (link.role !== "owner" || typeof b.account_id !== "string" || !Array.isArray(b.identities)) throw new HttpError(403, "forbidden");
      // D1 yields between reading and committing the first owner. A second
      // tab for the same account waits for that claim and then opens normally.
      const claim = this.ownerClaimTail.then(() => this.claimOwner(b.account_id, b.identities));
      this.ownerClaimTail = claim.then(() => undefined, () => undefined);
      return claim;
    }
    throw new HttpError(404, "not_found");
  }

  private claimOwner(accountId: string, identities: unknown[]): Promise<Response> {
    return withAuthorityMutation(this, () => this.claimOwnerSerialized(accountId, identities));
  }

  private async claimOwnerSerialized(accountId: string, identities: unknown[]): Promise<Response> {
    const current = this.db.get<string | null>("owner_account", null);
    if (current && current !== accountId) throw new HttpError(403, "claimed", "Another account owns this tendril");
    const expected = this.db.get<string | null>("intended_owner", null);
    if (!current && expected && !ownerMatches(expected, identities)) throw new HttpError(403, "wrong_owner", "This tendril was made for another account");
    if (!current) {
      let row: unknown;
      try {
        const lifetime = applicationPrepared(this) ? 'resident' : this.db.get('lifetime', 'ad_hoc');
        row = await this.env.ACCOUNTS.prepare(`UPDATE tendrils SET owner_account = ?, claimed_at = COALESCE(claimed_at, ?), lifetime = ?
          WHERE id = ? AND (owner_account IS NULL OR owner_account = ?) RETURNING id`)
          .bind(accountId, this.now(), lifetime, this.tid, accountId).first();
      } catch (err) {
        const msg = String(err);
        if (msg.includes("account_residents_full") || msg.includes("account_tendrils_full") || msg.includes("account_full")) {
          const limits = await accountLimits(this.env);
          if (msg.includes("account_residents_full")) throw new HttpError(429, "quota", "Account resident tendril limit reached", { limit: limits.residents ?? RESIDENT_LIMIT });
          if (msg.includes("account_tendrils_full")) throw new HttpError(429, "quota", "Account tendril limit reached", { limit: limits.pages ?? PAGE_LIMIT });
          throw new HttpError(413, "quota", "Account storage limit reached", { limit: limits.storage ?? ACCOUNT_STORAGE_LIMIT });
        }
        throw err;
      }
      if (!row) throw new HttpError(409, "claimed", "This tendril was claimed already");
      this.transaction(() => {
        this.db.set("owner_account", accountId);
        this.db.set("claimed_at", this.now());
        if (applicationPrepared(this)) this.db.set('lifetime', 'resident');
      });
      // Granted agents' evidence now names the owner account instead of the intended address.
      await ownerAdmissionEmail(this, accountId);
      for (const agentId of mirroredAgents(this)) await issueAgentAttestation(this, agentId).catch(() => undefined);
      // Starting the claim also starts the inactivity window.
      this.recordAccess();
      const label = (identities as { login?: unknown }[]).find((i) => typeof i?.login === "string")?.login;
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
        const account = await this.env.ACCOUNTS.prepare("SELECT created_at FROM accounts WHERE id = ?").bind(accountId)
          .first<{ created_at: number }>();
        if (account && account.created_at > this.now() - 7 * DAY) {
          await this.hold("High static screening score on claim");
        }
      }
    }
    await claimCreatorAgents(this.env, this.tid, accountId, identities);
    notifySetupChanged(this);
    const releasedAdmission = await this.env.ADMISSION.get(this.env.ADMISSION.idFromName("global"))
      .fetch(new Request("https://admission.internal/release", { method: "POST", headers: { "x-tendril-id": this.tid } }));
    await releasedAdmission.body?.cancel();
    this.scheduleAlarm();
    if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "held", "This page was held after screening. The owner can appeal.");
    return json({ role: "owner" });
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

  features(): Features {
    return { shared_by: this.db.get<string>('owner_label', 'Tendriller user'), ...runtimeRelease.features };
  }




  storageUsed(): number {
    return this.db.cached('files:stored-size', () =>
      this.db.one<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM stored_files")?.n ?? 0);
  }

  checkLocalStorage(additional: number): void {
    const limit = RESOURCE_LIMITS.page_bytes;
    const used = this.storageUsed()
      + this.db.one<{ n: number }>('SELECT COALESCE(SUM(length(value)),0) AS n FROM participant_records')!.n;
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
      if (message.includes("account_full")) {
        const limits = await accountLimits(this.env);
        throw new HttpError(413, "quota", "Account storage limit reached", { limit: limits.storage ?? ACCOUNT_STORAGE_LIMIT });
      }
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

  async createLink(role: Role, label: string | null, expiresIn: number | null, fromAgent = false, beforeInsert?: () => void, expectedEmail: string | null = null, targetView: string | null = null): Promise<Link> {
    if (expectedEmail !== null && role !== "guest") throw new HttpError(400, "bad_request", "Email restriction is only supported on guest invite links");
    const email = expectedEmail === null ? null : validOptionalEmail(expectedEmail);
    const view = targetView === null || targetView === "" ? null : targetView.trim();
    if (view !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(view)) {
      throw new HttpError(400, "bad_request", "view must be a lowercase facet id (a-z, 0-9, _, -)");
    }
    const id = newLinkId();
    const key = newPageKey();
    const hash = await sha256Hex(key);
    const now = this.now();
    const expires = expiresIn ? now + expiresIn * 1000 : null;
    this.transaction(() => {
      beforeInsert?.();
      if (role === "display") {
        const n = this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM links WHERE role = 'display'")?.n ?? 0;
        if (n >= 3) throw new HttpError(413, "quota", "At most three display links are allowed", { limit: 3, used: n });
      }
      this.db.run("INSERT INTO links (id, key, key_hash, role, label, created_at, expires_at, created_by_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, key, hash, role, label, now, expires, fromAgent ? 1 : 0);
      if (email) this.db.set(`link_email:${id}`, email);
      if (view) this.db.set(`link_view:${id}`, view);
    });
    return { id, key, role, label, expected_email: email, created_at: now, expires_at: expires, created_by_agent: fromAgent ? 1 : 0 };
  }

  renderLink(l: Link) {
    const email = l.expected_email !== undefined ? l.expected_email : this.db.get<string | null>(`link_email:${l.id}`, null);
    const view = this.db.get<string | null>(`link_view:${l.id}`, null);
    const baseUrl = this.linkUrl(l.key);
    const url = view ? `${baseUrl}?view=${encodeURIComponent(view)}` : baseUrl;
    return { id: l.id, url, role: l.role, label: l.label ?? null, email: email ?? null, ...(view ? { view } : {}), created_at: l.created_at, expires_at: l.expires_at ?? null };
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
    const l = this.db.cached(`links:key:${hash}`, () => {
      const row = this.db.one<Link & { key_hash: string }>("SELECT * FROM links WHERE key_hash = ?", hash);
      if (!row) return null;
      const expected_email = this.db.get<string | null>(`link_email:${row.id}`, null);
      return Object.freeze({ ...row, expected_email });
    });
    if (!l || !safeEqual(l.key_hash, hash)) return null;
    if (l.expires_at !== null && l.expires_at < this.now()) return null;
    return l;
  }

  // ---------------------------------------------------------------- alarm

  scheduleAlarm(): void {
    // The handler reconciles all deadlines once its work has finished. Avoid
    // persisting intermediate cleanup/recovery deadlines that are already due.
    if (this.handlingAlarm) return;
    this.afterCommit(() => this.scheduleCommittedAlarm());
  }

  private scheduleCommittedAlarm(): Promise<void> | void {
    if (!this.exists()) return;
    const now = this.now(), times = [this.db.get<number>('next_cleanup', now + DAY)];
    const peerDue = nextPeerDeadline(this), expires = this.expiresAt();
    if (peerDue !== null) times.push(peerDue);
    const relayDue = nextRelayDeadline(this);
    if (relayDue !== null) times.push(relayDue);
    if (lifetimeChangePending(this)) times.push(now + 5000);
    else if (expires !== null) times.push(expires);
    return this.alarms.ensure(Math.max(Math.min(...times) - this.skew, Date.now() + 1));
  }

  async alarm(): Promise<void> {
    await this.alarms.fired();
    this.handlingAlarm = true;
    try {
      if (!this.exists()) return;
      try { await recoverLifetimeChange(this); }
      catch (error) { console.error('Lifetime recovery remains pending', error); }
      // Expiry removes the entire object, so pruning and reconciling the same
      // records immediately before deletion would only add reads and writes.
      const due = this.expiresAt();
      if (due !== null && due <= this.now() && !lifetimeChangePending(this)) { await this.destroy(); return; }
      expirePeers(this);
      await expireRelays(this);
      if (this.db.get<number>('next_cleanup', 0) <= this.now()) await this.cleanup();
      const expires = this.expiresAt();
      if (expires !== null && expires <= this.now() && !lifetimeChangePending(this)) await this.destroy();
      // Only successful work reconciles deadlines. Re-arming failed, overdue
      // maintenance would replace the platform's backoff with a 1ms loop.
      this.handlingAlarm = false;
      await this.scheduleCommittedAlarm();
    } catch (error) {
      // A subsequent request must observe the runtime's pending retry instead
      // of treating the failed invocation as a successfully consumed alarm.
      await this.alarms.failed();
      throw error;
    } finally {
      this.handlingAlarm = false;
    }
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
    this.db.set('next_cleanup', now + DAY);
  }

  async pruneOrphanFiles(now: number): Promise<void> {
    // version_files.hash is NOT NULL. Materialize its reference set once rather
    // than scanning history for every stored file; no schema change needed.
    const rows = this.db.all<{ hash: string }>(`SELECT s.hash FROM stored_files s
      WHERE s.created_at < ? AND s.hash NOT IN (SELECT hash FROM version_files)`, now - HOUR);
    for (const { hash } of rows) {
      await deleteUnreferencedContent(this, hash, now - HOUR);
    }
  }

  // ---------------------------------------------------------------- deletion

  async destroy(): Promise<void> {
    const id = this.tid;
    const releaseAdmission = !!id && !this.db.get<string | null>("owner_account", null);
    // Granted agents learn of deletion; D1 grant rows cascade with the page index.
    const notified = id ? Promise.all(mirroredAgents(this).map(agentId => notifyAgentHub(this, agentId, "page-deleted", {}, id))) : null;
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
    if (id) {
      await this.env.ACCOUNTS.prepare("DELETE FROM tendrils WHERE id = ?").bind(id).run();
    }
    if (releaseAdmission) {
      const releasedAdmission = await this.env.ADMISSION.get(this.env.ADMISSION.idFromName("global")).fetch(new Request("https://admission.internal/release", {
        method: "POST", headers: { "x-tendril-id": id },
      }));
      await releasedAdmission.body?.cancel();
    }
    await notified;
    await this.ctx.storage.deleteAll();
    this.db.clearCache();
    this.db.init();
    // Clearing an alarm inside its handler can suppress retries. Keep it until
    // all fallible deletion work has completed so outages remain retryable.
    await this.alarms.clear();
  }
}

export function validName(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 100) throw new HttpError(400, "bad_request", "name must be a non-empty string of at most 100 characters");
  return v.trim();
}

export function validOptionalEmail(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "invalid_email", "Email must be a valid email address");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new HttpError(400, "invalid_email", "Enter a valid email address");
  }
  return trimmed.toLowerCase();
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
