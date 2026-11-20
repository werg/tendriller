// A state-aware connection card for createOwnerConnection. One message, at most one
// primary action, progress while setup runs, and technical details folded away.
// While not connected, the app shows this card instead of empty or stale data.
const STYLE = `.tc-card{display:flex;gap:1rem;align-items:flex-start;background:#fff;border:1px solid #cbdccd;border-radius:.8rem;padding:1.2rem;margin:1rem 0}
.tc-spinner{flex:none;width:1.4rem;height:1.4rem;border-radius:50%;border:3px solid #cbdccd;border-top-color:#17634b;animation:tc-spin 1s linear infinite}
.tc-card[data-phase=failed] .tc-spinner,.tc-card[data-phase=approve] .tc-spinner,.tc-card[data-phase=preview] .tc-spinner{display:none}
.tc-title{font-weight:650;margin:0 0 .2rem}.tc-detail{margin:0;color:#4f695c}.tc-action{margin-top:.8rem}
.tc-card details{margin-top:.6rem;font-size:.85rem;color:#4f695c}.tc-card code{overflow-wrap:anywhere}
.tc-card[hidden]{display:none}@keyframes tc-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.tc-spinner{animation:none}}`;

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
