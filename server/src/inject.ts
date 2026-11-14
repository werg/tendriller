// Runtime injection into served HTML (PROTOCOL section 5) and built-in pages.

export interface Features {
  push: boolean;
  vapid: string | null;
  shared_by: string;
  speech: { model: string; url: string; sha256: string };
}

export interface InjectConfig {
  id: string;
  base: string;
  version: number;
  features: Features;
}

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

export function runtimeTags(cfg: InjectConfig): string {
  const conf = { id: cfg.id, base: cfg.base, version: cfg.version, ws: cfg.base + "_tendril/ws", features: cfg.features };
  return (
    `<script>window.__TENDRIL__=${scriptSafeJson(conf)};</script>` +
    `<script src="${attr(cfg.base)}_tendril/tendril.js"></script>`
  );
}

const HEAD_RE = /<head(?:\s[^>]*)?>/i;

/** Inserts the runtime right after the opening <head> tag, or at the very start if there is none. */
export function injectRuntime(html: string, cfg: InjectConfig): string {
  const tags = runtimeTags(cfg);
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
<title>${n}</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font:1.25rem/1.5 system-ui,sans-serif;background:#f6f6f4;color:#222}
  main{text-align:center;padding:2rem}
  h1{font-size:1.5rem;margin:0 0 .5rem}
  @media (prefers-color-scheme: dark){body{background:#151515;color:#eee}}
</style>
</head>
<body>
<main>
  <h1>${n}</h1>
  <p role="status">Waiting for the agent&hellip;</p>
</main>
</body>
</html>`;
}

export function landingPage(publicBase: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tendriller</title>
<style>body{font:1.1rem/1.6 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}</style>
</head>
<body>
<h1>Tendriller</h1>
<p>Live web pages that an agent writes, controls and listens to.</p>
<p>Agents: read <a href="${escapeHtml(publicBase)}/agent.md">agent.md</a> for instructions.</p>
</body>
</html>`;
}

export function iconSvg(name: string, color: string): string {
  const letter = escapeHtml((name.trim()[0] ?? "T").toUpperCase());
  const bg = /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#2d6a4f";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<rect width="512" height="512" rx="96" fill="${bg}"/>` +
    `<text x="256" y="256" dy=".35em" text-anchor="middle" font-family="system-ui,sans-serif" font-size="300" font-weight="600" fill="#fff">${letter}</text>` +
    `</svg>`;
}
