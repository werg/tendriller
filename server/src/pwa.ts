/** Browser-facing install metadata; authored manifests can provide richer icons. */
export interface PageBranding {
  name: string;
  shortName?: string | null;
  themeColor?: string | null;
  icon?: string | null;
  /** Resolved iOS home-screen icon (PNG/JPEG), when one is known. */
  appleIcon?: { href: string; sizes?: string } | null;
  /** Rasterized page-specific PNG favicon (for Android Firefox / mobile browsers that prefer raster over SVG). */
  rasterIcon?: { href: string; sizes?: string } | null;
}

export const DEFAULT_THEME_COLOR = "#2d6a4f";

// Unicode's complete emoji sequences include flags, skin tones and ZWJ families.
// Also accept single pictographs and keycaps without a presentation selector.
// Use the constructor because the server's TypeScript target is ES2023.
const EMOJI_ICON = new RegExp(String.raw`^(?:\p{RGI_Emoji}|\p{Extended_Pictographic}\uFE0F?|[0-9#*]\uFE0F?\u20E3)$`, "v");

export function isEmojiIcon(icon: string): boolean {
  return EMOJI_ICON.test(icon);
}

export function iconMediaType(icon: string): string | undefined {
  try {
    const extension = /\.([a-z0-9]+)$/i.exec(new URL(icon).pathname)?.[1].toLowerCase();
    return extension && ({ png: "image/png", svg: "image/svg+xml", webp: "image/webp",
      jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", ico: "image/x-icon" } as Record<string, string>)[extension];
  } catch { return undefined; }
}

export interface PageShortcut {
  name: string;
  short_name?: string;
  description?: string;
  url: string;
}

export function isSafeRelativePageUrl(raw: string): boolean {
  if (raw === "") return true;
  if (raw.length > 256 || /[\u0000-\u001f\u007f\\]/.test(raw)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("/")) return false;
  const pathPart = raw.split(/[?#]/, 1)[0] ?? "";
  if (pathPart.split("/").some(seg => seg === ".." || seg === ".")) return false;
  return true;
}

export function validateShortcuts(raw: unknown): PageShortcut[] {
  if (!Array.isArray(raw)) throw new Error("shortcuts must be an array");
  if (raw.length > 4) throw new Error("At most 4 shortcuts are allowed");
  const out: PageShortcut[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each shortcut must be an object");
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || !rec.name.trim() || rec.name.trim().length > 64) {
      throw new Error("Each shortcut requires a name (1–64 characters)");
    }
    if (typeof rec.url !== "string" || !isSafeRelativePageUrl(rec.url.trim())) {
      throw new Error("Shortcut url must be a relative path, query, or fragment within this page");
    }
    const entry: PageShortcut = { name: rec.name.trim(), url: rec.url.trim() };
    if (rec.short_name !== undefined && rec.short_name !== null) {
      if (typeof rec.short_name !== "string" || !rec.short_name.trim() || rec.short_name.trim().length > 24) {
        throw new Error("Shortcut short_name must be 1–24 characters");
      }
      entry.short_name = rec.short_name.trim();
    }
    if (rec.description !== undefined && rec.description !== null) {
      if (typeof rec.description !== "string" || rec.description.trim().length > 120) {
        throw new Error("Shortcut description must be at most 120 characters");
      }
      if (rec.description.trim()) entry.description = rec.description.trim();
    }
    out.push(entry);
  }
  return out;
}

export function resolveShortcuts(shortcuts: PageShortcut[], base: string): PageShortcut[] {
  return shortcuts.map(s => ({
    name: s.name,
    ...(s.short_name ? { short_name: s.short_name } : {}),
    ...(s.description ? { description: s.description } : {}),
    url: s.url ? `${base}${s.url}` : base,
  }));
}

/**
 * Manifest icons. Chromium installability (`beforeinstallprompt` / Android WebAPK)
 * requires at least a 192x192 PNG/WebP icon with known dimensions on the first load.
 * Owner-drawn 512px PNGs (`rasterTag`) are listed first once available; until then,
 * static 192px + 512px brand PNGs satisfy installability immediately.
 */
export function pageIcons(base: string, icon: string | null, extra: { rasterTag?: string | null; customSize?: { type: string; width: number; height: number } | null } = {}) {
  const maskable = { src: `${base}_tendril/icon-maskable.svg`, sizes: "any", type: "image/svg+xml", purpose: "maskable" };
  const brandIcons = [
    { src: "/_tendril/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/_tendril/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ];
  if (icon && isEmojiIcon(icon)) {
    if (extra.rasterTag) {
      return [
        { src: `${base}_tendril/icon-512.png?v=${extra.rasterTag}`, sizes: "512x512", type: "image/png", purpose: "any" },
        { src: `${base}_tendril/icon-maskable-512.png?v=${extra.rasterTag}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
        { src: `${base}_tendril/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
        maskable,
      ];
    }
    return [
      { src: `${base}_tendril/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
      maskable,
      ...brandIcons,
    ];
  }
  const type = icon ? extra.customSize?.type ?? iconMediaType(icon) : undefined;
  if (icon && (extra.customSize || type === "image/png" || type === "image/webp" || type === "image/svg+xml")) {
    // A measured raster icon >= 192px satisfies Chromium installability on its own.
    // Do not add the generated letter as a maskable icon: launchers prefer maskable icons.
    const size = extra.customSize;
    const custom = { src: icon, sizes: size ? `${size.width}x${size.height}` : "any", type, purpose: "any" };
    return size && Math.min(size.width, size.height) >= 192 ? [custom] : [custom, ...brandIcons];
  }
  if (!icon && extra.rasterTag) {
    return [
      { src: `${base}_tendril/icon-512.png?v=${extra.rasterTag}`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `${base}_tendril/icon-maskable-512.png?v=${extra.rasterTag}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: `${base}_tendril/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
      maskable,
    ];
  }
  return [
    ...brandIcons,
    { src: `${base}_tendril/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
    maskable,
  ];
}
