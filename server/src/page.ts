import { watchPublication } from "./publication-watch";
import { PEER_ROUTE, handlePeers } from "./peers";
import { handleApplication, selectedApplication } from "./application";
// Page routes under P (PROTOCOL section 2.1), executed inside the Tendril Durable Object.
import type { Tendril } from "./tendril";
import { tendrilMeta } from "./agent";
import { servePageFile, servedVersion, versionFiles, publicationManifest } from "./files";
import { HttpError, json, readBody, readJson } from "./http";
import { iconSvg } from "./inject";
import { serviceDescriptor } from "./descriptor";
import { allows, authenticateLocalPage, currentPrincipal } from "./access";
import { handleManagement } from "./management";
import { requireWritesOpen } from "./service-state";
import { admitPageTraffic } from "./traffic-budget";

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
  const writes = req.method !== "GET" && req.method !== "HEAD" || upgrade;
  if (writes) {
    const expected = req.headers.get("x-tendril-origin");
    if (!expected || req.headers.get("Origin") !== expected) throw new HttpError(403, "bad_origin", "Request must originate from this tendril");
  }
  const link = await t.linkForKey(key);
  if (!link) return pageAccessDenied(401);
  let access: Awaited<ReturnType<typeof authenticateLocalPage>>;
  try { access = await authenticateLocalPage(t, req, link); }
  catch (error) {
    if (error instanceof HttpError && error.status === 401) return pageAccessDenied(401);
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
  // The former /claim/check preflight rejected unauthenticated traffic before
  // it could spend the page or owner's request allowance. Preserve that boundary
  // inside this single DO call, including display visits that hold the page.
  await admitPageTraffic(t.env, t.tid, t.db.get<string | null>("owner_account", null));
  if (writes && !(upgrade && rest === "_tendril/publication-ready")) await requireWritesOpen(t.env);
  const policy = await t.checkPagePolicy(principal.role === "display" ? null : principal.accountId);
  if (policy === "page") return pageAccessDenied(403);
  if (policy === "visitor" || !currentPrincipal(t, principal, key)) return pageAccessDenied(401);
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
  if (sub === 'service' && m === 'GET') return json(serviceDescriptor(t));
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
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>Report page · Tendriller</title><link rel="icon" href="${base}_tendril/brand/icon-64.png"><style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1.25rem}img{vertical-align:middle;margin-right:.5rem}textarea{display:block;width:100%;min-height:8rem;font:inherit}button{margin-top:1rem;padding:.7rem 1rem;background:#17654b;color:white;border:0;border-radius:.6rem;font:inherit}a{color:#17654b}</style></head><body><main><p><img src="${base}_tendril/brand/icon-64.png" alt="" width="32" height="32">Tendriller</p><h1>Report this page</h1><p>Tell us what is wrong with this tendril.</p><form method="post"><textarea name="reason" required maxlength="2000"></textarea><button type="submit">Send report</button></form></main></body></html>`,
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

  if (sub === "agents" && m === "GET") {
    if (!allows(principal, "page.owner")) throw new HttpError(403, "forbidden");
    return json({ agents: t.db.all("SELECT name, created_at, last_used FROM tokens ORDER BY created_at") });
  }
  const disconnect = /^agents\/([A-Za-z0-9_.@-]{1,64})\/disconnect$/.exec(sub);
  if (disconnect && m === "POST") {
    if (!allows(principal, "page.owner")) throw new HttpError(403, "forbidden");
    if (!t.db.one("SELECT 1 AS x FROM tokens WHERE name = ?", disconnect[1])) throw new HttpError(404, "not_found", "No such agent token");
    t.db.run("DELETE FROM tokens WHERE name = ?", disconnect[1]);
    return json({ ok: true });
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

  if (sub === "publication-ready" && m === "GET" && upgrade) return watchPublication(t, principal, key);
  if (sub === "publication-ready" && m === "HEAD") {
    return new Response(null, { status: servedVersion(t) > 0 ? 204 : 202, headers: { "Cache-Control": "no-store" } });
  }

  if (sub === "info" && m === "GET") {
    const v = servedVersion(t);
    return json({ application: selectedApplication(t), id: t.tid, mode: t.db.get("mode", "interactive"), version: v, base, files: v > 0 ? versionFiles(t, v).map((f) => f.path) : [], publication: publicationManifest(t, v, base), features: t.features() });
  }

  if (sub === "manifest.webmanifest" && m === "GET") {
    const meta = tendrilMeta(t);
    const name = t.db.get("name", "Tendril");
    const body = {
      name,
      short_name: meta.short_name ?? name.slice(0, 12),
      id: base,
      start_url: base,
      scope: base,
      display: "standalone",
      theme_color: meta.theme_color ?? "#2d6a4f",
      background_color: meta.background_color ?? "#ffffff",
      icons: [
        { src: `${base}_tendril/icon`, sizes: "512x512", type: iconType(t, meta.icon), purpose: "any" },
        { src: `${base}_tendril/icon`, sizes: "192x192", type: iconType(t, meta.icon), purpose: "any" },
      ],
    };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" } });
  }

  if (sub === "icon" && m === "GET") {
    const icon = t.db.get<string | null>("icon", null);
    if (icon && /^https:\/\//.test(icon)) return Response.redirect(icon, 302);
    const svg = iconSvg(t.db.get("name", "Tendril"), t.db.get<string | null>("theme_color", null) ?? "#2d6a4f");
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" } });
  }

  throw new HttpError(404, "not_found", `No route _tendril/${sub}`);
}

function iconType(t: Tendril, icon: string | null): string {
  if (icon && /\.png(\?|$)/i.test(icon)) return "image/png";
  if (icon) return "image/png";
  return "image/svg+xml";
}
