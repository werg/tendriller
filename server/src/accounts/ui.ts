import { brandHead, brandLink, brandStyle } from "../brand";

export const serviceStyle = `<style>
:root{
  color-scheme:light dark;
  --bg:#f7f5ef;
  --bg-tint:radial-gradient(1200px 520px at 8% -8%,rgba(31,140,94,.10),transparent 62%),radial-gradient(900px 480px at 100% 0%,rgba(232,116,66,.08),transparent 60%);
  --surface:#ffffff;
  --surface-2:#f3f1ea;
  --surface-3:#ebe8df;
  --border:#e4e0d5;
  --border-strong:#cfc9ba;
  --text:#17241e;
  --muted:#5b6a62;
  --faint:#8a968f;
  --accent:#17694a;
  --accent-hover:#0f553b;
  --accent-2:#1f8c5e;
  --accent-soft:#e6f2ea;
  --accent-text:#0f5a3d;
  --highlight:#e87442;
  --highlight-soft:#fdeee5;
  --warn:#94570f;
  --warn-soft:#fdf4e3;
  --warn-border:#efd39c;
  --danger:#b42323;
  --danger-hover:#962020;
  --danger-soft:#fdf1f0;
  --danger-border:#f1c4c0;
  --ring:rgba(23,105,74,.28);
  --shadow-sm:0 1px 2px rgba(30,40,32,.06);
  --shadow:0 1px 2px rgba(30,40,32,.05),0 8px 24px -6px rgba(30,40,32,.08);
  --shadow-lg:0 2px 6px rgba(30,40,32,.06),0 24px 48px -12px rgba(30,40,32,.18);
  --hero:linear-gradient(135deg,#173a2c 0%,#1d4a37 48%,#2b3d25 100%);
  --hero-text:#f6f1e3;
  --hero-muted:#cbd8c6;
  --radius:18px;
  --radius-sm:11px;
  --radius-xs:8px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  background:var(--bg);
  color:var(--text);
  accent-color:var(--accent);
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;min-height:100%}
body{background:var(--bg-tint),var(--bg);background-attachment:fixed;color:var(--text);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
main{max-width:54rem;margin:0 auto;padding:0 clamp(1rem,4vw,2rem) 3.5rem}
main.wide{max-width:72rem}
a{color:var(--accent-text);text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.icon{width:1.1em;height:1.1em;flex:none;display:inline-block;vertical-align:-.17em;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
header{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:0 calc(-1 * clamp(1rem,4vw,2rem)) clamp(1.25rem,3vw,2rem);padding:.85rem clamp(1rem,4vw,2rem);background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(1.4) blur(14px);-webkit-backdrop-filter:saturate(1.4) blur(14px);border-bottom:1px solid color-mix(in srgb,var(--border) 70%,transparent)}
header a{text-decoration:none;color:var(--text);font-weight:650;font-size:.95rem}
header nav,.nav{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
header .nav-link{display:inline-flex;align-items:center;gap:.4rem;padding:.45rem .85rem;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.86rem;font-weight:620;box-shadow:var(--shadow-sm);transition:background .15s,border-color .15s,transform .1s}
header .nav-link:hover{background:var(--surface-2);border-color:var(--border-strong)}
.back-link{display:inline-flex;align-items:center;gap:.35rem;font-size:.88rem;font-weight:620;color:var(--muted);text-decoration:none;margin-bottom:.9rem}
.back-link:hover{color:var(--text)}
.eyebrow{display:inline-flex;align-items:center;gap:.4rem;font-size:.72rem;font-weight:750;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-text);margin-bottom:.4rem}
h1{font-size:clamp(1.65rem,3.4vw,2.3rem);line-height:1.12;letter-spacing:-.032em;font-weight:760;margin:.1rem 0 .6rem;text-wrap:balance}
h2{font-size:1.12rem;line-height:1.28;letter-spacing:-.018em;font-weight:720;margin:0 0 .35rem}
h3{font-size:1rem;line-height:1.3;letter-spacing:-.01em;font-weight:690;margin:0 0 .25rem}
p{margin:0 0 .85rem;max-width:46rem}
p:last-child{margin-bottom:0}
.lead{font-size:1.04rem;color:var(--muted);max-width:44rem;text-wrap:pretty}
.muted,small{color:var(--muted)}
small{font-size:.84rem}
code{font:500 .85em/1.4 var(--mono);background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:.1em .38em;overflow-wrap:anywhere}
pre{font:400 .8rem/1.5 var(--mono);background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:.9rem 1rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:.75rem 0 0}
.page-head{margin-bottom:1.6rem}
.page-head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.page-head-row>div,.card-head>div{flex:1 1 16rem;min-width:0}
.stack{display:flex;flex-direction:column;gap:1.25rem}
.stack-sm{display:flex;flex-direction:column;gap:.65rem}
.row{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap}
.cluster{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.hero{position:relative;overflow:hidden;padding:clamp(1.4rem,3.8vw,2.3rem);border-radius:calc(var(--radius) + 4px);background:var(--surface);border:1px solid var(--border);box-shadow:var(--shadow);margin-bottom:1.5rem}
.hero.dark{background:var(--hero);color:var(--hero-text);border-color:transparent;box-shadow:var(--shadow-lg)}
.hero.dark::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(420px 220px at 92% 10%,rgba(232,116,66,.32),transparent 70%),radial-gradient(520px 260px at 0% 120%,rgba(110,224,168,.18),transparent 70%)}
.hero.dark>*{position:relative}
.hero.dark .eyebrow{color:#a8e8c4}
.hero.dark .lead,.hero.dark .muted{color:var(--hero-muted)}
.hero.dark .button.secondary,.hero.dark button.secondary{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.22);color:var(--hero-text)}
.hero.dark .button.secondary:hover,.hero.dark button.secondary:hover{background:rgba(255,255,255,.18)}
.hero.dark .button.primary-on-dark{background:#f08a58;color:#24170f}
.hero.dark .button.primary-on-dark:hover{background:#f59a6c}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,19rem),1fr));gap:1rem;margin:1rem 0 1.5rem}
.card{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:clamp(1.1rem,2.6vw,1.5rem);min-width:0;box-shadow:var(--shadow)}
.card.subtle{background:var(--surface-2);box-shadow:none}
.card.danger{border-color:var(--danger-border);background:var(--danger-soft)}
.card.interactive{transition:transform .15s,box-shadow .15s,border-color .15s}
.card.interactive:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg);border-color:var(--border-strong)}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem}
.card-head p{margin:.2rem 0 0;font-size:.9rem;color:var(--muted)}
.section-title{display:flex;align-items:center;gap:.6rem;margin:2rem 0 .85rem}
.section-title h2{margin:0}
.section-title .rule{flex:1;height:1px;background:var(--border)}
.badge{display:inline-flex;align-items:center;gap:.35rem;padding:.2rem .62rem;border-radius:999px;font-size:.75rem;font-weight:660;letter-spacing:.01em;border:1px solid var(--border);background:var(--surface-2);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--accent-soft);border-color:transparent;color:var(--accent-text)}
.badge.ok::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:var(--accent-2);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-2) 22%,transparent)}
.badge.warn{background:var(--warn-soft);border-color:var(--warn-border);color:var(--warn)}
.badge.danger{background:var(--danger-soft);border-color:var(--danger-border);color:var(--danger)}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:.55rem;margin-top:1.1rem}
.actions.tight{margin-top:0}
.button,button{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;min-height:2.55rem;border:1px solid transparent;border-radius:var(--radius-sm);padding:.55rem 1.1rem;background:var(--accent);color:#fff;font:inherit;font-size:.92rem;font-weight:640;cursor:pointer;text-decoration:none;box-shadow:0 1px 0 rgba(255,255,255,.15) inset,0 1px 2px rgba(10,40,25,.18);transition:background .15s,border-color .15s,box-shadow .15s,transform .06s;white-space:nowrap}
.button:hover,button:hover{background:var(--accent-hover)}
.button:active,button:active{transform:translateY(1px)}
.button:disabled,button:disabled{opacity:.6;cursor:default;transform:none}
.button.secondary,button.secondary{background:var(--surface);border-color:var(--border-strong);color:var(--text);box-shadow:var(--shadow-sm)}
.button.secondary:hover,button.secondary:hover{background:var(--surface-2)}
.button.ghost,button.ghost{background:transparent;border-color:transparent;color:var(--muted);box-shadow:none}
.button.ghost:hover,button.ghost:hover{background:var(--surface-2);color:var(--text)}
.button.danger,button.danger{background:var(--danger-soft);border-color:var(--danger-border);color:var(--danger);box-shadow:none}
.button.danger:hover,button.danger:hover{background:var(--danger);border-color:var(--danger);color:#fff}
.button.sm,button.sm{min-height:2.1rem;padding:.34rem .78rem;font-size:.84rem;border-radius:var(--radius-xs)}
.button.lg,button.lg{min-height:2.95rem;padding:.7rem 1.4rem;font-size:.98rem}
.button.block,button.block{width:100%}
.icon-button{min-width:2.1rem;padding:.34rem!important}
.list{list-style:none;margin:0;padding:0;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);overflow:hidden}
.list-item{display:flex;align-items:center;justify-content:space-between;gap:.85rem;flex-wrap:wrap;padding:.85rem 1rem;border-top:1px solid var(--border);transition:background .12s}
.list-item:first-child{border-top:0}
.list-item:hover{background:color-mix(in srgb,var(--surface-2) 55%,transparent)}
.list-item-main{min-width:0;flex:1 1 14rem}
.list-item-title{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;font-weight:650;font-size:.94rem}
.list-item-sub{font-size:.86rem;color:var(--muted);margin:.18rem 0 0;overflow-wrap:anywhere}
.empty{margin:0;padding:1.1rem 1.1rem;border:1.5px dashed var(--border-strong);border-radius:var(--radius-sm);color:var(--muted);font-size:.9rem;text-align:center;background:color-mix(in srgb,var(--surface) 50%,transparent)}
.group-label{font-size:.74rem;font-weight:750;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:1.15rem 0 .5rem}
.group-label:first-child{margin-top:0}
.check-list{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;background:var(--surface)}
.check-item{display:flex;align-items:flex-start;gap:.75rem;padding:.75rem .95rem;margin:0;border-top:1px solid var(--border);cursor:pointer;transition:background .12s}
.check-item:first-child{border-top:0}
.check-item:hover{background:var(--surface-2)}
.check-item input[type=checkbox]{flex:none;width:1.08rem;height:1.08rem;margin:.2rem 0 0;cursor:pointer;accent-color:var(--accent)}
.check-copy{min-width:0;flex:1}
.check-title{display:block;font-weight:640;font-size:.92rem;color:var(--text)}
.check-desc{display:block;font-size:.85rem;color:var(--muted);margin-top:.12rem;line-height:1.42}
.field{display:flex;flex-direction:column;gap:.35rem;margin:0 0 .95rem}
.field:last-child{margin-bottom:0}
.field-label{font-size:.86rem;font-weight:650;color:var(--text)}
.field-hint{font-size:.8rem;color:var(--muted)}
.field-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:.75rem}
input[type=text],input[type=email],input[type=url],input[type=password],input:not([type]),textarea,select{font:inherit;width:100%;max-width:36rem;border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:.6rem .8rem;background:var(--surface);color:var(--text);transition:border-color .15s,box-shadow .15s}
input[type=text]:focus,input[type=email]:focus,input[type=url]:focus,input[type=password]:focus,input:not([type]):focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}
textarea{min-height:7.5rem;resize:vertical}
label{display:block;margin:.6rem 0}
fieldset{border:1px solid var(--border);border-radius:var(--radius-sm);padding:1rem;margin:1rem 0}
legend{font-size:.78rem;font-weight:750;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);padding:0 .4rem}
details.disclosure{border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);overflow:hidden;margin-top:1rem}
details.disclosure summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.8rem 1rem;font-size:.9rem;font-weight:640;color:var(--text);cursor:pointer;user-select:none}
details.disclosure summary::-webkit-details-marker{display:none}
details.disclosure summary::after{content:"";width:.5rem;height:.5rem;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);transition:transform .18s;margin-right:.2rem}
details.disclosure[open] summary::after{transform:rotate(45deg)}
details.disclosure summary:hover{background:var(--surface-2)}
details.disclosure .disclosure-body{padding:1rem;border-top:1px solid var(--border)}
details.disclosure.danger{border-color:var(--danger-border)}
details.disclosure.danger summary{color:var(--danger)}
.meta-grid{display:grid;grid-template-columns:minmax(8.5rem,11rem) minmax(0,1fr);gap:.5rem 1rem;margin:0;font-size:.88rem}
.meta-grid dt{color:var(--muted);font-weight:600}
.meta-grid dd{margin:0;overflow-wrap:anywhere}
.notice{display:flex;gap:.65rem;align-items:flex-start;padding:.85rem 1rem;border-radius:var(--radius-sm);border:1px solid color-mix(in srgb,var(--accent) 22%,transparent);background:var(--accent-soft);color:var(--text);font-size:.92rem;margin:0 0 1.1rem;overflow-wrap:anywhere}
.notice.warn{background:var(--warn-soft);border-color:var(--warn-border)}
.notice.danger{background:var(--danger-soft);border-color:var(--danger-border)}
.inline-form{display:inline-flex;margin:0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,9.5rem),1fr));gap:.75rem;margin-top:1.4rem}
.stat{padding:.85rem 1rem;border-radius:var(--radius-sm);background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14)}
.stat strong{display:block;font-size:1.5rem;line-height:1.1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat span{font-size:.8rem;color:var(--hero-muted)}
.avatar{display:grid;place-items:center;flex:none;width:2.75rem;height:2.75rem;border-radius:13px;font-weight:760;font-size:1.15rem;color:#fff;background:linear-gradient(135deg,var(--av1,#1f8c5e),var(--av2,#17694a));box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 4px 10px -4px rgba(0,0,0,.35)}
.avatar.favicon{background:var(--surface-2);overflow:hidden;padding:0;box-shadow:0 0 0 1px var(--border)}
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
.qr-frame{display:grid;justify-items:center;gap:.45rem;padding:.9rem;border-radius:var(--radius);background:#fff;border:1px solid var(--border);box-shadow:var(--shadow-sm);color:#1a1a1a;width:max-content;max-width:100%}
.qr-frame svg{display:block;width:176px;height:176px;max-width:100%;height:auto}
.qr-frame span{font-size:.74rem;color:#4a4a4a;text-align:center;max-width:12rem}
.copy-box{display:flex;flex-direction:column;gap:.5rem}
.copy-box textarea,.copy-box input{font:400 .8rem/1.5 var(--mono);max-width:none;background:var(--surface-2);color:var(--text)}
.copy-box textarea{min-height:5.5rem}
.copy-box textarea.blurb-full{min-height:18.5rem}
.copy-line{display:flex;gap:.5rem;align-items:stretch}
.copy-line input{flex:1;min-width:0}
.ways{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:.75rem}
.way{display:flex;flex-direction:column;gap:.35rem;padding:1rem;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--surface);text-decoration:none;color:var(--text);transition:border-color .15s,box-shadow .15s,transform .12s}
.way:hover{border-color:var(--accent);box-shadow:0 0 0 3px var(--ring);transform:translateY(-1px)}
.way .way-icon{display:grid;place-items:center;width:2.3rem;height:2.3rem;border-radius:10px;background:var(--accent-soft);color:var(--accent-text);font-size:1.1rem;margin-bottom:.25rem}
.way strong{font-size:.95rem}
.way span{font-size:.84rem;color:var(--muted)}
.tabs{display:block}
.tab-input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.tab-list{display:flex;gap:.3rem;padding:.3rem;border-radius:calc(var(--radius-sm) + 4px);background:var(--surface-2);border:1px solid var(--border);margin-bottom:1.1rem;overflow-x:auto}
.tab-list label{flex:1 1 0;display:flex;align-items:center;justify-content:center;gap:.45rem;margin:0;padding:.55rem .8rem;border-radius:var(--radius-sm);font-size:.88rem;font-weight:650;color:var(--muted);cursor:pointer;white-space:nowrap;transition:background .15s,color .15s,box-shadow .15s}
.tab-list label:hover{color:var(--text)}
.tab-panel{display:none}
.tab-input:nth-of-type(1):checked~.tab-list label:nth-child(1),.tab-input:nth-of-type(2):checked~.tab-list label:nth-child(2),.tab-input:nth-of-type(3):checked~.tab-list label:nth-child(3),.tab-input:nth-of-type(4):checked~.tab-list label:nth-child(4){background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.tab-input:nth-of-type(1):focus-visible~.tab-list label:nth-child(1),.tab-input:nth-of-type(2):focus-visible~.tab-list label:nth-child(2),.tab-input:nth-of-type(3):focus-visible~.tab-list label:nth-child(3),.tab-input:nth-of-type(4):focus-visible~.tab-list label:nth-child(4){outline:2px solid var(--accent);outline-offset:1px}
.tab-input:nth-of-type(1):checked~.tab-panels>.tab-panel:nth-child(1),.tab-input:nth-of-type(2):checked~.tab-panels>.tab-panel:nth-child(2),.tab-input:nth-of-type(3):checked~.tab-panels>.tab-panel:nth-child(3),.tab-input:nth-of-type(4):checked~.tab-panels>.tab-panel:nth-child(4){display:block;animation:fade .18s ease-out}
@keyframes fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.steps{list-style:none;counter-reset:step;margin:0 0 1rem;padding:0;display:grid;gap:.55rem}
.steps li{counter-increment:step;display:flex;gap:.7rem;align-items:flex-start;font-size:.9rem}
.steps li::before{content:counter(step);display:grid;place-items:center;flex:none;width:1.5rem;height:1.5rem;border-radius:50%;background:var(--accent-soft);color:var(--accent-text);font-size:.78rem;font-weight:750;margin-top:.05rem}
dialog.sheet{width:min(40rem,calc(100vw - 1.5rem));max-height:min(90vh,52rem);max-height:min(90dvh,52rem);padding:0;border:1px solid var(--border);border-radius:calc(var(--radius) + 4px);background:var(--surface);color:var(--text);box-shadow:0 30px 80px -20px rgba(0,0,0,.45)}
dialog.sheet::backdrop{background:rgba(14,22,18,.5);backdrop-filter:blur(3px)}
dialog.sheet[open]{animation:pop .2s ease-out}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.sheet-head{position:sticky;top:0;z-index:1;display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1.15rem 1.35rem .9rem;background:var(--surface);border-bottom:1px solid var(--border)}
.sheet-head h2{margin:0;font-size:1.18rem}
.sheet-head p{margin:.15rem 0 0;font-size:.88rem;color:var(--muted)}
.sheet-body{padding:1.15rem 1.35rem 1.4rem}
.result{margin-top:1.1rem;padding:1rem;border-radius:var(--radius-sm);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);background:color-mix(in srgb,var(--accent-soft) 60%,var(--surface))}
.result h3{display:flex;align-items:center;gap:.45rem}
.fine{font-size:.8rem;color:var(--muted)}
footer{display:flex;align-items:center;gap:1.1rem;flex-wrap:wrap;margin-top:3.5rem;padding-top:1.25rem;border-top:1px solid var(--border);color:var(--muted);font-size:.85rem}
footer a{color:var(--muted);text-decoration:none}
footer a:hover{color:var(--text);text-decoration:underline}
@media(max-width:640px){
  .meta-grid{grid-template-columns:1fr;gap:.2rem}
  .meta-grid dd{margin-bottom:.6rem}
  .split{grid-template-columns:1fr}
  .tab-list label{padding:.55rem .5rem;font-size:.84rem}
  .tab-list label .icon{display:none}
  .sheet-head,.sheet-body{padding-left:1rem;padding-right:1rem}
  .qr-frame{margin:0 auto}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
@media(prefers-color-scheme:dark){
  :root{
    --bg:#0c110f;
    --bg-tint:radial-gradient(1100px 520px at 8% -10%,rgba(31,157,104,.13),transparent 62%),radial-gradient(900px 480px at 100% 0%,rgba(232,116,66,.07),transparent 60%);
    --surface:#131a17;
    --surface-2:#19221e;
    --surface-3:#202b26;
    --border:#24302b;
    --border-strong:#33433c;
    --text:#edf3ef;
    --muted:#98aaa1;
    --faint:#6e8178;
    --accent:#25a370;
    --accent-hover:#2fba80;
    --accent-2:#3ccf8e;
    --accent-soft:rgba(37,163,112,.15);
    --accent-text:#7fe4b2;
    --highlight-soft:rgba(232,116,66,.14);
    --warn:#f2b866;
    --warn-soft:rgba(242,184,102,.1);
    --warn-border:rgba(242,184,102,.3);
    --danger:#f47c7c;
    --danger-hover:#ef4444;
    --danger-soft:rgba(244,124,124,.1);
    --danger-border:rgba(244,124,124,.3);
    --ring:rgba(37,163,112,.38);
    --shadow-sm:0 1px 2px rgba(0,0,0,.4);
    --shadow:0 1px 2px rgba(0,0,0,.35),0 10px 28px -8px rgba(0,0,0,.45);
    --shadow-lg:0 2px 6px rgba(0,0,0,.4),0 26px 54px -14px rgba(0,0,0,.6);
    --hero:linear-gradient(135deg,#123326 0%,#17402f 50%,#25331f 100%);
  }
  .button,button{color:#04140c}
  .button.secondary,button.secondary{color:var(--text)}
  .button.ghost,button.ghost{color:var(--muted)}
  .button.danger,button.danger{color:#fca5a5}
  .button.danger:hover,button.danger:hover{color:#fff}
  .qr-frame{border-color:transparent}
}
</style>`;

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
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  sparkles: '<path d="M12 3 13.9 8.1 19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
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

export function servicePage(title: string, body: string, script = "", status = 200, options?: { wide?: boolean; nav?: string; remoteImages?: boolean }): Response {
  // Keep Origin on same-origin navigation POSTs without sending a referrer
  // on cross-origin requests. The forms still require the expected Origin.
  const nav = options?.nav ?? `<a class="nav-link" href="/dashboard">Dashboard</a>`;
  const mainClass = options?.wide ? ' class="wide"' : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${title} · Tendriller</title>${brandHead()}${serviceStyle}${brandStyle}</head><body><main${mainClass}><header>${brandLink}${nav}</header>${body}<footer><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/status">Status</a></footer></main>${script}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "Content-Security-Policy": `default-src 'none'; script-src ${script ? "'unsafe-inline'" : "'none'"}; style-src 'unsafe-inline'; img-src 'self'${options?.remoteImages ? " https:" : ""}; connect-src 'self'; form-action 'self'; base-uri 'none'` } });
}
