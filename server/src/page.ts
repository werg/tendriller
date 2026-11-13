// Page routes under P (PROTOCOL section 2.1), executed inside the Tendril Durable Object.
import type { Tendril } from "./tendril";
import { addActivity } from "./activity";
import { tendrilMeta } from "./agent";
import { servePageFile, servedVersion, versionFiles } from "./files";
import { HttpError, json, readBody } from "./http";
import { BLOB_ID_RE, DEVICE_ID_RE, DEVICE_SECRET_RE, safeEqual, sha256Hex, toBase64 } from "./ids";
import type { DeviceRow } from "./tendril";
import { iconSvg } from "./inject";
import { MAX_BLOB } from "./limits";
import { handleVoiceSession } from "./voice";

export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

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
  const link = await t.linkForKey(key);
  if (!link) {
    if (rest.startsWith("_tendril/")) throw new HttpError(404, "not_found", "Unknown or expired link");
    return new Response("This link is not valid (it may have expired or been revoked).", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (!rest.startsWith("_tendril/")) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed");
    return servePageFile(t, req, base, rest);
  }

  const sub = rest.slice("_tendril/".length);
  const m = req.method;

  if (sub === "ws") {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required", "Expected a WebSocket upgrade");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    t.ctx.acceptWebSocket(server);
    server.serializeAttachment({ linkId: link.id, deviceId: null, version: 0, at: t.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  if (sub === "info" && m === "GET") {
    const v = servedVersion(t);
    return json({ id: t.tid, version: v, base, files: v > 0 ? versionFiles(t, v).map((f) => f.path) : [], features: t.features() });
  }

  if (sub === "blob" && m === "POST") {
    if (link.role === "display") throw new HttpError(403, "forbidden", "Display links are read-only");
    const body = await readBody(req, MAX_BLOB);
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

  if (sub === "transcribe" && m === "POST") {
    if (!t.env.AI) throw new HttpError(501, "unavailable", "Server-side transcription is not configured");
    const dev = await verifiedDevice(t, req);
    if (!dev || dev.role === "display" || link.role === "display") throw new HttpError(403, "forbidden", "Transcription needs a connected, non-display device");
    const body = await readBody(req, MAX_BLOB);
    if (body.byteLength === 0) throw new HttpError(400, "bad_request", "Empty audio body");
    const lang = url.searchParams.get("language");
    const input: Record<string, unknown> = { audio: toBase64(body) };
    if (lang) input.language = lang.slice(0, 2);
    try {
      const out = await t.env.AI.run(WHISPER_MODEL, input);
      return json({ text: typeof out?.text === "string" ? out.text.trim() : "" });
    } catch (err) {
      throw new HttpError(502, "transcription_failed", err instanceof Error ? err.message : String(err));
    }
  }

  if (sub === "voice/session" && m === "POST") {
    // Voice sessions bill the server's provider account: owners only.
    const dev = await verifiedDevice(t, req);
    if (link.role !== "owner" || !dev || dev.role !== "owner" || dev.pending) {
      throw new HttpError(403, "forbidden", "The voice layer is available to the owner's paired devices only");
    }
    return handleVoiceSession(req, t.env, { tendrilId: t.tid, name: t.db.get("name", "Tendril") });
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
