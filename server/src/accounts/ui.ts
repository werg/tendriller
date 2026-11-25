import { brandBase as defaultBrandBase, brandHead, brandLink, brandStyle } from "../brand";

/**
 * Shared visual foundation (tokens, reset, sticky frosted topbar, typography,
 * dark mode, and footer) used across every Tendriller-owned HTML surface:
 * homepage, agent platform guides, dashboard, sign-in, page settings, status,
 * moderation/report flows, holding/review screens, and legal pages.
 */
export const baseThemeCss = `
:root{
  color-scheme:light dark;
  --paper:#f7f3e8;
  --paper-2:#efe9d8;
  --surface:#fffdf8;
  --surface-2:#f4efe2;
  --surface-3:#eae3d2;
  --ink:#17251f;
  --muted:#4e6258;
  --faint:#6f8077;
  --line:#ded7c5;
  --line-strong:#c9c0a9;
  --green:#165c43;
  --green-2:#1f7a58;
  --green-soft:#e4f1e9;
  --orange:#df5f32;
  --orange-hover:#c84e23;
  --orange-soft:#fdebe2;
  --amber:#f3b544;
  --stage:radial-gradient(60% 78% at 24% 48%,#47341c 0%,#282b1e 48%,#13231d 100%);
  --stage-ink:#fff9ec;
  --stage-muted:#d7dfd0;
  --warn:#94570f;
  --warn-soft:#fdf4e3;
  --warn-border:#efd39c;
  --danger:#b42323;
  --danger-hover:#962020;
  --danger-soft:#fdf1f0;
  --danger-border:#f1c4c0;
  --ring:rgba(22,92,67,.28);
  --shadow-sm:0 1px 2px rgba(20,32,25,.06);
  --shadow:0 2px 4px rgba(20,32,25,.05),0 14px 32px -12px rgba(20,32,25,.11);
  --shadow-lg:0 4px 10px rgba(15,24,19,.10),0 28px 60px -18px rgba(15,24,19,.30);
  --radius:20px;
  --radius-sm:13px;
  --radius-xs:9px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  /* Semantic aliases consumed by account/dashboard/settings markup */
  --bg:var(--paper);
  --border:var(--line);
  --border-strong:var(--line-strong);
  --text:var(--ink);
  --accent:var(--green);
  --accent-hover:var(--green-2);
  --accent-2:#1f8c5e;
  --accent-soft:var(--green-soft);
  --accent-text:var(--green);
  --highlight:var(--orange);
  --highlight-soft:var(--orange-soft);
  --hero:var(--stage);
  --hero-text:var(--stage-ink);
  --hero-muted:var(--stage-muted);
  font:15.5px/1.58 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  background:var(--paper);
  color:var(--ink);
  accent-color:var(--green);
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-behavior:smooth}
html,body{margin:0;min-height:100%}
body{
  background:
    radial-gradient(1100px 540px at 8% -4%,rgba(22,92,67,.09),transparent 62%),
    radial-gradient(960px 500px at 96% 2%,rgba(223,95,50,.09),transparent 60%),
    var(--paper);
  color:var(--ink);
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
a{color:var(--green);text-decoration-thickness:1.5px;text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2.5px solid var(--orange);outline-offset:3px}
.icon,.ico{width:1.15em;height:1.15em;flex:none;display:inline-block;vertical-align:-.18em;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}

/* Shared sticky frosted topbar */
.topbar{
  position:sticky;top:0;z-index:30;
  background:color-mix(in srgb,var(--paper) 84%,transparent);
  backdrop-filter:saturate(1.35) blur(14px);
  -webkit-backdrop-filter:saturate(1.35) blur(14px);
  border-bottom:1px solid color-mix(in srgb,var(--line) 75%,transparent);
}
.topbar-inner{
  max-width:54rem;margin:0 auto;
  padding:.75rem clamp(1rem,3.5vw,2.2rem);
  display:flex;align-items:center;justify-content:space-between;gap:1rem;
}
.topbar-inner.medium{max-width:62rem}
.topbar-inner.wide{max-width:74rem}
.topbar .brand{text-decoration:none;color:var(--ink);font-size:1.05rem;font-weight:780;letter-spacing:-.025em}
.topbar .brand img{width:34px;height:34px;border-radius:9px}
.topbar nav,.nav{display:flex;align-items:center;gap:clamp(.55rem,1.7vw,1.3rem);font-size:.91rem;font-weight:620;flex-wrap:wrap}
.topbar nav a,.topbar .nav-link{text-decoration:none;color:var(--muted);white-space:nowrap;transition:color .15s}
.topbar nav a:hover{color:var(--ink)}
.topbar .nav-pill,.topbar .nav-link{
  display:inline-flex;align-items:center;gap:.4rem;
  padding:.42rem .9rem;border-radius:999px;
  background:var(--surface);border:1px solid var(--line-strong);
  color:var(--ink);font-size:.87rem;font-weight:640;box-shadow:var(--shadow-sm);
  transition:background .15s,border-color .15s,transform .1s;
}
.topbar .nav-pill:hover,.topbar .nav-link:hover{background:var(--surface-2);border-color:var(--green);color:var(--ink)}

main{max-width:54rem;margin:0 auto;padding:clamp(1.25rem,3vw,2.2rem) clamp(1rem,3.5vw,2.2rem) 3.5rem}
main.medium{max-width:62rem}
main.wide{max-width:74rem}
h1,h2,h3,p{margin-top:0}
.eyebrow{
  display:inline-flex;align-items:center;gap:.42rem;
  font-size:.75rem;font-weight:780;letter-spacing:.1em;text-transform:uppercase;
  color:var(--orange);margin-bottom:.45rem;
}
code{font:500 .85em/1.4 var(--mono);background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:.1em .38em;overflow-wrap:anywhere}
pre{font:400 .8rem/1.5 var(--mono);background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);padding:.9rem 1rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:.75rem 0 0}

footer{
  display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;
  margin-top:3rem;padding-top:1.4rem;border-top:1px solid var(--line);
  color:var(--muted);font-size:.87rem;
}
footer .foot-links{display:flex;align-items:center;gap:.4rem 1.2rem;flex-wrap:wrap}
footer a{color:var(--muted);text-decoration:none;font-weight:560}
footer a:hover{color:var(--ink);text-decoration:underline}

@media(max-width:680px){.topbar nav a.hide-sm{display:none}}
@media(max-width:620px){
  .topbar-inner{padding:.65rem 1rem;gap:.6rem}
  .topbar .brand{font-size:.96rem}
  .topbar .brand img{width:28px;height:28px}
  .topbar nav{gap:.55rem;font-size:.84rem}
  .topbar .nav-pill,.topbar .nav-link{padding:.34rem .72rem;font-size:.82rem}
}
@media(max-width:540px){.topbar nav a.hide-xs{display:none}}
@media(max-width:390px){
  .topbar-inner{padding:.6rem .75rem}
  .topbar nav{gap:.42rem;font-size:.8rem}
  .topbar .nav-pill,.topbar .nav-link{padding:.3rem .6rem}
}
@media(max-width:360px){.topbar nav a.hide-xxs{display:none}}
@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{animation:none!important;transition:none!important}
}
@media(prefers-color-scheme:dark){
  :root{
    --paper:#0e1612;
    --paper-2:#141f1a;
    --surface:#17241e;
    --surface-2:#1d2d26;
    --surface-3:#24362e;
    --ink:#f3efe4;
    --muted:#a5bab0;
    --faint:#7d9589;
    --line:#253830;
    --line-strong:#354d42;
    --green:#6ed39f;
    --green-2:#82dead;
    --green-soft:rgba(110,211,159,.14);
    --orange:#f07b4d;
    --orange-hover:#f58f67;
    --orange-soft:rgba(240,123,77,.15);
    --warn:#f2b866;
    --warn-soft:rgba(242,184,102,.1);
    --warn-border:rgba(242,184,102,.3);
    --danger:#f47c7c;
    --danger-hover:#ef4444;
    --danger-soft:rgba(244,124,124,.1);
    --danger-border:rgba(244,124,124,.3);
    --ring:rgba(110,211,159,.35);
    --shadow-sm:0 1px 2px rgba(0,0,0,.35);
    --shadow:0 2px 6px rgba(0,0,0,.35),0 16px 36px -14px rgba(0,0,0,.55);
    --shadow-lg:0 4px 12px rgba(0,0,0,.45),0 30px 64px -18px rgba(0,0,0,.7);
    --accent-2:#3ccf8e;
  }
}
`;

/** Component styles shared by dashboard, sign-in, settings, status, platform guides, and legal pages. */
export const serviceComponentsCss = `
h1{font-size:clamp(1.75rem,3.6vw,2.45rem);line-height:1.1;letter-spacing:-.035em;font-weight:790;margin:.1rem 0 .6rem;text-wrap:balance}
h2{font-size:1.16rem;line-height:1.25;letter-spacing:-.02em;font-weight:740;margin:0 0 .4rem}
h3{font-size:1rem;line-height:1.3;letter-spacing:-.012em;font-weight:700;margin:0 0 .25rem}
p{margin:0 0 .9rem;max-width:46rem}
p:last-child{margin-bottom:0}
.lead{font-size:1.05rem;color:var(--muted);max-width:44rem;text-wrap:pretty}
.muted,small{color:var(--muted)}
small{font-size:.84rem}
.back-link{display:inline-flex;align-items:center;gap:.38rem;font-size:.88rem;font-weight:640;color:var(--muted);text-decoration:none;margin-bottom:1rem}
.back-link:hover{color:var(--ink)}
.page-head{margin-bottom:1.6rem}
.page-head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.page-head-row>div,.card-head>div{flex:1 1 16rem;min-width:0}
.stack{display:flex;flex-direction:column;gap:1.25rem}
.stack-sm{display:flex;flex-direction:column;gap:.65rem}
.row{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap}
.cluster{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.hero{position:relative;overflow:hidden;padding:clamp(1.4rem,3.8vw,2.3rem);border-radius:calc(var(--radius) + 4px);background:var(--surface);border:1px solid var(--line-strong);box-shadow:var(--shadow);margin-bottom:1.5rem}
.hero.dark{background:var(--stage);color:var(--stage-ink);border-color:rgba(255,244,218,.12);box-shadow:var(--shadow-lg)}
.hero.dark::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(520px 280px at 90% 10%,rgba(243,181,68,.20),transparent 68%),radial-gradient(460px 260px at 14% 70%,rgba(223,95,50,.18),transparent 66%),radial-gradient(520px 260px at 0% 120%,rgba(74,191,134,.16),transparent 70%)}
.hero.dark>*{position:relative}
.hero.dark .eyebrow{color:#f5cb78}
.hero.dark .lead,.hero.dark .muted{color:var(--stage-muted)}
.hero.dark .button.secondary,.hero.dark button.secondary{background:rgba(255,248,232,.11);border-color:rgba(255,248,232,.24);color:var(--stage-ink)}
.hero.dark .button.secondary:hover,.hero.dark button.secondary:hover{background:rgba(255,248,232,.19);border-color:rgba(243,181,68,.55)}
.hero.dark .button.primary-on-dark{background:var(--orange);color:#fff9f4}
.hero.dark .button.primary-on-dark:hover{background:var(--orange-hover)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,19rem),1fr));gap:1rem;margin:1rem 0 1.5rem}
.card{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:clamp(1.15rem,2.6vw,1.55rem);min-width:0;box-shadow:var(--shadow)}
.card.subtle{background:var(--surface-2);box-shadow:none}
.card.danger{border-color:var(--danger-border);background:var(--danger-soft)}
.card.interactive{transition:transform .16s,box-shadow .16s,border-color .16s}
.card.interactive:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg);border-color:var(--line-strong)}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem}
.card-head p{margin:.2rem 0 0;font-size:.9rem;color:var(--muted)}
.section-title{display:flex;align-items:center;gap:.65rem;margin:2rem 0 .85rem}
.section-title h2{margin:0}
.section-title .rule{flex:1;height:1px;background:var(--line)}
.badge{display:inline-flex;align-items:center;gap:.35rem;padding:.22rem .64rem;border-radius:999px;font-size:.75rem;font-weight:680;letter-spacing:.01em;border:1px solid var(--line);background:var(--surface-2);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--green-soft);border-color:transparent;color:var(--green)}
.badge.ok::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:var(--accent-2);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-2) 22%,transparent)}
.badge.warn{background:var(--warn-soft);border-color:var(--warn-border);color:var(--warn)}
.badge.danger{background:var(--danger-soft);border-color:var(--danger-border);color:var(--danger)}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:.55rem;margin-top:1.15rem}
.actions.tight{margin-top:0}
.button,button{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;min-height:2.55rem;border:1px solid transparent;border-radius:11px;padding:.55rem 1.1rem;background:var(--green);color:#fff;font:inherit;font-size:.92rem;font-weight:660;cursor:pointer;text-decoration:none;box-shadow:0 1px 0 rgba(255,255,255,.15) inset,0 1px 2px rgba(10,40,25,.18);transition:background .15s,border-color .15s,box-shadow .15s,transform .06s;white-space:nowrap}
.button:hover,button:hover{background:var(--green-2)}
.button:active,button:active{transform:translateY(1px)}
.button:disabled,button:disabled{opacity:.6;cursor:default;transform:none}
.button.cta,button.cta{background:var(--orange);color:#fff9f4;box-shadow:0 1px 0 rgba(255,255,255,.22) inset,0 6px 16px -8px rgba(223,95,50,.6)}
.button.cta:hover,button.cta:hover{background:var(--orange-hover)}
.button.secondary,button.secondary{background:var(--surface);border-color:var(--line-strong);color:var(--ink);box-shadow:var(--shadow-sm)}
.button.secondary:hover,button.secondary:hover{background:var(--surface-2);border-color:var(--green)}
.button.ghost,button.ghost{background:transparent;border-color:transparent;color:var(--muted);box-shadow:none}
.button.ghost:hover,button.ghost:hover{background:var(--surface-2);color:var(--ink)}
.button.danger,button.danger{background:var(--danger-soft);border-color:var(--danger-border);color:var(--danger);box-shadow:none}
.button.danger:hover,button.danger:hover{background:var(--danger);border-color:var(--danger);color:#fff}
.button.sm,button.sm{min-height:2.1rem;padding:.34rem .78rem;font-size:.84rem;border-radius:var(--radius-xs)}
.button.lg,button.lg{min-height:2.95rem;padding:.7rem 1.4rem;font-size:.98rem}
.button.block,button.block{width:100%}
.icon-button{min-width:2.1rem;padding:.34rem!important}
.list{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface);overflow:hidden}
.list-item{display:flex;align-items:center;justify-content:space-between;gap:.85rem;flex-wrap:wrap;padding:.85rem 1rem;border-top:1px solid var(--line);transition:background .12s}
.list-item:first-child{border-top:0}
.list-item:hover{background:color-mix(in srgb,var(--surface-2) 55%,transparent)}
.list-item-main{min-width:0;flex:1 1 14rem}
.list-item-title{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;font-weight:660;font-size:.94rem}
.list-item-sub{font-size:.86rem;color:var(--muted);margin:.18rem 0 0;overflow-wrap:anywhere}
.empty{margin:0;padding:1.15rem;border:1.5px dashed var(--line-strong);border-radius:var(--radius-sm);color:var(--muted);font-size:.9rem;text-align:center;background:color-mix(in srgb,var(--surface) 50%,transparent)}
.group-label{font-size:.74rem;font-weight:760;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:1.15rem 0 .5rem}
.group-label:first-child{margin-top:0}
.check-list{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden;background:var(--surface)}
.check-item{display:flex;align-items:flex-start;gap:.75rem;padding:.75rem .95rem;margin:0;border-top:1px solid var(--line);cursor:pointer;transition:background .12s}
.check-item:first-child{border-top:0}
.check-item:hover{background:var(--surface-2)}
.check-item input[type=checkbox]{flex:none;width:1.08rem;height:1.08rem;margin:.2rem 0 0;cursor:pointer;accent-color:var(--green)}
.check-copy{min-width:0;flex:1}
.check-title{display:block;font-weight:650;font-size:.92rem;color:var(--ink)}
.check-desc{display:block;font-size:.85rem;color:var(--muted);margin-top:.12rem;line-height:1.42}
.field{display:flex;flex-direction:column;gap:.35rem;margin:0 0 .95rem}
.field:last-child{margin-bottom:0}
.field-label{font-size:.86rem;font-weight:660;color:var(--ink)}
.field-hint{font-size:.8rem;color:var(--muted)}
.field-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:.75rem}
input[type=text],input[type=email],input[type=url],input[type=password],input:not([type]),textarea,select{font:inherit;width:100%;max-width:36rem;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:.6rem .8rem;background:var(--surface);color:var(--ink);transition:border-color .15s,box-shadow .15s}
input[type=text]:focus,input[type=email]:focus,input[type=url]:focus,input[type=password]:focus,input:not([type]):focus,textarea:focus,select:focus{outline:none;border-color:var(--green);box-shadow:0 0 0 3px var(--ring)}
textarea{min-height:7.5rem;resize:vertical}
label{display:block;margin:.6rem 0}
fieldset{border:1px solid var(--line);border-radius:var(--radius-sm);padding:1rem;margin:1rem 0}
legend{font-size:.78rem;font-weight:760;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);padding:0 .4rem}
details.disclosure{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface);overflow:hidden;margin-top:1rem}
details.disclosure summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.8rem 1rem;font-size:.9rem;font-weight:650;color:var(--ink);cursor:pointer;user-select:none}
details.disclosure summary::-webkit-details-marker{display:none}
details.disclosure summary::after{content:"";width:.5rem;height:.5rem;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);transition:transform .18s;margin-right:.2rem}
details.disclosure[open] summary::after{transform:rotate(45deg)}
details.disclosure summary:hover{background:var(--surface-2)}
details.disclosure .disclosure-body{padding:1rem;border-top:1px solid var(--line)}
details.disclosure.danger{border-color:var(--danger-border)}
details.disclosure.danger summary{color:var(--danger)}
.meta-grid{display:grid;grid-template-columns:minmax(8.5rem,11rem) minmax(0,1fr);gap:.5rem 1rem;margin:0;font-size:.88rem}
.meta-grid dt{color:var(--muted);font-weight:600}
.meta-grid dd{margin:0;overflow-wrap:anywhere}
.notice{display:flex;gap:.65rem;align-items:flex-start;padding:.85rem 1rem;border-radius:var(--radius-sm);border:1px solid color-mix(in srgb,var(--green) 22%,transparent);background:var(--green-soft);color:var(--ink);font-size:.92rem;margin:0 0 1.1rem;overflow-wrap:anywhere}
.notice.warn{background:var(--warn-soft);border-color:var(--warn-border)}
.notice.danger{background:var(--danger-soft);border-color:var(--danger-border)}
.inline-form{display:inline-flex;margin:0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,9.5rem),1fr));gap:.75rem;margin-top:1.4rem}
.stat{padding:.85rem 1rem;border-radius:var(--radius-sm);background:rgba(255,248,232,.07);border:1px solid rgba(255,248,232,.15)}
.stat strong{display:block;font-size:1.5rem;line-height:1.1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat span{font-size:.8rem;color:var(--stage-muted)}
.avatar{display:grid;place-items:center;flex:none;width:2.75rem;height:2.75rem;border-radius:13px;font-weight:760;font-size:1.15rem;color:#fff;background:linear-gradient(135deg,var(--av1,#1f8c5e),var(--av2,#17694a));box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 4px 10px -4px rgba(0,0,0,.35)}
.avatar.favicon{background:var(--surface-2);overflow:hidden;padding:0;box-shadow:0 0 0 1px var(--line)}
.avatar.favicon svg,.avatar.favicon img{display:block;width:100%;height:100%;object-fit:cover}
.avatar.favicon.emoji svg{padding:5px}
.page-card{display:flex;flex-direction:column;gap:.9rem}
.page-card-top{display:flex;align-items:flex-start;gap:.85rem}
.page-card-top>div{min-width:0;flex:1}
.page-card h3{font-size:1.06rem;margin:0;overflow-wrap:anywhere}
.page-meta{display:flex;flex-wrap:wrap;gap:.35rem .9rem;font-size:.82rem;color:var(--muted);margin:.2rem 0 0}
.page-meta span{display:inline-flex;align-items:center;gap:.3rem}
.page-card .activity{font-size:.84rem;color:var(--muted);padding:.6rem .75rem;border-radius:var(--radius-xs);background:var(--surface-2);margin:0}
.page-card .actions{margin-top:auto;padding-top:.2rem}
.split{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1.25rem;align-items:start}
.qr-frame{display:grid;justify-items:center;gap:.45rem;padding:.9rem;border-radius:var(--radius);background:#fff;border:1px solid var(--line);box-shadow:var(--shadow-sm);color:#1a1a1a;width:max-content;max-width:100%}
.qr-frame svg{display:block;width:176px;height:176px;max-width:100%;height:auto}
.qr-frame span{font-size:.74rem;color:#4a4a4a;text-align:center;max-width:12rem}
.copy-box{display:flex;flex-direction:column;gap:.5rem}
.copy-box textarea,.copy-box input{font:400 .82rem/1.5 var(--mono);max-width:none;background:var(--paper);border-color:var(--line);color:var(--ink)}
.copy-box textarea{min-height:5.5rem}
.copy-box textarea.blurb-full{min-height:18.5rem}
.copy-line{display:flex;gap:.5rem;align-items:stretch}
.copy-line input{flex:1;min-width:0}
.ways{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:.75rem}
.way{display:flex;flex-direction:column;gap:.35rem;padding:1rem;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--surface);text-decoration:none;color:var(--ink);transition:border-color .15s,box-shadow .15s,transform .12s}
.way:hover{border-color:var(--green);box-shadow:0 0 0 3px var(--ring);transform:translateY(-1px)}
.way .way-icon{display:grid;place-items:center;width:2.3rem;height:2.3rem;border-radius:10px;background:var(--green-soft);color:var(--green);font-size:1.1rem;margin-bottom:.25rem}
.way strong{font-size:.95rem}
.way span{font-size:.84rem;color:var(--muted)}
.tabs{display:block}
.tab-input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.tab-list{display:flex;gap:.3rem;padding:.3rem;border-radius:calc(var(--radius-sm) + 4px);background:var(--surface-2);border:1px solid var(--line);margin-bottom:1.1rem;overflow-x:auto}
.tab-list label{flex:1 1 0;display:flex;align-items:center;justify-content:center;gap:.45rem;margin:0;padding:.55rem .8rem;border-radius:var(--radius-sm);font-size:.88rem;font-weight:650;color:var(--muted);cursor:pointer;white-space:nowrap;transition:background .15s,color .15s,box-shadow .15s}
.tab-list label:hover{color:var(--ink)}
.tab-panel{display:none}
.tab-input:nth-of-type(1):checked~.tab-list label:nth-child(1),.tab-input:nth-of-type(2):checked~.tab-list label:nth-child(2),.tab-input:nth-of-type(3):checked~.tab-list label:nth-child(3),.tab-input:nth-of-type(4):checked~.tab-list label:nth-child(4){background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}
.tab-input:nth-of-type(1):focus-visible~.tab-list label:nth-child(1),.tab-input:nth-of-type(2):focus-visible~.tab-list label:nth-child(2),.tab-input:nth-of-type(3):focus-visible~.tab-list label:nth-child(3),.tab-input:nth-of-type(4):focus-visible~.tab-list label:nth-child(4){outline:2px solid var(--orange);outline-offset:1px}
.tab-input:nth-of-type(1):checked~.tab-panels>.tab-panel:nth-child(1),.tab-input:nth-of-type(2):checked~.tab-panels>.tab-panel:nth-child(2),.tab-input:nth-of-type(3):checked~.tab-panels>.tab-panel:nth-child(3),.tab-input:nth-of-type(4):checked~.tab-panels>.tab-panel:nth-child(4){display:block;animation:fade .18s ease-out}
@keyframes fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.steps{list-style:none;counter-reset:step;margin:0 0 1rem;padding:0;display:grid;gap:.65rem}
.steps li{counter-increment:step;display:flex;gap:.7rem;align-items:flex-start;font-size:.92rem}
.steps li::before{content:counter(step);display:grid;place-items:center;flex:none;width:1.55rem;height:1.55rem;border-radius:50%;background:var(--green-soft);color:var(--green);font-size:.78rem;font-weight:760;margin-top:.06rem}
dialog.sheet{width:min(40rem,calc(100vw - 1.5rem));max-height:min(90vh,52rem);max-height:min(90dvh,52rem);padding:0;border:1px solid var(--line-strong);border-radius:calc(var(--radius) + 4px);background:var(--surface);color:var(--ink);box-shadow:0 30px 80px -20px rgba(0,0,0,.45)}
dialog.sheet::backdrop{background:rgba(14,22,18,.52);backdrop-filter:blur(3px)}
dialog.sheet[open]{animation:pop .2s ease-out}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.sheet-head{position:sticky;top:0;z-index:1;display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1.15rem 1.35rem .9rem;background:var(--surface);border-bottom:1px solid var(--line)}
.sheet-head h2{margin:0;font-size:1.18rem}
.sheet-head p{margin:.15rem 0 0;font-size:.88rem;color:var(--muted)}
.sheet-body{padding:1.15rem 1.35rem 1.4rem}
.result{margin-top:1.1rem;padding:1rem;border-radius:var(--radius-sm);border:1px solid color-mix(in srgb,var(--green) 30%,transparent);background:color-mix(in srgb,var(--green-soft) 60%,var(--surface))}
.result h3{display:flex;align-items:center;gap:.45rem}
.fine{font-size:.82rem;color:var(--muted)}
/* Long-form prose (legal documents) */
.prose h1{margin-bottom:.35rem}
.prose h2{margin:1.65rem 0 .5rem;font-size:1.14rem}
.prose p,.prose li{color:var(--ink);line-height:1.65}
.prose ul{margin:.4rem 0 1rem;padding-left:1.35rem}
.prose li{margin-bottom:.45rem}
.prose-subnav{display:flex;flex-wrap:wrap;gap:.45rem;margin-bottom:1.25rem}
.prose-subnav a{padding:.34rem .75rem;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--muted);font-size:.84rem;font-weight:620;text-decoration:none}
.prose-subnav a:hover{border-color:var(--green);color:var(--ink)}
.prose-subnav a[aria-current="page"]{background:var(--green-soft);border-color:transparent;color:var(--green)}
@media(max-width:640px){
  .meta-grid{grid-template-columns:1fr;gap:.2rem}
  .meta-grid dd{margin-bottom:.6rem}
  .split{grid-template-columns:1fr}
  .tab-list label{padding:.55rem .5rem;font-size:.84rem}
  .tab-list label .icon{display:none}
  .sheet-head,.sheet-body{padding-left:1rem;padding-right:1rem}
  .qr-frame{margin:0 auto}
}
@media(prefers-color-scheme:dark){
  .button,button{color:#081b12}
  .button.cta,button.cta{color:#1d110a}
  .button.secondary,button.secondary{color:var(--ink)}
  .button.ghost,button.ghost{color:var(--muted)}
  .button.danger,button.danger{color:#fca5a5}
  .button.danger:hover,button.danger:hover{color:#fff}
  .qr-frame{border-color:transparent}
}
`;

export const serviceStyle = `<style>${baseThemeCss}${serviceComponentsCss}</style>`;

const ICONS: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="14" r="1.2"/><circle cx="15" cy="14" r="1.2"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.01M14 21h3M21 18v3M17.5 17.5h.01"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  sparkles: '<path d="M12 3 14.2 8.8 20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2Z"/><path d="M19 3v4M21 5h-4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L21 8l-3-3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  devices: '<rect x="2" y="4" width="13" height="10" rx="2"/><path d="M6 18h5M8.5 14v4"/><rect x="16" y="8" width="6" height="12" rx="1.5"/><path d="M18.5 17.5h1"/>',
  mic: '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/>',
  arrow: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  utensils: '<path d="M4 3v7a3 3 0 0 0 3 3v8M7 3v7M10 3v7a3 3 0 0 1-3 3"/><path d="M17 3v18M17 3c2.5 0 4 2.2 4 5.5S19.5 13 17 13"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 1 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><polygon points="16 8 14 14 8 16 10 10 16 8"/>',
  map: '<path d="M12 21s-6-5.5-6-10a6 6 0 1 1 12 0c0 4.5-6 10-6 10Z"/><circle cx="12" cy="11" r="2.2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
};

/** Decorative inline icon; it inherits the surrounding text color. */
export function icon(name: keyof typeof ICONS | string): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] ?? ''}</svg>`;
}

const AVATAR_PALETTE: ReadonlyArray<readonly [string, string]> = [
  ['#1f8c5e', '#145c3f'], ['#e07a45', '#b4542a'], ['#3a7bd5', '#24569e'], ['#8b5cf6', '#6334c9'],
  ['#d4a017', '#9c7208'], ['#d6456b', '#a12a4b'], ['#0f9fa6', '#0a6f74'], ['#5b6b2f', '#3c4a1a'],
];
/** A deterministic initial tile for pages that have no authored icon. */
export function avatar(name: string, seed = name): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const [a, b] = AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
  const letter = ([...name.trim()][0] ?? 'T').toUpperCase().replace(/[&<>"']/g, '');
  return `<span class="avatar" style="--av1:${a};--av2:${b}" aria-hidden="true">${letter || 'T'}</span>`;
}

export interface ShellOptions {
  title: string;
  body: string;
  rawTitle?: boolean;
  brand?: string;
  nav?: string;
  footer?: string;
  head?: string;
  extraCss?: string;
  includeServiceComponents?: boolean;
  width?: "narrow" | "medium" | "wide";
  brandBase?: string;
  referrer?: string;
  script?: string;
}

const DEFAULT_NAV = `<nav aria-label="Main navigation"><a class="hide-sm" href="/agents">Platforms</a><a class="hide-xs" href="/docs/BUILD_AN_APP.md">Agent instructions</a><a class="nav-pill" href="/dashboard">Dashboard</a></nav>`;
const DEFAULT_FOOTER = `<span>Tendriller</span><span class="foot-links"><a href="/agents">Platforms</a><a href="/dashboard">Dashboard</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/status">Status</a></span>`;

/** Renders a complete HTML document using Tendriller's unified theme, sticky topbar, and footer. */
export function renderShell(options: ShellOptions): string {
  const widthClass = options.width === "wide" ? " wide" : options.width === "medium" ? " medium" : "";
  const mainClass = options.width === "wide" ? ' class="wide"' : options.width === "medium" ? ' class="medium"' : "";
  const titleText = options.rawTitle ? options.title : `${options.title} · Tendriller`;
  const referrer = options.referrer === "" ? "" : `<meta name="referrer" content="${options.referrer ?? "same-origin"}">`;
  const css = (options.includeServiceComponents === false ? baseThemeCss : baseThemeCss + serviceComponentsCss) + (options.extraCss ?? "");
  const headerBrand = options.brand ?? brandLink;
  const nav = options.nav ?? DEFAULT_NAV;
  const footerHtml = options.footer === "" ? "" : `<footer>${options.footer ?? DEFAULT_FOOTER}</footer>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${referrer}<title>${titleText}</title>${options.head ?? ""}${brandHead(options.brandBase ?? defaultBrandBase)}<style>${css}</style>${brandStyle}</head><body><header class="topbar"><div class="topbar-inner${widthClass}">${headerBrand}${nav}</div></header><main${mainClass}>${options.body}${footerHtml}</main>${options.script ?? ""}</body></html>`;
}

export function servicePage(title: string, body: string, script = "", status = 200, options?: { wide?: boolean; medium?: boolean; nav?: string; footer?: string; remoteImages?: boolean; formAction?: string }): Response {
  // Keep Origin on same-origin navigation POSTs without sending a referrer
  // on cross-origin requests. The forms still require the expected Origin.
  const html = renderShell({
    title,
    body,
    script,
    width: options?.wide ? "wide" : options?.medium ? "medium" : "narrow",
    nav: options?.nav,
    footer: options?.footer,
  });
  const formAction = options?.formAction ?? "'self'";
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "Content-Security-Policy": `default-src 'none'; script-src ${script ? "'unsafe-inline'" : "'none'"}; style-src 'unsafe-inline'; img-src 'self'${options?.remoteImages ? " https:" : ""}; connect-src 'self'; form-action ${formAction}; base-uri 'none'` } });
}
