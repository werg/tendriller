/** Explicit page-host lifecycle and the filtered Chronolog participant transport. */
import { upgradeSetupWatch } from './setup-watch';
import { changeLifetime } from './lifetime';
import { PEER_ROUTE, handlePeers } from './peers';
import { applicationPrepared, withUnconfiguredApplication } from './authority';
import { handleApplication, selectedApplication } from './application';
import type { Tendril } from './tendril';
import { validName, validOptionalEmail } from './tendril';
import { addActivity, listActivity } from './activity';
import { pointers } from './files';
import { HttpError, intParam, json, readJson } from './http';
import { newPageKey, sha256Hex } from './ids';
import { serviceDescriptor } from './descriptor';
import { authenticateAgent, localAgentGrant, requireAgentScope, type AgentPrincipal } from './access';
import { pageAgents } from './agent-grants';
import { handleEnvelopeSync } from './mcp-participant';
import { onboardingDescriptor } from './onboarding';
import { publicBase } from './urls';
import { isEmojiIcon, validateShortcuts, type PageShortcut } from './pwa';
import { sendPushNotification } from './push';
import { setPageSubdomain } from './subdomains';

const ROLES = new Set(["owner", "guest", "display"]);

type Handler = (t: Tendril, req: Request, url: URL, by: string, params: string[], principal: AgentPrincipal) => Promise<Response> | Response;

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
  const rest = decodeURIComponent(req.headers.get('x-tendril-rest') ?? '');
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const principal = authenticateAgent(t, req);
  t.recordAccess();
  if (PEER_ROUTE.test(rest)) {
    requireAgentScope(principal, 'participants:connect');
    if (rest === 'peers/bootstrap' && method !== 'GET') requireAgentScope(principal, 'host:manage');
    return handlePeers(t, req, url, rest, principal);
  }
  if (rest === 'setup/watch') return upgradeSetupWatch(t, req, principal);
  if (rest === 'mcp/sync' && method === 'POST') {
    requireAgentScope(principal, 'participants:connect');
    return handleEnvelopeSync(t, req);
  }
  if (rest === 'push' && method === 'POST') {
    requireAgentScope(principal, 'notifications:send');
    const body = await readJson(req, 8192);
    return json(await sendPushNotification(t, body));
  }
  if (rest === 'application') { requireAgentScope(principal, 'host:read'); return handleApplication(t, req, principal); }
  const matches = routes.filter(route => route.pattern.test(rest));
  if (!matches.length) throw new HttpError(404, 'not_found', `No host route ${rest || '/'}`);
  const route = matches.find(route => route.method === method);
  if (!route) throw new HttpError(405, 'method_not_allowed');
  requireAgentScope(principal, method === 'GET' ? 'host:read' : 'host:manage');
  return route.handler(t, req, url, `agent:${principal.agentId}`, route.pattern.exec(rest)!.slice(1), principal);
}
/** Granted-page summary for agent listings; includes primary status and page @handle roster. */
export function agentPageSummary(t: Tendril, agentId: string) {
  const grant = localAgentGrant(t, agentId);
  const roster = pageAgents(t);
  return {
    id: t.tid, name: t.db.get('name', 'Tendril'), subdomain: t.activeSubdomain(),
    page_url: t.mainPageUrl(), bare_url: t.barePageUrl(), fallback_page_url: t.mainPageUrl({ fallback: true }),
    lifetime: t.db.get('lifetime', 'ad_hoc'),
    application: { id: selectedApplication(t).id }, claimed: t.db.get<string | null>('owner_account', null) !== null,
    expires_at: t.expiresAt(), scopes: grant?.scopes ?? [], granted_by: grant?.granted_by ?? null,
    primary_agent_id: roster.primary_agent_id, is_primary: roster.primary_agent_id === agentId, agents: roster.agents,
  };
}
async function tendrilInfo(t: Tendril, agentId?: string) {
  const ownerId = t.db.get<string | null>('owner_account', null);
  const owner = ownerId && t.env.ACCOUNTS ? await t.env.ACCOUNTS.prepare('SELECT provider, login FROM identities WHERE account_id = ? ORDER BY created_at LIMIT 1')
    .bind(ownerId).first<{ provider: string; login: string }>() : null;
  const roster = pageAgents(t);
  return {
    id: t.tid, name: t.db.get('name', 'Tendril'), subdomain: t.activeSubdomain(),
    page_url: t.mainPageUrl(), bare_url: t.barePageUrl(), fallback_page_url: t.mainPageUrl({ fallback: true }),
    lifetime: t.db.get('lifetime', 'ad_hoc'),
    application: selectedApplication(t), configured: applicationPrepared(t),
    expires_at: t.expiresAt(), owner, owner_account_id: ownerId, version: pointers(t), meta: tendrilMeta(t),
    primary_agent_id: roster.primary_agent_id,
    ...(agentId ? { is_primary: roster.primary_agent_id === agentId } : {}),
    agents: roster.agents,
  };
}
export function tendrilMeta(t: Tendril) {
  return {
    created_at: t.db.get("created_at", null),
    short_name: t.db.get<string | null>("short_name", null),
    theme_color: t.db.get<string | null>("theme_color", null),
    background_color: t.db.get<string | null>("background_color", null),
    icon: t.db.get<string | null>("icon", null),
    shortcuts: t.db.get<PageShortcut[] | null>("page_shortcuts", null),
    share_target: t.db.get<boolean>("share_target_enabled", true),
  };
}

route('GET', /^$/, async (t, _req, _url, _by, _params, principal) => json({ ...await tendrilInfo(t, principal.agentId), scopes: principal.scopes }));
route('GET', /^service$/, t => json(serviceDescriptor(t.env)));
route('GET', /^guide$/, t => json(onboardingDescriptor(publicBase(t.env))));
async function requireAgentManageOnPage(t: Tendril, agentId: string, targetPageId: string): Promise<void> {
  if (!t.env.ACCOUNTS) throw new HttpError(503, "unavailable", "Accounts database is not configured");
  const row = await t.env.ACCOUNTS.prepare(
    "SELECT scopes FROM agent_grants WHERE agent_id = ? AND page_id = ?",
  ).bind(agentId, targetPageId).first<{ scopes: string }>();
  if (!row) {
    throw new HttpError(403, "forbidden", `This agent does not have access to page ${targetPageId}, which currently holds this subdomain.`);
  }
  const scopes = JSON.parse(row.scopes) as string[];
  if (!scopes.includes("host:manage")) {
    throw new HttpError(403, "agent_scope_required", `Reassigning from page ${targetPageId} requires host:manage scope on that page.`);
  }
}

route("PATCH", /^$/, async (t, req, _url, by, _params, principal) => {
  const b = await readJson(req, 64 * 1024);
  if (b.name !== undefined) t.db.set("name", validName(b.name));
  if (b.lifetime !== undefined) {
    if (b.lifetime !== "ad_hoc" && b.lifetime !== "resident") throw new HttpError(400, "bad_request", "lifetime must be ad_hoc or resident");
    await changeLifetime(t, b.lifetime);
  }
  if (b.subdomain !== undefined) {
    if (b.subdomain !== null && typeof b.subdomain !== "string") {
      throw new HttpError(400, "invalid_subdomain", "subdomain must be a string or null to remove");
    }
    const owner = t.db.get<string | null>("owner_account", null);
    if (!owner) {
      throw new HttpError(409, "claim_required", "Claim this page with a paid account before assigning a named subdomain.");
    }
    await setPageSubdomain(t.env, owner, t.tid, b.subdomain, by, {
      reassign: b.reassign === true,
      swap: b.swap === true,
      authorizeDisplacedPage: (prevId) => requireAgentManageOnPage(t, principal.agentId, prevId),
    });
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
      const ok = typeof b.icon === "string" && (/^https:\/\/\S+$/.test(b.icon) || isEmojiIcon(b.icon));
      if (!ok) throw new HttpError(400, "bad_request", "icon must be a single emoji, an https URL, or null to reset");
    }
    t.db.set("icon", b.icon);
  }
  if (b.shortcuts !== undefined) {
    if (b.shortcuts === null) {
      t.db.del("page_shortcuts");
    } else {
      try { t.db.set("page_shortcuts", validateShortcuts(b.shortcuts)); }
      catch (err) { throw new HttpError(400, "bad_request", err instanceof Error ? err.message : "Invalid shortcuts"); }
    }
  }
  if (b.share_target !== undefined) {
    if (b.share_target === null) t.db.set("share_target_enabled", true);
    else if (typeof b.share_target === "boolean") t.db.set("share_target_enabled", b.share_target);
    else throw new HttpError(400, "bad_request", "share_target must be a boolean or null");
  }
  t.scheduleAlarm();
  return json(await tendrilInfo(t));
});

route("PUT", /^subdomain$/, async (t, req, _url, by, _params, principal) => {
  const b = await readJson(req, 4096);
  if (b.subdomain !== null && typeof b.subdomain !== "string") {
    throw new HttpError(400, "invalid_subdomain", "Expected { subdomain: string | null }");
  }
  const owner = t.db.get<string | null>("owner_account", null);
  if (!owner) {
    throw new HttpError(409, "claim_required", "Claim this page with a paid account before assigning a named subdomain.");
  }
  return json(await setPageSubdomain(t.env, owner, t.tid, b.subdomain, by, {
    reassign: b.reassign === true,
    swap: b.swap === true,
    authorizeDisplacedPage: (prevId) => requireAgentManageOnPage(t, principal.agentId, prevId),
  }));
});

route("DELETE", /^subdomain$/, async (t, _req, _url, by) => {
  const owner = t.db.get<string | null>("owner_account", null);
  if (!owner) {
    throw new HttpError(409, "claim_required", "This page is not claimed.");
  }
  return json(await setPageSubdomain(t.env, owner, t.tid, null, by));
});

route("DELETE", /^$/, async (t) => {
  await t.destroy();
  return new Response(null, { status: 204 });
});

route("POST", /^release$/, t => withUnconfiguredApplication(t, async () => {
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
  if (!t.env.ACCOUNTS || !t.env.ADMISSION) throw new HttpError(503, "unavailable");
  const admission = t.env.ADMISSION.get(t.env.ADMISSION.idFromName("global"));
  const reopened = await admission.fetch(new Request("https://admission.internal/reopen", { method: "POST", headers: { "x-tendril-id": t.tid } }));
  if (!reopened.ok) {
    if (reopened.status !== 404) return reopened;
    await reopened.body?.cancel();
    const reserved = await admission.fetch(new Request("https://admission.internal/reserve", { method: "POST", headers: { "x-tendril-id": t.tid } }));
    if (!reserved.ok) return reserved;
    await reserved.body?.cancel();
  } else await reopened.body?.cancel();
  try {
    const row = await t.env.ACCOUNTS.prepare("UPDATE tendrils SET owner_account = NULL, claimed_at = NULL WHERE id = ? AND owner_account = ? RETURNING id")
      .bind(t.tid, owner).first();
    if (!row) throw new HttpError(409, "owner_changed", "Owner changed during release");
  } catch (err) {
    const released = await admission.fetch(new Request("https://admission.internal/release", { method: "POST", headers: { "x-tendril-id": t.tid } }));
    await released.body?.cancel();
    throw err;
  }
  await t.env.ACCOUNTS.prepare("DELETE FROM page_subdomains WHERE tendril_id = ?").bind(t.tid).run().catch(() => {});
  t.db.del("subdomain");
  t.db.del("owner_account");
  t.db.del("claimed_at");
  t.db.del("owner_label");
  t.db.set("unclaimed_since", t.now());
  t.db.run("INSERT INTO release_events (at) VALUES (?)", t.now());
  t.db.run("DELETE FROM page_sessions");
  // Revoke the previous owner's active introduction channels with their sessions.
  for (const ws of t.ctx.getWebSockets()) ws.close(4003, "claim released");
  t.scheduleAlarm();
  return json({ released: true, expires_at: t.expiresAt() });
}));

route("POST", /^links$/, async (t, req) => {
  const b = await readJson(req, 4096);
  if (!ROLES.has(b.role)) throw new HttpError(400, "bad_request", "role must be owner, guest or display");
  if (b.role !== "guest") throw new HttpError(403, "forbidden", "Agents can only create guest invites");
  const expiresIn = b.expires_in === undefined || b.expires_in === null ? null : Number(b.expires_in);
  if (expiresIn !== null && !(expiresIn > 0)) throw new HttpError(400, "bad_request", "expires_in must be a positive number of seconds");
  const label = typeof b.label === "string" ? b.label.slice(0, 100) : null;
  const email = validOptionalEmail(b.email);
  return json(t.renderLink(await t.createLink(b.role, label, expiresIn, true, undefined, email)), 201);
});

route("GET", /^links$/, (t) => json({ links: t.listLinks().filter((l) => l.role !== "display") }));

route("DELETE", /^links\/([^/]+)$/, (t, req, url, by, [id]) => {
  if (id === "l_main") throw new HttpError(400, "cannot_delete", "The main link cannot be deleted; rotate it instead");
  const link = t.db.one<{ role: string }>("SELECT role FROM links WHERE id = ?", id);
  if (!link) throw new HttpError(404, "not_found", "No such link");
  if (link.role === "display") throw new HttpError(403, "forbidden", "Only the owner can manage display links");
  t.db.run("DELETE FROM links WHERE id = ?", id);
  t.db.del(`link_email:${id}`);
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

route("GET", /^activity$/, (t, req, url) => {
  const a = url.searchParams.get("after");
  const limit = intParam(url, "limit", 100, 1, 1000);
  return json(listActivity(t, a === null || a === "" ? 0 : intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER), limit));
});
