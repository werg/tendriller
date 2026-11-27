// A state-aware connection card for createOwnerConnection. One message, at most one
// primary action, progress while setup runs, and a subtle visible error code pill
// on failure so diagnostic reports always surface the exact root cause.
// Connection status never hides retained local data or gates ordinary Save.
const STYLE = `.tc-card{--_tc-bg:#fff;--_tc-fg:#111a16;--_tc-muted:#53665d;--_tc-border:#dde5e0;--_tc-accent:#146c4a;--_tc-accent-fg:#fff;--_tc-accent-hover:#0f583c;display:flex;gap:.9rem;align-items:flex-start;background:var(--tc-bg,var(--_tc-bg));color:var(--tc-fg,var(--_tc-fg));border:1px solid var(--tc-border,var(--_tc-border));border-radius:12px;padding:1rem 1.15rem;margin:1rem 0;box-shadow:0 1px 2px rgba(15,26,21,.05)}
.tc-spinner{flex:none;width:1.15rem;height:1.15rem;margin-top:.15rem;border-radius:50%;border:2.5px solid var(--tc-border,var(--_tc-border));border-top-color:var(--tc-accent,var(--_tc-accent));animation:tc-spin .9s linear infinite}
.tc-card[data-phase=failed] .tc-spinner,.tc-card[data-phase=key-required] .tc-spinner,.tc-card[data-phase=preview] .tc-spinner{display:none}
.tc-title{font-weight:650;font-size:.95rem;margin:0 0 .18rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}.tc-detail{margin:0;font-size:.88rem;color:var(--tc-muted,var(--_tc-muted))}
.tc-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.72rem;font-weight:600;padding:.1rem .45rem;border-radius:999px;background:rgba(17,26,22,.07);color:var(--tc-muted,var(--_tc-muted));overflow-wrap:anywhere}
.tc-action{margin-top:.75rem;padding:.45rem .9rem;border:0;border-radius:8px;background:var(--tc-accent,var(--_tc-accent));color:var(--tc-accent-fg,var(--_tc-accent-fg));font:inherit;font-size:.88rem;font-weight:620;cursor:pointer}
.tc-action:hover{background:var(--tc-accent-hover,var(--tc-accent,var(--_tc-accent-hover)))}
.tc-action:focus-visible{outline:2px solid var(--tc-accent,var(--_tc-accent));outline-offset:3px}
.tc-card[hidden]{display:none}@keyframes tc-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.tc-spinner{animation:none}}
@media(prefers-color-scheme:dark){.tc-card{--_tc-bg:#141b18;--_tc-fg:#eef3f0;--_tc-muted:#91a49a;--_tc-border:#26332d;--_tc-accent:#1f9d68;--_tc-accent-fg:#05140d;--_tc-accent-hover:#26b377;box-shadow:none}.tc-code{background:rgba(255,255,255,.1)}}`;

export function mountConnectionView(container, { hideWhenConnected = true } = {}) {
  if (!document.getElementById('tc-style')) document.head.append(Object.assign(document.createElement('style'), { id: 'tc-style', textContent: STYLE }));
  const card = document.createElement('section'), spinner = document.createElement('div'), body = document.createElement('div');
  const title = document.createElement('p'), titleText = document.createElement('span'), technical = document.createElement('code');
  const detail = document.createElement('p'), action = document.createElement('button');
  card.className = 'tc-card'; card.id = 'connection-card'; card.setAttribute('aria-live', 'polite');
  spinner.className = 'tc-spinner'; spinner.setAttribute('aria-hidden', 'true');
  title.className = 'tc-title'; title.id = 'connection'; title.setAttribute('role', 'status');
  technical.className = 'tc-code'; technical.id = 'connection-code'; technical.hidden = true;
  title.append(titleText, technical);
  detail.className = 'tc-detail'; detail.id = 'connection-detail';
  action.className = 'tc-action'; action.id = 'connection-action'; action.type = 'button'; action.hidden = true;
  body.append(title, detail, action); card.append(spinner, body); container.append(card);
  let current;
  action.addEventListener('click', () => { action.disabled = true; void Promise.resolve(current?.action?.run()).finally(() => { action.disabled = false; }); });
  return Object.freeze({
    element: card,
    render(state) {
      current = state;
      card.dataset.phase = state.phase; card.hidden = hideWhenConnected && state.phase === 'connected';
      titleText.textContent = state.title; detail.textContent = state.detail ?? '';
      action.hidden = !state.action; if (state.action) action.textContent = state.action.label;
      technical.hidden = !state.technical; technical.textContent = state.technical ?? '';
    },
  });
}
