import { brandHead, brandLink, brandStyle } from "./brand";

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
<meta name="description" content="Connect a live web page and device sensors to an ongoing agent session. Talk to your agent from the page and see its updates live.">
<meta property="og:type" content="website"><meta property="og:title" content="Tendriller"><meta property="og:description" content="Connect a live web page and device sensors to an ongoing agent session."><meta property="og:image" content="${escapeHtml(publicBase)}/_tendril/brand/logo.png">
${brandHead()}${brandStyle}
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{font:1rem/1.6 system-ui,sans-serif;margin:0;background:#f6f8f5;color:#1e3028}main{max-width:68rem;margin:auto;padding:clamp(1.25rem,4vw,3rem)}header,footer{display:flex;align-items:center;justify-content:space-between;gap:1rem}header{margin-bottom:2.5rem}a{color:#17654b}header a{text-decoration:none;font-weight:700}h1{font-size:clamp(2rem,4.5vw,3.35rem);line-height:1.14;letter-spacing:-.035em;margin:0 0 1.25rem;max-width:21ch}h2{font-size:1.35rem;line-height:1.25;margin:0 0 .8rem}p{max-width:50rem;margin:.7rem 0}.intro{padding-bottom:2rem;border-bottom:1px solid #cce1d1}.intro p{font-size:clamp(1.05rem,1.8vw,1.22rem)}.actions{display:flex;gap:.7rem;flex-wrap:wrap;margin:1.5rem 0 0}.button{display:inline-block;background:#176a47;color:#fff;text-decoration:none;font-weight:650;padding:.7rem 1rem;border-radius:.6rem}.button.secondary{background:#d2e6d7;color:#1a5839}.access{padding:2rem 0;border-bottom:1px solid #cce1d1}.examples{padding:2rem 0}.examples ul{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr));gap:.7rem 2rem;margin:1.25rem 0 0;padding:0}.examples li{padding:.65rem 0;border-top:1px solid #dbe6dc}.examples strong{display:block}footer{margin:2rem 0;color:#607468;flex-wrap:wrap}@media(prefers-color-scheme:dark){body{background:#14221b;color:#edf6ee}.intro,.access{border-color:#36523d}.examples li{border-color:#36523d}a{color:#8ee0af}.button{color:#fff}.button.secondary{background:#375542;color:#fff}}
</style>
<style>
.how{padding:2rem 0;border-bottom:1px solid #cce1d1}.flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1rem;list-style:none;padding:0;margin:1.25rem 0 0}.flow li{position:relative;min-height:9rem;padding:1rem;border:1px solid #cce1d1;border-radius:.7rem;background:#fff}.flow li:not(:last-child)::after{content:"→";position:absolute;right:-.82rem;top:50%;transform:translateY(-50%);font-size:1.25rem;font-weight:700;color:#17654b;z-index:1}.flow-number{display:block;font-size:.8rem;font-weight:700;color:#497361}.flow p{margin:.35rem 0 0;line-height:1.45}@media(max-width:950px){.flow{grid-template-columns:1fr;gap:1.4rem}.flow li{min-height:0;display:flex;align-items:flex-start;gap:.8rem}.flow-number{min-width:1.2rem}.flow p{margin:0}.flow li:not(:last-child)::after{content:"↓";right:auto;top:auto;bottom:-1.35rem;left:50%;transform:translateX(-50%)}}@media(prefers-color-scheme:dark){.how,.flow li{border-color:#36523d}.flow li{background:#1c2e22}.flow-number{color:#b4c8b7}.flow li:not(:last-child)::after{color:#8ee0af}}
</style>
</head>
<body>
<main><header>${brandLink}<a href="/dashboard">Dashboard</a></header>
<section class="intro"><h1>Connect a live page to your agent session</h1>
<p>Tendriller is a minimal-setup way to connect a web page and device sensors to an ongoing agent session. Your agent can create and update the page while you use it. You can talk or type to the agent from the page, and its replies and interface changes appear live.</p>
<p>Open the page on your phone, tablet, or computer, even when the agent runs on another device. With your permission, page code can use that device’s location, accelerometer, camera, microphone, and other browser inputs. It can send events to the agent; the agent can send messages and change the page in return.</p>
<div class="actions"><a class="button" href="${escapeHtml(publicBase)}/agent.md">Agent setup guide</a><a class="button secondary" href="/dashboard">Open dashboard</a></div></section>
<section class="how"><h2>How it works</h2><ol class="flow">
<li><span class="flow-number" aria-hidden="true">1</span><p>Tell your agent about Tendriller.</p></li>
<li><span class="flow-number" aria-hidden="true">2</span><p>It creates a page for your email address.</p></li>
<li><span class="flow-number" aria-hidden="true">3</span><p>It gives you the page URL.</p></li>
<li><span class="flow-number" aria-hidden="true">4</span><p>Open the page and sign in with GitHub or Google.</p></li>
<li><span class="flow-number" aria-hidden="true">5</span><p>Keep talking in the page or agent session. The agent updates the page live.</p></li>
</ol></section>
<section class="access"><h2>Access and sign-in</h2><p>Opening your owner page and managing access requires GitHub or Google OAuth sign-in. Your agent uses a separate credential that you can revoke from the dashboard. Browser permissions for sensors and cameras are requested on the device where you use the page.</p></section>
<section class="examples"><h2>Example applications</h2><p>These are ideas an agent can build and change with you:</p><ul>
<li><strong>Field notebook</strong>Collect photos, location, voice notes, and observations on a walk.</li>
<li><strong>Remote camera helper</strong>Point your phone at an object and discuss what the camera sees with an agent running elsewhere.</li>
<li><strong>Movement companion</strong>Use motion and location readings to reflect on a walk, workout, or exercise.</li>
<li><strong>Voice-guided task</strong>Use spoken prompts and replies while cooking, repairing something, or working with your hands.</li>
<li><strong>Inventory scanner</strong>Scan barcodes or photograph items and let the agent update a list.</li>
<li><strong>Collaborative sketchpad</strong>Draw, point, and make choices while the agent changes the controls and layout.</li>
<li><strong>Workshop instrument</strong>Connect a Bluetooth, Serial, USB, or MIDI device and ask the agent to interpret its readings.</li>
<li><strong>Accessibility controls</strong>Use a gamepad or connected switch to trigger page actions and agent instructions.</li>
<li><strong>Screen troubleshooting</strong>Share a selected screen capture and get step-by-step help on the page.</li>
<li><strong>Location-aware checklist</strong>Have the page show the next task or question as you move between places.</li>
<li><strong>Multi-device workspace</strong>Use a phone for camera and sensors and a computer for a larger live display.</li>
<li><strong>Home experiment log</strong>Track light, motion, or connected sensor readings and ask the agent to summarize changes.</li>
</ul></section><footer><span>Tendriller</span><span><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/status">Status</a></span></footer></main>
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
