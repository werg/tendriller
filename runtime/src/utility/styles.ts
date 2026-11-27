import { utilityBottom, utilityTop } from "../utility-layout";

export const UTILITY_CSS = `
  :host{
    all:initial;
    color-scheme:light dark;
    font:14px/1.48 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --t-bg:#ffffff;
    --t-surface:#f7f8f7;
    --t-surface-2:#eef1ef;
    --t-border:rgba(20,36,28,.13);
    --t-border-strong:rgba(20,36,28,.22);
    --t-ink:#14241c;
    --t-muted:#53665c;
    --t-accent:#166047;
    --t-accent-hover:#114c38;
    --t-accent-soft:rgba(22,96,71,.12);
    --t-accent-ink:#ffffff;
    --t-glow:rgba(22,163,116,.55);
    --t-danger:#b91c1c;
    --t-danger-solid:#dc2626;
    --t-danger-soft:rgba(185,28,28,.12);
    --t-warn:#b45309;
    --t-warn-solid:#d97706;
    --t-warn-soft:rgba(217,119,6,.13);
    --t-ok:#15803d;
    --t-ok-soft:rgba(21,128,61,.13);
    --t-shadow:0 8px 30px rgba(10,20,16,.14),0 2px 8px rgba(10,20,16,.08);
    --t-shadow-lg:0 20px 60px rgba(8,18,14,.28),0 4px 16px rgba(8,18,14,.14);
    --t-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    color:var(--t-ink);
  }
  @media(prefers-color-scheme:dark){
    :host{
      --t-bg:#141b18;
      --t-surface:#1b2420;
      --t-surface-2:#232f2a;
      --t-border:rgba(220,240,230,.13);
      --t-border-strong:rgba(220,240,230,.24);
      --t-ink:#edf4f0;
      --t-muted:#9eb3a8;
      --t-accent:#2fa377;
      --t-accent-hover:#3ab888;
      --t-accent-soft:rgba(47,163,119,.18);
      --t-accent-ink:#091f17;
      --t-glow:rgba(52,211,153,.55);
      --t-danger:#f87171;
      --t-danger-solid:#dc2626;
      --t-danger-soft:rgba(248,113,113,.22);
      --t-warn:#fbbf24;
      --t-warn-solid:#d97706;
      --t-warn-soft:rgba(251,191,36,.16);
      --t-ok:#4ade80;
      --t-ok-soft:rgba(74,222,128,.16);
      --t-shadow:0 10px 32px rgba(0,0,0,.45),0 2px 10px rgba(0,0,0,.3);
      --t-shadow-lg:0 24px 64px rgba(0,0,0,.65),0 4px 20px rgba(0,0,0,.4);
    }
  }
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  button,a,input,select,textarea{font:inherit;color:inherit}
  button,a{cursor:pointer;touch-action:manipulation;text-decoration:none}
  button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--t-accent);outline-offset:2px}
  .ico{display:inline-flex;align-items:center;justify-content:center;flex:none;line-height:0}
  .ico svg{display:block}

  /* ── Floating Dock ─────────────────────────────────────────────── */
  nav.dock{
    display:flex;flex-shrink:0;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:4px;
    padding:4px;border-radius:999px;
    border:1px solid var(--t-border-strong);
    background:color-mix(in srgb,var(--t-bg) 88%,transparent);
    backdrop-filter:saturate(1.4) blur(16px);
    -webkit-backdrop-filter:saturate(1.4) blur(16px);
    box-shadow:var(--t-shadow);
    margin-left:auto;width:fit-content;max-width:100%;
    touch-action:none;user-select:none;-webkit-user-select:none;
    transition:opacity .15s,box-shadow .18s,transform .12s;
  }
  nav.dock.tucked{opacity:0;pointer-events:none}
  nav.dock.behind-modal{opacity:0;pointer-events:none}
  nav.dock[data-sensors=true]{position:relative;z-index:2147483646}
  nav.dock.dragging{cursor:grabbing;box-shadow:var(--t-shadow-lg);opacity:.92}
  :host([data-h=left]) nav.dock,:host([data-h=left]) .popover,:host([data-h=left]) .float-card{margin-left:0;margin-right:auto}
  :host([data-h=left]) nav.dock{flex-direction:row-reverse}
  :host([data-v=top]) .popover,:host([data-v=top]) .float-card{margin-top:10px;margin-bottom:0}

  .dock-btn{
    position:relative;display:inline-flex;align-items:center;justify-content:center;
    width:44px;height:44px;min-width:44px;min-height:44px;padding:0;
    border:0;border-radius:999px;background:transparent;color:var(--t-ink);
    transition:background .14s,color .14s,transform .1s,box-shadow .2s;
  }
  .dock-btn:hover{background:var(--t-surface-2)}
  .dock-btn:active{transform:scale(.95)}
  .dock-btn[aria-expanded=true]{background:var(--t-accent-soft);color:var(--t-accent)}

  /* Cohesive Chat + Expandable Mic Capsule */
  .talk-pill{
    display:inline-flex;align-items:center;
    border-radius:999px;background:var(--t-accent);color:var(--t-accent-ink);
    transition:background .14s,box-shadow .2s;
  }
  :host([data-h=left]) .talk-pill,:host([data-h=left]) .voice-reveal{flex-direction:row-reverse}
  .talk-pill[data-glow=true]{
    animation:t-talk-glow 2.1s ease-in-out infinite;
    box-shadow:0 0 0 3px var(--t-accent-soft),0 0 18px var(--t-glow);
  }
  .talk-pill[data-recording=true]{animation:none}

  .voice-reveal{
    display:inline-flex;align-items:center;flex-shrink:0;
    max-width:0;opacity:0;overflow:hidden;pointer-events:none;
    transition:max-width .2s cubic-bezier(.22,1,.36,1),opacity .15s ease;
  }
  .talk-pill:hover .voice-reveal,
  .talk-pill:focus-within .voice-reveal,
  .talk-pill[data-recording=true] .voice-reveal,
  .talk-pill[data-working=true] .voice-reveal,
  .talk-pill[data-wake=true] .voice-reveal{
    max-width:50px;opacity:1;pointer-events:auto;
  }
  .talk-pill[data-recording=true] .voice-reveal{overflow:visible}

  .talk-sep{
    width:1px;height:20px;flex:none;
    background:color-mix(in srgb,var(--t-accent-ink) 28%,transparent);
    transition:opacity .15s;
  }
  .talk-pill[data-recording=true] .talk-sep,.talk-pill[data-working=true] .talk-sep{opacity:0}

  .dock-talk,.dock-voice{
    background:transparent;color:var(--t-accent-ink);
  }
  .dock-voice{
    width:42px;min-width:42px;--level:0;
    transform:scale(.84);
    transition:transform .2s cubic-bezier(.22,1,.36,1),background .14s,color .14s,box-shadow .16s;
  }
  .talk-pill:hover .dock-voice,
  .talk-pill:focus-within .dock-voice,
  .talk-pill[data-recording=true] .dock-voice,
  .talk-pill[data-working=true] .dock-voice,
  .talk-pill[data-wake=true] .dock-voice{
    transform:scale(1);
  }
  .dock-talk:hover,.dock-voice:hover{
    background:color-mix(in srgb,var(--t-accent-ink) 14%,transparent);
    color:var(--t-accent-ink);
  }
  .dock-talk:focus-visible,.dock-voice:focus-visible{
    outline:2px solid var(--t-accent-ink);outline-offset:-3px;
  }
  .dock-voice[data-recording=true]{
    background:var(--t-danger-solid)!important;color:#fff!important;
    box-shadow:0 0 0 calc(4px + var(--level) * 10px) var(--t-danger-soft);
  }
  .dock-voice[data-working=true]{
    background:var(--t-warn-solid)!important;color:#fff!important;
  }
  .dock-voice[data-error=true]{
    background:var(--t-danger-solid)!important;color:#fff!important;
  }
  .voice-error-card{border-left:4px solid var(--t-danger)}
  .voice-error-card strong{color:var(--t-danger)}
  .voice-error-card p{color:var(--t-ink);overflow-wrap:anywhere;white-space:pre-wrap}
  @media(hover:none),(pointer:coarse){
    .voice-reveal{max-width:50px;opacity:1;pointer-events:auto}
    .dock-voice{transform:scale(1)}
  }
  @keyframes t-talk-glow{
    0%,100%{box-shadow:0 0 0 2px var(--t-accent-soft),0 0 12px var(--t-glow)}
    50%{box-shadow:0 0 0 6px var(--t-accent-soft),0 0 24px var(--t-glow)}
  }

  .dock-dot{
    position:absolute;top:5px;right:5px;width:9px;height:9px;border-radius:50%;
    border:2px solid var(--t-bg);background:var(--t-accent);pointer-events:none;
  }
  .dock-dot[data-tone=online]{background:var(--t-ok)}
  .dock-dot[data-tone=busy]{background:var(--t-warn)}
  .dock-dot[data-tone=danger]{background:var(--t-danger)}
  .dock-badge{
    position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 5px;
    border-radius:999px;background:var(--t-danger-solid);color:#fff;border:2px solid var(--t-bg);
    font-size:10px;font-weight:750;line-height:14px;text-align:center;pointer-events:none;
  }

  .sensors-pill{padding:0 10px;max-width:min(52vw,240px);font-size:12px;font-weight:600;overflow-wrap:anywhere}
  .stop-btn{
    display:inline-flex;align-items:center;gap:5px;min-height:38px;padding:0 12px;
    border:0;border-radius:999px;background:var(--t-danger-solid);color:#fff;font-size:12px;font-weight:650;
  }
  .stop-btn.sm{min-height:30px;padding:0 10px;font-size:11.5px}
  .stop-btn:hover{filter:brightness(.92)}
  .stop-btn:disabled{opacity:.6;cursor:default}

  .rec-chip{
    display:inline-flex;align-items:center;gap:7px;padding:4px 8px 4px 12px;flex-wrap:wrap;
    font-size:12px;font-weight:650;color:var(--t-ink);max-width:min(72vw,440px);min-width:0;
  }
  .rec-chip > span:not(.rec-pulse){min-width:0;overflow-wrap:anywhere}
  .rec-pulse{width:8px;height:8px;border-radius:50%;background:var(--t-danger);flex:none;animation:t-pulse 1s ease-in-out infinite}
  @keyframes t-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}
  .rec-cancel{
    border:1px solid var(--t-border-strong);border-radius:999px;background:var(--t-surface);
    min-height:30px;padding:0 10px;font-size:11px;font-weight:650;flex:none;
  }

  /* ── Floating Cards (Broadcast, Update, Suggestion) ────────────── */
  .float-card{
    flex-shrink:1;min-height:0;width:min(340px,calc(100vw - 24px));max-width:100%;
    border:1px solid var(--t-border-strong);border-radius:16px;padding:14px 16px;
    margin:0 0 10px auto;background:var(--t-bg);color:var(--t-ink);box-shadow:var(--t-shadow);
    overflow:auto;max-height:calc(var(--tendril-viewport-height,100dvh) - var(--tendril-utility-height,54px) - 14px - ${utilityTop} - ${utilityBottom});
  }
  .float-card strong{display:block;font-size:14px;font-weight:720;margin-bottom:4px}
  .float-card p{margin:0 0 10px;font-size:12.5px;color:var(--t-muted)}
  .broadcast-card{border-left:4px solid var(--t-accent)}
  .broadcast-card.warn{border-left-color:var(--t-warn)}
  .broadcast-card.danger{border-left-color:var(--t-danger)}
  .broadcast-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;flex-wrap:wrap}

  /* ── Compact Options Popover Menu ──────────────────────────────── */
  .popover{
    flex-shrink:1;min-height:0;
    width:min(336px,calc(100vw - 24px));max-width:100%;
    border:1px solid var(--t-border-strong);border-radius:18px;
    margin:0 0 10px auto;
    background:var(--t-bg);
    box-shadow:var(--t-shadow-lg);
    overflow:hidden;display:flex;flex-direction:column;
    max-height:calc(var(--tendril-viewport-height,100dvh) - var(--tendril-utility-height,54px) - 16px - ${utilityTop} - ${utilityBottom});
  }
  @keyframes t-pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
  .pop-head{
    display:flex;align-items:center;justify-content:space-between;gap:10px;
    padding:12px 14px 10px;border-bottom:1px solid var(--t-border);
  }
  .pop-title-wrap{min-width:0;display:flex;flex-direction:column;gap:2px}
  .pop-title{font-size:14.5px;font-weight:740;letter-spacing:-.015em;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pop-title:focus{outline:none}
  .pop-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--t-muted)}
  .pop-close{
    width:36px;height:36px;min-width:36px;min-height:36px;padding:0;
    display:inline-flex;align-items:center;justify-content:center;
    border:0;border-radius:10px;background:transparent;color:var(--t-muted);
  }
  .pop-close:hover{background:var(--t-surface-2);color:var(--t-ink)}

  .pop-body{overflow-y:auto;overscroll-behavior:contain;padding:6px;display:flex;flex-direction:column;gap:2px}
  .pop-banner{
    margin:4px 6px 6px;padding:9px 11px;border-radius:12px;
    background:var(--t-accent-soft);border:1px solid color-mix(in srgb,var(--t-accent) 28%,transparent);
    display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;
  }
  .pop-banner strong{font-size:12.5px;display:block}
  .menu-item{
    width:100%;display:flex;align-items:center;gap:11px;
    padding:9px 10px;min-height:48px;border:0;border-radius:12px;
    background:transparent;text-align:left;color:var(--t-ink);
    transition:background .12s;
  }
  .menu-item:hover{background:var(--t-surface-2)}
  .menu-ico{
    width:34px;height:34px;border-radius:10px;flex:none;
    display:inline-flex;align-items:center;justify-content:center;
    background:var(--t-surface-2);color:var(--t-accent);
  }
  .menu-item:hover .menu-ico{background:var(--t-accent-soft)}
  .menu-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
  .menu-label{font-size:13.5px;font-weight:650;line-height:1.25}
  .menu-sub{font-size:11.5px;color:var(--t-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .menu-trail{display:inline-flex;align-items:center;gap:6px;color:var(--t-muted);flex:none}

  .pop-foot{
    border-top:1px solid var(--t-border);padding:10px 12px;
    display:flex;align-items:center;justify-content:space-between;gap:10px;
    background:var(--t-surface);
  }
  .pop-links{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
  .pop-link{
    display:inline-flex;align-items:center;gap:4px;padding:5px 8px;min-height:32px;
    border-radius:8px;font-size:11.5px;font-weight:600;color:var(--t-muted);
  }
  .pop-link:hover{background:var(--t-surface-2);color:var(--t-ink)}

  /* ── Compact Visual Mini-Screen Corner Picker ──────────────────── */
  .corner-picker{
    position:relative;width:54px;height:36px;flex:none;
    border:1.5px solid var(--t-border-strong);border-radius:8px;
    background:var(--t-bg);display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;
    padding:3px;gap:2px;
  }
  .corner-dot{
    position:relative;border:0;padding:0;margin:0;min-height:0;min-width:0;
    background:transparent;border-radius:4px;display:flex;align-items:center;justify-content:center;
  }
  .corner-dot::after{
    content:"";width:7px;height:7px;border-radius:999px;
    background:var(--t-border-strong);transition:background .12s,transform .12s;
  }
  .corner-dot:hover::after{background:var(--t-muted);transform:scale(1.15)}
  .corner-dot[aria-pressed=true]::after{background:var(--t-accent);transform:scale(1.25)}
  .corner-dot[data-corner="top-left"]{align-items:flex-start;justify-content:flex-start;padding:2px}
  .corner-dot[data-corner="top-right"]{align-items:flex-start;justify-content:flex-end;padding:2px}
  .corner-dot[data-corner="bottom-left"]{align-items:flex-end;justify-content:flex-start;padding:2px}
  .corner-dot[data-corner="bottom-right"]{align-items:flex-end;justify-content:flex-end;padding:2px}

  /* ── Reactive Modal Backdrop (Desktop Dialog / True Full-Screen Mobile) ── */
  .modal-backdrop{
    position:fixed;inset:0;z-index:2147483647;
    background:rgba(8,14,12,.48);
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
    display:flex;align-items:center;justify-content:center;
    padding:16px;
    padding-top:max(16px,env(safe-area-inset-top));
    padding-bottom:max(16px,env(safe-area-inset-bottom));
    overscroll-behavior:contain;
    animation:t-fade .14s ease-out;
  }
  @keyframes t-fade{from{opacity:0}to{opacity:1}}
  .modal{
    width:min(520px,calc(100vw - 32px));max-width:100%;
    max-height:min(84dvh,calc(var(--tendril-viewport-height,100dvh) - 32px),720px);
    background:var(--t-bg);color:var(--t-ink);
    border:1px solid var(--t-border-strong);border-radius:20px;
    box-shadow:var(--t-shadow-lg);
    display:flex;flex-direction:column;overflow:hidden;
    animation:t-modal-in .16s ease-out;
  }
  .modal.modal-chat{width:min(560px,calc(100vw - 32px));height:min(78dvh,680px)}
  @keyframes t-modal-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
  .modal-head{
    display:flex;align-items:center;justify-content:space-between;gap:10px;
    padding:14px 16px;border-bottom:1px solid var(--t-border);flex:none;
    background:var(--t-surface);
  }
  .modal-head-left{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
  .modal-head-ico{
    width:34px;height:34px;border-radius:10px;flex:none;
    display:inline-flex;align-items:center;justify-content:center;
    background:var(--t-accent-soft);color:var(--t-accent);
  }
  .modal-head-copy{min-width:0;display:flex;flex-direction:column;gap:1px}
  .modal-head h2{margin:0;font-size:16px;font-weight:740;letter-spacing:-.02em;line-height:1.25}
  .modal-head h2:focus{outline:none}
  .modal-head-sub{font-size:12px;color:var(--t-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .modal-head-actions{display:flex;align-items:center;gap:4px;flex:none}
  .modal-body{
    flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
    padding:16px;display:flex;flex-direction:column;gap:14px;
  }
  .modal-body.chat-body{padding:0;gap:0;overflow:hidden}
  @media(max-width:639px){
    .modal-backdrop{
      top:var(--tendril-viewport-top,0px);
      left:var(--tendril-viewport-left,0px);
      width:var(--tendril-viewport-width,100vw);
      height:var(--tendril-viewport-height,100dvh);
      right:auto;bottom:auto;
      padding:0;align-items:stretch;justify-content:stretch;
      background:var(--t-bg);backdrop-filter:none;-webkit-backdrop-filter:none;
    }
    .modal,.modal.modal-chat{
      width:100%;height:100%;max-width:100%;max-height:100%;
      border-radius:0;border:0;box-shadow:none;
      animation:t-fade .12s ease-out;
    }
    .modal-head{
      padding:max(10px,env(safe-area-inset-top)) 12px 10px 14px;
    }
    .modal-backdrop[data-vv-shifted=true] .modal-head{padding-top:10px}
    .modal-backdrop[data-kb=true] .modal-head{padding:8px 12px}
    .modal-backdrop[data-kb=true] .modal-head-ico{width:30px;height:30px}
    .modal-backdrop[data-kb=true] .chat-subpanel{max-height:42%}
    .modal-body{padding:14px 14px calc(16px + env(safe-area-inset-bottom))}
    .modal-backdrop[data-kb=true] .modal-body{padding-bottom:12px}
    .modal-backdrop[data-kb=true] .chat-composer{padding:8px 10px}
  }

  /* ── Reusable UI Primitives inside Modals ──────────────────────── */
  .seg{
    display:flex;gap:3px;padding:3px;border-radius:12px;
    background:var(--t-surface-2);border:1px solid var(--t-border);
  }
  .seg button{
    flex:1;min-height:36px;padding:6px 8px;border:0;border-radius:9px;
    background:transparent;font-size:12.5px;font-weight:650;line-height:1.2;text-align:center;color:var(--t-muted);
    display:inline-flex;align-items:center;justify-content:center;gap:6px;
    transition:background .12s,color .12s,box-shadow .12s;
  }
  .seg button[aria-selected=true]{background:var(--t-bg);color:var(--t-ink);box-shadow:0 1px 4px rgba(0,0,0,.1)}

  .btn{
    display:inline-flex;align-items:center;justify-content:center;gap:7px;
    min-height:40px;padding:8px 14px;border-radius:11px;border:1px solid var(--t-border-strong);
    background:var(--t-bg);color:var(--t-ink);font-size:13px;font-weight:650;
    transition:background .12s,border-color .12s,transform .08s;
  }
  .btn:hover:not(:disabled){background:var(--t-surface-2)}
  .btn:active:not(:disabled){transform:scale(.98)}
  .btn:disabled{opacity:.55;cursor:default}
  .btn.primary{background:var(--t-accent);color:var(--t-accent-ink);border-color:var(--t-accent)}
  .btn.primary:hover:not(:disabled){background:var(--t-accent-hover);border-color:var(--t-accent-hover)}
  .btn.danger{color:var(--t-danger);border-color:color-mix(in srgb,var(--t-danger) 38%,transparent);background:transparent}
  .btn.danger:hover:not(:disabled){background:var(--t-danger-soft)}
  .btn.sm{min-height:34px;padding:5px 11px;font-size:12px;border-radius:9px}
  .btn.full{width:100%}
  .btn.icon-only{width:36px;height:36px;min-width:36px;min-height:36px;padding:0;border-radius:10px;border-color:transparent;background:transparent}
  .btn.icon-only:hover:not(:disabled){background:var(--t-surface-2)}
  .btn.icon-only[aria-pressed=true]{background:var(--t-accent-soft);color:var(--t-accent)}

  .pill{
    display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;
    font-size:11px;font-weight:680;background:var(--t-surface-2);color:var(--t-muted);white-space:nowrap;
  }
  .pill.accent{background:var(--t-accent-soft);color:var(--t-accent)}
  .pill.ok{background:var(--t-ok-soft);color:var(--t-ok)}
  .pill.warn{background:var(--t-warn-soft);color:var(--t-warn)}
  .pill.danger{background:var(--t-danger-soft);color:var(--t-danger)}
  .pill.code-pill{font-family:var(--t-mono);font-size:10.5px;white-space:normal;overflow-wrap:anywhere;max-width:100%}

  .card-box{
    border:1px solid var(--t-border);border-radius:14px;padding:13px 14px;
    background:var(--t-surface);display:flex;flex-direction:column;gap:10px;
  }
  .card-box.highlight{border-color:color-mix(in srgb,var(--t-accent) 42%,transparent);background:color-mix(in srgb,var(--t-accent) 7%,var(--t-bg))}
  .card-title{font-size:13.5px;font-weight:720;margin:0;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .muted{font-size:12.5px;color:var(--t-muted);margin:0;line-height:1.45}
  .status-msg{font-size:12.5px;color:var(--t-accent);font-weight:580;margin:0}
  .status-msg.error{color:var(--t-danger)}
  .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .row-between{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .stack{display:flex;flex-direction:column;gap:10px}
  .stack-sm{display:flex;flex-direction:column;gap:6px}
  .divider{height:1px;background:var(--t-border);margin:2px 0}

  .field{display:flex;flex-direction:column;gap:5px}
  .field label{font-size:12px;font-weight:650;color:var(--t-muted)}
  .input,.select,.textarea{
    width:100%;min-width:0;min-height:40px;padding:8px 11px;
    border:1px solid var(--t-border-strong);border-radius:10px;
    background:var(--t-bg);color:var(--t-ink);font-size:13.5px;
    transition:border-color .12s;
  }
  .input:focus,.select:focus,.textarea:focus{border-color:var(--t-accent)}
  .textarea{min-height:84px;resize:vertical;font-family:var(--t-mono);font-size:12px;line-height:1.45}

  /* ── Modern Role Cards & Expiry Chips (Invite UI) ──────────────── */
  .role-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  @media(max-width:420px){.role-grid{grid-template-columns:1fr}}
  .role-card{
    display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;
    padding:11px 12px;border-radius:13px;border:1.5px solid var(--t-border);
    background:var(--t-surface);color:var(--t-ink);transition:border-color .14s,background .14s;
  }
  .role-card:hover{border-color:var(--t-border-strong)}
  .role-card[aria-checked=true]{border-color:var(--t-accent);background:var(--t-accent-soft)}
  .role-card strong{font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px}
  .role-card span{font-size:11.5px;color:var(--t-muted);line-height:1.35}

  .chips{display:flex;gap:6px;flex-wrap:wrap}
  .chip{
    min-height:34px;padding:5px 12px;border-radius:999px;
    border:1px solid var(--t-border-strong);background:var(--t-bg);
    font-size:12px;font-weight:640;color:var(--t-muted);transition:all .12s;
  }
  .chip:hover{background:var(--t-surface-2);color:var(--t-ink)}
  .chip[aria-pressed=true]{background:var(--t-accent);color:var(--t-accent-ink);border-color:var(--t-accent)}

  /* ── QR Card ───────────────────────────────────────────────────── */
  .qr-card{
    background:#fff;color:#111;border:1px solid var(--t-border);border-radius:16px;
    padding:14px;display:flex;flex-direction:column;align-items:center;gap:8px;
    margin:0 auto;width:fit-content;max-width:100%;
  }
  .qr-card svg{display:block;width:176px;height:176px;max-width:100%;height:auto}
  .qr-cap{font-size:11.5px;color:#4a5550;text-align:center}

  /* ── Toggle Switch for Agent Grants ────────────────────────────── */
  .switch-row{
    display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:10px 12px;border:1px solid var(--t-border);border-radius:12px;
    background:var(--t-surface);cursor:pointer;
  }
  .switch-copy{min-width:0;display:flex;flex-direction:column;gap:2px}
  .switch-copy strong{font-size:13.5px;font-weight:700}
  .switch-copy span{font-size:12px;color:var(--t-muted);overflow-wrap:anywhere}
  .switch-input{
    appearance:none;-webkit-appearance:none;position:relative;flex:none;
    width:42px;height:24px;border-radius:999px;background:var(--t-border-strong);
    cursor:pointer;transition:background .15s;margin:0;
  }
  .switch-input::after{
    content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;
    border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s;
  }
  .switch-input:checked{background:var(--t-accent)}
  .switch-input:checked::after{transform:translateX(18px)}
  .switch-input:disabled{opacity:.5;cursor:default}

  /* ── Lists (Links, Agents, Guests, Diagnostics, Connections) ───── */
  .item-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
  .item-card{
    border:1px solid var(--t-border);border-radius:13px;padding:11px 12px;
    background:var(--t-surface);display:flex;flex-direction:column;gap:7px;
  }
  .mono{font-family:var(--t-mono);font-size:11.5px;overflow-wrap:anywhere;color:var(--t-muted)}
  .code-box{
    font-family:var(--t-mono);font-size:12px;line-height:1.45;
    padding:10px 12px;border-radius:10px;background:var(--t-bg);border:1px solid var(--t-border);
    white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow-y:auto;margin:0;
  }
  .steps-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:13px}

  /* ── Transport Inspector & Capabilities ────────────────────────── */
  .conn-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
  .conn-item{border:1px solid var(--t-border);border-radius:12px;padding:10px 12px;display:grid;gap:3px;background:var(--t-surface);min-width:0}
  .conn-name{font-weight:700;font-size:13px;overflow-wrap:anywhere}
  .conn-item p{margin:0;font-size:12px;color:var(--t-muted);overflow-wrap:anywhere}
  .conn-name{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
  .conn-tech{margin:4px 0}
  .conn-tech summary{font-size:12px;color:var(--t-muted);cursor:pointer;padding:6px 0}
  .conn-tech ul{margin:4px 0 8px;padding-left:18px;font-size:12px;color:var(--t-muted)}
  .conn-tech p{font-size:11.5px;color:var(--t-muted);margin:0 0 6px}
  .cap-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(136px,1fr));gap:6px}
  .cap-chip{
    display:flex;align-items:center;justify-content:space-between;gap:6px;
    padding:7px 9px;border-radius:10px;border:1px solid var(--t-border);background:var(--t-surface);
    font-size:12px;
  }
  .cap-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .diag-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
  .diag-item{font:11.5px/1.45 var(--t-mono);padding:8px 10px;border-radius:10px;background:var(--t-surface);border:1px solid var(--t-border);overflow-wrap:anywhere}

  /* ── Chat Modal ────────────────────────────────────────────────── */
  .chat-presence-btn{
    display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;
    padding:2px 6px;margin:-2px -6px;border-radius:8px;font-size:12px;color:var(--t-muted);
    max-width:100%;overflow:hidden;text-align:left;
  }
  .chat-presence-btn span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .chat-presence-btn:hover{background:var(--t-surface-2);color:var(--t-ink)}
  .pdot{width:8px;height:8px;border-radius:50%;background:var(--t-muted);flex:none}
  .pdot[data-status=online]{background:var(--t-ok)}
  .pdot[data-status=busy]{background:var(--t-warn)}
  .pdot[data-status=offline],.pdot[data-status=stopped]{background:var(--t-danger)}
  .pdot[data-status=unknown]{background:transparent;border:1.5px solid var(--t-muted);box-sizing:border-box}

  .chat-subpanel{
    border-bottom:1px solid var(--t-border);background:var(--t-surface);
    padding:12px 14px;display:flex;flex-direction:column;gap:10px;
    max-height:min(340px,54%);overflow-y:auto;overscroll-behavior:contain;flex:none;
  }
  .chat-feed{
    flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
    padding:14px;display:flex;flex-direction:column;gap:11px;background:var(--t-bg);
  }
  .chat-empty{
    margin:auto;text-align:center;max-width:300px;padding:24px 12px;
    display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--t-muted);font-size:13px;
  }
  .chat-msg{display:flex;flex-direction:column;max-width:86%;gap:3px}
  .chat-msg.self{align-self:flex-end;align-items:flex-end}
  .chat-msg.other{align-self:flex-start;align-items:flex-start}
  .chat-msg.system{align-self:center;align-items:center;max-width:96%}
  .handle-tag{
    display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:720;
    padding:1px 8px;border-radius:999px;
    background:color-mix(in srgb,var(--h-color,var(--t-accent)) 14%,var(--t-bg));
    color:var(--h-color,var(--t-accent));
  }
  .handle-role{font-size:10px;font-weight:620;opacity:.82}
  .chat-bubble{
    padding:9px 13px;border-radius:15px;white-space:pre-wrap;
    overflow-wrap:anywhere;word-break:break-word;font-size:13.5px;line-height:1.45;
  }
  .chat-msg.self .chat-bubble{background:var(--t-accent);color:var(--t-accent-ink);border-bottom-right-radius:4px}
  .chat-msg.other .chat-bubble{background:var(--t-surface);border:1px solid var(--t-border);color:var(--t-ink);border-bottom-left-radius:4px}
  .chat-msg.system .chat-bubble{background:transparent;font-size:12px;color:var(--t-muted);padding:3px 8px}
  .chat-msg.streaming .chat-bubble{border-style:dashed}
  .mention-pill{
    display:inline;padding:0 5px;border-radius:6px;font-weight:700;
    background:rgba(255,255,255,.22);
  }
  .chat-msg.other .mention-pill{background:var(--t-accent-soft);color:var(--t-accent)}
  .chat-meta{font-size:11px;color:var(--t-muted);display:flex;gap:6px;align-items:center}
  .chat-play-btn{
    display:inline-flex;align-items:center;justify-content:center;
    width:24px;height:24px;min-width:24px;min-height:24px;padding:0;
    border:0;border-radius:7px;background:transparent;color:var(--t-muted);
    transition:background .12s,color .12s;
  }
  .chat-play-btn:hover{background:var(--t-surface-2);color:var(--t-accent)}
  .chat-play-btn .ico svg{width:14px;height:14px}

  .chat-activity{border-top:1px solid var(--t-border);background:var(--t-surface);font-size:12px;flex:none}
  .chat-activity summary{cursor:pointer;padding:7px 14px;font-weight:650;color:var(--t-muted);user-select:none}
  .chat-activity ul{list-style:none;margin:0;padding:0 14px 10px;display:flex;flex-direction:column;gap:6px;max-height:140px;overflow-y:auto}
  .chat-activity li{padding:6px 9px;border-radius:9px;background:var(--t-bg);border:1px solid var(--t-border)}

  .chat-status{
    padding:8px 14px;font-size:12px;background:var(--t-surface);border-top:1px solid var(--t-border);
    display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;flex-wrap:wrap;
  }
  .chat-status span{flex:1 1 160px;min-width:0;overflow-wrap:anywhere;white-space:normal}
  .chat-status-actions{display:inline-flex;align-items:center;gap:6px;flex:none}
  .chat-status.error{color:var(--t-danger);font-weight:600;background:color-mix(in srgb,var(--t-danger-soft) 55%,var(--t-surface))}

  /* Prominent 1-tap Voice Generation (Spoken Replies) pill & quick bar */
  .voice-out-pill{
    display:inline-flex;align-items:center;gap:5px;min-height:34px;padding:4px 10px;
    border-radius:999px;border:1px solid var(--t-border-strong);
    background:var(--t-bg);color:var(--t-ink);font-size:12px;font-weight:650;
    transition:background .12s,border-color .12s,color .12s;white-space:nowrap;
  }
  .voice-out-pill:hover{background:var(--t-surface-2)}
  .voice-out-pill[aria-pressed=true]{background:var(--t-accent-soft);border-color:var(--t-accent);color:var(--t-accent)}
  .voice-out-pill[data-state=error]{background:var(--t-danger-soft);border-color:var(--t-danger);color:var(--t-danger)}
  .voice-out-bar{
    display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;
    padding:7px 14px;border-bottom:1px solid var(--t-border);
    background:color-mix(in srgb,var(--t-accent-soft) 45%,var(--t-surface));
    font-size:12px;flex:none;
  }
  .voice-out-bar[data-state=error]{background:color-mix(in srgb,var(--t-danger-soft) 55%,var(--t-surface))}
  .voice-out-bar-msg{flex:1 1 140px;min-width:0;color:var(--t-muted);overflow-wrap:anywhere}
  .voice-out-bar[data-state=error] .voice-out-bar-msg{color:var(--t-danger);font-weight:600}
  .voice-engine-seg{
    display:inline-flex;gap:2px;padding:2px;border-radius:999px;
    background:var(--t-surface-2);border:1px solid var(--t-border);flex:none;
  }
  .voice-engine-seg button{
    min-height:26px;padding:2px 9px;border:0;border-radius:999px;background:transparent;
    font-size:11.5px;font-weight:650;color:var(--t-muted);
  }
  .voice-engine-seg button[aria-pressed=true]{background:var(--t-bg);color:var(--t-ink);box-shadow:0 1px 3px rgba(0,0,0,.12)}
  .voice-wake-pill{
    display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:3px 10px;
    border-radius:999px;border:1px solid var(--t-border-strong);background:var(--t-bg);
    color:var(--t-ink);font-size:11.5px;font-weight:650;flex:none;white-space:nowrap;
    transition:background .12s,border-color .12s,color .12s;
  }
  .voice-wake-pill:hover{background:var(--t-surface-2)}
  .voice-wake-pill[aria-pressed=true]{background:var(--t-ok-soft);border-color:var(--t-ok);color:var(--t-ok)}
  .voice-upgrade-btn,.rec-upgrade{
    display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:3px 10px;
    border-radius:999px;border:1px solid color-mix(in srgb,var(--t-accent) 45%,var(--t-border-strong));
    background:var(--t-bg);color:var(--t-accent);font-size:11.5px;font-weight:700;
    flex:none;white-space:nowrap;transition:background .12s,border-color .12s,color .12s;
  }
  .voice-upgrade-btn:hover,.rec-upgrade:hover{background:var(--t-accent-soft)}
  .voice-upgrade-btn[aria-pressed=true],.rec-upgrade[aria-pressed=true]{
    background:var(--t-ok-soft);border-color:var(--t-ok);color:var(--t-ok);
  }

  /* Image Attachments in Composer & Feed */
  .chat-body.drag-over{outline:2px dashed var(--t-accent);outline-offset:-6px}
  .attach-btn{
    width:40px;height:40px;min-width:40px;min-height:40px;padding:0;border-radius:999px;
    border:1px solid var(--t-border-strong);background:var(--t-surface);color:var(--t-muted);
    display:inline-flex;align-items:center;justify-content:center;flex:none;
    transition:background .14s,color .14s,border-color .14s;
  }
  .attach-btn:hover:not(:disabled){background:var(--t-surface-2);color:var(--t-ink)}
  .attach-btn:disabled{opacity:.5;cursor:default}
  .pending-attachments{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 2px 4px;
  }
  .pending-thumb{
    position:relative;width:62px;height:62px;border-radius:11px;overflow:hidden;
    border:1px solid var(--t-border-strong);background:var(--t-surface);flex:none;
  }
  .pending-thumb img{display:block;width:100%;height:100%;object-fit:cover}
  .pending-thumb-rm{
    position:absolute;top:2px;right:2px;width:22px;height:22px;min-width:22px;min-height:22px;
    padding:0;border:0;border-radius:999px;background:rgba(12,18,15,.78);color:#fff;
    display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;
  }
  .pending-thumb-rm:hover{background:var(--t-danger-solid)}
  .chat-attachments{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  .chat-img-link{
    display:block;border-radius:10px;overflow:hidden;border:1px solid var(--t-border);
    max-width:220px;background:var(--t-surface-2);
  }
  .chat-img-link img{display:block;max-width:220px;max-height:180px;width:auto;height:auto;object-fit:cover}
  .chat-att-chip{
    display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:8px;
    font-size:11.5px;border:1px solid var(--t-border);background:color-mix(in srgb,var(--t-bg) 40%,transparent);
  }

  .chat-composer{
    position:relative;flex:none;padding:10px 12px calc(10px + env(safe-area-inset-bottom));
    border-top:1px solid var(--t-border);background:var(--t-bg);
    display:flex;flex-direction:column;gap:7px;
  }
  .mention-menu{
    position:absolute;left:12px;right:12px;bottom:100%;margin-bottom:6px;
    background:var(--t-bg);border:1px solid var(--t-border-strong);border-radius:14px;
    box-shadow:var(--t-shadow-lg);padding:4px;display:flex;flex-direction:column;gap:2px;
    z-index:20;max-height:210px;overflow-y:auto;
  }
  .mention-opt{
    display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:6px 10px;
    border:0;border-radius:9px;background:transparent;text-align:left;font-size:12.5px;color:var(--t-ink);
  }
  .mention-opt:hover,.mention-opt[aria-selected=true]{background:var(--t-accent-soft)}
  .mention-opt .m-meta{margin-left:auto;font-size:11px;color:var(--t-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%}
  .composer-row{display:flex;align-items:flex-end;gap:7px}
  .composer-input{
    flex:1;min-width:0;min-height:42px;max-height:132px;padding:9px 14px;
    border:1px solid var(--t-border-strong);border-radius:21px;background:var(--t-surface);
    resize:none;line-height:1.38;font-size:14px;
  }
  .composer-input:focus{border-color:var(--t-accent);background:var(--t-bg)}
  .mic-btn{
    width:42px;height:42px;min-width:42px;min-height:42px;padding:0;border-radius:999px;
    border:1px solid var(--t-border-strong);background:var(--t-surface);color:var(--t-ink);
    display:inline-flex;align-items:center;justify-content:center;flex:none;--level:0;
    transition:background .14s,color .14s,border-color .14s,transform .08s;
  }
  .mic-btn:hover{background:var(--t-surface-2)}
  .mic-btn:active{transform:scale(.95)}
  .mic-btn.primary-mic{background:var(--t-accent);color:var(--t-accent-ink);border-color:var(--t-accent)}
  .mic-btn.primary-mic:hover{background:var(--t-accent-hover);border-color:var(--t-accent-hover)}
  .send-btn{
    width:42px;height:42px;min-width:42px;min-height:42px;padding:0;border-radius:999px;border:0;
    background:var(--t-accent);color:var(--t-accent-ink);font-weight:680;
    display:inline-flex;align-items:center;justify-content:center;flex:none;
    transition:background .14s,transform .08s;
  }
  .send-btn:hover:not(:disabled){background:var(--t-accent-hover)}
  .send-btn:active:not(:disabled){transform:scale(.95)}
  .send-btn:disabled{opacity:.45;cursor:default}

  /* Unified Live Voice Capture Bar inside Composer */
  .voice-bar{
    display:flex;align-items:center;gap:6px;min-height:44px;flex-wrap:wrap;
    padding:4px 4px 4px 6px;border-radius:22px;
    border:1px solid var(--t-border-strong);background:var(--t-surface);
    --level:0;
  }
  .voice-bar[data-state=recording]{
    border-color:color-mix(in srgb,var(--t-danger-solid) 45%,var(--t-border-strong));
    background:color-mix(in srgb,var(--t-danger-solid) 7%,var(--t-surface));
  }
  .voice-cancel-btn{
    width:36px;height:36px;min-width:36px;min-height:36px;padding:0;border-radius:999px;
    border:0;background:transparent;color:var(--t-muted);
    display:inline-flex;align-items:center;justify-content:center;flex:none;
  }
  .voice-cancel-btn:hover{background:var(--t-surface-2);color:var(--t-ink)}
  .voice-wave-wrap{
    flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:0 4px;
  }
  .voice-meter{
    display:inline-flex;align-items:center;gap:2.5px;height:18px;flex:none;
  }
  .voice-meter i{
    display:block;width:3px;border-radius:999px;background:var(--t-danger-solid);
    height:calc(5px + var(--level) * 13px);transition:height .08s linear;
  }
  .voice-meter i:nth-child(2),.voice-meter i:nth-child(4){height:calc(8px + var(--level) * 10px)}
  .voice-meter i:nth-child(3){height:calc(11px + var(--level) * 7px)}
  .voice-bar-label{
    font-size:13px;font-weight:640;color:var(--t-ink);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .voice-finish-btn{
    display:inline-flex;align-items:center;justify-content:center;gap:6px;
    height:36px;min-height:36px;padding:0 14px;border-radius:999px;border:0;
    font-size:13px;font-weight:700;flex:none;
    transition:background .14s,box-shadow .14s,transform .08s;
  }
  .voice-finish-btn:active{transform:scale(.96)}
  .voice-finish-btn.send-mode{
    background:var(--t-danger-solid);color:#fff;
    box-shadow:0 0 0 calc(2px + var(--level) * 6px) var(--t-danger-soft);
  }
  .voice-finish-btn.send-mode:hover{filter:brightness(.93)}
  .voice-finish-btn.draft-mode{
    background:var(--t-accent);color:var(--t-accent-ink);
  }
  .voice-finish-btn.draft-mode:hover{background:var(--t-accent-hover)}

  .quick-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  @media(max-width:420px){.quick-grid{grid-template-columns:1fr}}

  /* Prevent iOS Safari auto-zoom on inputs/textareas below 16px */
  @media(max-width:639px),(hover:none) and (pointer:coarse){
    .input,.select,.textarea,.composer-input{font-size:16px}
  }

  @media(prefers-reduced-motion:reduce){
    *,*::before,*::after{animation:none!important;transition:none!important}
  }
`;
