/** Explicit page-host lifecycle and the filtered Chronolog participant transport. */
import { upgradeSetupWatch } from './setup-watch';
import { proposeAssistant } from './assistant-admission';
import { changeLifetime } from './lifetime';
import { PEER_ROUTE, handlePeers } from './peers';
import { withUnconfiguredPeerApplication } from './peer-generations';
import { handleApplication, selectedApplication } from './application';
import type { Tendril } from './tendril';
import { validName } from './tendril';
import { addActivity, listActivity } from './activity';
import { pointers } from './files';
import { HttpError, intParam, json, readJson } from './http';
import { newPageKey, newToken, sha256Hex } from './ids';
import { serviceDescriptor } from './descriptor';
import { agentBinding, agentScopes, authenticateAgent, currentPrincipal, requireAgentScope } from './access';
import { onboardingDescriptor } from './onboarding';
import { publicBase } from './urls';

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
  const rest = decodeURIComponent(req.headers.get('x-tendril-rest') ?? '');
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const principal = await authenticateAgent(t, req);
  if (!currentPrincipal(t, principal)) throw new HttpError(401, 'unauthorized');
  t.recordAccess();
  if (PEER_ROUTE.test(rest)) {
    requireAgentScope(principal, 'participants:connect');
    if (rest === 'peers/bootstrap' && method !== 'GET') requireAgentScope(principal, 'host:manage');
    return handlePeers(t, req, url, rest, principal);
  }
  if (rest === 'setup/watch') return upgradeSetupWatch(t, req, principal);
  if (rest === 'assistant/propose' && method === 'POST') {
    requireAgentScope(principal, 'assistant:manage');
    return proposeAssistant(t, req, principal);
  }
  if (rest === 'application') { requireAgentScope(principal, 'host:read'); return handleApplication(t, req, principal); }
  if (rest === 'self' && method === 'GET') return json({ name: principal.name, binding: principal.binding,
    applicationId: selectedApplication(t).id, authority: 'host-access-only' });
  if (rest === 'tokens' && method === 'POST') {
    requireAgentScope(principal, 'agents:delegate');
    const body = await readJson(req, 4096), scopes = agentScopes(body.scopes, principal.binding?.scopes);
    for (const scope of scopes) requireAgentScope(principal, scope);
    if (typeof body.name !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(body.name)) throw new HttpError(400, 'invalid_agent_name');
    if (body.name === 'setup') throw new HttpError(400, 'reserved_agent_name', 'The setup name is reserved for the fixed account-bound creation credential.');
    if (t.db.one('SELECT 1 FROM tokens WHERE name=?', body.name)) throw new HttpError(409, 'exists');
    if ((t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM tokens')?.n ?? 0) >= 32) throw new HttpError(429, 'agent_binding_capacity');
    const token = await t.addToken(body.name, scopes, () => {
      if (!currentPrincipal(t, principal)) throw new HttpError(403, 'agent_binding_revoked');
      if ((t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM tokens')?.n ?? 0) >= 32) throw new HttpError(429, 'agent_binding_capacity');
    });
    return json({ name: body.name, token, binding: agentBinding(t, body.name) }, 201);
  }
  const rotate = /^tokens\/([^/]+)\/rotate$/.exec(rest);
  if (rotate && method === 'POST') {
    const name = rotate[1], binding = agentBinding(t, name);
    if (name === 'setup' && t.db.get('account_setup', null))
      throw new HttpError(403, 'setup_credential_fixed', 'This setup credential is bound to the retained creation commitment. Use the owner’s reviewed delegation route instead of rotating it.');
    if (!binding || !t.db.one('SELECT 1 FROM tokens WHERE name=?', name)) throw new HttpError(404, 'not_found');
    if (name !== principal.name) {
      requireAgentScope(principal, 'agents:delegate');
      for (const scope of binding.scopes) requireAgentScope(principal, scope);
    }
    const token = newToken(), hash = await sha256Hex(token);
    if (!currentPrincipal(t, principal) || agentBinding(t, name)?.revision !== binding.revision) throw new HttpError(409, 'agent_binding_changed');
    const next = { ...binding, revision: binding.revision + 1 };
    t.transaction(() => { t.db.run('UPDATE tokens SET hash=? WHERE name=?', hash, name); t.db.set('agent_binding:' + name, next); });
    return json({ name, token, binding: next });
  }
  if (rest.startsWith('tokens/') && method === 'DELETE') {
    const target = agentBinding(t, rest.slice('tokens/'.length));
    if (target) for (const scope of target.scopes) requireAgentScope(principal, scope);
  }
  const matches = routes.filter(route => route.pattern.test(rest));
  if (!matches.length) throw new HttpError(404, 'not_found', `No host route ${rest || '/'}`);
  const route = matches.find(route => route.method === method);
  if (!route) throw new HttpError(405, 'method_not_allowed');
  requireAgentScope(principal, rest.startsWith('tokens') ? 'agents:delegate' : method === 'GET' ? 'host:read' : 'host:manage');
  return route.handler(t, req, url, principal.name, route.pattern.exec(rest)!.slice(1));
}
async function tendrilInfo(t: Tendril) {
  const ownerId = t.db.get<string | null>('owner_account', null);
  const owner = ownerId && t.env.ACCOUNTS ? await t.env.ACCOUNTS.prepare('SELECT provider, login FROM identities WHERE account_id = ? ORDER BY created_at LIMIT 1')
    .bind(ownerId).first<{ provider: string; login: string }>() : null;
  return { id: t.tid, name: t.db.get('name', 'Tendril'), page_url: t.mainPageUrl(), lifetime: t.db.get('lifetime', 'ad_hoc'),
    application: selectedApplication(t), configured: t.db.get('peer_generation_configuration', null) !== null,
    expires_at: t.expiresAt(), owner, owner_account_id: ownerId, version: pointers(t), meta: tendrilMeta(t) };
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

route('GET', /^$/, async t => json(await tendrilInfo(t)));
route('GET', /^service$/, () => json(serviceDescriptor()));
route('GET', /^guide$/, t => json(onboardingDescriptor(publicBase(t.env))));
route("PATCH", /^$/, async (t, req) => {
  const b = await readJson(req, 64 * 1024);
  if (b.name !== undefined) t.db.set("name", validName(b.name));
  if (b.lifetime !== undefined) {
    if (b.lifetime !== "ad_hoc" && b.lifetime !== "resident") throw new HttpError(400, "bad_request", "lifetime must be ad_hoc or resident");
    await changeLifetime(t, b.lifetime);
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
      const ok = typeof b.icon === "string" && /^https:\/\/\S+$/.test(b.icon);
      if (!ok) throw new HttpError(400, "bad_request", "icon must be an https URL");
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

route("POST", /^release$/, t => withUnconfiguredPeerApplication(t, async () => {
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

route("GET", /^activity$/, (t, req, url) => {
  const a = url.searchParams.get("after");
  const limit = intParam(url, "limit", 100, 1, 1000);
  return json(listActivity(t, a === null || a === "" ? 0 : intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER), limit));
});

route("GET", /^tokens$/, (t) => json({ tokens: t.db.all<{ name: string; created_at: number; last_used: number | null }>("SELECT name, created_at, last_used FROM tokens ORDER BY created_at ASC")
  .map(row => ({ ...row, binding: agentBinding(t, row.name) })) }));

route("DELETE", /^tokens\/([^/]+)$/, (t, req, url, by, [name]) => {
  if (!t.db.one("SELECT 1 AS x FROM tokens WHERE name = ?", name)) throw new HttpError(404, "not_found", "No such token");
  t.db.run("DELETE FROM tokens WHERE name = ?", name);
  t.db.del('agent_binding:' + name);
  for (const socket of t.ctx.getWebSockets()) {
    const attached = socket.deserializeAttachment();
    if (attached?.principal?.kind === 'agent' && attached.principal.name === name) socket.close(4003, 'Agent binding revoked');
  }
  return new Response(null, { status: 204 });
});
