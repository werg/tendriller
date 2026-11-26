import { AGENT_PLATFORMS, hostFromBase, platformLogoSvg } from "./agent-platforms";
import { icon, renderShell } from "./accounts/ui";
import { brandLogo } from "./brand";
import { copyAttrs, escapeCopyHtml as escapeHtml, renderCopyPlain, renderCopyText, SITE_COPY } from "./site-copy";

const LANDING_CSS = `
.brand-mark{width:1.18rem;height:1.18rem;flex:none;display:block}
h1{font-size:clamp(2.05rem,3.15vw,2.9rem);line-height:1.06;letter-spacing:-.042em;font-weight:820;margin:0 0 1rem;white-space:nowrap}
h2{font-size:clamp(1.6rem,2.9vw,2.3rem);line-height:1.12;letter-spacing:-.032em;font-weight:780;margin:0 0 .6rem;text-wrap:balance}
h3{font-size:1.06rem;line-height:1.28;letter-spacing:-.015em;font-weight:730;margin:0 0 .35rem}
p{margin:0 0 1rem}
p:last-child{margin-bottom:0}
.section{padding:clamp(3rem,6vw,4.75rem) 0;border-top:1px solid var(--line)}
section[id]{scroll-margin-top:4.5rem}
.section.flush-top{border-top:0;padding-top:clamp(2.2rem,4.5vw,3.5rem)}
.section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:1.5rem;flex-wrap:wrap;margin-bottom:clamp(1.5rem,3vw,2.3rem)}
.section-head-copy{max-width:44rem}
.section-head-copy p{font-size:1.06rem;color:var(--muted);text-wrap:pretty}

/* Hero stage */
.hero{
  position:relative;overflow:hidden;
  border-radius:calc(var(--radius) + 6px);
  background:var(--stage);color:var(--stage-ink);
  box-shadow:var(--shadow-lg);
  border:1px solid rgba(255,244,218,.12);
}
.hero::before{
  content:"";position:absolute;inset:0;pointer-events:none;
  background:
    radial-gradient(520px 300px at 88% 8%,rgba(243,181,68,.18),transparent 68%),
    radial-gradient(460px 280px at 26% 52%,rgba(223,95,50,.20),transparent 65%),
    radial-gradient(560px 260px at 6% 100%,rgba(74,191,134,.16),transparent 68%);
}
.hero-grid{
  position:relative;z-index:1;
  display:grid;grid-template-columns:minmax(0,.92fr) minmax(0,1.12fr);
  align-items:center;gap:clamp(1rem,3vw,2.5rem);
  padding:clamp(1.4rem,3.6vw,2.8rem) clamp(1.4rem,4vw,3rem);
}
.hero-art{min-width:0;display:flex;align-items:center;justify-content:center}
.hero .brand-art{display:block;width:100%;max-width:34rem;margin:0}
.hero .brand-art img{display:block;width:100%;height:auto;filter:drop-shadow(0 16px 28px rgba(0,0,0,.35))}
.hero-copy{min-width:0;padding:.4rem 0}
.hero-pill{
  display:inline-flex;align-items:center;gap:.5rem;
  padding:.32rem .78rem;border-radius:999px;margin-bottom:1.1rem;
  background:rgba(255,248,232,.09);border:1px solid rgba(255,248,232,.18);
  color:#f8dfa5;font-size:.8rem;font-weight:680;letter-spacing:.02em;
}
.live-dot{
  width:.52rem;height:.52rem;border-radius:50%;
  background:#5ee3a1;box-shadow:0 0 0 4px rgba(94,227,161,.22);
  animation:blink 2.4s ease-in-out infinite;
}
@keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(.84)}}
.hero-copy .lead{font-size:clamp(1.05rem,1.4vw,1.18rem);line-height:1.54;color:#f6f0df;max-width:36rem;margin-bottom:.85rem}
.hero-copy .sub{font-size:clamp(.97rem,1.16vw,1.04rem);line-height:1.56;color:var(--stage-muted);max-width:36rem;margin-bottom:0}
.hero-copy strong{color:#fff9ec;font-weight:720}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:.55rem;margin-top:1.55rem}
.cta{
  display:inline-flex;align-items:center;justify-content:center;gap:.4rem;
  min-height:2.85rem;padding:.64rem 1.1rem;border-radius:12px;border:1px solid transparent;
  background:var(--orange);color:#fff9f4;text-decoration:none;
  font-size:.94rem;font-weight:730;letter-spacing:-.01em;
  box-shadow:0 1px 0 rgba(255,255,255,.22) inset,0 8px 20px -8px rgba(223,95,50,.65);
  transition:background .15s,transform .08s,box-shadow .15s;
}
.cta:hover{background:var(--orange-hover);transform:translateY(-1px)}
.cta:active{transform:translateY(0)}
.button{
  display:inline-flex;align-items:center;justify-content:center;gap:.4rem;
  min-height:2.85rem;padding:.64rem 1.05rem;border-radius:12px;
  background:rgba(255,248,232,.11);border:1px solid rgba(255,248,232,.25);
  color:#fff9ec;text-decoration:none;
  font-size:.93rem;font-weight:680;letter-spacing:-.01em;
  transition:background .15s,border-color .15s,transform .08s;
}
.button:hover{background:rgba(255,248,232,.19);border-color:rgba(243,181,68,.55);transform:translateY(-1px)}
.button:active{transform:translateY(0)}
.hero-link{
  display:inline-flex;align-items:center;gap:.35rem;
  padding:.5rem .35rem;margin-left:.15rem;
  color:#f5d590;font-size:.9rem;font-weight:660;text-decoration:none;
}
.hero-link:hover{color:#fff3d1;text-decoration:underline}
.hero-ribbon{
  position:relative;z-index:1;
  display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.55rem 1.1rem;
  padding:.9rem clamp(1.4rem,4vw,3rem);
  background:rgba(8,16,13,.38);
  border-top:1px solid rgba(255,244,218,.11);
  font-size:.82rem;color:#c9d6c8;
}
.hero-ribbon-label{font-weight:730;color:#f5d590;letter-spacing:.04em;text-transform:uppercase;font-size:.72rem}
.hero-ribbon-list{display:flex;flex-wrap:wrap;gap:.45rem 1.1rem;list-style:none;margin:0;padding:0}
.hero-ribbon-list li{display:inline-flex;align-items:center;gap:.38rem}
.hero-ribbon-list li::before{content:"";width:.34rem;height:.34rem;border-radius:50%;background:#67d59c;opacity:.85}

/* Bring any agent + live prompt card */
.agent-split{
  display:grid;grid-template-columns:minmax(0,.94fr) minmax(0,1.06fr);
  gap:clamp(1.5rem,3.5vw,3rem);align-items:start;
}
.agent-copy p{font-size:1.05rem;color:var(--muted);max-width:34rem}
.agent-copy strong{color:var(--ink);font-weight:690}

/* Unobtrusive skeleton-logo platform grid */
.platforms-wrap{margin-top:2rem;padding-top:1.65rem;border-top:1px dashed var(--line-strong)}
.platforms-head{
  display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap;
  margin-bottom:.95rem;
}
.platforms-head p{margin:0;font-size:.88rem;color:var(--muted)}
.platforms-head-links{display:flex;align-items:center;gap:.75rem;font-size:.84rem;font-weight:640}
.platforms-head-links a{text-decoration:none}
.platforms-head-links a:hover{text-decoration:underline}
.plat-grid{
  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.6rem;
  list-style:none;margin:0;padding:0;
}
.plat-card{
  display:flex;align-items:stretch;
  background:color-mix(in srgb,var(--surface) 78%,var(--paper));
  border:1px solid var(--line);border-radius:12px;
  overflow:hidden;
  transition:border-color .15s,background .15s,box-shadow .15s;
}
.plat-card:hover{background:var(--surface);border-color:var(--line-strong);box-shadow:var(--shadow-sm)}
.plat-main{
  flex:1 1 auto;min-width:0;
  display:flex;align-items:center;gap:.65rem;
  padding:.62rem .75rem;text-decoration:none;color:var(--ink);
}
.plat-logo{
  display:grid;place-items:center;flex:none;
  width:2rem;height:2rem;border-radius:8px;
  color:var(--muted);background:var(--surface-2);border:1px solid color-mix(in srgb,var(--line) 80%,transparent);
  opacity:.82;transition:opacity .15s,color .15s,border-color .15s;
}
.plat-card:hover .plat-logo{opacity:1;color:var(--green);border-color:color-mix(in srgb,var(--green) 35%,var(--line))}
.plat-meta{min-width:0;display:flex;flex-direction:column}
.plat-name{font-size:.9rem;font-weight:680;line-height:1.2;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plat-kind{font-size:.73rem;color:var(--faint);line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plat-ai{
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  padding:0 .65rem;border-left:1px solid var(--line);
  font:600 .75rem/1 var(--mono);color:var(--faint);text-decoration:none;
  transition:background .15s,color .15s;
}
.plat-ai:hover{background:var(--green-soft);color:var(--green);text-decoration:none}

.prompt-card{
  background:var(--surface);border:1px solid var(--line-strong);
  border-radius:var(--radius);box-shadow:var(--shadow);
  overflow:hidden;
}
.prompt-bar{
  display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;
  padding:.75rem 1rem;background:var(--surface-2);border-bottom:1px solid var(--line);
}
.prompt-tabs{display:flex;gap:.3rem;flex-wrap:wrap}
.prompt-tab{
  appearance:none;border:1px solid transparent;border-radius:999px;
  padding:.3rem .72rem;background:transparent;color:var(--muted);
  font:600 .8rem/1.2 inherit;cursor:pointer;transition:background .15s,color .15s,border-color .15s;
}
.prompt-tab:hover{color:var(--ink);background:color-mix(in srgb,var(--surface) 60%,transparent)}
.prompt-tab[aria-pressed="true"]{background:var(--surface);color:var(--ink);border-color:var(--line-strong);box-shadow:var(--shadow-sm)}
.prompt-label{font-size:.74rem;font-weight:750;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.prompt-body{padding:1.25rem 1.3rem 1.15rem}
.prompt-quote{
  margin:0;padding:1rem 1.1rem;border-radius:var(--radius-sm);
  background:var(--paper);border:1px solid var(--line);
  font:500 .91rem/1.6 var(--mono);color:var(--ink);
  overflow-wrap:anywhere;
}
.prompt-foot{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin-top:.95rem}
.copy-btn{
  appearance:none;display:inline-flex;align-items:center;gap:.45rem;
  min-height:2.4rem;padding:.45rem .95rem;border-radius:10px;
  border:1px solid var(--green);background:var(--green);color:#fff;
  font:660 .86rem/1 inherit;cursor:pointer;transition:background .15s,transform .08s;
}
.copy-btn:hover{background:var(--green-2)}
.copy-btn:active{transform:translateY(1px)}
.prompt-hint{font-size:.82rem;color:var(--muted)}
.reply-strip{
  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem;
  padding:.85rem 1.3rem 1.05rem;
  background:color-mix(in srgb,var(--green-soft) 55%,var(--surface));
  border-top:1px solid var(--line);
  font-size:.8rem;color:var(--muted);
}
.reply-strip strong{display:block;color:var(--ink);font-size:.83rem;margin-bottom:.1rem}

/* Four core pillars (2x2 bento) */
.pillars{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.1rem}
.pillar{
  display:flex;flex-direction:column;gap:.8rem;
  padding:1.55rem 1.5rem;border-radius:var(--radius);
  background:var(--surface);border:1px solid var(--line);
  box-shadow:var(--shadow);
}
.pillar-ico{display:grid;place-items:center;width:2.85rem;height:2.85rem;border-radius:13px;background:var(--green-soft);color:var(--green);font-size:1.25rem}
.pillar.warm .pillar-ico{background:var(--orange-soft);color:var(--orange)}
.pillar h3{font-size:1.2rem;margin:0}
.pillar p{color:var(--muted);font-size:.96rem;margin:0}
.tag-row{display:flex;flex-wrap:wrap;gap:.38rem;margin-top:auto;padding-top:.4rem}
.tag{font-size:.76rem;font-weight:650;padding:.22rem .58rem;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);color:var(--muted)}

/* How it works — connected milestone timeline */
.timeline{
  position:relative;
  display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1.5rem;
  list-style:none;margin:2rem 0 0;padding:0;
}
.timeline::before{
  content:"";position:absolute;top:1.38rem;left:12.5%;right:12.5%;height:2px;
  background:linear-gradient(90deg,var(--green) 0%,var(--green-2) 66%,var(--orange) 100%);
  opacity:.55;
}
.timeline li{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 .35rem}
.step-num{
  display:grid;place-items:center;flex:none;
  width:2.75rem;height:2.75rem;border-radius:50%;margin-bottom:1.1rem;
  background:var(--green);color:#fff;font-weight:800;font-size:.98rem;
  box-shadow:0 0 0 5px var(--paper),0 0 0 6.5px color-mix(in srgb,var(--green) 35%,var(--line));
}
.timeline li:last-child .step-num{
  background:var(--orange);color:#fff;
  box-shadow:0 0 0 5px var(--paper),0 0 0 6.5px color-mix(in srgb,var(--orange) 42%,var(--line));
}
.timeline h3{font-size:1.04rem;margin-bottom:.38rem}
.timeline p{font-size:.91rem;color:var(--muted);line-height:1.5;max-width:16rem;margin:0}
.how-note{margin-top:2rem;padding:1rem 1.2rem;border-radius:var(--radius-sm);background:var(--paper-2);border:1px solid var(--line);font-size:.92rem;color:var(--muted)}
.how-note strong{color:var(--ink)}

/* Things you can build */
.ideas{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;list-style:none;margin:0;padding:0}
.idea{
  display:flex;flex-direction:column;gap:.55rem;
  padding:1.3rem 1.3rem 1.4rem;border-radius:var(--radius-sm);
  background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-sm);
  transition:transform .16s,box-shadow .16s,border-color .16s;
}
.idea:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--line-strong)}
.idea-top{display:flex;align-items:center;justify-content:space-between;gap:.6rem;margin-bottom:.15rem}
.idea-ico{display:grid;place-items:center;width:2.25rem;height:2.25rem;border-radius:10px;background:var(--surface-2);color:var(--green);border:1px solid var(--line)}
.idea-cat{font-size:.73rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--faint)}
.idea h3{font-size:1.03rem;margin:0}
.idea p{font-size:.92rem;color:var(--muted);line-height:1.48;margin:0}
.cookbook-cta{
  display:inline-flex;align-items:center;gap:.4rem;
  padding:.58rem 1rem;border-radius:999px;
  background:var(--surface);border:1px solid var(--line-strong);
  color:var(--ink);font-size:.9rem;font-weight:680;text-decoration:none;
  box-shadow:var(--shadow-sm);white-space:nowrap;transition:border-color .15s,background .15s;
}
.cookbook-cta:hover{border-color:var(--green);background:var(--surface-2)}

/* Access & trust */
.trust-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem}
.trust-card{padding:1.25rem 1.2rem;border-radius:var(--radius-sm);background:var(--surface);border:1px solid var(--line)}
.trust-card .icon{width:1.35rem;height:1.35rem;color:var(--green);margin-bottom:.65rem;display:block}
.trust-card h3{font-size:.98rem;margin-bottom:.32rem}
.trust-card p{font-size:.89rem;color:var(--muted);line-height:1.48;margin:0}

/* For agents & developers dark band */
.agents-band{
  margin-top:clamp(2.5rem,5vw,4rem);
  padding:clamp(1.6rem,3.6vw,2.6rem);
  border-radius:var(--radius);
  background:linear-gradient(135deg,#142b22 0%,#1a362a 55%,#272d1d 100%);
  color:var(--stage-ink);
  border:1px solid rgba(255,244,218,.13);
  box-shadow:var(--shadow-lg);
}
.agents-band .eyebrow{color:#f5cb78}
.agents-band h2{color:#fff9ec;margin-bottom:.5rem}
.agents-band .band-lead{color:var(--stage-muted);max-width:44rem;font-size:1rem;margin-bottom:1.5rem}
.agent-links{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.8rem;list-style:none;margin:0;padding:0}
.agent-links a{
  display:flex;flex-direction:column;gap:.25rem;height:100%;
  padding:1rem 1.1rem;border-radius:var(--radius-sm);
  background:rgba(255,249,236,.07);border:1px solid rgba(255,249,236,.15);
  color:#fff9ec;text-decoration:none;
  transition:background .15s,border-color .15s,transform .12s;
}
.agent-links a:hover{background:rgba(255,249,236,.13);border-color:rgba(243,181,68,.55);transform:translateY(-1px)}
.agent-links strong{font-size:.96rem;display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.agent-links span{font-size:.84rem;color:var(--stage-muted);line-height:1.42}
.agent-links code{align-self:flex-start;margin-top:auto;padding-top:.4rem;font:500 .76rem/1.3 var(--mono);color:#9be6be;background:none;border:0}

/* Namesake */
.namesake{
  margin-top:2.5rem;padding:1.35rem 1.5rem;border-radius:var(--radius-sm);
  background:var(--paper-2);border:1px solid var(--line);
  display:flex;align-items:flex-start;gap:1rem;
}
.namesake img{width:40px;height:40px;border-radius:10px;flex:none;margin-top:.1rem}
.namesake p{margin:0;color:var(--muted);font-size:.95rem;max-width:50rem}
.namesake strong{color:var(--ink)}

@media(max-width:960px){
  .hero-grid{grid-template-columns:1fr;text-align:left}
  .hero .brand-art{max-width:26rem}
  .agent-split{grid-template-columns:1fr}
  .plat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pillars{grid-template-columns:1fr}
  .ideas,.trust-grid,.agent-links{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:760px){
  .timeline{display:block;margin:1.75rem 0 0}
  .timeline::before{top:1.35rem;bottom:1.6rem;left:1.35rem;right:auto;width:2px;height:auto;background:linear-gradient(180deg,var(--green) 0%,var(--green-2) 66%,var(--orange) 100%)}
  .timeline li{flex-direction:row;align-items:flex-start;text-align:left;gap:1.15rem;padding:0 0 1.65rem}
  .timeline li:last-child{padding-bottom:0}
  .step-num{margin:0}
  .timeline p{max-width:none}
}
@media(max-width:620px){
  .hero{border-radius:1.25rem}
  .hero-grid{padding:1.25rem 1.2rem 1.5rem}
  .hero-copy h1{font-size:clamp(1.85rem,7.8vw,2.5rem);white-space:normal}
  .hero-ribbon{padding:.8rem 1.2rem}
  .reply-strip{grid-template-columns:1fr;gap:.65rem}
  .plat-grid,.ideas,.trust-grid,.agent-links{grid-template-columns:1fr}
  .namesake{padding:1.1rem 1.15rem}
}
@media(prefers-color-scheme:dark){
  .cta{color:#1d110a}
  .copy-btn,.step-num{color:#081b12}
  .timeline li:last-child .step-num{color:#1d110a}
}
`;

export function landingPage(publicBase: string, options?: { editable?: boolean }): string {
  const editable = Boolean(options?.editable);
  const base = escapeHtml(publicBase);
  const rawHost = hostFromBase(publicBase);
  const vars = { host: rawHost, base: publicBase };
  const h = SITE_COPY.home;
  const c = (key: string, template: string) => copyAttrs(key, template, editable);
  const txt = (template: string) => renderCopyText(template, vars);
  const prompts = h.start.prompts.map((p) => ({
    label: p.label,
    raw: p.text,
    plain: renderCopyPlain(p.text, vars),
  }));

  const platformCards = AGENT_PLATFORMS.map((p) =>
    `<li class="plat-card">` +
    `<a class="plat-main" href="${base}/agents/${p.slug}" title="Human getting-started guide for ${escapeHtml(p.name)}">` +
    `<span class="plat-logo" aria-hidden="true">${platformLogoSvg(p.slug)}</span>` +
    `<span class="plat-meta"><span class="plat-name">${escapeHtml(p.name)}</span><span class="plat-kind"${c(`platforms.items.${p.slug}.kind`, p.kind)}>${escapeHtml(p.kind)}</span></span>` +
    `</a>` +
    `<a class="plat-ai" href="${base}/agents/${p.slug}.md" title="AI-friendly Markdown guide for ${escapeHtml(p.name)}" aria-label="AI Markdown guide for ${escapeHtml(p.name)}">.md</a>` +
    `</li>`
  ).join("");

  const head = `<meta name="description" content="A face for your agent: a live dashboard page you can talk to and reshape with your requests, backed by shared database state, device sensors, and private guest invites.">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:title" content="Tendriller — ${escapeHtml(h.hero.title)}">` +
    `<meta property="og:description" content="Give your agent eyes, ears, and a form of expression — a private dashboard page with shared database state, sensors, and guest invites.">` +
    `<meta property="og:image" content="${base}/_tendril/brand/logo.png">` +
    `<link rel="alternate" type="text/markdown" href="${base}/agent.md" title="Agent instructions">` +
    `<link rel="alternate" type="text/plain" href="${base}/llms.txt" title="Documentation index">` +
    `<link rel="service-desc" type="application/json" href="${base}/.well-known/tendriller.json">`;

  const nav = `<nav aria-label="Main navigation">` +
    `<a class="hide-sm" href="#how">How it works</a>` +
    `<a class="hide-sm" href="#ideas">Examples</a>` +
    `<a class="hide-xxs" href="${base}/docs/BUILD_AN_APP.md">${escapeHtml(h.hero.ctaAgent)}</a>` +
    `<a class="nav-pill" href="/dashboard">Dashboard</a>` +
    `<a class="hide-xs" href="https://github.com/werg/tendriller">GitHub</a>` +
    `</nav>`;

  const footer = `<span>Tendriller</span><span class="foot-links">` +
    `<a href="${base}/agents">Platforms</a>` +
    `<a href="/dashboard">Dashboard</a>` +
    `<a href="${base}/docs/BUILD_AN_APP.md">${escapeHtml(h.hero.ctaAgent)}</a>` +
    `<a href="https://cookbooks.tendriller.dev/">Cookbooks</a>` +
    `<a href="https://github.com/werg/tendriller">GitHub</a>` +
    `<a href="/terms">Terms</a>` +
    `<a href="/privacy">Privacy</a>` +
    `<a href="/status">Status</a>` +
    `</span>`;

  const body = `
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-grid">
      <div class="hero-art">${brandLogo}</div>
      <div class="hero-copy">
        <span class="hero-pill"><span class="live-dot" aria-hidden="true"></span><span${c("home.hero.pill", h.hero.pill)}>${txt(h.hero.pill)}</span></span>
        <h1 id="hero-title"${c("home.hero.title", h.hero.title)}>${txt(h.hero.title)}</h1>
        <p class="lead"${c("home.hero.lead", h.hero.lead)}>${txt(h.hero.lead)}</p>
        <p class="sub"${c("home.hero.sub", h.hero.sub)}>${txt(h.hero.sub)}</p>
        <div class="actions">
          <a class="cta" href="#start"><span${c("home.hero.ctaPrimary", h.hero.ctaPrimary)}>${txt(h.hero.ctaPrimary)}</span></a>
          <a class="button" href="${base}/docs/BUILD_AN_APP.md">${icon("terminal")} <span${c("home.hero.ctaAgent", h.hero.ctaAgent)}>${txt(h.hero.ctaAgent)}</span></a>
          <a class="hero-link" href="https://cookbooks.tendriller.dev/"><span${c("home.hero.ctaCookbooks", h.hero.ctaCookbooks)}>${txt(h.hero.ctaCookbooks)}</span> ${icon("arrow")}</a>
        </div>
      </div>
    </div>
    <div class="hero-ribbon" aria-label="Supported capabilities">
      <span class="hero-ribbon-label"${c("home.hero.ribbonLabel", h.hero.ribbonLabel)}>${txt(h.hero.ribbonLabel)}</span>
      <ul class="hero-ribbon-list">
        ${h.hero.ribbon.map((item, i) => `<li${c(`home.hero.ribbon.${i}`, item)}>${txt(item)}</li>`).join("")}
      </ul>
    </div>
  </section>

  <section id="start" class="section flush-top" aria-labelledby="start-title">
    <div class="agent-split">
      <div class="agent-copy">
        <span class="eyebrow"${c("home.start.eyebrow", h.start.eyebrow)}>${txt(h.start.eyebrow)}</span>
        <h2 id="start-title"${c("home.start.title", h.start.title)}>${txt(h.start.title)}</h2>
        <p${c("home.start.p1", h.start.p1)}>${txt(h.start.p1)}</p>
        <p${c("home.start.p2", h.start.p2)}>${txt(h.start.p2)}</p>
      </div>

      <div class="prompt-card" aria-label="Example prompt for your agent">
        <div class="prompt-bar">
          <span class="prompt-label"${c("home.start.promptLabel", h.start.promptLabel)}>${txt(h.start.promptLabel)}</span>
          <div class="prompt-tabs" role="group" aria-label="Prompt examples">
            ${prompts.map((p, i) => `<button type="button" class="prompt-tab" data-prompt="${escapeHtml(p.plain)}" data-prompt-index="${i}" aria-pressed="${i === 0 ? "true" : "false"}">${escapeHtml(p.label)}</button>`).join("")}
          </div>
        </div>
        <div class="prompt-body">
          <p id="prompt-text" class="prompt-quote"${c("home.start.prompts.0.text", prompts[0]!.raw)}>${escapeHtml(prompts[0]!.plain)}</p>
          <div class="prompt-foot">
            <button type="button" id="copy-prompt" class="copy-btn">${icon("copy")}<span>Copy prompt</span></button>
            <span class="prompt-hint" id="copy-status" role="status" aria-live="polite"${c("home.start.promptHint", h.start.promptHint)}>${txt(h.start.promptHint)}</span>
          </div>
        </div>
        <div class="reply-strip">
          ${h.start.replyStrip.map((r, i) => `<div><strong${c(`home.start.replyStrip.${i}.title`, r.title)}>${txt(r.title)}</strong><span${c(`home.start.replyStrip.${i}.body`, r.body)}>${txt(r.body)}</span></div>`).join("")}
        </div>
      </div>
    </div>

    <div class="platforms-wrap" aria-labelledby="platforms-label">
      <div class="platforms-head">
        <p id="platforms-label"${c("home.start.platformsLead", h.start.platformsLead)}>${txt(h.start.platformsLead)}</p>
        <div class="platforms-head-links">
          <a href="${base}/agents">All platforms ${icon("arrow")}</a>
          <a href="${base}/agents.md">Index (.md)</a>
        </div>
      </div>
      <ul class="plat-grid" aria-label="Supported agent harnesses">
        ${platformCards}
      </ul>
    </div>
  </section>

  <section class="section" aria-labelledby="pillars-title">
    <div class="section-head">
      <div class="section-head-copy">
        <span class="eyebrow"${c("home.pillars.eyebrow", h.pillars.eyebrow)}>${txt(h.pillars.eyebrow)}</span>
        <h2 id="pillars-title"${c("home.pillars.title", h.pillars.title)}>${txt(h.pillars.title)}</h2>
        <p${c("home.pillars.lead", h.pillars.lead)}>${txt(h.pillars.lead)}</p>
      </div>
    </div>
    <div class="pillars">
      ${h.pillars.items.map((item, i) => `<article class="pillar${item.warm ? " warm" : ""}">
        <span class="pillar-ico">${icon(item.icon)}</span>
        <h3${c(`home.pillars.items.${i}.title`, item.title)}>${txt(item.title)}</h3>
        <p${c(`home.pillars.items.${i}.body`, item.body)}>${txt(item.body)}</p>
        <div class="tag-row">${item.tags.map((t, j) => `<span class="tag"${c(`home.pillars.items.${i}.tags.${j}`, t)}>${txt(t)}</span>`).join("")}</div>
      </article>`).join("")}
    </div>
  </section>

  <section id="how" class="section" aria-labelledby="how-title">
    <div class="section-head">
      <div class="section-head-copy">
        <span class="eyebrow"${c("home.how.eyebrow", h.how.eyebrow)}>${txt(h.how.eyebrow)}</span>
        <h2 id="how-title"${c("home.how.title", h.how.title)}>${txt(h.how.title)}</h2>
        <p${c("home.how.lead", h.how.lead)}>${txt(h.how.lead)}</p>
      </div>
    </div>
    <ol class="timeline">
      ${h.how.steps.map((step, i) => `<li><span class="step-num" aria-hidden="true">${i + 1}</span><div><h3${c(`home.how.steps.${i}.title`, step.title)}>${txt(step.title)}</h3><p${c(`home.how.steps.${i}.body`, step.body)}>${txt(step.body)}</p></div></li>`).join("")}
    </ol>
    <p class="how-note"><span${c("home.how.note", h.how.note)}>${txt(h.how.note)}</span> Stuck on a step? <a href="${base}/docs/TROUBLESHOOTING.md">Setup help</a> names the exact next action.</p>
  </section>

  <section id="ideas" class="section" aria-labelledby="ideas-title">
    <div class="section-head">
      <div class="section-head-copy">
        <span class="eyebrow"${c("home.ideas.eyebrow", h.ideas.eyebrow)}>${txt(h.ideas.eyebrow)}</span>
        <h2 id="ideas-title"${c("home.ideas.title", h.ideas.title)}>${txt(h.ideas.title)}</h2>
        <p${c("home.ideas.lead", h.ideas.lead)}>${txt(h.ideas.lead)}</p>
      </div>
      <a class="cookbook-cta" href="https://cookbooks.tendriller.dev/"><span${c("home.ideas.cta", h.ideas.cta)}>${txt(h.ideas.cta)}</span> ${icon("arrow")}</a>
    </div>
    <ul class="ideas">
      ${h.ideas.items.map((item, i) => `<li class="idea">
        <div class="idea-top"><span class="idea-ico">${icon(item.icon)}</span><span class="idea-cat"${c(`home.ideas.items.${i}.cat`, item.cat)}>${txt(item.cat)}</span></div>
        <h3${c(`home.ideas.items.${i}.title`, item.title)}>${txt(item.title)}</h3>
        <p${c(`home.ideas.items.${i}.body`, item.body)}>${txt(item.body)}</p>
      </li>`).join("")}
    </ul>
  </section>

  <section class="section" aria-labelledby="access-title">
    <div class="section-head">
      <div class="section-head-copy">
        <span class="eyebrow"${c("home.access.eyebrow", h.access.eyebrow)}>${txt(h.access.eyebrow)}</span>
        <h2 id="access-title"${c("home.access.title", h.access.title)}>${txt(h.access.title)}</h2>
        <p${c("home.access.lead", h.access.lead)}>${txt(h.access.lead)}</p>
      </div>
    </div>
    <div class="trust-grid">
      ${h.access.items.map((item, i) => `<div class="trust-card">${icon(item.icon)}<h3${c(`home.access.items.${i}.title`, item.title)}>${txt(item.title)}</h3><p${c(`home.access.items.${i}.body`, item.body)}>${txt(item.body)}</p></div>`).join("")}
    </div>
    <p class="how-note"><span${c("home.access.openSourceNote", h.access.openSourceNote)}>${txt(h.access.openSourceNote)}</span> <a href="https://github.com/werg/tendriller">View source on GitHub</a>.</p>
  </section>

  <section class="agents-band" aria-labelledby="agents-title">
    <span class="eyebrow">${icon("terminal")} <span${c("home.agentsBand.eyebrow", h.agentsBand.eyebrow)}>${txt(h.agentsBand.eyebrow)}</span></span>
    <h2 id="agents-title"${c("home.agentsBand.title", h.agentsBand.title)}>${txt(h.agentsBand.title)}</h2>
    <p class="band-lead"${c("home.agentsBand.lead", h.agentsBand.lead)}>${txt(h.agentsBand.lead)}</p>
    <ul class="agent-links">
      ${h.agentsBand.items.map((item, i) => `<li><a href="${base}${item.href}"><strong><span${c(`home.agentsBand.items.${i}.title`, item.title)}>${txt(item.title)}</span> ${icon("arrow")}</strong><span${c(`home.agentsBand.items.${i}.body`, item.body)}>${txt(item.body)}</span><code>${escapeHtml(item.href)}</code></a></li>`).join("")}
    </ul>
  </section>

  <aside class="namesake" aria-label="About the name">
    <img src="/_tendril/brand/icon-64.png" alt="" width="40" height="40">
    <p><strong${c("home.namesake.lead", h.namesake.lead)}>${txt(h.namesake.lead)}</strong> <span${c("home.namesake.body", h.namesake.body)}>${txt(h.namesake.body)}</span></p>
  </aside>`;

  const script = `<script>
(()=>{
  const text=document.getElementById('prompt-text');
  const copy=document.getElementById('copy-prompt');
  const status=document.getElementById('copy-status');
  const tabs=[...document.querySelectorAll('.prompt-tab')];
  if(!text||!copy)return;
  for(const tab of tabs){
    tab.addEventListener('click',()=>{
      for(const t of tabs)t.setAttribute('aria-pressed',String(t===tab));
      text.textContent=tab.dataset.prompt||'';
      if(text.hasAttribute('data-copy')&&tab.dataset.promptIndex)text.setAttribute('data-copy','home.start.prompts.'+tab.dataset.promptIndex+'.text');
      if(status)status.textContent=${JSON.stringify(h.start.promptHint)};
    });
  }
  let timer;
  copy.addEventListener('click',async()=>{
    const val=text.textContent||'';
    try{
      await navigator.clipboard.writeText(val);
      const label=copy.querySelector('span');
      if(label)label.textContent='Copied!';
      if(status)status.textContent='Paste this into your agent and replace the email.';
      clearTimeout(timer);
      timer=setTimeout(()=>{if(label)label.textContent='Copy prompt';},2200);
    }catch{
      const r=document.createRange();r.selectNodeContents(text);
      const s=window.getSelection();s?.removeAllRanges();s?.addRange(r);
      if(status)status.textContent='Prompt selected — press Ctrl/Cmd+C to copy.';
    }
  });
})();
</script>`;

  return renderShell({
    title: `Tendriller — ${escapeHtml(h.hero.title)}`,
    rawTitle: true,
    referrer: "",
    width: "wide",
    includeServiceComponents: false,
    head,
    extraCss: LANDING_CSS,
    nav,
    body,
    footer,
    script,
  });
}
