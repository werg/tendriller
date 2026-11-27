// Single Source of Truth (SSOT) for page icons & branding across:
// - manifest.webmanifest (Android Chrome WebAPK + Firefox Android CookiePolicy.OMIT)
// - HTML <link rel="icon"> & <link rel="apple-touch-icon">
// - /dashboard page cards (cross-origin cookieless capability URL)
// - _tendril/manage header avatar
import type { Env } from "./env";
import type { Tendril } from "./tendril";
import type { VersionFile } from "./files";
import { fileKey } from "./files";
import { emojiIconSvg, iconSvg, maskableEmojiIconSvg, maskableIconSvg } from "./inject";
import { DEFAULT_THEME_COLOR, iconMediaType, isEmojiIcon } from "./pwa";
import { currentIconRaster, iconRasterTag } from "./icon-raster";
import { safeEqual } from "./ids";

export interface AuthoredIconRecord {
  href: string;
  type: string | null;
  sizes: string | null;
  /** Set when the authored <link rel="icon"> resolved to an immutable file in version_files. */
  path?: string | null;
  hash?: string | null;
  /** Set when the authored icon is an inline data: URI (bounded to 64 KiB). */
  dataUri?: string | null;
}

export type ResolvedPageIcon =
  | { kind: "emoji"; emoji: string; themeColor: string; tag: string }
  | { kind: "published"; path: string; hash: string; type: string; themeColor: string; tag: string }
  | { kind: "data"; dataUri: string; type: string; themeColor: string; tag: string }
  | { kind: "external"; url: string; type: string | null; themeColor: string; tag: string }
  | { kind: "generated"; name: string; themeColor: string; tag: string };

const MAX_DATA_URI_LEN = 64 * 1024;
const enc = new TextEncoder();

function shortTag(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

function hmacKeyMaterial(env: Env): string {
  return env.HOST_ATTESTATION_KEY || env.OAUTH_CONFIG_KEY || env.BROADCAST_ADMIN_TOKEN || "tendriller-dev-icon-secret";
}

/** Deterministic 32-hex HMAC capability token scoped to (tendrilId, tag). */
export async function signIconToken(env: Env, tendrilId: string, tag: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(hmacKeyMaterial(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`icon-cap-v1:${tendrilId}:${tag}`)));
  return [...sig.subarray(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyIconToken(env: Env, tendrilId: string, tag: string, sig: string): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(sig)) return false;
  const expected = await signIconToken(env, tendrilId, tag);
  return safeEqual(sig, expected);
}

export async function iconBlobUrl(
  env: Env,
  tendrilId: string,
  tag: string,
  file: "icon.svg" | "icon-maskable.svg" | "any-192.png" | "any-512.png" | "maskable-512.png" | "authored",
  originPrefix = "",
): Promise<string> {
  const sig = await signIconToken(env, tendrilId, tag);
  return `${originPrefix}/_tendril/icon-blob/${tendrilId}/${tag}/${sig}/${file}`;
}

/** Match an icon URL against all known page bases (main, bare, fallback variants). */
export function resolveSamePagePath(rawUrl: string, pageBases: readonly string[]): string | null {
  try {
    const target = new URL(rawUrl);
    for (const candidate of pageBases) {
      if (!candidate) continue;
      let base: URL;
      try { base = new URL(candidate); } catch { continue; }
      if (base.hostname !== target.hostname || !target.pathname.startsWith(base.pathname)) continue;
      let rel = decodeURIComponent(target.pathname.slice(base.pathname.length));
      const pinned = /^_publications\/[1-9][0-9]*\/(.*)$/.exec(rel);
      if (pinned) rel = pinned[1]!;
      return rel.replace(/^\/+/, "");
    }
  } catch {}
  return null;
}

export function allPageBases(t: Tendril, extra?: string): string[] {
  const bases = [
    t.mainPageUrl(),
    t.barePageUrl(),
    t.mainPageUrl({ fallback: true }),
    t.barePageUrl({ fallback: true }),
    extra ?? null,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  return [...new Set(bases)];
}

/** Parse authored <link rel="icon">, <link rel="apple-touch-icon">, and <meta name="theme-color"> from entry HTML. */
export function extractAuthoredBranding(
  html: string,
  files: Map<string, VersionFile>,
  pageBases: readonly string[],
): { icon: AuthoredIconRecord | null; themeColor: string | null } {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? html.slice(0, 16384);
  const markup = head.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  let themeColor: string | null = null;
  let bestIcon: { priority: number; rec: AuthoredIconRecord } | null = null;

  for (const match of markup.matchAll(/<(link|meta)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const tag = match[1]!.toLowerCase();
    const attrs = new Map<string, string>();
    for (const attr of match[0].slice(match[1]!.length + 1, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = attr[1]!.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    if (tag === "meta" && attrs.get("name")?.toLowerCase() === "theme-color" && !themeColor) {
      const content = (attrs.get("content") ?? "").trim();
      if (/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,30})$/.test(content)) themeColor = content;
      continue;
    }
    if (tag !== "link") continue;
    const rels = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const isIcon = rels.includes("icon");
    const isApple = rels.includes("apple-touch-icon") || rels.includes("apple-touch-icon-precomposed");
    if (!isIcon && !isApple) continue;
    const href = (attrs.get("href") ?? "").trim();
    if (!href || href.startsWith("_tendril/")) continue;
    const declaredType = (attrs.get("type") ?? "").trim().toLowerCase() || null;
    const sizes = (attrs.get("sizes") ?? "").trim() || null;

    // Prioritize: published PNG/SVG > explicit rel="icon" > apple-touch-icon > data URI
    let rec: AuthoredIconRecord | null = null;
    let priority = isIcon ? 20 : 10;

    if (href.startsWith("data:")) {
      if (href.length <= MAX_DATA_URI_LEN && /^data:image\/(?:svg\+xml|png|webp|jpeg|gif|x-icon)/i.test(href)) {
        const mime = /^data:(image\/[a-z0-9.+-]+)/i.exec(href)?.[1]?.toLowerCase() ?? declaredType;
        rec = { href, type: mime, sizes, dataUri: href };
        priority += mime === "image/png" ? 8 : 5;
      }
    } else if (/^https:\/\//i.test(href)) {
      const samePath = resolveSamePagePath(href, pageBases);
      const pub = samePath ? files.get(samePath) : undefined;
      if (pub) {
        rec = { href, type: pub.type || declaredType, sizes, path: pub.path, hash: pub.hash };
        priority += pub.type === "image/png" ? 15 : 12;
      } else {
        rec = { href, type: declaredType ?? iconMediaType(href) ?? null, sizes };
        priority += 6;
      }
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//")) {
      const cleaned = href.split(/[?#]/, 1)[0]!.replace(/^\.?\//, "");
      const pub = files.get(cleaned);
      if (pub) {
        rec = { href: cleaned, type: pub.type || declaredType, sizes, path: pub.path, hash: pub.hash };
        priority += pub.type === "image/png" ? 15 : 12;
      }
    }

    if (rec && (!bestIcon || priority > bestIcon.priority)) {
      bestIcon = { priority, rec };
    }
  }

  return { icon: bestIcon?.rec ?? null, themeColor };
}

/** Resolve the single canonical icon for a page (explicit meta.icon -> authored HTML icon -> generated initial). */
export function resolvePageIcon(t: Tendril): ResolvedPageIcon {
  const metaIcon = t.db.get<string | null>("icon", null);
  const authoredTheme = t.db.get<string | null>("authored_theme_color", null);
  const themeColor = t.db.get<string | null>("theme_color", null) ?? authoredTheme ?? DEFAULT_THEME_COLOR;
  const name = t.db.get("name", "Tendril");

  if (metaIcon) {
    if (isEmojiIcon(metaIcon)) {
      return { kind: "emoji", emoji: metaIcon, themeColor, tag: `e-${shortTag(`${metaIcon}|${themeColor}`)}` };
    }
    if (/^https:\/\//i.test(metaIcon)) {
      const samePath = resolveSamePagePath(metaIcon, allPageBases(t));
      const version = t.db.get<number>("current", 0);
      const file = samePath && version > 0
        ? t.db.one<{ path: string; hash: string; type: string }>("SELECT path,hash,type FROM version_files WHERE version=? AND path=?", version, samePath)
        : null;
      if (file) {
        return { kind: "published", path: file.path, hash: file.hash, type: file.type, themeColor, tag: `p-${file.hash.slice(0, 16)}` };
      }
      return { kind: "external", url: metaIcon, type: iconMediaType(metaIcon) ?? null, themeColor, tag: `x-${shortTag(metaIcon)}` };
    }
  }

  const authored = t.db.get<AuthoredIconRecord | null>("authored_icon", null);
  if (authored) {
    if (authored.hash && authored.path) {
      return {
        kind: "published",
        path: authored.path,
        hash: authored.hash,
        type: authored.type ?? iconMediaType(`https://x/${authored.path}`) ?? "image/svg+xml",
        themeColor,
        tag: `a-${authored.hash.slice(0, 16)}`,
      };
    }
    if (authored.dataUri) {
      return {
        kind: "data",
        dataUri: authored.dataUri,
        type: authored.type ?? "image/svg+xml",
        themeColor,
        tag: `d-${shortTag(authored.dataUri)}`,
      };
    }
    if (/^https:\/\//i.test(authored.href)) {
      return { kind: "external", url: authored.href, type: authored.type, themeColor, tag: `x-${shortTag(authored.href)}` };
    }
  }

  const letter = (name.trim()[0] ?? "T").toUpperCase();
  return { kind: "generated", name, themeColor, tag: `g-${shortTag(`${letter}|${themeColor}`)}` };
}

export function decodeDataUri(dataUri: string): { type: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(dataUri);
  if (!m) return null;
  const type = (m[1] || "image/svg+xml").toLowerCase();
  const isBase64 = Boolean(m[2]);
  const payload = m[3] ?? "";
  try {
    if (isBase64) {
      const bin = atob(payload);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return { type, bytes: out };
    }
    return { type, bytes: enc.encode(decodeURIComponent(payload)) };
  } catch {
    return null;
  }
}

/** Build a cookieless capability URL for the dashboard / management avatar when the resolved icon is an image asset. */
export async function dashboardIconUrl(t: Tendril): Promise<string | null> {
  const resolved = resolvePageIcon(t);
  if (resolved.kind === "published" || resolved.kind === "data") {
    return iconBlobUrl(t.env, t.tid, resolved.tag, "authored");
  }
  if (resolved.kind === "external") {
    return resolved.url;
  }
  const raster = currentIconRaster(t);
  if (raster) {
    const rTag = `r-${iconRasterTag(raster.key)}`;
    return iconBlobUrl(t.env, t.tid, rTag, "any-192.png");
  }
  return null;
}

/** Build cookieless manifest icons (with 192x192 + 512x512 any + 512x512 maskable PNGs + SVG) for PWA installers. */
export async function buildManifestIcons(
  t: Tendril,
  customSize?: { type: string; width: number; height: number } | null,
): Promise<Array<{ src: string; sizes: string; type?: string; purpose: string }>> {
  const resolved = resolvePageIcon(t);
  const raster = currentIconRaster(t);
  const icons: Array<{ src: string; sizes: string; type?: string; purpose: string }> = [];

  if (raster) {
    const rTag = `r-${iconRasterTag(raster.key)}`;
    const [u192, u512, uMask] = await Promise.all([
      iconBlobUrl(t.env, t.tid, rTag, "any-192.png"),
      iconBlobUrl(t.env, t.tid, rTag, "any-512.png"),
      iconBlobUrl(t.env, t.tid, rTag, "maskable-512.png"),
    ]);
    icons.push(
      { src: u192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: u512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: uMask, sizes: "512x512", type: "image/png", purpose: "maskable" },
    );
  }

  if (resolved.kind === "published" || resolved.kind === "data") {
    const authoredUrl = await iconBlobUrl(t.env, t.tid, resolved.tag, "authored");
    const sizeStr = customSize ? `${customSize.width}x${customSize.height}` : "any";
    icons.push({ src: authoredUrl, sizes: sizeStr, type: resolved.type, purpose: "any" });
    if (icons.length === 1 && resolved.type === "image/svg+xml") {
      icons.push(
        { src: "/_tendril/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/_tendril/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      );
    }
    return icons;
  }

  if (resolved.kind === "external") {
    const effectiveType = customSize?.type ?? resolved.type;
    if (customSize || effectiveType === "image/png" || effectiveType === "image/webp" || effectiveType === "image/svg+xml") {
      const sizeStr = customSize ? `${customSize.width}x${customSize.height}` : "any";
      icons.push({ src: resolved.url, sizes: sizeStr, ...(effectiveType ? { type: effectiveType } : {}), purpose: "any" });
      if (!customSize || Math.min(customSize.width, customSize.height) < 192) {
        icons.push(
          { src: "/_tendril/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/_tendril/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        );
      }
      return icons;
    }
  }

  const [svgUrl, maskSvgUrl] = await Promise.all([
    iconBlobUrl(t.env, t.tid, resolved.tag, "icon.svg"),
    iconBlobUrl(t.env, t.tid, resolved.tag, "icon-maskable.svg"),
  ]);
  icons.push(
    { src: svgUrl, sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: maskSvgUrl, sizes: "any", type: "image/svg+xml", purpose: "maskable" },
  );
  if (!raster) {
    icons.push(
      { src: "/_tendril/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/_tendril/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    );
  }
  return icons;
}

/** Serve a cookieless capability-signed icon blob (zero cookies, zero redirects, immutable). */
export async function serveIconBlob(t: Tendril, tag: string, file: string, head: boolean): Promise<Response> {
  const baseHeaders = {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  };
  if (file === "any-192.png" || file === "any-512.png" || file === "maskable-512.png") {
    const raster = currentIconRaster(t);
    if (!raster || `r-${iconRasterTag(raster.key)}` !== tag) {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const b64 = file === "maskable-512.png" ? raster.maskable : file === "any-192.png" ? (raster.any192 ?? raster.any) : raster.any;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new Response(head ? null : bytes, { status: 200, headers: { ...baseHeaders, "Content-Type": "image/png", "Content-Length": String(bytes.byteLength) } });
  }

  const resolved = resolvePageIcon(t);
  if (resolved.tag !== tag) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  if (file === "authored") {
    if (resolved.kind === "published") {
      const obj = await t.env.FILES.get(fileKey(t, resolved.hash));
      if (!obj) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      return new Response(head ? null : obj.body, {
        status: 200,
        headers: { ...baseHeaders, "Content-Type": resolved.type, "Content-Length": String(obj.size) },
      });
    }
    if (resolved.kind === "data") {
      const decoded = decodeDataUri(resolved.dataUri);
      if (!decoded) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      return new Response(head ? null : decoded.bytes, {
        status: 200,
        headers: { ...baseHeaders, "Content-Type": decoded.type, "Content-Length": String(decoded.bytes.byteLength) },
      });
    }
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  if (file === "icon.svg" || file === "icon-maskable.svg") {
    const maskable = file === "icon-maskable.svg";
    let svg: string;
    if (resolved.kind === "emoji") svg = maskable ? maskableEmojiIconSvg(resolved.emoji, resolved.themeColor) : emojiIconSvg(resolved.emoji);
    else if (resolved.kind === "generated") svg = maskable ? maskableIconSvg(resolved.name, resolved.themeColor) : iconSvg(resolved.name, resolved.themeColor);
    else if (!maskable && resolved.kind === "published" && resolved.type === "image/svg+xml") {
      const obj = await t.env.FILES.get(fileKey(t, resolved.hash));
      if (!obj) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      return new Response(head ? null : obj.body, {
        status: 200,
        headers: { ...baseHeaders, "Content-Type": "image/svg+xml", "Content-Length": String(obj.size) },
      });
    } else if (!maskable && resolved.kind === "data" && resolved.type === "image/svg+xml") {
      const decoded = decodeDataUri(resolved.dataUri);
      if (!decoded) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      return new Response(head ? null : decoded.bytes, {
        status: 200,
        headers: { ...baseHeaders, "Content-Type": "image/svg+xml", "Content-Length": String(decoded.bytes.byteLength) },
      });
    } else {
      svg = maskable ? maskableIconSvg(t.db.get("name", "Tendril"), resolved.themeColor) : iconSvg(t.db.get("name", "Tendril"), resolved.themeColor);
    }
    const bytes = enc.encode(svg);
    return new Response(head ? null : bytes, {
      status: 200,
      headers: { ...baseHeaders, "Content-Type": "image/svg+xml", "Content-Length": String(bytes.byteLength) },
    });
  }

  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

/** Render the resolved SVG (or maskable SVG) for `_tendril/icon.svg` & `_tendril/icon-maskable.svg`. */
export async function resolvedSvgResponse(t: Tendril, maskable: boolean, head: boolean): Promise<Response> {
  const resolved = resolvePageIcon(t);
  const headers = { "Content-Type": "image/svg+xml", "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" };
  if (resolved.kind === "published" && resolved.type === "image/svg+xml" && !maskable) {
    const obj = await t.env.FILES.get(fileKey(t, resolved.hash));
    if (obj) return new Response(head ? null : obj.body, { headers });
  }
  if (resolved.kind === "data" && resolved.type === "image/svg+xml" && !maskable) {
    const decoded = decodeDataUri(resolved.dataUri);
    if (decoded) return new Response(head ? null : decoded.bytes, { headers });
  }
  if (resolved.kind === "emoji") {
    const svg = maskable ? maskableEmojiIconSvg(resolved.emoji, resolved.themeColor) : emojiIconSvg(resolved.emoji);
    return new Response(head ? null : svg, { headers });
  }
  const svg = maskable
    ? maskableIconSvg(t.db.get("name", "Tendril"), resolved.themeColor)
    : iconSvg(t.db.get("name", "Tendril"), resolved.themeColor);
  return new Response(head ? null : svg, { headers });
}
