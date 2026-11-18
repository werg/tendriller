/** Browser-facing install metadata; authored manifests can provide richer icons. */
export interface PageBranding {
  name: string;
  shortName?: string | null;
  themeColor?: string | null;
  icon?: string | null;
}

export const DEFAULT_THEME_COLOR = "#2d6a4f";

export function iconMediaType(icon: string): string | undefined {
  try {
    const extension = /\.([a-z0-9]+)$/i.exec(new URL(icon).pathname)?.[1].toLowerCase();
    return extension && ({ png: "image/png", svg: "image/svg+xml", webp: "image/webp",
      jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", ico: "image/x-icon" } as Record<string, string>)[extension];
  } catch { return undefined; }
}

export function pageIcons(base: string, icon: string | null) {
  const fallback = [
    { src: "/_tendril/brand/icon-180.png", sizes: "180x180", type: "image/png", purpose: "any" },
    { src: `${base}_tendril/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
  ];
  if (!icon) return fallback;
  const type = iconMediaType(icon);
  // A URL alone does not establish raster dimensions. Keep the scalable default
  // available, and let the browser inspect a custom icon whose size is unknown.
  return [...fallback, { src: icon, ...(type ? { type } : {}),
    ...(type === "image/svg+xml" ? { sizes: "any" } : {}), purpose: "any" }];
}
