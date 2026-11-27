// Home-screen icons for Android. Chrome's WebAPK install ignores SVG manifest icons
// and raster icons without real dimensions; with neither it draws a letter. Emoji
// icons exist only as SVG, so the owner's browser rasterizes the page's own icon
// SVGs once (it has the emoji font) and stores 512px PNGs here.
import type { Tendril } from "./tendril";
import { HttpError } from "./http";
import { DEFAULT_THEME_COLOR, isEmojiIcon } from "./pwa";
import { fileKey, servedVersion, versionFile } from "./files";
import { allPageBases, type AuthoredIconRecord } from "./page-icon";

export const ICON_RASTER_SIZE = 512;
export const ICON_RASTER_SMALL_SIZE = 192;
const MAX_PNG_BYTES = 400 * 1024;
const SIZE_LOOKUP_MS = 2500;

export interface StoredRaster { key: string; any: string; any192?: string; maskable: string }

/** Identity of the SVG pair the rasters were drawn from (emoji, authored SVG, or default page initial+theme). */
export function iconRasterKey(t: Tendril): string | null {
  const icon = t.db.get<string | null>("icon", null);
  const authoredTheme = t.db.get<string | null>("authored_theme_color", null);
  const themeColor = t.db.get<string | null>("theme_color", null) ?? authoredTheme ?? DEFAULT_THEME_COLOR;
  if (icon) {
    if (!isEmojiIcon(icon)) return null;
    return JSON.stringify([1, icon, themeColor]);
  }
  // Never overwrite an authored raster icon with a generated green-letter PNG!
  // If the page authored an SVG <link rel="icon">, rasterize THAT SVG (keyed on its content).
  const authored = t.db.get<AuthoredIconRecord | null>("authored_icon", null);
  if (authored) {
    const isSvg = authored.type === "image/svg+xml" || /\.svg(?:$|[?#])/i.test(authored.href);
    if (!isSvg) return null;
    const identity = authored.hash ?? authored.dataUri?.slice(0, 256) ?? authored.href;
    return JSON.stringify([3, identity, themeColor]);
  }
  const letter = (t.db.get("name", "Tendril").trim()[0] ?? "T").toUpperCase();
  return JSON.stringify([2, letter, themeColor]);
}

/** A short cache-busting tag for the icon URLs. */
export function iconRasterTag(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

/** The current raster pair, if it was drawn from the current icon. */
export function currentIconRaster(t: Tendril): StoredRaster | null {
  const key = iconRasterKey(t), stored = t.db.get<StoredRaster | null>("icon_raster", null);
  return key && stored?.key === key ? stored : null;
}

/** Only the owner's page needs to draw a missing or stale pair. */
export function iconRasterRequest(t: Tendril, role: string): { key: string } | undefined {
  const key = iconRasterKey(t);
  return role === "owner" && key && !currentIconRaster(t) ? { key } : undefined;
}

/** Validates a base64 square PNG of expected pixel dimensions and returns it unchanged. */
function validPng(value: unknown, expectedSize = ICON_RASTER_SIZE): string {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_PNG_BYTES * 4 / 3) + 4) throw new HttpError(400, "invalid_icon", "Expected a base64 PNG");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0)); } catch { throw new HttpError(400, "invalid_icon", "Expected a base64 PNG"); }
  const size = imageSize(bytes);
  if (size?.type !== "image/png" || size.width !== expectedSize || size.height !== expectedSize)
    throw new HttpError(400, "invalid_icon", `Expected a ${expectedSize}x${expectedSize} PNG`);
  return value;
}

export function storeIconRaster(t: Tendril, body: Record<string, unknown>): void {
  const key = iconRasterKey(t);
  if (!key || body.key !== key) throw new HttpError(409, "icon_changed", "The page icon changed; reload to draw the current one");
  const any192 = body.any192 !== undefined && body.any192 !== null ? validPng(body.any192, ICON_RASTER_SMALL_SIZE) : undefined;
  t.db.set("icon_raster", {
    key,
    any: validPng(body.any, ICON_RASTER_SIZE),
    ...(any192 ? { any192 } : {}),
    maskable: validPng(body.maskable, ICON_RASTER_SIZE),
  } satisfies StoredRaster);
}

export function iconRasterResponse(t: Tendril, which: "any" | "any192" | "maskable", head: boolean): Response | null {
  const stored = currentIconRaster(t);
  if (!stored) return null;
  const b64 = which === "any192" ? (stored.any192 ?? stored.any) : stored[which];
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Response(head ? null : bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" } });
}

/**
 * iOS home-screen icon. Safari ignores manifest icons and SVG, and turns
 * transparency black, so emoji pages use the opaque full-bleed PNG; custom
 * images are used when they are PNG or JPEG (by extension or measured type).
 */
export async function appleTouchIcon(t: Tendril, base: string, requestBase: string, { background = false } = {}): Promise<{ href: string; sizes?: string } | null> {
  const icon = t.db.get<string | null>("icon", null);
  if (!icon || isEmojiIcon(icon)) {
    const raster = currentIconRaster(t);
    return raster ? { href: `${base}_tendril/icon-maskable-512.png?v=${iconRasterTag(raster.key)}`, sizes: "512x512" } : null;
  }
  if (!/^https:\/\//.test(icon)) return null;
  if (/\.png(?:$|[?#])/i.test(icon)) return { href: icon };
  if (background) {
    const cached = t.db.get<{ type: string; width: number; height: number } | { failed: number } | null>("icon_size:" + icon, null);
    if (cached && "width" in cached) {
      return (cached.type === "image/png" || cached.type === "image/jpeg") ? { href: icon, sizes: `${cached.width}x${cached.height}` } : null;
    }
    if (!cached || ("failed" in cached && t.now() - cached.failed >= 3_600_000)) {
      t.ctx.waitUntil(remoteIconSize(t, icon, requestBase).catch(() => null));
    }
    return null;
  }
  const size = await remoteIconSize(t, icon, requestBase);
  return size && (size.type === "image/png" || size.type === "image/jpeg") ? { href: icon, sizes: `${size.width}x${size.height}` } : null;
}

/** Rasterized 512px PNG favicon when the owner's browser has drawn one for this page's icon. */
export function rasterFavicon(t: Tendril, base: string): { href: string; sizes: string } | null {
  const raster = currentIconRaster(t);
  return raster ? { href: `${base}_tendril/icon-512.png?v=${iconRasterTag(raster.key)}`, sizes: "512x512" } : null;
}

/** Pixel size of a PNG, GIF, WebP or JPEG from its leading bytes. */
export function imageSize(b: Uint8Array): { type: string; width: number; height: number } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength), ascii = (at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
  if (b.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && ascii(12, 4) === "IHDR")
    return { type: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  if (b.length >= 10 && ascii(0, 3) === "GIF") return { type: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") return { type: "image/webp", width: 1 + (b[24]! | b[25]! << 8 | b[26]! << 16), height: 1 + (b[27]! | b[28]! << 8 | b[29]! << 16) };
    if (chunk === "VP8L") { const v = view.getUint32(21, true); return { type: "image/webp", width: 1 + (v & 0x3fff), height: 1 + (v >> 14 & 0x3fff) }; }
    if (chunk === "VP8 ") return { type: "image/webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let at = 2; at + 9 < b.length;) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1]!, length = view.getUint16(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { type: "image/jpeg", width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      at += 2 + length;
    }
  }
  return null;
}

type Size = { type: string; width: number; height: number };

/** An icon published inside this page: read it from storage (fetching it would need the owner's sign-in). */
async function publishedIconSize(t: Tendril, icon: string, pageBases: string[]): Promise<Size | null | undefined> {
  const target = new URL(icon);
  // Same page host and path (ports differ between local hosts and the configured URL).
  const base = pageBases.map(candidate => new URL(candidate))
    .find(candidate => candidate.hostname === target.hostname && target.pathname.startsWith(candidate.pathname));
  if (!base) return undefined;
  let path: string;
  try { path = decodeURIComponent(target.pathname.slice(base.pathname.length)); } catch { return null; }
  const file = versionFile(t, servedVersion(t), path);
  if (!file) return null;
  const cacheKey = "icon_size:" + file.hash, cached = t.db.get<Size | null>(cacheKey, null);
  if (cached) return cached;
  const object = await t.env.FILES.get(fileKey(t, file.hash), { range: { offset: 0, length: 65536 } });
  const size = object ? imageSize(new Uint8Array(await object.arrayBuffer())) : null;
  if (size) t.db.set(cacheKey, size);
  return size;
}

/** Real dimensions of an authored HTTPS icon, looked up once and remembered. */
export async function remoteIconSize(t: Tendril, icon: string, requestBase: string): Promise<Size | null> {
  const published = await publishedIconSize(t, icon, allPageBases(t, requestBase)).catch(() => null);
  if (published !== undefined) return published;
  const cacheKey = "icon_size:" + icon;
  const cached = t.db.get<{ type: string; width: number; height: number } | { failed: number } | null>(cacheKey, null);
  if (cached && "width" in cached) return cached;
  if (cached && "failed" in cached && t.now() - cached.failed < 3_600_000) return null;
  try {
    const response = await fetch(icon, { redirect: "follow", signal: AbortSignal.timeout(SIZE_LOOKUP_MS), headers: { Range: "bytes=0-65535" } });
    if (!response.ok && response.status !== 206) throw new Error("unavailable");
    const reader = response.body!.getReader(), parts: Uint8Array[] = [];
    let length = 0;
    while (length < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); length += value.length;
    }
    await reader.cancel().catch(() => {});
    const bytes = new Uint8Array(length); let at = 0;
    for (const part of parts) { bytes.set(part.subarray(0, length - at), at); at += part.length; }
    const size = imageSize(bytes);
    if (!size) throw new Error("unrecognized");
    t.db.set(cacheKey, size);
    return size;
  } catch {
    t.db.set(cacheKey, { failed: t.now() });
    return null;
  }
}
