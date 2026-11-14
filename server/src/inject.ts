import { brandHead, brandLink, brandLogo, brandStyle } from "./brand";

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
<title>${n} is getting ready · Tendriller</title>
${brandHead("_tendril/brand/")}${brandStyle}
<style>
  :root{color-scheme:light dark}*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{display:grid;place-items:center;font:1rem/1.6 system-ui,sans-serif;background:#f6f8f5;color:#203a2a;padding:1.25rem}main{max-width:35rem;width:100%;padding:clamp(1.5rem,5vw,3rem);border:1px solid #d2e5d6;border-radius:1.5rem;background:#e9f3eb;box-shadow:0 20px 70px #183b2012}.eyebrow{font-size:.8rem;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:#39805a}h1{font-size:clamp(2rem,6vw,3.25rem);line-height:1.1;letter-spacing:-.04em;margin:.5rem 0 1rem}.pulse{display:inline-block;width:.7rem;height:.7rem;background:#29945b;border-radius:50%;margin-right:.5rem;animation:pulse 1.5s infinite}@keyframes pulse{50%{opacity:.35;transform:scale(.7)}}@media(prefers-reduced-motion:reduce){.pulse{animation:none}}@media(prefers-color-scheme:dark){body{background:#14221b;color:#eaf5ed}main{background:#203a29;border-color:#385d42}}
</style>
</head>
<body>
<main>
  <img class="holding-brand" src="_tendril/brand/icon-180.png" alt="Tendriller" width="88" height="88">
  <span class="eyebrow">Your page is connected</span><h1>${n} is getting ready.</h1>
  <p role="status"><span class="pulse" aria-hidden="true"></span>Your agent is preparing the first version. This page will update as soon as it arrives.</p><p>You can talk to the agent using the control in the corner while you wait.</p>
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
<meta name="description" content="A place for people and agents to build useful, live pages together.">
<meta property="og:type" content="website"><meta property="og:title" content="Tendriller"><meta property="og:description" content="Pages that grow with the conversation."><meta property="og:image" content="${escapeHtml(publicBase)}/_tendril/brand/logo.png">
${brandHead()}${brandStyle}
<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{font:1rem/1.6 system-ui,sans-serif;margin:0;background:#f6f8f5;color:#1e3028}main{max-width:70rem;margin:auto;padding:clamp(1.25rem,4vw,3rem)}header,footer{display:flex;align-items:center;justify-content:space-between;gap:1rem}header{margin-bottom:4rem}a{color:#17654b}header a{text-decoration:none;font-weight:700}.hero{background:#e7f2e9;border:1px solid #cce1d1;border-radius:1.5rem;padding:clamp(1.5rem,5vw,4rem)}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:.8rem;color:#43805c;font-weight:700}h1{font-size:clamp(2.7rem,7vw,5rem);line-height:1.04;letter-spacing:-.055em;max-width:12ch;margin:.7rem 0 1.5rem}h2{line-height:1.2}.lead{font-size:clamp(1.1rem,2vw,1.35rem);max-width:38rem}.button{display:inline-block;background:#176a47;color:#fff;text-decoration:none;font-weight:700;padding:.8rem 1.2rem;border-radius:.7rem;margin:.7rem .7rem .7rem 0}.button.secondary{background:#d2e6d7;color:#1a5839}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem;margin:2rem 0}.card{padding:1.5rem;background:#fff;border:1px solid #dbe6dc;border-radius:1rem}.card h3{margin-top:0}footer{margin:3rem 0;color:#607468;flex-wrap:wrap}@media(prefers-color-scheme:dark){body{background:#14221b;color:#edf6ee}.hero{background:#1d3829;border-color:#355e44}.card{background:#1c2e22;border-color:#36523d}a{color:#8ee0af}.button{color:#fff}.button.secondary{background:#375542;color:#fff}}</style>
</head>
<body>
<main><header>${brandLink}<a href="/dashboard">Open dashboard →</a></header><section class="hero">${brandLogo}<span class="eyebrow">A space for people and agents</span><h1>Pages that grow with the conversation.</h1><p class="lead">Give an agent a place to build something useful for you. See changes live, speak or type, and decide who can join.</p><a class="button" href="${escapeHtml(publicBase)}/agent.md">Get started with an agent</a><a class="button secondary" href="/dashboard">Your pages</a></section><div class="grid"><section class="card"><h3>Made for your task</h3><p>An agent can create a page, add files, and refine it as you work together.</p></section><section class="card"><h3>Always in the loop</h3><p>Talk from the page, see its status, and get updates without refreshing.</p></section><section class="card"><h3>Your call</h3><p>Sign in to claim ownership, review guest requests, and disconnect agents whenever you want.</p></section></div><footer><span>Every page gets its own address.</span><span><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/status">Status</a></span></footer></main>
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
