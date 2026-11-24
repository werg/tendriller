import { brandHead, brandLink, brandStyle } from "../brand";

export const serviceStyle = `<style>
:root{
  color-scheme:light dark;
  --bg:#f6f8f7;
  --surface:#ffffff;
  --surface-2:#eff3f1;
  --border:#dde5e0;
  --border-strong:#c4d1c9;
  --text:#111a16;
  --muted:#53665d;
  --accent:#146c4a;
  --accent-hover:#0f583c;
  --accent-soft:#e8f4ee;
  --accent-text:#0e573b;
  --warn:#9a5b13;
  --warn-soft:#fef6e7;
  --warn-border:#f2d7a4;
  --danger:#b91c1c;
  --danger-hover:#991b1b;
  --danger-soft:#fef2f2;
  --danger-border:#f5c2c2;
  --ring:rgba(20,108,74,.25);
  --shadow:0 1px 2px rgba(15,26,21,.05),0 6px 20px rgba(15,26,21,.04);
  --radius:14px;
  --radius-sm:9px;
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  background:var(--bg);
  color:var(--text);
  accent-color:var(--accent);
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
main{max-width:52rem;margin:0 auto;padding:clamp(1rem,3.5vw,2.5rem) clamp(1rem,4vw,2rem) 3.5rem}
main.wide{max-width:64rem}
a{color:var(--accent-text);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{text-decoration-thickness:2px}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-bottom:1rem;margin-bottom:2rem;border-bottom:1px solid var(--border)}
header a{text-decoration:none;color:var(--text);font-weight:600;font-size:.94rem}
header .nav-link{display:inline-flex;align-items:center;gap:.35rem;padding:.42rem .8rem;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.86rem;font-weight:600;transition:background .15s,border-color .15s}
header .nav-link:hover{background:var(--surface-2);border-color:var(--border-strong)}
.back-link{display:inline-flex;align-items:center;gap:.35rem;font-size:.88rem;font-weight:600;color:var(--muted);text-decoration:none;margin-bottom:.75rem}
.back-link:hover{color:var(--text)}
.eyebrow{display:inline-block;font-size:.74rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--accent-text);margin-bottom:.35rem}
h1{font-size:clamp(1.55rem,3.2vw,2.15rem);line-height:1.15;letter-spacing:-.028em;font-weight:750;margin:.15rem 0 .65rem}
h2{font-size:1.08rem;line-height:1.28;letter-spacing:-.015em;font-weight:700;margin:0 0 .35rem}
h3{font-size:.96rem;line-height:1.3;font-weight:680;margin:0 0 .25rem}
p{margin:0 0 .85rem;max-width:44rem}
p:last-child{margin-bottom:0}
.lead{font-size:1.02rem;color:var(--muted);max-width:42rem}
.muted,small{color:var(--muted)}
small{font-size:.84rem}
code{font:500 .86em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:.12em .38em;overflow-wrap:anywhere}
pre{font:400 .8rem/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:.9rem 1rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:.75rem 0 0}
.page-head{margin-bottom:1.5rem}
.page-head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.page-head-row>div,.card-head>div{flex:1 1 16rem;min-width:0}
.stack{display:flex;flex-direction:column;gap:1.15rem}
.stack-sm{display:flex;flex-direction:column;gap:.65rem}
.row{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap}
.hero{padding:clamp(1.35rem,3.5vw,2.1rem);border-radius:var(--radius);background:var(--surface);border:1px solid var(--border);box-shadow:var(--shadow);margin-bottom:1.5rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:1rem;margin:1rem 0 1.5rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:clamp(1.1rem,2.5vw,1.45rem);min-width:0;box-shadow:var(--shadow)}
.card.subtle{background:var(--surface-2);box-shadow:none}
.card.danger{border-color:var(--danger-border);background:var(--danger-soft)}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin-bottom:.9rem}
.card-head p{margin:.2rem 0 0;font-size:.9rem;color:var(--muted)}
.badge{display:inline-flex;align-items:center;gap:.35rem;padding:.2rem .6rem;border-radius:999px;font-size:.76rem;font-weight:650;letter-spacing:.01em;border:1px solid var(--border);background:var(--surface-2);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--accent-soft);border-color:transparent;color:var(--accent-text)}
.badge.warn{background:var(--warn-soft);border-color:var(--warn-border);color:var(--warn)}
.badge.danger{background:var(--danger-soft);border-color:var(--danger-border);color:var(--danger)}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:.6rem;margin-top:1rem}
.actions.tight{margin-top:0}
.button,button{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;min-height:2.5rem;border:1px solid transparent;border-radius:var(--radius-sm);padding:.55rem 1.05rem;background:var(--accent);color:#fff;font:inherit;font-size:.92rem;font-weight:620;cursor:pointer;text-decoration:none;transition:background .15s,border-color .15s,transform .05s;white-space:nowrap}
.button:hover,button:hover{background:var(--accent-hover)}
.button:active,button:active{transform:translateY(.5px)}
.button.secondary,button.secondary{background:var(--surface-2);border-color:var(--border);color:var(--text)}
.button.secondary:hover,button.secondary:hover{background:var(--border);border-color:var(--border-strong)}
.button.ghost,button.ghost{background:transparent;border-color:transparent;color:var(--muted)}
.button.ghost:hover,button.ghost:hover{background:var(--surface-2);color:var(--text)}
.button.danger,button.danger{background:var(--danger-soft);border-color:var(--danger-border);color:var(--danger)}
.button.danger:hover,button.danger:hover{background:var(--danger);border-color:var(--danger);color:#fff}
.button.sm,button.sm{min-height:2rem;padding:.32rem .72rem;font-size:.84rem;border-radius:7px}
.button.lg,button.lg{min-height:2.85rem;padding:.7rem 1.35rem;font-size:.98rem}
.list{list-style:none;margin:0;padding:0;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);overflow:hidden}
.list-item{display:flex;align-items:center;justify-content:space-between;gap:.85rem;flex-wrap:wrap;padding:.8rem 1rem;border-top:1px solid var(--border)}
.list-item:first-child{border-top:0}
.list-item-main{min-width:0;flex:1 1 14rem}
.list-item-title{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;font-weight:640;font-size:.94rem}
.list-item-sub{font-size:.86rem;color:var(--muted);margin:.18rem 0 0;overflow-wrap:anywhere}
.empty{margin:0;padding:.85rem 1rem;border:1px dashed var(--border-strong);border-radius:var(--radius-sm);color:var(--muted);font-size:.9rem}
.group-label{font-size:.76rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:1.1rem 0 .45rem}
.group-label:first-child{margin-top:0}
.check-list{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;background:var(--surface)}
.check-item{display:flex;align-items:flex-start;gap:.75rem;padding:.72rem .95rem;margin:0;border-top:1px solid var(--border);cursor:pointer;transition:background .12s}
.check-item:first-child{border-top:0}
.check-item:hover{background:var(--surface-2)}
.check-item input[type=checkbox]{flex:none;width:1.08rem;height:1.08rem;margin:.2rem 0 0;cursor:pointer;accent-color:var(--accent)}
.check-copy{min-width:0;flex:1}
.check-title{display:block;font-weight:640;font-size:.92rem;color:var(--text)}
.check-desc{display:block;font-size:.85rem;color:var(--muted);margin-top:.12rem;line-height:1.42}
.field{display:flex;flex-direction:column;gap:.35rem;margin:0 0 .9rem}
.field:last-child{margin-bottom:0}
.field-label{font-size:.86rem;font-weight:640;color:var(--text)}
input[type=text],input[type=url],input[type=password],input:not([type]),textarea,select{font:inherit;width:100%;max-width:34rem;border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:.58rem .78rem;background:var(--surface);color:var(--text);transition:border-color .15s,box-shadow .15s}
input[type=text]:focus,input[type=url]:focus,input[type=password]:focus,input:not([type]):focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}
textarea{min-height:7.5rem;resize:vertical}
label{display:block;margin:.6rem 0}
fieldset{border:1px solid var(--border);border-radius:var(--radius-sm);padding:1rem;margin:1rem 0}
legend{font-size:.8rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:0 .4rem}
details.disclosure{border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);overflow:hidden;margin-top:1rem}
details.disclosure summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.78rem 1rem;font-size:.9rem;font-weight:630;color:var(--text);cursor:pointer;user-select:none}
details.disclosure summary::-webkit-details-marker{display:none}
details.disclosure summary::after{content:"▸";color:var(--muted);font-size:.85rem;transition:transform .15s}
details.disclosure[open] summary::after{transform:rotate(90deg)}
details.disclosure summary:hover{background:var(--surface-2)}
details.disclosure .disclosure-body{padding:1rem;border-top:1px solid var(--border)}
details.disclosure.danger{border-color:var(--danger-border)}
details.disclosure.danger summary{color:var(--danger)}
.meta-grid{display:grid;grid-template-columns:minmax(8.5rem,11rem) minmax(0,1fr);gap:.45rem 1rem;margin:0;font-size:.88rem}
.meta-grid dt{color:var(--muted);font-weight:600}
.meta-grid dd{margin:0;overflow-wrap:anywhere}
.notice{padding:.85rem 1rem;border-radius:var(--radius-sm);border:1px solid var(--border);border-left:3px solid var(--accent);background:var(--accent-soft);color:var(--text);font-size:.92rem;margin:0 0 1.1rem}
.notice.warn{background:var(--warn-soft);border-color:var(--warn-border);border-left-color:var(--warn)}
.notice.danger{background:var(--danger-soft);border-color:var(--danger-border);border-left-color:var(--danger)}
.inline-form{display:inline-flex;margin:0}
footer{display:flex;align-items:center;gap:1.1rem;flex-wrap:wrap;margin-top:3rem;padding-top:1.25rem;border-top:1px solid var(--border);color:var(--muted);font-size:.85rem}
footer a{color:var(--muted);text-decoration:none}
footer a:hover{color:var(--text);text-decoration:underline}
@media(max-width:560px){
  .meta-grid{grid-template-columns:1fr;gap:.2rem}
  .meta-grid dd{margin-bottom:.6rem}
  header{margin-bottom:1.35rem}
}
@media(prefers-color-scheme:dark){
  :root{
    --bg:#0d1210;
    --surface:#141b18;
    --surface-2:#1b2420;
    --border:#26332d;
    --border-strong:#35473f;
    --text:#eef3f0;
    --muted:#91a49a;
    --accent:#1f9d68;
    --accent-hover:#26b377;
    --accent-soft:rgba(31,157,104,.14);
    --accent-text:#6ee0a8;
    --warn:#f5b963;
    --warn-soft:rgba(245,185,99,.12);
    --warn-border:rgba(245,185,99,.32);
    --danger:#f87171;
    --danger-hover:#ef4444;
    --danger-soft:rgba(248,113,113,.12);
    --danger-border:rgba(248,113,113,.32);
    --ring:rgba(31,157,104,.35);
    --shadow:0 1px 2px rgba(0,0,0,.35),0 10px 28px rgba(0,0,0,.25);
  }
  .button,button{color:#05140d}
  .button.secondary,button.secondary{color:var(--text)}
  .button.ghost,button.ghost{color:var(--muted)}
  .button.danger,button.danger{color:#fca5a5}
  .button.danger:hover,button.danger:hover{color:#fff}
}
</style>`;

export function servicePage(title: string, body: string, script = "", status = 200, options?: { wide?: boolean; nav?: string }): Response {
  // Keep Origin on same-origin navigation POSTs without sending a referrer
  // on cross-origin requests. The forms still require the expected Origin.
  const nav = options?.nav ?? `<a class="nav-link" href="/dashboard">Dashboard</a>`;
  const mainClass = options?.wide ? ' class="wide"' : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${title} · Tendriller</title>${brandHead()}${serviceStyle}${brandStyle}</head><body><main${mainClass}><header>${brandLink}${nav}</header>${body}<footer><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/status">Status</a></footer></main>${script}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "Content-Security-Policy": `default-src 'none'; script-src ${script ? "'unsafe-inline'" : "'none'"}; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'` } });
}
