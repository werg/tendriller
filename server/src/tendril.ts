import { isDiscoverySocket, closeDiscoverySocket, openDiscoveryHubStream, closeDiscoveryHubStream, type DiscoveryState } from './discovery';
import { isSetupWatch, notifySetupChanged, openSetupHubStream } from './setup-watch';
import { applicationPrepared, withAuthorityMutation } from './authority';
import { attestGrantedAgent, issueAgentAttestation, ownerAdmissionEmail } from './admissions';
import { isPublicationWatch, notifyPublicationWatchers } from "./publication-watch";
import { lifetimeChangePending, recoverLifetimeChange } from './lifetime';
import { isPeerSocket, handlePeerMessage, closePeer, nextPeerDeadline, expirePeers, openRendezvousHubStream, handlePeerHubData, closePeerHubStream, type PeerState } from './peers';
import { isRelaySocket, handleRelayMessage, closeRelay, nextRelayDeadline, expireRelays } from './peer-relay';
import { closeInvitationSocket, isInvitationSocket, handleInvitationMessage, openInvitationHubStream, handleInvitationHubData, type InvitationState } from './peer-invitations';
import { closeAllHubSubscribers, deleteHubSubscriber, getHubSubscriber, hubStreamKey, listHubSubscribers, type HubStreamDataResult, type HubStreamOpenResult, type HubStreamRef, type HubSubscriber } from './hub-streams';
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
import { requestTiming, withServerTiming } from './server-timing';
import { Transactions, type CommitEffect } from './transactions';
import { createVersion, deleteUnreferencedContent, servedVersion, storeContent, versionFiles, type VersionFile } from './files';
import { HttpError, json, readJson, toErrorResponse } from './http';
import { parseShareExpiry } from './sharing';
import { AGENT_PUBLIC_KEY_RE, AGENT_WRAP_KEY_RE, handleAgentGrants, mirroredAgents, notifyAgentHub, notifyGrantedAgents, validAgentBio, validAgentHandle, writeLocalGrant } from './agent-grants';
import { AGENT_ID_RE, newLinkId, newPageKey, sha256Hex, safeEqual } from './ids';
import type { Features } from './inject';
import { ACCESS_WRITE_INTERVAL, ACCOUNT_STORAGE_LIMIT, AD_HOC_IDLE, DAY, HOUR, PAGE_LIMIT, RESIDENT_LIMIT } from './limits';
import { accountLimits } from './service-state';
import { getAccountEntitlements, quotaError } from './billing/entitlements';
import { handlePage, pageAccessDenied } from './page';
import { dashboardIconUrl, serveIconBlob } from './page-icon';
import { isEmojiIcon } from './pwa';
import { enforceOrgDepartureOnPage, matchingPageGroupRule } from './groups/org-groups';
import { agentPageApi, barePageUrl, pageUrl, publicBase } from './urls';
import { AGENT_HEADER, AGENT_SCOPES, authenticateAgent, authenticateLocalPage, currentPrincipal, invalidatePagePolicyCache, pagePolicy, readPageSession, requireAgentScope } from './access';
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
    const timing = requestTiming(req);
    const started = Date.now();
    const res = await this.handle(req);
    timing.add("object", Date.now() - started);
    return withServerTiming(res, timing);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const kind = url.pathname.split("/")[1];
    try {
      if (kind === "create") return await this.create(req);
      if (kind === "create-owned") return await this.createOwned(req);
      if (!this.exists()) {
        if (kind === "page") return pageAccessDenied(401);
        throw new HttpError(404, "not_found", "No such tendril");
      }
      if (kind === "remix-source" && req.method === "GET") return this.remixSource(req);
      if (kind === "icon-blob" && (req.method === "GET" || req.method === "HEAD")) {
        if (this.db.get<boolean>("disabled", false)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
        const parts = url.pathname.split("/");
        const tag = decodeURIComponent(parts[2] ?? "");
        const file = decodeURIComponent(parts[3] ?? "");
        return await serveIconBlob(this, tag, file, req.method === "HEAD");
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
        invalidatePagePolicyCache(this);
        if (body.disabled) this.db.set("disabled_at", this.db.get<number | null>("disabled_at", null) ?? this.now());
        else this.db.del("disabled_at");
        if (body.disabled) {
          for (const ws of this.ctx.getWebSockets()) ws.close(4003, "page held");
          closeAllHubSubscribers(this, 4003, "page held");
        }
        this.scheduleAlarm();
        return json({ ok: true });
      }
      if (kind === "abuse" && url.pathname === "/abuse/preview" && req.method === "GET") {
        return json({ id: this.tid, name: this.db.get("name", "Tendril"),
          versions: this.db.all("SELECT version, created_at, risk_score, risk_flags FROM versions ORDER BY version DESC LIMIT 20"),
          files: this.db.all("SELECT version, path, type, size FROM version_files ORDER BY version DESC, path LIMIT 200"),
          activity: this.db.all("SELECT ts, kind, summary FROM activity ORDER BY seq DESC LIMIT 30") });
      }
      if (kind === 'hub' && req.method === 'POST') return await this.handleHubStream(req, url);
      if (kind === 'mcp' && req.method === 'POST') return await mcpRequest(this, req);
      if (kind === 'agent-grant') return await handleAgentGrants(this, req, url);
      if (kind === 'org-departure' && req.method === 'POST') {
        const b = await readJson(req, 8192);
        if (typeof b.account_id !== "string" || !Array.isArray(b.departed_groups)) {
          throw new HttpError(400, "bad_request", "account_id and departed_groups are required");
        }
        const result = await enforceOrgDepartureOnPage(this, {
          accountId: b.account_id,
          departedGroups: b.departed_groups.filter((g: unknown): g is string => typeof g === "string"),
          observedAbsentAt: typeof b.observed_absent_at === "number" ? b.observed_absent_at : this.now(),
        });
        return json(result);
      }
      if (kind === 'agent-summary') {
        const agentId = req.headers.get(AGENT_HEADER) ?? '';
        if (!AGENT_ID_RE.test(agentId)) throw new HttpError(400, 'invalid_agent');
        return json(agentPageSummary(this, agentId));
      }
      if (kind === "account" && req.headers.get("x-account-id") && req.headers.get("x-account-id") === this.db.get<string | null>("owner_account", null)) {
        if (url.pathname === "/account/summary" && req.method === "GET") {
          const iconUrl = await dashboardIconUrl(this);
          return json({
            name: this.db.get("name", "Tendril"),
            page_url: this.mainPageUrl(),
            bare_url: this.barePageUrl(),
            fallback_page_url: this.mainPageUrl({ fallback: true }),
            fallback_bare_url: this.barePageUrl({ fallback: true }),
            subdomain: this.activeSubdomain(),
            icon: this.db.get<string | null>("icon", null),
            icon_url: iconUrl,
            theme_color: this.db.get<string | null>("theme_color", null) ?? this.db.get<string | null>("authored_theme_color", null),
            version: this.db.get("current", 0), held: this.db.get("disabled", false),
            bytes: this.storageUsed(),
            agents: (this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM agent_grants")?.n ?? 0)
              + (this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_connections")?.n ?? 0),
            primary_agent_id: this.db.get<string | null>("primary_agent_id", null),
            guests_waiting: this.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM guest_accounts WHERE approved = 0")?.n ?? 0,
            open_readers: this.db.get<boolean>("v2_open_readers", false),
            open_writers: this.db.get<boolean>("v2_open_writers", false),
            last_activity: this.db.one<{ ts: number; summary: string }>("SELECT ts, summary FROM activity ORDER BY seq DESC LIMIT 1"),
          });
        }
        if (url.pathname === "/account/subdomain" && req.method === "POST") {
          const body = await readJson(req, 4096);
          const next = body.subdomain === null ? null : typeof body.subdomain === "string" ? body.subdomain.trim().toLowerCase() || null : undefined;
          if (next === undefined) throw new HttpError(400, "bad_request", "Expected { subdomain: string | null }");
          const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 120) : `owner:${req.headers.get("x-account-id")}`;
          const prev = this.activeSubdomain();
          this.transaction(() => {
            if (next === null) this.db.del("subdomain");
            else this.db.set("subdomain", next);
            if (prev !== next) {
              addActivity(this, {
                kind: "subdomain",
                summary: next
                  ? `Set named subdomain to ${next}.${this.env.PAGE_BASE_DOMAIN}`
                  : `Removed named subdomain${prev ? ` (${prev}.${this.env.PAGE_BASE_DOMAIN})` : ""}`,
                by,
              });
            }
          });
          return json({
            id: this.tid,
            subdomain: this.activeSubdomain(),
            page_url: this.mainPageUrl(),
            bare_url: this.barePageUrl(),
            fallback_page_url: this.mainPageUrl({ fallback: true }),
            fallback_bare_url: this.barePageUrl({ fallback: true }),
          });
        }
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

  /** Stateless DO-to-DO virtual stream endpoints called by AgentHub. */
  private async handleHubStream(req: Request, url: URL): Promise<Response> {
    if (url.pathname === '/hub/stream/close') {
      const body = await readJson(req, 64 * 1024);
      const agentId = typeof body.agentId === 'string' ? body.agentId : '';
      const connId = typeof body.connId === 'string' ? body.connId : '';
      if (!AGENT_ID_RE.test(agentId) || !connId) throw new HttpError(400, 'bad_request');
      const filter = Array.isArray(body.streams) ? new Set(body.streams.filter((v: unknown): v is number => Number.isInteger(v))) : null;
      const rows = listHubSubscribers(this).filter(sub => sub.agentId === agentId && sub.connId === connId && (!filter || filter.has(sub.streamId)));
      for (const sub of rows) {
        deleteHubSubscriber(this, sub.key);
        if (sub.kind === 'peer-discovery') closeDiscoveryHubStream(this, sub as HubSubscriber<DiscoveryState>);
        else if (sub.kind === 'rendezvous') closePeerHubStream(this, sub as HubSubscriber<PeerState>);
      }
      return json({ closed: rows.length });
    }
    if (url.pathname === '/hub/stream/data') {
      const body = await readJson(req, 1024 * 1024 + 4096);
      const agentId = typeof body.agentId === 'string' ? body.agentId : '';
      const connId = typeof body.connId === 'string' ? body.connId : '';
      const s = body.s;
      if (!AGENT_ID_RE.test(agentId) || !connId || !Number.isInteger(s)) throw new HttpError(400, 'bad_request');
      const key = hubStreamKey(agentId, connId, s as number);
      const sub = getHubSubscriber(this, key);
      if (!sub) return json({ close: { code: 1011, reason: 'stream_unknown' } } satisfies HubStreamDataResult);
      if (sub.kind === 'peer-discovery') {
        deleteHubSubscriber(this, sub.key);
        closeDiscoveryHubStream(this, sub as HubSubscriber<DiscoveryState>);
        return json({ close: { code: 1008, reason: 'Discovery watch is receive-only' } } satisfies HubStreamDataResult);
      }
      if (sub.kind === 'setup-watch') {
        deleteHubSubscriber(this, sub.key);
        return json({ close: { code: 1008, reason: 'Setup watch is receive-only' } } satisfies HubStreamDataResult);
      }
      try { await this.admitTraffic('agent'); }
      catch {
        deleteHubSubscriber(this, sub.key);
        if (sub.kind === 'rendezvous') closePeerHubStream(this, sub as HubSubscriber<PeerState>);
        return json({ close: { code: 1013, reason: 'Page traffic limit reached; reconnect shortly' } } satisfies HubStreamDataResult);
      }
      if (typeof body.text !== 'string') {
        deleteHubSubscriber(this, sub.key);
        if (sub.kind === 'rendezvous') closePeerHubStream(this, sub as HubSubscriber<PeerState>);
        return json({
          close: {
            code: 1009,
            reason: sub.kind === 'peer-invitations'
              ? 'Invitations accept bounded acknowledgements'
              : 'Rendezvous accepts bounded SDP/ICE signaling only',
          },
        } satisfies HubStreamDataResult);
      }
      if (sub.kind === 'peer-invitations') {
        return json(handleInvitationHubData(this, sub as HubSubscriber<InvitationState>, body.text));
      }
      if (sub.kind === 'rendezvous') {
        return json(await handlePeerHubData(this, sub as HubSubscriber<PeerState>, body.text));
      }
      deleteHubSubscriber(this, sub.key);
      return json({ close: { code: 1008, reason: 'Unsupported participant transport' } } satisfies HubStreamDataResult);
    }
    if (url.pathname === '/hub/stream/open') {
      await this.admitTraffic('agent');
      await recoverLifetimeChange(this);
      const owner = this.db.get<string | null>('owner_account', null);
      if (owner && await this.checkPagePolicy() === 'page') {
        throw new HttpError(403, 'disabled', 'This tendril is unavailable');
      }
      if (this.db.get<boolean>('disabled', false)) {
        throw new HttpError(403, 'disabled', 'This tendril is unavailable');
      }
      const body = await readJson(req, 16 * 1024);
      const connId = typeof body.connId === 'string' ? body.connId : '';
      const s = body.s;
      const path = typeof body.path === 'string' ? body.path : '';
      const protocols = Array.isArray(body.protocols) ? body.protocols.filter((p: unknown): p is string => typeof p === 'string') : [];
      if (!connId || !Number.isInteger(s)) throw new HttpError(400, 'bad_request');
      const principal = authenticateAgent(this, req);
      this.recordAccess();
      const baseRef: Omit<HubStreamRef, 'kind'> = {
        key: hubStreamKey(principal.agentId, connId, s as number),
        agentId: principal.agentId,
        connId,
        streamId: s as number,
      };
      let result: HubStreamOpenResult;
      if (path === 'setup/watch') {
        result = await openSetupHubStream(this, protocols, principal, { ...baseRef, kind: 'setup-watch' });
      } else if (path === 'peers/discovery/watch') {
        requireAgentScope(principal, 'participants:connect');
        result = await openDiscoveryHubStream(this, url, protocols, principal, { ...baseRef, kind: 'peer-discovery' });
      } else if (path === 'peers/invitations') {
        requireAgentScope(principal, 'participants:connect');
        result = await openInvitationHubStream(this, url, protocols, principal, { ...baseRef, kind: 'peer-invitations' });
      } else if (path === 'peers/rendezvous') {
        requireAgentScope(principal, 'participants:connect');
        result = await openRendezvousHubStream(this, url, protocols, principal, { ...baseRef, kind: 'rendezvous' });
      } else {
        throw new HttpError(404, 'not_found');
      }
      return json(result);
    }
    throw new HttpError(404, 'not_found');
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
    if (isInvitationSocket(ws)) closeInvitationSocket(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch {}
    if (isPeerSocket(ws)) closePeer(this, ws);
    if (isRelaySocket(ws)) closeRelay(this, ws);
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    if (isDiscoverySocket(ws)) { closeDiscoverySocket(this, ws); try { ws.close(1011); } catch {} return; }
    if (isInvitationSocket(ws)) { closeInvitationSocket(ws); try { ws.close(1011); } catch {} return; }
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
    let icon: string | null = null;
    if (body.icon !== undefined && body.icon !== null) {
      if (typeof body.icon !== "string" || body.icon.length > 512 || !(/^https:\/\/\S+$/.test(body.icon) || isEmojiIcon(body.icon))) {
        throw new HttpError(400, "bad_request", "icon must be a single emoji or an https URL");
      }
      icon = body.icon;
    }
    let themeColor: string | null = null;
    if (body.theme_color !== undefined && body.theme_color !== null) {
      if (typeof body.theme_color !== "string" || !/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,30})$/.test(body.theme_color)) {
        throw new HttpError(400, "bad_request", "theme_color must be a CSS color like #336699");
      }
      themeColor = body.theme_color;
    }
    const owner = account ? null : validIntendedOwner(body.owner);
    const label = account ? await this.env.ACCOUNTS.prepare("SELECT login FROM identities WHERE account_id = ? ORDER BY created_at LIMIT 1")
      .bind(account).first<{ login: string }>() : null;
    const now = this.now();
    const key = newPageKey(), keyHash = await sha256Hex(key);
    const grant = this.transaction(() => {
      this.db.set("id", id);
      this.db.set("name", name);
      if (icon !== null) this.db.set("icon", icon);
      if (themeColor !== null) this.db.set("theme_color", themeColor);
      if (owner) this.db.set("intended_owner", owner);
      if (account) {
        this.db.set("owner_account", account);
        this.db.set("claimed_at", now);
        if (label) this.db.set("owner_label", label.login.slice(0, 80));
      }
      this.db.set("lifetime", "ad_hoc");
      this.db.set("application", applicationSelection(body.application ?? { id: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("") }));
      if (body.application !== undefined) this.db.set("application_pinned", true);
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

  /**
   * Owner-direct page creation with zero agent required (used by Remix and browser-first starter launch).
   * Optionally seeds immutable public v1 files into R2 and rewrites `configuration.json` to bind
   * the brand-new `applicationId`, `page_url`, and optional `authority` hint.
   */
  private async createOwned(req: Request): Promise<Response> {
    if (this.exists()) throw new HttpError(409, "exists");
    const id = req.headers.get("x-tendril-id") ?? "";
    const account = req.headers.get("x-account-id") ?? "";
    if (!id || !account) throw new HttpError(400, "bad_request", "Missing page ID or owner account");
    const body = await readJson(req, 8 * 1024 * 1024);
    const name = body.name === undefined ? "New Page" : validName(body.name);
    const entry = typeof body.entry === "string" && body.entry.trim() ? body.entry.trim() : "index.html";
    const rawFiles = Array.isArray(body.files) ? body.files : [];
    const rewriteConfigJson = body.rewriteConfigJson === true;
    const authorityHint = body.authorityHint && typeof body.authorityHint === "object" ? body.authorityHint : null;
    const activitySummary = typeof body.activitySummary === "string" && body.activitySummary.trim()
      ? body.activitySummary.trim().slice(0, 200)
      : `Page "${name}" created from dashboard`;

    const label = await this.env.ACCOUNTS.prepare("SELECT login FROM identities WHERE account_id = ? ORDER BY created_at LIMIT 1")
      .bind(account).first<{ login: string }>();
    const now = this.now();
    const key = newPageKey(), keyHash = await sha256Hex(key);
    const appId = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");

    const iconVal = typeof body.icon === "string" && body.icon.length <= 512 && (/^https:\/\/\S+$/.test(body.icon) || isEmojiIcon(body.icon))
      ? body.icon : null;
    const themeColorVal = typeof body.theme_color === "string" && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,30})$/.test(body.theme_color)
      ? body.theme_color : null;

    this.transaction(() => {
      this.db.set("id", id);
      this.db.set("name", name);
      if (iconVal !== null) this.db.set("icon", iconVal);
      if (themeColorVal !== null) this.db.set("theme_color", themeColorVal);
      this.db.set("owner_account", account);
      this.db.set("claimed_at", now);
      if (label) this.db.set("owner_label", label.login.slice(0, 80));
      this.db.set("lifetime", "ad_hoc");
      this.db.set("application", applicationSelection({ id: appId }));
      this.db.set("created_at", now);
      this.db.set("next_cleanup", now + DAY);
      this.db.run(
        "INSERT INTO links (id, key, key_hash, role, label, created_at, expires_at) VALUES ('l_main', ?, ?, 'owner', 'main', ?, NULL)",
        key, keyHash, now,
      );
      addActivity(this, { kind: "created", summary: activitySummary, by: `owner:${account}` });
    });

    const pageUrlValue = this.mainPageUrl();
    let version = 0;
    if (rawFiles.length > 0) {
      const ent = await getAccountEntitlements(this.env, account, now).catch(() => null);
      const pageLimit = ent?.quotas.pageStorageBytes;
      const versionMap = new Map<string, VersionFile>();
      for (const item of rawFiles as Array<{ path?: unknown; type?: unknown; bytesBase64?: unknown }>) {
        if (!item || typeof item.path !== "string" || typeof item.type !== "string" || typeof item.bytesBase64 !== "string") {
          throw new HttpError(400, "invalid_seed_file");
        }
        let bytes: Uint8Array;
        if (rewriteConfigJson && item.path === "configuration.json") {
          const nextConfig: Record<string, unknown> = {
            applicationId: appId,
            page_url: pageUrlValue,
            ...(authorityHint ? { authority: authorityHint } : {}),
            ...(body.blueprint && typeof body.blueprint === "object" ? { blueprint: body.blueprint } : {}),
          };
          bytes = new TextEncoder().encode(JSON.stringify(nextConfig, null, 2) + "\n");
        } else {
          const bin = atob(item.bytesBase64);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        }
        const hash = await sha256Hex(bytes);
        await storeContent(this, bytes.slice().buffer, item.type, { pageLimit });
        versionMap.set(item.path, { path: item.path, hash, type: item.type, size: bytes.byteLength });
      }
      if (!versionMap.has(entry)) throw new HttpError(400, "entry_missing", `Entry file ${entry} missing from seeded files`);
      await createVersion(this, versionMap, null, `owner:${account}`, {
        entry,
        beforeCommit: async () => {},
        commit(v) { version = v; },
      });
    }

    this.recordAccess();
    this.scheduleAlarm();
    return json({ id, name, page_url: pageUrlValue, version, application: { id: appId } }, 201);
  }

  /** Return ONLY public publication metadata for Remix (never private ops, keys, or envelopes). */
  private remixSource(req: Request): Response {
    const requester = req.headers.get("x-account-id") ?? "";
    const owner = this.db.get<string | null>("owner_account", null);
    const openReaders = this.db.get<boolean>("v2_open_readers", false);
    if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "disabled", "This page is unavailable");
    if (!requester || (requester !== owner && !openReaders)) {
      throw new HttpError(403, "forbidden", "Only the owner (or any signed-in user on a public page) can remix this page.");
    }
    const v = servedVersion(this);
    if (v <= 0) throw new HttpError(409, "not_published", "Publish a version before remixing this page.");
    const ver = this.db.one<{ entry: string | null }>("SELECT entry FROM versions WHERE version = ?", v);
    const files = versionFiles(this, v);
    return json({
      id: this.tid,
      name: this.db.get("name", "Tendril"),
      icon: this.db.get<string | null>("icon", null),
      theme_color: this.db.get<string | null>("theme_color", null),
      entry: ver?.entry || "index.html",
      files,
    });
  }

  /** The agent-facing description of a newly created page. Contains no credential. */
  pageResult() {
    const application = selectedApplication(this);
    const claimed = this.db.get<string | null>("owner_account", null) !== null;
    const subdomain = this.activeSubdomain();
    return {
      id: this.tid,
      name: this.db.get("name", "Tendril"),
      subdomain,
      page_url: this.mainPageUrl(),
      bare_url: this.barePageUrl(),
      fallback_page_url: this.mainPageUrl({ fallback: true }),
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

  activeSubdomain(): string | null {
    return this.db.get<string | null>("subdomain", null);
  }

  mainLink(): Link | null {
    return this.db.cached('links:main-row', () => {
      const row = this.db.one<Link>("SELECT * FROM links WHERE id = 'l_main'");
      return row ? Object.freeze(row) : null;
    }, ['links']);
  }

  mainPageUrl(options?: { fallback?: boolean }): string {
    const key = this.db.cached('links:main-key', () =>
      this.db.one<{ key: string }>("SELECT key FROM links WHERE id = 'l_main'")!.key, ['links']);
    return pageUrl(this.env, this.tid, key, options?.fallback ? null : this.activeSubdomain());
  }

  barePageUrl(options?: { fallback?: boolean }): string {
    return barePageUrl(this.env, this.tid, options?.fallback ? null : this.activeSubdomain());
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
    closeAllHubSubscribers(this, 4003, "page held");
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
    if (url.pathname === "/claim/bare-info" && req.method === "GET") {
      return json({
        claimed: !!this.db.get<string | null>("owner_account", null),
        open_readers: this.db.get<boolean>("v2_open_readers", false),
      });
    }
    const bare = req.headers.get("x-tendril-bare") === "1";
    const key = req.headers.get("x-tendril-key") ?? "";
    const link = bare ? this.mainLink() : await this.linkForKey(key);
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
      const { principal } = await authenticateLocalPage(this, req, link, { bare });
      if (principal.role === "display") {
        await this.recordVisitorSignal("display", req.headers.get("x-visitor-ip") ?? "");
        if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "disabled");
      }
      const status = await this.checkPagePolicy(principal.role === "display" ? null : principal.accountId);
      if (status === "page") throw new HttpError(403, "disabled");
      if (status === "visitor" || !currentPrincipal(this, principal, bare ? undefined : key)) throw new HttpError(401, "unauthorized");
      return json({ role: principal.role });
    }
    if (url.pathname === "/claim/session" && req.method === "POST") {
      const b = await readJson(req, 4096);
      if (typeof b.account_id !== "string" || typeof b.hash !== "string" || !/^[a-f0-9]{64}$/.test(b.hash)) throw new HttpError(403, "forbidden");
      if (bare && b.role !== "owner") throw new HttpError(403, "forbidden");
      if (b.role === "owner" && (link.role !== "owner" || b.account_id !== this.db.get<string | null>("owner_account", null))) throw new HttpError(403, "forbidden");
      if (b.role === "guest") {
        const orgApproved = link.role === "owner" && this.db.one("SELECT 1 AS x FROM guest_accounts WHERE account_id = ? AND link_id = '__org__' AND approved = 1", b.account_id);
        const linkApproved = link.role === "guest" && this.db.one("SELECT 1 AS x FROM guest_accounts WHERE account_id = ? AND link_id = ? AND approved = 1", b.account_id, link.id);
        if (!orgApproved && !linkApproved) throw new HttpError(403, "forbidden");
      }
      if (b.role !== "owner" && b.role !== "guest") throw new HttpError(403, "forbidden");
      this.db.run("INSERT INTO page_sessions (hash, account_id, role, expires_at) VALUES (?, ?, ?, ?)", b.hash, b.account_id, b.role, this.now() + 30 * DAY);
      return json({ ok: true });
    }
    if (url.pathname === "/claim/org" && req.method === "POST") {
      const b = await readJson(req, 4096);
      if (link.role !== "owner" || !this.db.get<string | null>("owner_account", null) || typeof b.account_id !== "string") throw new HttpError(403, "forbidden");
      const rule = await matchingPageGroupRule(this, b.account_id);
      if (!rule) throw new HttpError(403, "org_membership_required", "Your account does not belong to an authorized organization or team for this page");
      this.db.run("INSERT OR REPLACE INTO guest_accounts (account_id, link_id, approved, created_at) VALUES (?, '__org__', 1, ?)",
        b.account_id, this.now());
      this.db.set(`org_member:${b.account_id}`, {
        accountId: b.account_id,
        group: rule.group.toLowerCase(),
        ruleId: rule.ruleId,
        role: rule.role,
        joinedAt: this.now(),
      });
      await this.recordVisitorSignal("guest", b.account_id);
      if (this.db.get<boolean>("disabled", false)) throw new HttpError(403, "disabled");
      return json({ approved: true, group: rule.group, rule_id: rule.ruleId, role: rule.role });
    }
    if (url.pathname === "/claim/guest" && req.method === "POST") {
      const b = await readJson(req, 8192);
      if (link.role !== "guest" || !this.db.get<string | null>("owner_account", null) || typeof b.account_id !== "string") throw new HttpError(403, "forbidden");
      if (link.expected_email) {
        if (!Array.isArray(b.identities) || !ownerMatches(link.expected_email, b.identities)) {
          throw new HttpError(403, "wrong_guest_email", "This invitation is for a different email address");
        }
      }
      const existingGuest = this.db.one<{ approved: number }>("SELECT approved FROM guest_accounts WHERE account_id = ? AND link_id = ?", b.account_id, link.id);
      if (!existingGuest) {
        const pageOwner = this.db.get<string | null>("owner_account", null);
        const ent = pageOwner ? await getAccountEntitlements(this.env, pageOwner, this.now()).catch(() => null) : null;
        if (ent && ent.quotas.guestsPerPage !== null) {
          const distinctGuests = this.db.one<{ n: number }>("SELECT COUNT(DISTINCT account_id) AS n FROM guest_accounts WHERE approved = 1 AND account_id != ?", b.account_id)?.n ?? 0;
          if (distinctGuests >= ent.quotas.guestsPerPage) {
            throw quotaError({
              env: this.env,
              quota: "guests",
              plan: ent.plan,
              used: distinctGuests,
              limit: ent.quotas.guestsPerPage,
              resetsAt: null,
              message: `This page has reached its guest limit (${ent.quotas.guestsPerPage} guests on ${ent.plan}).`,
              localAlternative: "The page owner can remove an unused guest, upgrade for more guests per page, or self-host on Cloudflare.",
            });
          }
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
          const [limits, ent] = await Promise.all([
            accountLimits(this.env, accountId),
            getAccountEntitlements(this.env, accountId, this.now()).catch(() => null),
          ]);
          const plan = ent?.plan ?? "free";
          if (msg.includes("account_residents_full")) {
            const limit = limits.residents ?? RESIDENT_LIMIT;
            throw quotaError({ env: this.env, code: "quota", status: 429, quota: "residents", plan, used: limit, limit, resetsAt: null, message: "Account resident tendril limit reached" });
          }
          if (msg.includes("account_tendrils_full")) {
            const limit = limits.pages ?? PAGE_LIMIT;
            throw quotaError({ env: this.env, code: "quota", status: 429, quota: "pages", plan, used: limit, limit, resetsAt: null, message: "Account tendril limit reached" });
          }
          const limit = limits.storage ?? ACCOUNT_STORAGE_LIMIT;
          throw quotaError({ env: this.env, code: "quota", status: 413, quota: "storage", plan, used: limit, limit, resetsAt: null, message: "Account storage limit reached" });
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
    return pageUrl(this.env, this.tid, key, this.activeSubdomain());
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
      this.db.one<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM stored_files")?.n ?? 0, ['stored_files']);
  }

  checkLocalStorage(additional: number, pageLimit: number = RESOURCE_LIMITS.page_bytes): void {
    const limit = pageLimit;
    const used = this.storageUsed()
      + this.db.one<{ n: number }>('SELECT COALESCE(SUM(length(value)),0) AS n FROM participant_records')!.n;
    if (used + additional > limit) throw new HttpError(413, "quota", "Tendril storage limit reached", { limit, used });
  }

  reserveStoredFile(hash: string, size: number, riskScore: number, pageLimit?: number): boolean {
    const stored = this.db.one<{ size: number }>("SELECT size FROM stored_files WHERE hash=?", hash);
    if (stored) {
      if (stored.size !== size) throw new HttpError(422, "digest_size_mismatch", "Stored content has a different size");
      return false;
    }
    this.checkLocalStorage(size, pageLimit);
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
        const owner = this.db.get<string | null>("owner_account", null);
        const [limits, ent] = await Promise.all([
          accountLimits(this.env, owner),
          owner ? getAccountEntitlements(this.env, owner, this.now()).catch(() => null) : Promise.resolve(null),
        ]);
        const limit = limits.storage ?? ACCOUNT_STORAGE_LIMIT;
        throw quotaError({
          env: this.env,
          code: "quota",
          status: 413,
          quota: "storage",
          plan: ent?.plan ?? "free",
          used: limit,
          limit,
          resetsAt: null,
          message: "Account storage limit reached",
        });
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
    }, ['links', 'meta:link_email:']);
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
    closeAllHubSubscribers(this, 4004, "tendril deleted");
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
