import runtimeRelease from "./runtime-release.json";
import type { RuntimeArtifactFeatures } from "../../contract/index.mjs";
import { brandHead, brandStyle } from "./brand";
import { baseThemeCss } from "./accounts/ui";
export { landingPage } from "./landing";
import { DEFAULT_THEME_COLOR, iconMediaType, isEmojiIcon, type PageBranding } from "./pwa";

// Runtime injection into served HTML (PROTOCOL section 5) and built-in pages.

export interface Features extends RuntimeArtifactFeatures {
  shared_by: string;
}

export interface PublicationManifest {
  id: string;
  base: string;
  entry: string;
  assets: { path: string; sha256: string; type: string; size: number }[];
  runtime: { id: string; version: string; base: string; features: RuntimeArtifactFeatures };
}

export type InjectConfig = {
  id: string;
  base: string;
  version: number;
  features: Features;
  application: import("../../contract/application.mjs").ApplicationSelection;
  peerBootstrap?: import("../../contract/peers.mjs").PeerBootstrap;
  /** Asks the owner's page to draw missing home-screen PNG icons (owner only). */
  iconRaster?: { key: string };
  /** Trusted Ed25519 public keys for verifying system-wide signed broadcasts. */
  broadcastKeys?: import("../../contract/broadcasts.mjs").BroadcastPublicJwk[];
  /** Nonzero when at least one active system broadcast exists on the service. */
  broadcastLatestSeq?: number;
  /** Server-rendered install branding, not part of the runtime configuration. */
  branding?: PageBranding;
} & ({ publication: PublicationManifest; documentPath: string } | { publication?: null; documentPath: null });

/** Escapes a JSON string for safe inclusion inside a <script> element. */
function scriptSafeJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function runtimeTags(cfg: InjectConfig, installTags = `<link rel="manifest" href="${attr(cfg.base)}_tendril/manifest.webmanifest" crossorigin="use-credentials">`): string {
  const publication = cfg.publication;
  const directory = cfg.documentPath === null ? "" : cfg.documentPath.slice(0, cfg.documentPath.lastIndexOf("/") + 1);
  const documentBase = publication ? publication.base + directory.split("/").map(encodeURIComponent).join("/") : cfg.base;
  const runtimeBase = publication?.runtime.base ?? `/_tendril/runtime/${runtimeRelease.id}/`;
  const conf = { id: cfg.id, base: cfg.base, version: cfg.version, documentPath: cfg.documentPath,
    application: cfg.application, peerBootstrap: cfg.peerBootstrap, ...(cfg.iconRaster ? { iconRaster: cfg.iconRaster } : {}),
    ...(cfg.broadcastKeys?.length ? { broadcastKeys: cfg.broadcastKeys } : {}),
    ...(cfg.broadcastLatestSeq ? { broadcastLatestSeq: cfg.broadcastLatestSeq } : {}),
    features: { ...cfg.features, ...publication?.runtime.features }, ...(publication ? { publication } : {}) };
  return (
    `<base href="${attr(documentBase)}">` +
    installTags +
    `<script>window.__TENDRIL__=${scriptSafeJson(conf)};</script>` +
    `<script src="${attr(runtimeBase)}tendril.js"></script>`
  );
}

const HEAD_RE = /<head(?:\s[^>]*)?>/i;

/** Read only actual metadata tags, not markup mentioned in comments or scripts. */
function metadataTags(html: string): { tag: string; attributes: Map<string, string> }[] {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? html;
  const markup = head.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  return [...markup.matchAll(/<(link|meta)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)].map(match => {
    const attributes = new Map<string, string>();
    for (const attr of match[0].slice(match[1].length + 1, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = attr[1].toLowerCase();
      if (!attributes.has(name)) attributes.set(name, attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    return { tag: match[1].toLowerCase(), attributes };
  });
}

function installMetadata(html: string, cfg: InjectConfig): string {
  const tags = metadataTags(html);
  const link = (...names: string[]) => tags.some(({ tag, attributes }) => tag === "link" &&
    (attributes.get("rel") ?? "").toLowerCase().split(/\s+/).some(value => names.includes(value)));
  const meta = (name: string) => tags.some(({ tag, attributes }) => tag === "meta" && attributes.get("name")?.toLowerCase() === name);
  const authoredManifest = link("manifest");
  const authoredIcon = link("icon");
  const branding = cfg.branding;
  const customFavicon = branding?.icon && !isEmojiIcon(branding.icon) ? branding.icon : null;
  const faviconType = customFavicon ? iconMediaType(customFavicon) : "image/svg+xml";
  const customAppleIcon = branding?.appleIcon ?? (branding?.icon && iconMediaType(branding.icon) === "image/png" ? { href: branding.icon } : null);
  const rasterIcon = !customFavicon ? branding?.rasterIcon : null;
  // Never inject the generic Tendriller brand apple-touch-icon over a page that already
  // authored its own `<link rel="icon">` or configured a custom/emoji icon — Android Firefox
  // ranks a 180x180 PNG apple-touch-icon ahead of SVG/authored favicons for tab & bookmark icons.
  const appleIconTag = !authoredManifest && !link("apple-touch-icon", "apple-touch-icon-precomposed")
    ? customAppleIcon
      ? `<link rel="apple-touch-icon" href="${attr(customAppleIcon.href)}"${customAppleIcon.sizes ? ` sizes="${attr(customAppleIcon.sizes)}"` : ""}>`
      : (!authoredIcon && !branding?.icon ? `<link rel="apple-touch-icon" href="/_tendril/brand/icon-180.png" sizes="180x180">` : "")
    : "";
  return [
    // Fetching a same-origin manifest still omits cookies without this attribute.
    !authoredManifest ? `<link rel="manifest" href="${attr(cfg.base)}_tendril/manifest.webmanifest" crossorigin="use-credentials">` : "",
    // Apple touch icons and title/theme metadata can take precedence over a
    // manifest's branding. Leave an authored manifest in charge of those defaults.
    !authoredManifest && !authoredIcon ? `<link rel="icon" href="${attr(customFavicon ?? `${cfg.base}_tendril/icon.svg`)}"${faviconType ? ` type="${faviconType}"` : ""}${customFavicon ? "" : ' sizes="any"'}>` : "",
    !authoredManifest && !authoredIcon && rasterIcon ? `<link rel="icon" href="${attr(rasterIcon.href)}" type="image/png"${rasterIcon.sizes ? ` sizes="${attr(rasterIcon.sizes)}"` : ""}>` : "",
    appleIconTag,
    !authoredManifest && !meta("theme-color") ? `<meta name="theme-color" content="${attr(branding?.themeColor ?? DEFAULT_THEME_COLOR)}">` : "",
    !authoredManifest && branding && !meta("apple-mobile-web-app-title")
      ? `<meta name="apple-mobile-web-app-title" content="${attr(branding.shortName ?? branding.name)}">` : "",
    !meta("viewport") ? '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' : "",
  ].join("");
}

/** Inserts the runtime right after the opening <head> tag, or at the very start if there is none. */
export function injectRuntime(html: string, cfg: InjectConfig): string {
  // Defaults fill gaps individually; every authored install preference wins.
  const tags = runtimeTags(cfg, installMetadata(html, cfg));
  const m = HEAD_RE.exec(html);
  if (!m) return tags + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + tags + html.slice(at);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function holdingPage(name: string): string {
  const n = escapeHtml(name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${n} is getting ready · Tendriller</title>
${brandHead()}${brandStyle}
<style>
${baseThemeCss}
body{display:grid;place-items:center;padding:1.25rem}
main{max-width:34rem;width:100%;margin:0;padding:clamp(1.6rem,4vw,2.5rem);border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow)}
h1{font-size:clamp(1.6rem,4vw,2.15rem);line-height:1.12;letter-spacing:-.032em;margin:.2rem 0 .75rem}
.pulse{display:inline-block;width:.58rem;height:.58rem;background:var(--accent-2);border-radius:50%;margin-right:.55rem;vertical-align:middle;box-shadow:0 0 0 4px color-mix(in srgb,var(--accent-2) 22%,transparent);animation:pulse 1.8s ease-in-out infinite}
p{color:var(--muted);margin:0 0 1rem}
p:last-child{margin-bottom:0}
a{font-weight:660}
@keyframes pulse{50%{opacity:.4;transform:scale(.78)}}
@media(prefers-reduced-motion:reduce){.pulse{animation:none}}
</style>
</head>
<body>
<main>
  <img class="holding-brand" src="/_tendril/brand/icon-180.png" alt="Tendriller" width="72" height="72">
  <span class="eyebrow">Waiting for publication</span><h1>${n} is getting ready.</h1>
  <p><span class="pulse" aria-hidden="true"></span><span id="publication-status" role="status">Your agent is preparing the first version. It will open here automatically.</span></p>
  <p><a href="">Check now</a></p>
</main>
</body>
</html>`;
}

export function emojiIconSvg(emoji: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<text x="256" y="416" text-anchor="middle" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif" font-size="416">${escapeHtml(emoji)}</text>` +
    `</svg>`;
}

export function iconSvg(name: string, color: string): string {
  const letter = escapeHtml((name.trim()[0] ?? "T").toUpperCase());
  const bg = /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#2d6a4f";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<rect width="512" height="512" rx="96" fill="${bg}"/>` +
    `<text x="256" y="256" dy=".35em" text-anchor="middle" font-family="system-ui,sans-serif" font-size="300" font-weight="600" fill="#fff">${letter}</text>` +
    `</svg>`;
}

/** Maskable icon with full square background bleed and artwork centered inside the 70% adaptive safe zone. */
export function maskableIconSvg(name: string, color: string): string {
  const letter = escapeHtml((name.trim()[0] ?? "T").toUpperCase());
  const bg = /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#2d6a4f";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<rect width="512" height="512" fill="${bg}"/>` +
    `<text x="256" y="256" dy=".35em" text-anchor="middle" font-family="system-ui,sans-serif" font-size="220" font-weight="650" fill="#fff">${letter}</text>` +
    `</svg>`;
}

export function maskableEmojiIconSvg(emoji: string, color: string): string {
  const bg = /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#2d6a4f";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<rect width="512" height="512" fill="${bg}"/>` +
    `<text x="256" y="346" text-anchor="middle" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif" font-size="250">${escapeHtml(emoji)}</text>` +
    `</svg>`;
}
