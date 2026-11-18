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
  const type = icon ? iconMediaType(icon) : undefined;
  if (icon && (type === "image/png" || type === "image/webp" || type === "image/svg+xml")) {
    // Chromium skips entries without sizes and prefers a sized default over a
    // custom raster candidate marked "any". Let it decode and size the custom
    // asset without claiming pixel dimensions that the URL cannot establish.
    return [{ src: icon, sizes: "any", type, purpose: "any" }];
  }
  return [
    { src: "/_tendril/brand/icon-180.png", sizes: "180x180", type: "image/png", purpose: "any" },
    { src: `${base}_tendril/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
  ];
}
