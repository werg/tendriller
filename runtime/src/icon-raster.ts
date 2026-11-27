// Android home-screen installs need PNG icons; the page's emoji icon exists only as
// SVG. When the host asks (owner pages only), draw the page's own icon SVGs into
// 512px PNGs with this device's emoji font and store them once. Failures are silent:
// the SVG icons keep working everywhere else.
import type { TendrilConfig } from "./types";

const SIZE = 512;
const SMALL_SIZE = 192;

async function draw(url: string, size = SIZE): Promise<string> {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas");
  context.drawImage(image, 0, 0, size, size);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function rasterizeHomeScreenIcon(cfg: TendrilConfig): void {
  const request = cfg.iconRaster;
  if (!request || typeof document === "undefined" || typeof fetch !== "function") return;
  const run = async () => {
    const base = new URL(cfg.base, location.href);
    const anyUrl = new URL("_tendril/icon.svg", base).href;
    const maskUrl = new URL("_tendril/icon-maskable.svg", base).href;
    const [any, any192, maskable] = await Promise.all([draw(anyUrl, SIZE), draw(anyUrl, SMALL_SIZE), draw(maskUrl, SIZE)]);
    const response = await fetch(new URL("_tendril/icon-raster", base).href, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: request.key, any, any192, maskable }),
    });
    if (!response.ok) return;
    // Replace the manifest link node so Chromium re-fetches the updated manifest and
    // re-evaluates installability with the page's own 512px PNG icons without a reload.
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) {
      const href = new URL(link.href);
      href.searchParams.set("icons", String(Date.now()));
      const next = document.createElement("link");
      next.rel = "manifest";
      if (link.crossOrigin) next.crossOrigin = link.crossOrigin;
      next.href = href.href;
      link.replaceWith(next);
    }
  };
  const start = () => { run().catch(() => { /* Keep the SVG/brand icons. */ }); };
  // Run promptly after initial paint so the page's own 512px PNGs are stored before
  // the user opens install options, without blocking document parsing.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { setTimeout(start, 0); }, { once: true });
  } else {
    setTimeout(start, 0);
  }
}
