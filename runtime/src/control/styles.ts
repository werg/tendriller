export const CSS = `
.root {
  --bg: rgba(255,255,255,.88); --solid: #ffffff; --fg: #1b1e25; --muted: #5a6070;
  --line: rgba(17,22,33,.12); --soft: rgba(17,22,33,.05); --soft2: rgba(17,22,33,.09);
  --accent: #3550d6; --accent-fg: #ffffff; --accent-soft: rgba(53,80,214,.12);
  --focus: #3550d6;
  --s-listening: #0b7d8c; --s-working: #3550d6; --s-done: #2b8a3e; --s-scheduled: #5a6070;
  --s-not_responding: #a85400; --s-away: #6b7180; --s-no_agent: #6b7180; --s-offline: #6b7180;
  --s-connecting: #6b7180; --s-pending: #8a5a00;
  --danger: #b42318; --warn-bg: #fff4e5; --warn-fg: #7a3d00;
  --shadow: 0 10px 30px rgba(14,18,28,.16), 0 2px 8px rgba(14,18,28,.08);
  --radius: 18px; --bw: 1px;
  font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--fg); -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
  letter-spacing: normal; text-align: left; direction: ltr;
}
.root[data-size="large"] { font-size: 19px; }
.root[data-size="x-large"] { font-size: 22px; }
@media (prefers-color-scheme: dark) {
  .root {
    --bg: rgba(28,30,37,.88); --solid: #1c1e25; --fg: #eceef3; --muted: #a3a9b7;
    --line: rgba(255,255,255,.13); --soft: rgba(255,255,255,.06); --soft2: rgba(255,255,255,.1);
    --accent: #8ea2ff; --accent-fg: #0d1020; --accent-soft: rgba(142,162,255,.16); --focus: #a9b8ff;
    --s-listening: #3cc4d4; --s-working: #8ea2ff; --s-done: #5fd07a; --s-scheduled: #a3a9b7;
    --s-not_responding: #ffb35c; --s-away: #8f95a3; --s-no_agent: #8f95a3; --s-offline: #8f95a3;
    --s-connecting: #8f95a3; --s-pending: #ffc65c;
    --danger: #ff8a80; --warn-bg: #3a2a12; --warn-fg: #ffd59a;
    --shadow: 0 10px 30px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3);
  }
}
.root[data-contrast="high"] {
  --bg: #ffffff; --solid: #ffffff; --fg: #000000; --muted: #1a1a1a; --line: #000000;
  --soft: #f0f0f0; --soft2: #e2e2e2; --accent: #0030c0; --accent-fg: #fff; --accent-soft: #dde4ff; --focus: #000;
  --s-listening: #004f59; --s-working: #0030c0; --s-done: #005a14; --s-scheduled: #000; --s-not_responding: #7a2e00;
  --s-away: #000; --s-no_agent: #000; --s-offline: #000; --s-connecting: #000; --s-pending: #5c3b00;
  --danger: #8a0000; --warn-bg: #fff; --warn-fg: #000; --bw: 2px;
}
@media (prefers-color-scheme: dark) {
  .root[data-contrast="high"] {
    --bg: #000; --solid: #000; --fg: #fff; --muted: #f0f0f0; --line: #fff; --soft: #161616; --soft2: #262626;
    --accent: #b8c6ff; --accent-fg: #000; --accent-soft: #1c2450; --focus: #fff;
    --s-listening: #7fe9f5; --s-working: #b8c6ff; --s-done: #8ff0a4; --s-scheduled: #fff; --s-not_responding: #ffc98a;
    --s-away: #fff; --s-no_agent: #fff; --s-offline: #fff; --s-connecting: #fff; --s-pending: #ffd98a;
    --danger: #ffb3ad; --warn-bg: #000; --warn-fg: #fff;
  }
}
@media (prefers-contrast: more) {
  .root { --line: currentColor; --bw: 2px; --muted: var(--fg); --bg: var(--solid); }
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select, textarea { font: inherit; color: inherit; letter-spacing: inherit; }
button { cursor: pointer; -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.icon { display: inline-flex; width: 1.25em; height: 1.25em; flex: none; }
.icon svg { width: 100%; height: 100%; }
.sr { position: absolute !important; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* ---- dock (pill + chips) ---- */
.dock {
  position: fixed; z-index: 2; display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  right: calc(12px + env(safe-area-inset-right, 0px)); bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  max-width: calc(100vw - 24px); pointer-events: none;
}
.dock > * { pointer-events: auto; }
.root[data-pos$="left"] .dock { right: auto; left: calc(12px + env(safe-area-inset-left, 0px)); align-items: flex-start; }
.root[data-pos^="top"] .dock { bottom: auto; top: calc(12px + env(safe-area-inset-top, 0px)); flex-direction: column-reverse; }
.glass {
  background: var(--bg); border: var(--bw) solid var(--line); box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(14px) saturate(1.5); backdrop-filter: blur(14px) saturate(1.5);
}
.pill { display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 999px; }
.presence {
  display: flex; align-items: center; gap: .5em; min-height: 44px; min-width: 44px; padding: 0 .9em 0 6px;
  border: 0; border-radius: 999px; background: transparent; font-weight: 600; font-size: .92em; white-space: nowrap;
}
.presence:hover { background: var(--soft); }
.presence .label { max-width: 15em; overflow: hidden; text-overflow: ellipsis; }
.orb {
  --c: var(--s-connecting);
  display: inline-grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: 50%;
  color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent);
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--c) 45%, transparent);
  position: relative;
}
.orb .icon { width: 18px; height: 18px; }
.orb[data-state] { --c: var(--s-connecting); }
.orb[data-state="listening"] { --c: var(--s-listening); }
.orb[data-state="working"] { --c: var(--s-working); }
.orb[data-state="done"] { --c: var(--s-done); }
.orb[data-state="scheduled"] { --c: var(--s-scheduled); }
.orb[data-state="not_responding"] { --c: var(--s-not_responding); }
.orb[data-state="away"] { --c: var(--s-away); }
.orb[data-state="no_agent"] { --c: var(--s-no_agent); }
.orb[data-state="offline"] { --c: var(--s-offline); }
.orb[data-state="pending"] { --c: var(--s-pending); }
.orb[data-state="listening"]::after {
  content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid var(--c); opacity: 0;
  animation: breathe 3.2s ease-in-out infinite;
}
.orb[data-state="working"] .spin { transform-origin: 12px 12px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes breathe { 0%,100% { opacity: 0; transform: scale(.92); } 50% { opacity: .45; transform: scale(1.05); } }
.badge {
  display: inline-grid; place-items: center; min-width: 1.4em; height: 1.4em; padding: 0 .35em; border-radius: 999px;
  background: var(--s-pending); color: var(--solid); font-size: .78em; font-weight: 700;
}
.mic {
  display: inline-grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; border: 0;
  background: var(--accent); color: var(--accent-fg); touch-action: none; user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none; transition: transform .12s ease, box-shadow .12s ease;
}
.mic .icon { width: 20px; height: 20px; }
.mic[aria-pressed="true"] { box-shadow: 0 0 0 4px var(--accent-soft), 0 0 0 7px color-mix(in srgb, var(--accent) 35%, transparent); transform: scale(1.06); }
.mic:disabled { opacity: .45; cursor: default; }
.bubble {
  max-width: min(22em, calc(100vw - 24px)); padding: .6em .9em; border-radius: 14px; font-size: .92em;
}
.bubble .who { display: block; font-size: .78em; font-weight: 600; color: var(--muted); }
.chip { display: flex; align-items: center; gap: .5em; padding: 4px 4px 4px .8em; border-radius: 999px; font-size: .9em; font-weight: 600; }
.chip.sensors { color: var(--danger); }
.chip .icons { display: inline-flex; gap: .25em; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: .45em; min-height: 44px; min-width: 44px;
  padding: 0 1em; border-radius: 12px; border: var(--bw) solid var(--line); background: var(--solid); font-weight: 600; font-size: .92em;
}
.btn:hover { background: var(--soft); }
.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
.btn.primary:hover { filter: brightness(1.06); }
.btn.danger { color: var(--danger); }
.btn.stop { background: var(--danger); color: var(--solid); border-color: transparent; border-radius: 999px; }
.btn.small { min-height: 44px; padding: 0 .8em; font-size: .85em; }
.btn.ghost { background: transparent; border-color: transparent; }
.btn:disabled { opacity: .5; cursor: default; }

/* ---- sheet ---- */
.sheet {
  position: fixed; z-index: 3; right: calc(12px + env(safe-area-inset-right, 0px)); bottom: calc(68px + env(safe-area-inset-bottom, 0px));
  width: min(25em, calc(100vw - 24px)); max-height: min(78vh, 46em); overflow: auto; overscroll-behavior: contain;
  background: var(--solid); border: var(--bw) solid var(--line); border-radius: 22px; box-shadow: var(--shadow);
  padding: 14px 16px 18px; animation: rise .18s ease-out;
}
.root[data-pos$="left"] .sheet { right: auto; left: calc(12px + env(safe-area-inset-left, 0px)); }
.root[data-pos^="top"] .sheet { bottom: auto; top: calc(68px + env(safe-area-inset-top, 0px)); }
@keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
@media (max-width: 520px) {
  .sheet, .root[data-pos] .sheet {
    left: 0; right: 0; bottom: 0; top: auto; width: auto; max-height: 86vh; border-radius: 22px 22px 0 0;
    border-bottom: 0; padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px));
  }
}
.head { display: flex; align-items: center; gap: .7em; margin: -14px -16px 6px; padding: 14px 16px 8px; position: sticky; top: -14px; z-index: 1; background: var(--solid); }
.head .orb { width: 40px; height: 40px; }
.head .orb .icon { width: 22px; height: 22px; }
.head .titles { flex: 1; min-width: 0; }
.head h2 { margin: 0; font-size: 1.08em; font-weight: 700; line-height: 1.25; }
.head p { margin: 0; color: var(--muted); font-size: .88em; }
.iconbtn {
  display: inline-grid; place-items: center; width: 44px; height: 44px; border-radius: 50%;
  border: 0; background: var(--soft); flex: none;
}
.iconbtn:hover { background: var(--soft2); }
.card { border-radius: 14px; padding: 12px 14px; margin: 10px 0; background: var(--soft); border: var(--bw) solid transparent; }
.card.warn { background: var(--warn-bg); color: var(--warn-fg); border-color: color-mix(in srgb, var(--warn-fg) 30%, transparent); }
.card h3 { margin: 0 0 4px; font-size: .95em; }
.card p { margin: 0 0 8px; font-size: .9em; }
.card .row { display: flex; gap: 8px; flex-wrap: wrap; }
.code { font: 700 1.9em/1.1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: .12em; margin: 6px 0 8px; word-break: break-all; }
.log { list-style: none; margin: 6px 0 10px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.log li { max-width: 88%; padding: .5em .8em; border-radius: 14px; background: var(--soft); font-size: .92em; overflow-wrap: anywhere; }
.log li.user { align-self: flex-end; background: var(--accent-soft); }
.log li .who { display: block; font-size: .75em; font-weight: 700; color: var(--muted); }
.log .empty { background: transparent; color: var(--muted); padding-left: 0; }
.composer { display: flex; gap: 8px; align-items: flex-end; margin: 8px 0 4px; }
.composer textarea {
  flex: 1; min-width: 0; min-height: 44px; max-height: 8em; resize: none; padding: .55em .8em; border-radius: 14px;
  border: var(--bw) solid var(--line); background: var(--solid); line-height: 1.4;
}
.composer textarea::placeholder { color: var(--muted); opacity: 1; }
.composer .send { width: 44px; height: 44px; padding: 0; border-radius: 50%; }
.hint { font-size: .82em; color: var(--muted); margin: 2px 2px 6px; min-height: 1.2em; }
.hint:empty { margin: 0; min-height: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
details { border-top: var(--bw) solid var(--line); }
details:last-of-type { border-bottom: var(--bw) solid var(--line); }
summary {
  list-style: none; display: flex; align-items: center; gap: .6em; min-height: 48px; padding: 0 4px; cursor: pointer; font-weight: 600; font-size: .95em;
  border-radius: 10px;
}
summary::-webkit-details-marker { display: none; }
summary .chev { margin-left: auto; transition: transform .15s ease; color: var(--muted); }
details[open] > summary .chev { transform: rotate(90deg); }
.panel { padding: 2px 4px 14px; font-size: .92em; }
.panel p { margin: 4px 0 8px; }
.muted { color: var(--muted); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.list li { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 12px; background: var(--soft); }
.list li .grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.list li .sub { display: block; font-size: .82em; color: var(--muted); }
.thumb { width: 52px; height: 52px; object-fit: cover; border-radius: 8px; background: var(--soft2); flex: none; }
.tag { display: inline-block; font-size: .75em; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: var(--soft2); margin-left: 4px; vertical-align: 1px; }
.qrbox { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 10px 0; }
.qr { width: min(240px, 70vw); height: auto; border-radius: 12px; border: var(--bw) solid var(--line); }
.url { font: .82em/1.35 ui-monospace, Menlo, Consolas, monospace; word-break: break-all; background: var(--soft); padding: 6px 8px; border-radius: 8px; width: 100%; }
fieldset { border: 0; margin: 0 0 12px; padding: 0; }
legend { font-weight: 600; margin-bottom: 6px; padding: 0; }
.seg { display: flex; gap: 6px; flex-wrap: wrap; }
.seg label { flex: 1; }
.seg input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.seg span {
  display: flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 .8em; border-radius: 12px;
  border: var(--bw) solid var(--line); cursor: pointer; font-weight: 600;
}
.seg input:checked + span { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
.seg input:focus-visible + span { outline: 3px solid var(--focus); outline-offset: 2px; }
.switch { display: flex; align-items: center; gap: .7em; min-height: 44px; cursor: pointer; }
.switch input { width: 1.4em; height: 1.4em; accent-color: var(--accent); margin: 0; flex: none; }
.field { display: flex; align-items: center; gap: .6em; min-height: 44px; flex-wrap: wrap; }
.field select, .field input[type="number"] {
  min-height: 44px; padding: 0 .6em; border-radius: 10px; border: var(--bw) solid var(--line); background: var(--solid);
}
.field input[type="number"] { width: 6em; }
.error { color: var(--danger); font-size: .88em; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
.root[data-display="true"] .presence { font-size: 1em; }
`;
