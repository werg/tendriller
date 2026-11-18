import runtimeRelease from "./runtime-release.json";
import type { RuntimeArtifactFeatures } from "../../contract/index.mjs";
import { brandHead, brandLink, brandLogo, brandStyle } from "./brand";

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

export function runtimeTags(cfg: InjectConfig, includeManifest = true): string {
  const publication = cfg.publication;
  const directory = cfg.documentPath === null ? "" : cfg.documentPath.slice(0, cfg.documentPath.lastIndexOf("/") + 1);
  const documentBase = publication ? publication.base + directory.split("/").map(encodeURIComponent).join("/") : cfg.base;
  const runtimeBase = publication?.runtime.base ?? `/_tendril/runtime/${runtimeRelease.id}/`;
  const conf = { id: cfg.id, base: cfg.base, version: cfg.version, documentPath: cfg.documentPath,
    application: cfg.application, peerBootstrap: cfg.peerBootstrap,
    features: { ...cfg.features, ...publication?.runtime.features }, ...(publication ? { publication } : {}) };
  return (
    `<base href="${attr(documentBase)}">` +
    // Every published page gets the per-origin install metadata. On iOS,
    // installed Home Screen web apps can receive push when no tab is open.
    (includeManifest ? `<link rel="manifest" href="${attr(cfg.base)}_tendril/manifest.webmanifest">` : "") +
    `<script>window.__TENDRIL__=${scriptSafeJson(conf)};</script>` +
    `<script src="${attr(runtimeBase)}tendril.js"></script>`
  );
}

const HEAD_RE = /<head(?:\s[^>]*)?>/i;

/** Inserts the runtime right after the opening <head> tag, or at the very start if there is none. */
export function injectRuntime(html: string, cfg: InjectConfig): string {
  // Preserve a page author's own install metadata. The generated manifest is
  // only a default for pages that do not declare one.
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? html;
  const hasManifest = /<link\b[^>]*\brel\s*=\s*(?:"[^"]*\bmanifest\b[^"]*"|'[^']*\bmanifest\b[^']*'|manifest\b)[^>]*>/i.test(head);
  const tags = runtimeTags(cfg, !hasManifest);
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
  :root{color-scheme:light dark}*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{display:grid;place-items:center;font:1rem/1.6 system-ui,sans-serif;background:#f6f8f5;color:#203a2a;padding:1.25rem}main{max-width:35rem;width:100%;padding:clamp(1.5rem,5vw,3rem);border:1px solid #d2e5d6;border-radius:1.5rem;background:#e9f3eb;box-shadow:0 20px 70px #183b2012}.eyebrow{font-size:.8rem;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:#39805a}h1{font-size:clamp(2rem,6vw,3.25rem);line-height:1.1;letter-spacing:-.04em;margin:.5rem 0 1rem}.pulse{display:inline-block;width:.7rem;height:.7rem;background:#29945b;border-radius:50%;margin-right:.5rem;animation:pulse 1.5s infinite}@keyframes pulse{50%{opacity:.35;transform:scale(.7)}}@media(prefers-reduced-motion:reduce){.pulse{animation:none}}@media(prefers-color-scheme:dark){body{background:#14221b;color:#eaf5ed}main{background:#203a29;border-color:#385d42}}
</style>
</head>
<body>
<main>
  <img class="holding-brand" src="/_tendril/brand/icon-180.png" alt="Tendriller" width="88" height="88">
  <span class="eyebrow">Waiting for publication</span><h1>${n} is getting ready.</h1>
  <p><span class="pulse" aria-hidden="true"></span><span id="publication-status" role="status">Your agent is preparing the first version. It will open here automatically.</span></p>
  <p><a href="">Check now</a></p>
</main>
<script>
(() => {
  const status = document.querySelector('#publication-status');
  const waiting = status.textContent;
  const endpoint = new URL('_tendril/publication-ready', document.baseURI);
  let timer, inFlight = false, done = false, delay = 2000;
  function schedule(ms) {
    clearTimeout(timer);
    if (!done && !document.hidden && !inFlight) timer = setTimeout(check, ms);
  }
  async function check() {
    if (done || document.hidden || inFlight) return;
    inFlight = true;
    try {
      const response = await fetch(endpoint, { method: 'HEAD', cache: 'no-store', redirect: 'manual',
        signal: AbortSignal.timeout(8000) });
      if (response.status === 204) {
        done = true;
        location.reload();
      } else if (response.status === 202) {
        status.textContent = waiting;
        delay = Math.min(delay * 1.5, 15000);
      } else if ([401, 403, 404].includes(response.status) || response.type === 'opaqueredirect') {
        done = true;
        status.textContent = 'This page could not be opened. Select Check now to try again.';
      } else {
        throw new Error('Publication check failed');
      }
    } catch {
      status.textContent = 'Could not check for updates. Retrying automatically.';
      delay = Math.min(delay * 2, 15000);
    } finally {
      inFlight = false;
      schedule(delay);
    }
  }
  document.addEventListener('visibilitychange', () => schedule(0));
  window.addEventListener('online', () => schedule(0));
  schedule(0);
})();
</script>
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
<meta name="description" content="Connect a live page and device sensors to an ongoing agent session. Talk to your agent and see the page change as you work.">
<meta property="og:type" content="website"><meta property="og:title" content="Tendriller"><meta property="og:description" content="Connect a live page and device sensors to an ongoing agent session."><meta property="og:image" content="${escapeHtml(publicBase)}/_tendril/brand/logo.png">
${brandHead()}${brandStyle}
<style>
:root{color-scheme:light dark;--paper:#f8f5ec;--ink:#20332c;--muted:#52685c;--line:#d8e0d5;--green:#195d46;--orange:#e87442;--cream:#fff9ea}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:1rem/1.55 system-ui,sans-serif}
a{color:var(--green)}a:focus-visible{outline:3px solid var(--orange);outline-offset:4px}main{max-width:76rem;margin:auto;padding:clamp(1rem,3vw,2.5rem)}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:1rem}header{padding:.35rem 0 1.5rem}header a{text-decoration:none;font-weight:700}header .brand img{width:44px;height:44px}header nav{display:flex;align-items:center;gap:clamp(.8rem,2vw,1.5rem);font-size:.94rem}
h1,h2,h3,p{margin-top:0}h1{font-size:clamp(2.15rem,4vw,3.65rem);line-height:1.08;letter-spacing:-.045em;margin-bottom:1.15rem}h2{font-size:clamp(1.5rem,2.5vw,2rem);line-height:1.2;letter-spacing:-.025em;margin-bottom:.5rem}h3{font-size:1.04rem;line-height:1.25;margin-bottom:.4rem}p{margin-bottom:1rem}
.hero{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,.92fr);align-items:center;overflow:hidden;background:radial-gradient(circle at 25% 45%,#3d311e 0,#29291e 54%,#182a24 100%);color:#fff8ea;border-radius:1.5rem;box-shadow:0 20px 50px #20332c20}
.hero-art{min-width:0}.hero .brand-art{display:block;width:100%;max-width:none;margin:0}.hero .brand-art img{display:block;width:100%;height:auto}.hero-copy{padding:2.5rem clamp(1.5rem,3vw,3rem) 2.5rem 0}.hero-copy p{font-size:clamp(1.04rem,1.5vw,1.2rem);line-height:1.55;max-width:30rem;color:#f1ebd9}.hero-copy p:last-of-type{color:#d7dfcc}.actions{display:flex;flex-wrap:wrap;gap:.65rem;margin-top:1.6rem}.button{display:inline-flex;align-items:center;justify-content:center;min-height:2.9rem;padding:.7rem 1.1rem;border-radius:.65rem;background:#ef8150;color:#241e19;text-decoration:none;font-weight:750}.button.secondary{background:#f7eed8;color:#263b2e}.button:hover{filter:brightness(1.06)}
.how,.access,.examples{padding:clamp(2.7rem,5vw,4.5rem) 0}.how{border-bottom:1px solid var(--line)}.how>p,.examples>p{color:var(--muted);max-width:45rem}
.namesake{padding:1.4rem 0 2rem;color:var(--muted)}.namesake p{max-width:48rem;margin:0}.namesake strong{color:var(--ink)}
.flow{position:relative;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));list-style:none;margin:2.2rem 0 0;padding:0}.flow::before{content:"";position:absolute;top:1.45rem;left:10%;right:10%;height:2px;background:#a9c4ac}.flow li{position:relative;z-index:1;text-align:center;padding:0 .55rem}.flow-number{display:grid;place-items:center;width:3rem;height:3rem;margin:0 auto 1rem;border-radius:50%;background:var(--green);border:3px solid var(--paper);color:#fff;font-weight:800;box-shadow:0 0 0 1px #8bae98}.flow li:last-child .flow-number{background:var(--orange);color:#241e19;box-shadow:0 0 0 1px #d47046}.flow p{max-width:12rem;margin:0 auto;line-height:1.4;font-weight:600}
.access{display:grid;grid-template-columns:minmax(0,.4fr) minmax(0,.6fr);gap:2rem;align-items:start;border-bottom:1px solid var(--line)}.access p{max-width:41rem;margin:0;font-size:1.08rem}.access strong{color:var(--green)}
.examples>p{margin-bottom:1.7rem}.ideas{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.9rem;list-style:none;padding:0;margin:0}.ideas li{padding:1.2rem 1.3rem 1.35rem;background:#fffdf7;border:1px solid #e3e7dc;border-radius:.9rem;box-shadow:0 3px 12px #20332c08}.ideas li p{color:var(--muted);margin:0;line-height:1.45}
footer{padding:2rem 0 1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem;flex-wrap:wrap}
@media(max-width:850px){.hero{grid-template-columns:1fr}.hero-art{max-width:42rem;margin:0 auto}.hero-copy{padding:0 clamp(1.4rem,5vw,2.3rem) 2.4rem}.hero-copy h1{max-width:18ch}.access{grid-template-columns:1fr;gap:.5rem}.ideas{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){header{padding-bottom:1rem}.hero{border-radius:1.1rem}.hero-art{width:100%}.hero-copy h1{font-size:clamp(2rem,8vw,2.65rem)}.how,.access,.examples{padding:2.6rem .1rem}.flow{display:block;margin:1.7rem 0 0}.flow::before{top:1.25rem;bottom:1.5rem;left:1.5rem;right:auto;width:2px;height:auto}.flow li{display:flex;align-items:flex-start;text-align:left;gap:1rem;padding:0 0 1.3rem}.flow li:last-child{padding-bottom:0}.flow-number{flex:none;margin:0}.flow p{max-width:none;margin:.42rem 0 0}.ideas{grid-template-columns:1fr}.ideas li{padding:1rem 1.1rem}.access p{font-size:1rem}}
@media(prefers-color-scheme:dark){:root{--paper:#17251d;--ink:#f0f5e9;--muted:#b8cbbb;--line:#385343;--green:#9ed4a9}.hero{box-shadow:none}.flow::before{background:#729d7b}.flow-number{background:#315b40;border-color:var(--paper);color:#fff}.access strong{color:#a9deb2}.ideas li{background:#203528;border-color:#395542}}
</style>
</head>
<body>
<main>
<header>${brandLink}<nav aria-label="Main navigation"><a href="/dashboard">Dashboard</a><a href="https://github.com/werg/tendriller">GitHub</a></nav></header>
<section class="hero" aria-labelledby="hero-title">
<div class="hero-art">${brandLogo}</div>
<div class="hero-copy"><h1 id="hero-title">A page your agent launches for you</h1>
<p>Your agent creates an ad-hoc page connected to your ongoing session. Talk or type to the agent from that page while it updates the interface live.</p>
<p>Open it on any of your devices. The page can send taps and other UI interactions back to the agent, along with camera, location, motion, microphone, and other sensor input you allow.</p>
<p><strong>Agents: read <a href="${escapeHtml(publicBase)}/agent.md" style="color:inherit">${escapeHtml(publicBase)}/agent.md</a>.</strong> It explains page creation, authentication, publication and live event delivery. <a href="https://cookbooks.tendriller.dev/" style="color:inherit">Cookbooks</a> help you choose an approach and adapt the page to the task; their <a href="https://github.com/werg/tendriller-contrib" style="color:inherit">source is on GitHub</a>. See <a href="${escapeHtml(publicBase)}/llms.txt" style="color:inherit">the documentation index</a> for platform APIs and optional operational tools.</p>
<div class="actions"><a class="button" href="https://cookbooks.tendriller.dev/">Explore cookbooks</a><a class="button secondary" href="${escapeHtml(publicBase)}/agent.md">Agent setup guide</a></div></div>
</section>
<section class="how" aria-labelledby="how-title"><h2 id="how-title">How it works</h2><p>Setup starts in the agent session you already use.</p>
<ol class="flow">
<li><span class="flow-number" aria-hidden="true">1</span><p>Tell your agent about Tendriller.</p></li>
<li><span class="flow-number" aria-hidden="true">2</span><p>It creates a page for your email address.</p></li>
<li><span class="flow-number" aria-hidden="true">3</span><p>It gives you the page URL.</p></li>
<li><span class="flow-number" aria-hidden="true">4</span><p>Open it and sign in with GitHub or Google.</p></li>
<li><span class="flow-number" aria-hidden="true">5</span><p>Keep talking here or in your agent session. The page changes live.</p></li>
</ol></section>
<section class="access" aria-labelledby="access-title"><h2 id="access-title">Access and permissions</h2><p>Your owner page is gated by <strong>GitHub or Google OAuth sign-in</strong>. Your agent uses a separate credential that you can revoke. Camera, location, and other browser permissions are requested on the device where you open the page.</p></section>
<section class="examples" aria-labelledby="examples-title"><h2 id="examples-title">Things you can build</h2><p>Choose the interface and behavior that fit your task. <a href="https://cookbooks.tendriller.dev/">Explore the decisions and alternatives in the cookbooks.</a></p><ul class="ideas">
<li><h3>Field notebook</h3><p>Collect photos, location, voice notes, and observations on a walk.</p></li>
<li><h3>Remote camera helper</h3><p>Point your phone at an object and discuss it with an agent running elsewhere.</p></li>
<li><h3>Sports and activity companion</h3><p>Build your own experience for sailing, cycling, geocaching, or any physical activity using location and motion.</p></li>
<li><h3>Voice-guided task</h3><p>Get spoken prompts and replies while cooking or working with your hands.</p></li>
<li><h3>Kitchen assistant</h3><p>Keep a shopping list, look inside the fridge with your camera, show recipes, and follow along as you cook.</p></li>
<li><h3>Inventory scanner</h3><p>Scan barcodes or photograph items while the agent updates a list.</p></li>
<li><h3>Collaborative sketchpad</h3><p>Draw and make choices as the agent changes the controls and layout.</p></li>
<li><h3>Workshop instrument</h3><p>Connect a Bluetooth, Serial, USB, or MIDI device and interpret its readings.</p></li>
<li><h3>Accessibility controls</h3><p>Use a gamepad or connected switch to trigger page actions.</p></li>
<li><h3>Screen troubleshooting</h3><p>Share a selected screen capture and get help on the page.</p></li>
<li><h3>Hands-on repair helper</h3><p>Point your camera at a car repair or other physical task while the agent shows diagrams, images, and next steps.</p></li>
<li><h3>Location-aware checklist</h3><p>Show the next task or question as you move between places.</p></li>
<li><h3>Multi-device workspace</h3><p>Use a phone for sensors and a computer for a larger live display.</p></li>
<li><h3>Interactive office dashboard</h3><p>Bring tasks, notes, status, and controls into a dashboard the agent can update as your work changes.</p></li>
<li><h3>Home experiment log</h3><p>Track light, motion, or connected sensors and summarize changes.</p></li>
</ul></section>
<aside class="namesake" aria-label="About the name"><p><strong>Why Tendriller?</strong> An agent can extend its tendrils into other devices’ interfaces and sensors. Tendriller makes the opening for each new connection, like a drill.</p></aside>
<footer><span>Tendriller</span><span><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/status">Status</a></span></footer>
</main>
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
