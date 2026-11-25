import { watchPublication } from "./publication-watch";
import { PEER_ROUTE, handlePeers } from "./peers";
import { handleApplication, selectedApplication } from "./application";
// Page routes under P (PROTOCOL section 2.1), executed inside the Tendril Durable Object.
import type { Tendril } from "./tendril";
import { validOptionalEmail } from "./tendril";
import { tendrilMeta } from "./agent";
import { servePageFile, servedVersion, versionFiles, publicationManifest } from "./files";
import { HttpError, json, readBody, readJson } from "./http";
import { emojiIconSvg, iconSvg, maskableEmojiIconSvg, maskableIconSvg } from "./inject";
import { serviceDescriptor } from "./descriptor";
import { AGENT_SCOPES, accountActive, allows, authenticateLocalPage, currentPrincipal } from "./access";
import { handleManagement } from "./management";
import { currentIconRaster, iconRasterResponse, iconRasterTag, remoteIconSize, storeIconRaster } from "./icon-raster";
import { addActivity } from "./activity";
import { deleteAgentGrant, mirroredAgents, pageAgents, putAgentGrant, setPrimaryAgent } from "./agent-grants";
import { listAccountAgents } from "./agents";
import { handlePageMcp } from "./mcp-participant";
import { publicBase } from "./urls";
import { brandHead, brandMark, brandStyle } from "./brand";
import { serviceStyle } from "./accounts/ui";
import { requireWritesOpen } from "./service-state";
import { admitPageTraffic } from "./traffic-budget";
import { DEFAULT_THEME_COLOR, isEmojiIcon, pageIcons, resolveShortcuts } from "./pwa";
import { deletePushSubscription, savePushSubscription, validatePushSubscriptionInput, vapidConfig } from "./push";

/** Internal admission result; the Worker consumes it before returning a page response. */
export const PAGE_ACCESS_HEADER = "x-tendril-page-access";
export function pageAccessDenied(status: 401 | 403): Response {
  return new Response(null, { status, headers: { [PAGE_ACCESS_HEADER]: status === 403 ? "unavailable" : "signin", "Cache-Control": "no-store" } });
}

export async function handlePage(t: Tendril, req: Request, url: URL): Promise<Response> {
  const key = req.headers.get("x-tendril-key") ?? "";
  const base = req.headers.get("x-tendril-base") ?? "/";
  const rest = decodeURIComponent(req.headers.get("x-tendril-rest") ?? "");
  // Before PSL acceptance sibling tendrils are same-site. Check the actual
  // browser origin for every mutation and WebSocket upgrade; cookies alone
  // cannot distinguish a hostile sibling origin.
  const upgrade = req.headers.get("Upgrade")?.toLowerCase() === "websocket";
  const shareTargetFallback = rest === "_tendril/share-target" && req.method === "POST";
  const writes = (req.method !== "GET" && req.method !== "HEAD" && !shareTargetFallback) || upgrade;
  if (writes) {
    const expected = req.headers.get("x-tendril-origin");
    if (!expected || req.headers.get("Origin") !== expected) throw new HttpError(403, "bad_origin", "Request must originate from this tendril");
  }
  const denyLocal = async () => pageAccessDenied(t.db.get<string | null>("owner_account", null)
    && await t.checkPagePolicy() === "page" ? 403 : 401);
  const link = await t.linkForKey(key);
  if (!link) return denyLocal();
  let access: Awaited<ReturnType<typeof authenticateLocalPage>>;
  try { access = await authenticateLocalPage(t, req, link); }
  catch (error) {
    if (error instanceof HttpError && error.status === 401) return denyLocal();
    throw error;
  }
  const { principal, session } = access;
  // Count a display visit in the same authenticated request as the page operation.
  // Shared platform assets need no visitor entry or second authentication pass.
  if (principal.role === "display") {
    await t.recordVisitorSignal("display", req.headers.get("x-visitor-ip") ?? "");
    if (t.db.get("disabled", false)) return pageAccessDenied(403);
    if (!currentPrincipal(t, principal, key)) return pageAccessDenied(401);
  }
  const policy = await t.checkPagePolicy(principal.accountId);
  if (policy === "page") return pageAccessDenied(403);
  if (policy === "visitor" || !currentPrincipal(t, principal, key)) return pageAccessDenied(401);
  // Only an active account may charge the shared page and owner budgets.
  await admitPageTraffic(t.env, t.tid, t.db.get<string | null>("owner_account", null));
  if (writes && !(upgrade && rest === "_tendril/publication-ready")) await requireWritesOpen(t.env);
  // Guest suspension does not necessarily invalidate this object's SQL.
  const active = principal.role !== "guest" || !principal.accountId || await accountActive(t, principal.accountId);
  if (!active || !currentPrincipal(t, principal, key)) return pageAccessDenied(t.db.get("disabled", false) ? 403 : 401);
  t.recordAccess();

  if (!rest.startsWith("_tendril/")) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed");
    return servePageFile(t, req, base, rest, link.role, session?.account_id ?? null);
  }

  const sub = rest.slice("_tendril/".length);
  const m = req.method;
  if (PEER_ROUTE.test(sub)) return handlePeers(t, req, url, sub, principal);
  if (sub === "application") return handleApplication(t, req, principal);
  if (sub === 'manage') return handleManagement(t, req, base, principal);
  if (sub === 'mcp/grants' || sub === 'mcp/connect' || sub === 'mcp/rekey' || sub === 'mcp/sync' || /^mcp\/[A-Za-z0-9_-]{1,128}$/.test(sub)) {
    return handlePageMcp(t, req, sub, principal);
  }
  if (sub === 'service' && m === 'GET') return json(serviceDescriptor(t.env));
  if (sub === "trust-version" && m === "POST") {
    if (!allows(principal, "page.owner") || !session?.account_id) throw new HttpError(403, "forbidden");
    const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
    const version = Number(form.get("version"));
    if (!Number.isInteger(version) || !t.db.one("SELECT 1 AS x FROM versions WHERE version = ? AND risk_score >= 5", version)) {
      throw new HttpError(400, "bad_request", "Invalid version");
    }
    t.db.run("INSERT OR IGNORE INTO trusted_versions (account_id, version) VALUES (?, ?)", session.account_id, version);
    return new Response(null, { status: 303, headers: { Location: base, "Cache-Control": "no-store" } });
  }

  if (sub === "report" && m === "GET") {
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>Report page · Tendriller</title>${brandHead(base + "_tendril/brand/")}${serviceStyle}${brandStyle}</head><body><main><header>${brandMark(base + "_tendril/brand/", base)}<a class="nav-link" href="${base}">Return to page</a></header><section class="card"><span class="eyebrow">Safety</span><h1>Report this page</h1><p class="lead">Tell us what is wrong with this page.</p><form method="post"><div class="field"><label class="field-label" for="report-reason">Details</label><textarea id="report-reason" name="reason" required maxlength="2000" placeholder="Describe the issue…"></textarea></div><div class="actions"><button type="submit">Send report</button></div></form></section></main></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" } });
  }
  if (sub === "report" && m === "POST") {
    if (!t.env.ACCOUNTS) throw new HttpError(503, "unavailable");
    if (t.env.REPORT_RATE && !(await t.env.REPORT_RATE.limit({ key: req.headers.get("CF-Connecting-IP") ?? "unknown" })).success) {
      throw new HttpError(429, "rate_limited", "Too many reports");
    }
    const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 8192)));
    const reason = form.get("reason");
    if (!reason || !reason.trim() || reason.length > 2000) throw new HttpError(400, "bad_request", "Reason must be 1–2000 characters");
    await t.recordReport("page", session?.account_id ?? null, reason.trim());
    return new Response("Report received. Thank you.", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }

  // Unified page agent roster (non-display authenticated users can read; owner can toggle grants and choose primary).
  if (sub === "agents" && m === "GET") {
    if (principal.role === "display") throw new HttpError(403, "forbidden");
    const roster = pageAgents(t);
    const isOwner = allows(principal, "page.owner") && !!principal.accountId;
    const granted = new Set(mirroredAgents(t));
    const account_agents = isOwner
      ? (await listAccountAgents(t.env, principal.accountId!)).map(agent => ({
          id: agent.id, handle: agent.handle, bio: agent.bio, public_key: agent.public_key, granted: granted.has(agent.id),
        }))
      : undefined;
    return json({
      ...roster,
      can_manage: isOwner,
      dashboard: `${publicBase(t.env)}/dashboard#agents`,
      connections: `${publicBase(t.env)}/connections`,
      ...(account_agents ? { account_agents } : {}),
    }, 200, { "Cache-Control": "no-store" });
  }
  if (sub === "agents/primary" && m === "PUT") {
    if (!allows(principal, "page.owner") || !principal.accountId) throw new HttpError(403, "forbidden");
    await requireWritesOpen(t.env);
    const b = await readJson(req, 4096);
    if (b.agent_id !== null && typeof b.agent_id !== "string") {
      throw new HttpError(400, "bad_request", "Expected { agent_id: string | null }");
    }
    if (!currentPrincipal(t, principal, key)) throw new HttpError(401, "unauthorized", "The owner session changed. Sign in again.");
    const roster = setPrimaryAgent(t, b.agent_id, `owner:${principal.accountId}`);
    return json(roster, 200, { "Cache-Control": "no-store" });
  }
  if (sub === "agents" && m === "POST") {
    if (!allows(principal, "page.owner") || !principal.accountId) throw new HttpError(403, "forbidden");
    await requireWritesOpen(t.env);
    const b = await readJson(req, 4096);
    if (typeof b.agent !== "string" || typeof b.granted !== "boolean") throw new HttpError(400, "bad_request", "Expected { agent, granted }");
    if (!currentPrincipal(t, principal, key)) throw new HttpError(401, "unauthorized", "The owner session changed. Sign in again.");
    if (b.granted) {
      const agent = (await listAccountAgents(t.env, principal.accountId)).find(row => row.id === b.agent);
      if (!agent) throw new HttpError(404, "not_found", "No such agent on your account");
      await putAgentGrant(t, principal.accountId, agent.id, agent.handle, agent.bio, agent.public_key, agent.wrap_key, [...AGENT_SCOPES]);
    } else await deleteAgentGrant(t, b.agent, `owner:${principal.accountId}`);
    return json({ agent: b.agent, granted: b.granted, roster: pageAgents(t) });
  }
  if (sub === "links" && m === "GET") {
    if (!allows(principal, "page.owner")) throw new HttpError(403, "forbidden");
    return json({ name: t.db.get("name", "Tendril"), links: t.listLinks() });
  }
  if (sub === "links" && m === "POST") {
    if (!allows(principal, "page.owner")) throw new HttpError(403, "forbidden");
    const b = await readJson(req, 4096);
    if (b.role !== "guest" && b.role !== "display") throw new HttpError(400, "bad_request", "role must be guest or display");
    const total = t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM links")?.n ?? 0;
    if (total >= 50) throw new HttpError(429, "link_limit", "At most 50 links are allowed per page");
    const expiresIn = b.expires_in === undefined || b.expires_in === null ? null : Number(b.expires_in);
    if (expiresIn !== null && (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 365 * 86400)) {
      throw new HttpError(400, "bad_request", "expires_in must be between 1 second and 365 days");
    }
    const rawLabel = typeof b.label === "string" ? b.label.trim().slice(0, 100) : "";
    const label = rawLabel || null;
    const email = validOptionalEmail(b.email);
    if (email !== null && b.role !== "guest") throw new HttpError(400, "bad_request", "Email restriction is only supported on guest invite links");
    const link = await t.createLink(b.role, label, expiresIn, false, () => {
      if (!currentPrincipal(t, principal, key)) throw new HttpError(401, "unauthorized");
      const total = t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM links")?.n ?? 0;
      if (total >= 50) throw new HttpError(429, "link_limit", "At most 50 links are allowed per page");
    }, email);
    addActivity(t, { kind: "link", summary: `Created ${b.role} link${label ? ` (${label})` : ""}${email ? ` for ${email}` : ""}`, by: `owner:${principal.accountId ?? "unknown"}` });
    return json(t.renderLink(link), 201);
  }
  const deleteLink = /^links\/([A-Za-z0-9_-]{1,64})$/.exec(sub);
  if (deleteLink && m === "DELETE") {
    if (!allows(principal, "page.owner")) throw new HttpError(403, "forbidden");
    const id = deleteLink[1];
    if (id === "l_main") throw new HttpError(400, "cannot_delete", "The main owner link cannot be deleted");
    const existing = t.db.one<{ role: string; label: string | null }>("SELECT role, label FROM links WHERE id = ?", id);
    if (!existing) throw new HttpError(404, "not_found", "No such link");
    t.db.run("DELETE FROM links WHERE id = ?", id);
    t.db.del(`link_email:${id}`);
    t.db.run("DELETE FROM guest_accounts WHERE link_id = ?", id);
    t.closeLinkSockets(id);
    addActivity(t, { kind: "link", summary: `Revoked ${existing.role} link${existing.label ? ` (${existing.label})` : ""}`, by: `owner:${principal.accountId ?? "unknown"}` });
    return new Response(null, { status: 204 });
  }

  if (sub === "guests" && m === "GET") {
    if (!allows(principal, "page.owner")) throw new HttpError(403, "forbidden");
    const pending = t.db.all<{ account_id: string; link_id: string; created_at: number }>("SELECT account_id, link_id, created_at FROM guest_accounts WHERE approved = 0 ORDER BY created_at");
    const guests = await Promise.all(pending.map(async (row) => ({ ...row,
      email: (await t.env.ACCOUNTS?.prepare("SELECT email FROM accounts WHERE id = ?").bind(row.account_id).first<{ email: string | null }>())?.email ?? null,
    })));
    return json({ guests });
  }
  const approveGuest = /^guests\/([^/]+)\/([^/]+)\/approve$/.exec(sub);
  if (approveGuest && m === "POST") {
    if (!allows(principal, "page.owner")) throw new HttpError(403, "forbidden");
    const exists = t.db.one("SELECT 1 AS x FROM guest_accounts WHERE account_id = ? AND link_id = ? AND approved = 0", approveGuest[1], approveGuest[2]);
    if (!exists) throw new HttpError(404, "not_found", "No pending guest");
    t.db.run("UPDATE guest_accounts SET approved = 1 WHERE account_id = ? AND link_id = ?", approveGuest[1], approveGuest[2]);
    return json({ ok: true });
  }
  const declineGuest = /^guests\/([^/]+)\/([^/]+)\/decline$/.exec(sub);
  if (declineGuest && m === "POST") {
    if (!allows(principal, "page.owner")) throw new HttpError(403, "forbidden");
    const exists = t.db.one("SELECT 1 AS x FROM guest_accounts WHERE account_id = ? AND link_id = ? AND approved = 0", declineGuest[1], declineGuest[2]);
    if (!exists) throw new HttpError(404, "not_found", "No pending guest");
    t.db.run("UPDATE guest_accounts SET approved = -1 WHERE account_id = ? AND link_id = ?", declineGuest[1], declineGuest[2]);
    return json({ ok: true });
  }

  if (sub === "publication-ready" && m === "GET" && upgrade) return watchPublication(t, req, principal, key);
  if (sub === "publication-ready" && m === "HEAD") {
    return new Response(null, { status: servedVersion(t) > 0 ? 204 : 202, headers: { "Cache-Control": "no-store", "Tendril-Publication-Version": String(servedVersion(t)) } });
  }

  if (sub === "info" && m === "GET") {
    const v = servedVersion(t);
    return json({
      application: selectedApplication(t), id: t.tid, version: v, base,
      files: v > 0 ? versionFiles(t, v).map((f) => f.path) : [],
      publication: publicationManifest(t, v, base),
      features: t.features(),
      ...(principal.role !== "display" ? { agents: pageAgents(t) } : {}),
    });
  }

  if (sub === "share-target" && m === "POST") {
    // Side-effect-free fallback when the page service worker is not yet active.
    // Never retain or log the posted share payload on the server.
    await req.body?.cancel();
    return new Response(null, { status: 303, headers: { Location: base, "Cache-Control": "no-store" } });
  }

  if (sub === "push/key" && m === "GET") {
    if (!allows(principal, "page.write")) throw new HttpError(403, "forbidden");
    const cfg = vapidConfig(t.env);
    return json({ configured: Boolean(cfg), publicKey: cfg?.publicKey ?? null });
  }
  if (sub === "push/subscribe" && m === "POST") {
    if (!allows(principal, "page.write") || !principal.accountId) throw new HttpError(403, "forbidden");
    if (!vapidConfig(t.env)) throw new HttpError(503, "push_not_configured", "Web Push notifications are not configured on this host");
    const input = validatePushSubscriptionInput(await readJson(req, 4096));
    const saved = savePushSubscription(t, principal.accountId, principal.role, input);
    return json({ id: saved.id, subscribed: true }, 201);
  }
  if (sub === "push/subscribe" && m === "DELETE") {
    if (!allows(principal, "page.write") || !principal.accountId) throw new HttpError(403, "forbidden");
    const body = await readJson(req, 4096);
    if (typeof body.endpoint !== "string" || !body.endpoint) throw new HttpError(400, "bad_request", "endpoint required");
    deletePushSubscription(t, principal.accountId, body.endpoint);
    return new Response(null, { status: 204 });
  }

  if (sub === "manifest.webmanifest" && (m === "GET" || m === "HEAD")) {
    const meta = tendrilMeta(t);
    const name = t.db.get("name", "Tendril");
    const body: Record<string, unknown> = {
      name,
      short_name: meta.short_name ?? name.slice(0, 12),
      id: base,
      start_url: base,
      scope: base,
      display: "standalone",
      theme_color: meta.theme_color ?? DEFAULT_THEME_COLOR,
      background_color: meta.background_color ?? "#ffffff",
      icons: pageIcons(base, meta.icon, {
        rasterTag: currentIconRaster(t) ? iconRasterTag(currentIconRaster(t)!.key) : null,
        customSize: meta.icon && /^https:\/\//.test(meta.icon) ? await remoteIconSize(t, meta.icon, new URL(base, req.url).href) : null,
      }),
    };
    if (meta.shortcuts && meta.shortcuts.length > 0) {
      body.shortcuts = resolveShortcuts(meta.shortcuts, base);
    }
    if (meta.share_target !== false) {
      body.share_target = {
        action: `${base}_tendril/share-target`,
        method: "POST",
        enctype: "multipart/form-data",
        params: {
          title: "title",
          text: "text",
          url: "url",
          files: [{ name: "files", accept: ["image/*", "text/*", "application/pdf"] }],
        },
      };
    }
    return new Response(m === "HEAD" ? null : JSON.stringify(body), { headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" } });
  }

  if ((sub === "icon" || sub === "icon.svg") && (m === "GET" || m === "HEAD")) {
    const icon = t.db.get<string | null>("icon", null);
    if (sub === "icon" && icon && /^https:\/\//.test(icon)) return new Response(null, { status: 302,
      headers: { Location: icon, "Cache-Control": "private, no-cache" } });
    const svg = icon && isEmojiIcon(icon) ? emojiIconSvg(icon)
      : iconSvg(t.db.get("name", "Tendril"), t.db.get<string | null>("theme_color", null) ?? DEFAULT_THEME_COLOR);
    return new Response(m === "HEAD" ? null : svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" } });
  }

  if ((sub === "icon-512.png" || sub === "icon-maskable-512.png") && (m === "GET" || m === "HEAD")) {
    const response = iconRasterResponse(t, sub === "icon-512.png" ? "any" : "maskable", m === "HEAD");
    if (!response) throw new HttpError(404, "not_found", "No rendered icon yet");
    return response;
  }
  if (sub === "icon-raster" && m === "POST") {
    // The owner's browser draws the page's own icon SVGs into PNGs (it has the emoji font).
    if (!allows(principal, "page.owner")) throw new HttpError(403, "forbidden");
    storeIconRaster(t, await readJson(req, 1_200_000));
    return new Response(null, { status: 204 });
  }
  if (sub === "icon-maskable.svg" && (m === "GET" || m === "HEAD")) {
    const icon = t.db.get<string | null>("icon", null);
    const themeColor = t.db.get<string | null>("theme_color", null) ?? DEFAULT_THEME_COLOR;
    const svg = icon && isEmojiIcon(icon) ? maskableEmojiIconSvg(icon, themeColor)
      : maskableIconSvg(t.db.get("name", "Tendril"), themeColor);
    return new Response(m === "HEAD" ? null : svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" } });
  }

  throw new HttpError(404, "not_found", `No route _tendril/${sub}`);
}
