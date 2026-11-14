// Page routes under P (PROTOCOL section 2.1), executed inside the Tendril Durable Object.
import type { Tendril } from "./tendril";
import { addActivity } from "./activity";
import { tendrilMeta } from "./agent";
import { servePageFile, servedVersion, versionFiles } from "./files";
import { HttpError, json, readBody } from "./http";
import { BLOB_ID_RE, DEVICE_ID_RE, DEVICE_SECRET_RE, safeEqual, sha256Hex } from "./ids";
import type { DeviceRow } from "./tendril";
import { iconSvg } from "./inject";

/**
 * The device making an HTTP request from the page, verified by its device secret
 * (`X-Tendril-Device` + `X-Tendril-Device-Secret`, PROTOCOL 2.1). Null if absent or wrong.
 */
async function verifiedDevice(t: Tendril, req: Request): Promise<DeviceRow | null> {
  const id = req.headers.get("X-Tendril-Device");
  const secret = req.headers.get("X-Tendril-Device-Secret");
  if (!id || !secret || !DEVICE_ID_RE.test(id) || !DEVICE_SECRET_RE.test(secret)) return null;
  const dev = t.device(id);
  if (!dev) return null;
  return safeEqual(dev.secret_hash, await sha256Hex(secret)) ? dev : null;
}

export async function handlePage(t: Tendril, req: Request, url: URL): Promise<Response> {
  const key = req.headers.get("x-tendril-key") ?? "";
  const base = req.headers.get("x-tendril-base") ?? "/";
  const rest = decodeURIComponent(req.headers.get("x-tendril-rest") ?? "");
  // Before PSL acceptance sibling tendrils are same-site. Check the actual
  // browser origin for every mutation and WebSocket upgrade; cookies alone
  // cannot distinguish a hostile sibling origin.
  if (req.method !== "GET" && req.method !== "HEAD" || req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    const expected = req.headers.get("x-tendril-origin");
    if (!expected || req.headers.get("Origin") !== expected) throw new HttpError(403, "bad_origin", "Request must originate from this tendril");
  }
  const link = await t.linkForKey(key);
  if (!link) {
    if (rest.startsWith("_tendril/")) throw new HttpError(404, "not_found", "Unknown or expired link");
    return new Response("This link is not valid (it may have expired or been revoked).", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const session = await t.pageSession(req);
  {
    const owner = link.role === "owner" && session?.role === "owner" && session.account_id === t.db.get<string | null>("owner_account", null);
    const guest = link.role === "guest" && session?.role === "guest" && !!t.db.one("SELECT 1 AS x FROM guest_accounts WHERE account_id = ? AND link_id = ? AND approved = 1", session.account_id, link.id);
    const display = link.role === "display" && !link.created_by_agent && !!t.db.get<string | null>("owner_account", null);
    if (!owner && !guest && !display) throw new HttpError(401, "unauthorized", "Page sign-in required");
  }

  if (!rest.startsWith("_tendril/")) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed");
    return servePageFile(t, req, base, rest, link.role, session?.account_id ?? null);
  }

  const sub = rest.slice("_tendril/".length);
  const m = req.method;

  if (sub === "trust-version" && m === "POST") {
    if (link.role !== "owner" || !session?.account_id) throw new HttpError(403, "forbidden");
    const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
    const version = Number(form.get("version"));
    if (!Number.isInteger(version) || !t.db.one("SELECT 1 AS x FROM versions WHERE version = ? AND risk_score >= 5", version)) {
      throw new HttpError(400, "bad_request", "Invalid version");
    }
    t.db.run("INSERT OR IGNORE INTO trusted_versions (account_id, version) VALUES (?, ?)", session.account_id, version);
    return new Response(null, { status: 303, headers: { Location: base, "Cache-Control": "no-store" } });
  }

  if (sub === "report" && m === "GET") {
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Report page</title></head><body><main><h1>Report this page</h1><p>Tell us what is wrong with this tendril.</p><form method="post"><textarea name="reason" required maxlength="2000"></textarea><button type="submit">Send report</button></form></main></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" } });
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
    if (link.role !== "owner") throw new HttpError(403, "forbidden");
    return json({ agents: t.db.all("SELECT name, created_at, last_used FROM tokens ORDER BY created_at") ,
      webhook: t.renderWake().webhook });
  }
  const disconnect = /^agents\/([A-Za-z0-9_.@-]{1,64})\/disconnect$/.exec(sub);
  if (disconnect && m === "POST") {
    if (link.role !== "owner") throw new HttpError(403, "forbidden");
    if (!t.db.one("SELECT 1 AS x FROM tokens WHERE name = ?", disconnect[1])) throw new HttpError(404, "not_found", "No such agent token");
    t.db.run("DELETE FROM tokens WHERE name = ?", disconnect[1]);
    return json({ ok: true });
  }
  if (sub === "guests" && m === "GET") {
    if (link.role !== "owner") throw new HttpError(403, "forbidden");
    const pending = t.db.all<{ account_id: string; link_id: string; created_at: number }>("SELECT account_id, link_id, created_at FROM guest_accounts WHERE approved = 0 ORDER BY created_at");
    const guests = await Promise.all(pending.map(async (row) => ({ ...row,
      email: (await t.env.ACCOUNTS?.prepare("SELECT email FROM accounts WHERE id = ?").bind(row.account_id).first<{ email: string | null }>())?.email ?? null,
    })));
    return json({ guests });
  }
  const approveGuest = /^guests\/([^/]+)\/([^/]+)\/approve$/.exec(sub);
  if (approveGuest && m === "POST") {
    if (link.role !== "owner") throw new HttpError(403, "forbidden");
    const exists = t.db.one("SELECT 1 AS x FROM guest_accounts WHERE account_id = ? AND link_id = ? AND approved = 0", approveGuest[1], approveGuest[2]);
    if (!exists) throw new HttpError(404, "not_found", "No pending guest");
    t.db.run("UPDATE guest_accounts SET approved = 1 WHERE account_id = ? AND link_id = ?", approveGuest[1], approveGuest[2]);
    return json({ ok: true });
  }
  const declineGuest = /^guests\/([^/]+)\/([^/]+)\/decline$/.exec(sub);
  if (declineGuest && m === "POST") {
    if (link.role !== "owner") throw new HttpError(403, "forbidden");
    const exists = t.db.one("SELECT 1 AS x FROM guest_accounts WHERE account_id = ? AND link_id = ? AND approved = 0", declineGuest[1], declineGuest[2]);
    if (!exists) throw new HttpError(404, "not_found", "No pending guest");
    t.db.run("UPDATE guest_accounts SET approved = -1 WHERE account_id = ? AND link_id = ?", declineGuest[1], declineGuest[2]);
    return json({ ok: true });
  }

  if (sub === "ws") {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required", "Expected a WebSocket upgrade");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    t.ctx.acceptWebSocket(server);
    server.serializeAttachment({ linkId: link.id, deviceId: null, version: 0, at: t.now(),
      accountId: session?.account_id ?? null, sessionRole: link.role });
    return new Response(null, { status: 101, webSocket: client });
  }

  if (sub === "info" && m === "GET") {
    const v = servedVersion(t);
    return json({ id: t.tid, version: v, base, files: v > 0 ? versionFiles(t, v).map((f) => f.path) : [], features: t.features() });
  }

  if (sub === "blob" && m === "POST") {
    if (link.role === "display") throw new HttpError(403, "forbidden", "Display links are read-only");
    const body = await readBody(req, t.blobLimit());
    const type = req.headers.get("Content-Type") || "application/octet-stream";
    const name = req.headers.get("X-Tendril-Name");
    const device = (await verifiedDevice(t, req))?.id ?? null;
    const store = async () => {
      const r = await t.storeBlob(body, type, name ? name.slice(0, 200) : null, device, "page");
      addActivity(t, { kind: "blob", summary: `${blobLabel(type)} sent${name ? ` (${name.slice(0, 80)})` : ""}, ${formatSize(body.byteLength)}`, blob: r.id, device });
      return r;
    };
    // A verified device's upload carrying a client id is stored once (offline replay).
    const cid = req.headers.get("X-Tendril-Cid");
    return json(device && cid ? await t.dedupe(device, `upload:${cid}`, store) : await store());
  }

  const bm = /^blob\/(b_[a-z2-7]{20})$/.exec(sub);
  if (bm && (m === "GET" || m === "HEAD")) return t.getBlob(bm[1]);

  if (sub === "manifest.webmanifest" && m === "GET") {
    const meta = tendrilMeta(t);
    const name = t.db.get("name", "Tendril");
    const body = {
      name,
      short_name: meta.short_name ?? name.slice(0, 12),
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
    if (icon && BLOB_ID_RE.test(icon) && t.db.one("SELECT 1 AS x FROM blobs WHERE id = ?", icon)) return t.getBlob(icon);
    if (icon && /^https:\/\//.test(icon)) return Response.redirect(icon, 302);
    const svg = iconSvg(t.db.get("name", "Tendril"), t.db.get<string | null>("theme_color", null) ?? "#2d6a4f");
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" } });
  }

  throw new HttpError(404, "not_found", `No route _tendril/${sub}`);
}

function iconType(t: Tendril, icon: string | null): string {
  if (icon && BLOB_ID_RE.test(icon)) return t.db.one<{ type: string }>("SELECT type FROM blobs WHERE id = ?", icon)?.type ?? "image/png";
  if (icon && /\.png(\?|$)/i.test(icon)) return "image/png";
  if (icon) return "image/png";
  return "image/svg+xml";
}

function blobLabel(type: string): string {
  if (type.startsWith("image/")) return "Photo";
  if (type.startsWith("video/")) return "Video clip";
  if (type.startsWith("audio/")) return "Audio clip";
  return "File";
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
