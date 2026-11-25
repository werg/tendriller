// Full-duplex responsive dashboard shell and glanceable domain widgets.
// Mobile-first (1-col phone -> 2-col tablet -> 3/4-col desktop), zero external deps,
// dark/light adaptive, safe-area and --tendril-utility-height aware.

const STYLE_ID = 'tendril-dashboard-style';
const STYLE = String.raw`
.td-shell{--td-bg:#f6f8f7;--td-card:#ffffff;--td-border:#d7e1dc;--td-text:#162921;--td-muted:#546b61;--td-accent:#1e644a;--td-ok:#1e7e4c;--td-warn:#b86b11;--td-alert:#b72222;color:var(--td-text);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:1280px;margin:0 auto;padding:16px 16px calc(84px + var(--tendril-utility-height,54px));display:flex;flex-direction:column;gap:14px}
@media(prefers-color-scheme:dark){.td-shell{--td-bg:#111614;--td-card:#18201d;--td-border:#2c3a34;--td-text:#eaf2ee;--td-muted:#9bb0a7;--td-accent:#5ec49b;--td-ok:#52c785;--td-warn:#f0a84a;--td-alert:#ff7b7b}}
.td-shell *{box-sizing:border-box}
.td-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;background:var(--td-card);border:1px solid var(--td-border);border-radius:14px}
.td-title-wrap{min-width:0}
.td-title{margin:0;font-size:1.25rem;line-height:1.25;letter-spacing:-.02em}
.td-subtitle{margin:2px 0 0;font-size:.86rem;color:var(--td-muted)}
.td-pills{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.td-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--td-border);background:color-mix(in srgb,var(--td-card) 85%,var(--td-text))}
.td-dot{width:8px;height:8px;border-radius:50%;background:var(--td-muted);flex:none}
.td-pill[data-tone="ok"] .td-dot{background:var(--td-ok)}
.td-pill[data-tone="warn"] .td-dot{background:var(--td-warn)}
.td-pill[data-tone="alert"] .td-dot{background:var(--td-alert)}
.td-btn{font:inherit;font-size:12px;font-weight:600;color:var(--td-text);background:var(--td-card);border:1px solid var(--td-border);border-radius:9px;min-height:34px;padding:5px 10px;cursor:pointer;touch-action:manipulation}
.td-btn:hover:not(:disabled){border-color:var(--td-accent)}
.td-btn.primary{background:var(--td-accent);color:#fff;border-color:var(--td-accent)}
.td-btn:focus-visible{outline:2px solid var(--td-accent);outline-offset:2px}
.td-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(270px,100%),1fr));gap:12px;align-items:stretch}
.td-card{background:var(--td-card);border:1px solid var(--td-border);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:8px;min-width:0;transition:opacity .2s,border-color .2s}
.td-card[data-stale="true"]{opacity:.72}
.td-card[data-tone="warn"]{border-color:var(--td-warn)}
.td-card[data-tone="alert"]{border-color:var(--td-alert)}
.td-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.td-card-title{margin:0;font-size:13px;font-weight:650;color:var(--td-muted);text-transform:uppercase;letter-spacing:.03em}
.td-metric-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.td-metric-value{font-size:2rem;font-weight:750;line-height:1.1;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.td-metric-unit{font-size:.95rem;font-weight:500;color:var(--td-muted)}
.td-delta{font-size:12px;font-weight:650;padding:2px 7px;border-radius:999px;background:color-mix(in srgb,var(--td-accent) 14%,transparent);color:var(--td-accent)}
.td-delta[data-sign="down"]{background:color-mix(in srgb,var(--td-alert) 14%,transparent);color:var(--td-alert)}
.td-spark{width:100%;height:42px;display:block;overflow:visible}
.td-card-foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--td-muted);padding-top:4px}
.td-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.td-list-item{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:8px 9px;border-radius:9px;background:color-mix(in srgb,var(--td-card) 93%,var(--td-text));font-size:13px}
.td-list-item button{flex:none}
.td-badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:650;text-transform:uppercase}
.td-badge[data-tone="ok"]{background:color-mix(in srgb,var(--td-ok) 18%,transparent);color:var(--td-ok)}
.td-badge[data-tone="warn"]{background:color-mix(in srgb,var(--td-warn) 18%,transparent);color:var(--td-warn)}
.td-badge[data-tone="alert"]{background:color-mix(in srgb,var(--td-alert) 18%,transparent);color:var(--td-alert)}
.td-chips{display:flex;flex-wrap:wrap;gap:6px}
.td-chip{font:inherit;font-size:13px;font-weight:600;padding:7px 12px;border-radius:999px;border:1px solid var(--td-border);background:var(--td-card);color:var(--td-text);cursor:pointer;min-height:36px}
.td-chip[aria-pressed="true"]{background:var(--td-accent);color:#fff;border-color:var(--td-accent)}
.td-note{width:100%;min-height:60px;padding:8px 10px;border:1px solid var(--td-border);border-radius:9px;background:var(--td-card);color:var(--td-text);font:inherit;resize:vertical}
@media(max-width:600px){.td-shell{padding:10px 10px calc(84px + var(--tendril-utility-height,54px))}.td-metric-value{font-size:1.7rem}}
`;

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.append(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatAge(fetchedAtMs) {
  if (!fetchedAtMs) return 'Waiting for data…';
  const sec = Math.max(0, Math.round((Date.now() - fetchedAtMs) / 1000));
  if (sec < 5) return 'Updated just now';
  if (sec < 60) return `Updated ${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `Updated ${min}m ago`;
  return `Updated ${Math.round(min / 60)}h ago`;
}

function renderSparklineSvg(values) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'td-spark');
  svg.setAttribute('viewBox', '0 0 160 40');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (nums.length < 2) return svg;
  const min = Math.min(...nums), max = Math.max(...nums);
  const span = max - min || 1;
  const points = nums.map((v, i) => {
    const x = (i / (nums.length - 1)) * 160;
    const y = 36 - ((v - min) / span) * 30;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const poly = document.createElementNS(svgNS, 'polyline');
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', 'currentColor');
  poly.setAttribute('stroke-width', '2');
  poly.setAttribute('stroke-linecap', 'round');
  poly.setAttribute('stroke-linejoin', 'round');
  poly.setAttribute('points', points);
  svg.style.color = 'var(--td-accent)';
  svg.append(poly);
  return svg;
}

/**
 * Responsive dashboard shell with connection/agent status pills, refresh trigger,
 * and a multi-column card grid.
 */
export function mountDashboardShell(container, {
  title = 'Dashboard',
  subtitle = '',
  session = null,
  runtime = null,
  keepAwakeToggle = false,
  onRefresh = null,
} = {}) {
  ensureStyles();
  const shell = el('div', 'td-shell');
  const header = el('header', 'td-header');
  const titleWrap = el('div', 'td-title-wrap');
  const h1 = el('h1', 'td-title', title);
  const sub = el('p', 'td-subtitle', subtitle);
  sub.hidden = !subtitle;
  titleWrap.append(h1, sub);

  const pills = el('div', 'td-pills');
  const connPill = el('span', 'td-pill');
  const connDot = el('span', 'td-dot');
  const connLabel = el('span', undefined, 'Connecting…');
  connPill.append(connDot, connLabel);

  const agentPill = el('span', 'td-pill');
  const agentDot = el('span', 'td-dot');
  const agentLabel = el('span', undefined, 'Agent ready');
  agentPill.append(agentDot, agentLabel);

  const freshLabel = el('span', 'td-pill', 'Waiting…');
  pills.append(connPill, agentPill, freshLabel);

  let refreshBtn = null;
  if (typeof onRefresh === 'function') {
    refreshBtn = el('button', 'td-btn', 'Refresh');
    refreshBtn.type = 'button';
    refreshBtn.addEventListener('click', () => { void onRefresh(); });
    pills.append(refreshBtn);
  }
  let wakeLease = null;
  let offWakeStop = () => {};
  if (keepAwakeToggle && runtime?.sensors?.wakeLock) {
    const awakeBtn = el('button', 'td-btn', 'Keep awake');
    awakeBtn.type = 'button';
    awakeBtn.setAttribute('aria-pressed', 'false');
    const setPressed = active => {
      awakeBtn.setAttribute('aria-pressed', String(active));
      awakeBtn.classList.toggle('primary', active);
      awakeBtn.textContent = active ? 'Awake: On' : 'Keep awake';
    };
    offWakeStop = runtime.on?.('sensors_stopped', () => { wakeLease = null; setPressed(false); }) ?? (() => {});
    awakeBtn.addEventListener('click', () => {
      if (wakeLease) {
        const prev = wakeLease;
        wakeLease = null;
        setPressed(false);
        void prev.release();
        return;
      }
      // Call synchronously inside click handler to preserve user gesture.
      void runtime.sensors.wakeLock({ label: 'Keep dashboard awake', autoReacquire: true }).then(lease => {
        if (!lease.supported) { setPressed(false); return; }
        wakeLease = lease;
        setPressed(true);
      }).catch(() => setPressed(false));
    });
    pills.append(awakeBtn);
  }
  header.append(titleWrap, pills);

  const grid = el('div', 'td-grid');
  shell.append(header, grid);
  container.append(shell);

  const setStatus = (tone, label) => {
    connPill.dataset.tone = tone;
    connLabel.textContent = label;
  };
  const setAgentStatus = (tone, label) => {
    agentPill.dataset.tone = tone;
    agentLabel.textContent = label;
  };
  const setFreshness = text => {
    freshLabel.textContent = text;
  };

  let offParticipation = () => {};
  if (session?.participation?.onStatus) {
    const applyParticipation = status => {
      const peers = status?.connectedPeers?.length ?? 0;
      if (peers > 0) setStatus('ok', `Live · ${peers} peer${peers === 1 ? '' : 's'}`);
      else if (status?.phase === 'connecting' || status?.phase === 'recovering') setStatus('warn', 'Reconnecting…');
      else setStatus('alert', status?.error ? `Offline (${status.error})` : 'Offline');
    };
    if (session.participation.status) applyParticipation(session.participation.status);
    offParticipation = session.participation.onStatus(applyParticipation);
  }

  return Object.freeze({
    element: shell,
    grid,
    setStatus,
    setAgentStatus,
    setFreshness,
    addCard(node) { grid.append(node); return node; },
    close() { offParticipation(); offWakeStop(); void wakeLease?.release(); wakeLease = null; shell.remove(); },
  });
}

/** Glanceable KPI card with value, delta, inline SVG sparkline, freshness, and "Ask agent" context handoff. */
export function mountMetricCard(container, {
  title,
  unit = '',
  format = v => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v ?? '—')),
  historyLimit = 24,
  staleAfterMs = 60_000,
  onAskAgent = null,
} = {}) {
  ensureStyles();
  const card = el('article', 'td-card');
  const head = el('div', 'td-card-head');
  const titleNode = el('h2', 'td-card-title', title || 'Metric');
  head.append(titleNode);
  let askBtn = null;
  if (typeof onAskAgent === 'function') {
    askBtn = el('button', 'td-btn', 'Ask agent');
    askBtn.type = 'button';
    askBtn.addEventListener('click', () => onAskAgent({ title, latest }));
    head.append(askBtn);
  }
  const row = el('div', 'td-metric-row');
  const valNode = el('span', 'td-metric-value', '—');
  const unitNode = el('span', 'td-metric-unit', unit);
  const deltaNode = el('span', 'td-delta');
  deltaNode.hidden = true;
  row.append(valNode, unitNode, deltaNode);

  const sparkSlot = el('div');
  const detailNode = el('div', 'td-subtitle');
  detailNode.hidden = true;
  const foot = el('div', 'td-card-foot');
  const ageNode = el('span', undefined, 'Waiting for data…');
  foot.append(ageNode);
  card.append(head, row, sparkSlot, detailNode, foot);
  container.append(card);

  let history = [];
  let latest = null;
  let fetchedAtMs = null;

  const refreshAge = () => {
    ageNode.textContent = formatAge(fetchedAtMs);
    card.dataset.stale = String(Boolean(fetchedAtMs && Date.now() - fetchedAtMs > staleAfterMs));
  };
  const ageTimer = setInterval(refreshAge, 5_000);

  return Object.freeze({
    element: card,
    update(next = {}) {
      latest = next;
      if (next.value !== undefined) {
        valNode.textContent = format(next.value);
        if (typeof next.value === 'number' && Number.isFinite(next.value) && !Array.isArray(next.history)) {
          history.push(next.value);
          if (history.length > historyLimit) history = history.slice(-historyLimit);
        }
      }
      if (Array.isArray(next.history)) history = next.history.slice(-historyLimit);
      if (next.delta) {
        deltaNode.textContent = next.delta;
        deltaNode.dataset.sign = String(next.delta).trim().startsWith('-') ? 'down' : 'up';
        deltaNode.hidden = false;
      } else {
        deltaNode.hidden = true;
      }
      if (next.detail) { detailNode.textContent = next.detail; detailNode.hidden = false; }
      else detailNode.hidden = true;
      if (next.tone) card.dataset.tone = next.tone;
      else delete card.dataset.tone;
      fetchedAtMs = next.fetchedAtMs ?? Date.now();
      sparkSlot.replaceChildren(renderSparklineSvg(history));
      refreshAge();
    },
    setError(message) {
      card.dataset.tone = 'alert';
      detailNode.textContent = String(message || 'Feed unavailable');
      detailNode.hidden = false;
    },
    close() { clearInterval(ageTimer); card.remove(); },
  });
}

/** Glanceable live list card (alerts, jobs, logs, sensors) with optional per-item "Ask agent". */
export function mountFeedListCard(container, {
  title = 'Live activity',
  emptyText = 'No items yet.',
  maxItems = 12,
  onAskAgent = null,
} = {}) {
  ensureStyles();
  const card = el('article', 'td-card');
  const head = el('div', 'td-card-head');
  head.append(el('h2', 'td-card-title', title));
  const list = el('ul', 'td-list');
  const empty = el('p', 'td-subtitle', emptyText);
  const foot = el('div', 'td-card-foot');
  const ageNode = el('span', undefined, 'Waiting for data…');
  foot.append(ageNode);
  card.append(head, list, empty, foot);
  container.append(card);

  return Object.freeze({
    element: card,
    update(items = [], { fetchedAtMs = Date.now() } = {}) {
      list.replaceChildren();
      const slice = items.slice(0, maxItems);
      empty.hidden = slice.length > 0;
      for (const item of slice) {
        const li = el('li', 'td-list-item');
        const body = el('div');
        if (item.badge) {
          const badge = el('span', 'td-badge', item.badge);
          if (item.tone) badge.dataset.tone = item.tone;
          body.append(badge, document.createTextNode(' '));
        }
        body.append(el('strong', undefined, item.title || String(item)));
        if (item.detail) body.append(el('div', 'td-subtitle', item.detail));
        li.append(body);
        if (typeof onAskAgent === 'function') {
          const ask = el('button', 'td-btn', 'Ask');
          ask.type = 'button';
          ask.addEventListener('click', () => onAskAgent(item));
          li.append(ask);
        }
        list.append(li);
      }
      ageNode.textContent = formatAge(fetchedAtMs);
    },
    close() { card.remove(); },
  });
}

/** 1-tap user-to-agent feedback & decision card (choice chips + optional note). */
export function mountFeedbackCard(container, {
  title = 'Quick feedback',
  prompt = 'Guide the agent',
  choices = ['Looks good', 'Investigate', 'Pause'],
  allowNote = true,
  submitLabel = 'Send feedback',
  onSubmit,
} = {}) {
  ensureStyles();
  const card = el('article', 'td-card');
  card.append(el('h2', 'td-card-title', title), el('p', 'td-subtitle', prompt));
  const chips = el('div', 'td-chips');
  let selected = null;
  let hasSelection = false;
  let submitting = false;
  const chipButtons = choices.map(choice => {
    const label = typeof choice === 'string' ? choice : choice.label;
    const value = typeof choice === 'string' ? choice : choice.value;
    const b = el('button', 'td-chip', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      if (submitting) return;
      selected = value;
      hasSelection = true;
      for (const other of chipButtons) other.setAttribute('aria-pressed', String(other === b));
      if (!allowNote && typeof onSubmit === 'function') void submit();
    });
    chips.append(b);
    return b;
  });
  card.append(chips);

  const note = el('textarea', 'td-note');
  note.placeholder = 'Optional note for the agent…';
  note.setAttribute('aria-label', 'Note for the agent');
  note.hidden = !allowNote;
  const foot = el('div', 'td-card-foot');
  const status = el('span');
  status.setAttribute('role', 'status');
  const send = el('button', 'td-btn primary', submitLabel);
  send.type = 'button';
  send.hidden = !allowNote;
  foot.append(status, send);
  card.append(note, foot);
  container.append(card);

  const submit = async () => {
    if (submitting) return;
    if (typeof onSubmit !== 'function') {
      status.textContent = 'Feedback is not connected.';
      return;
    }
    if (!hasSelection && !note.value.trim()) {
      status.textContent = 'Pick a choice or add a note first.';
      return;
    }
    submitting = true;
    send.disabled = true;
    note.disabled = true;
    for (const b of chipButtons) b.disabled = true;
    status.textContent = 'Sending…';
    try {
      await onSubmit({ choice: selected, note: note.value.trim() });
      note.value = '';
      selected = null;
      hasSelection = false;
      for (const b of chipButtons) b.setAttribute('aria-pressed', 'false');
      status.textContent = 'Feedback sent.';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Failed to send feedback.';
    } finally {
      submitting = false;
      send.disabled = false;
      note.disabled = false;
      for (const b of chipButtons) b.disabled = false;
    }
  };
  send.addEventListener('click', () => { void submit(); });

  return Object.freeze({
    element: card,
    close() { card.remove(); },
  });
}
