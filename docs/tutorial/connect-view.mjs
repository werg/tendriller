// A state-aware connection card for createOwnerConnection. One message, at most one
// primary action, progress while setup runs, and technical details folded away.
// The card never hides retained domain data or independent editable drafts.
const STYLE = `.tc-card{display:flex;gap:.9rem;align-items:flex-start;background:#fff;color:#111a16;border:1px solid #dde5e0;border-radius:12px;padding:1rem 1.15rem;margin:1rem 0;box-shadow:0 1px 2px rgba(15,26,21,.05)}
.tc-spinner{flex:none;width:1.15rem;height:1.15rem;margin-top:.15rem;border-radius:50%;border:2.5px solid #dde5e0;border-top-color:#146c4a;animation:tc-spin .9s linear infinite}
.tc-card[data-phase=failed] .tc-spinner,.tc-card[data-phase=key-required] .tc-spinner,.tc-card[data-phase=preview] .tc-spinner{display:none}
.tc-title{font-weight:650;font-size:.95rem;margin:0 0 .18rem}.tc-detail{margin:0;font-size:.88rem;color:#53665d}
.tc-action{margin-top:.75rem;padding:.45rem .9rem;border:0;border-radius:8px;background:#146c4a;color:#fff;font:inherit;font-size:.88rem;font-weight:620;cursor:pointer}
.tc-action:hover{background:#0f583c}
.tc-card details{margin-top:.55rem;font-size:.82rem;color:#53665d}.tc-card code{overflow-wrap:anywhere}
.tc-card[hidden]{display:none}@keyframes tc-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.tc-spinner{animation:none}}
@media(prefers-color-scheme:dark){.tc-card{background:#141b18;color:#eef3f0;border-color:#26332d;box-shadow:none}.tc-spinner{border-color:#26332d;border-top-color:#1f9d68}.tc-detail,.tc-card details{color:#91a49a}.tc-action{background:#1f9d68;color:#05140d}.tc-action:hover{background:#26b377}}`;

export function mountConnectionView(container, { hideWhenConnected = true } = {}) {
  if (!document.getElementById('tc-style')) document.head.append(Object.assign(document.createElement('style'), { id: 'tc-style', textContent: STYLE }));
  const card = document.createElement('section'), spinner = document.createElement('div'), body = document.createElement('div');
  const title = document.createElement('p'), detail = document.createElement('p'), action = document.createElement('button');
  const details = document.createElement('details'), summary = document.createElement('summary'), technical = document.createElement('code');
  card.className = 'tc-card'; card.id = 'connection-card'; card.setAttribute('aria-live', 'polite');
  spinner.className = 'tc-spinner'; spinner.setAttribute('aria-hidden', 'true');
  title.className = 'tc-title'; title.id = 'connection'; title.setAttribute('role', 'status');
  detail.className = 'tc-detail'; detail.id = 'connection-detail';
  action.className = 'tc-action'; action.id = 'connection-action'; action.type = 'button'; action.hidden = true;
  summary.textContent = 'Technical details'; details.append(summary, technical); details.hidden = true;
  body.append(title, detail, action, details); card.append(spinner, body); container.append(card);
  let current;
  action.addEventListener('click', () => { action.disabled = true; void Promise.resolve(current?.action?.run()).finally(() => { action.disabled = false; }); });
  return Object.freeze({
    element: card,
    render(state) {
      current = state;
      card.dataset.phase = state.phase; card.hidden = hideWhenConnected && state.phase === 'connected';
      title.textContent = state.title; detail.textContent = state.detail ?? '';
      action.hidden = !state.action; if (state.action) action.textContent = state.action.label;
      details.hidden = !state.technical; technical.textContent = state.technical ?? '';
    },
  });
}
