import { chartSeries, sourceKey, sourceLabel } from './model.mjs';
const t = window.tendril, $ = id => document.getElementById(id);
const machines = new Map(), records = [], logRows = [], runs = new Set(), metrics = new Set();
let follow = true, scheduled = false;
const element = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const number = value => typeof value === 'number' && Number.isFinite(value);
const format = value => number(value) ? value.toLocaleString(undefined, { maximumSignificantDigits: 4 }) : '—';
const key = sourceKey;
function notice(text) { $('notice').hidden = false; $('notice').textContent = text; }
function connection() { $('connection').textContent = t.connected ? 'Connected' : 'Reconnecting'; $('connection').classList.toggle('live', t.connected); }
function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; render(); }); } }

function add(record) {
  const data = record.data || {};
  if (record.type === 'host') machines.set(data.source || record.producer, record);
  else if (record.type === 'log') {
    logRows.push(record); if (logRows.length > 200) logRows.shift();
  } else if (record.type === 'collector_error') notice(`${data.source}: ${data.reason}. Check the collector’s input format and status.`);
  else {
    records.push(record); if (records.length > 2000) records.shift();
  }
  schedule();
}

function options(id, values, fallback) {
  const select = $(id), chosen = select.value;
  const names = [...values].sort();
  if ([...select.options].map(o => o.value).join('\n') === [...(fallback ? [''] : []), ...names].join('\n')) return;
  select.replaceChildren(...(fallback ? [new Option(fallback, '')] : []), ...names.map(value => new Option(id === 'run' ? sourceLabel(value) : value, value)));
  select.value = [...select.options].some(o => o.value === chosen) ? chosen : names.includes('loss') ? 'loss' : select.options[0]?.value || '';
}

function renderMachines() {
  if (!machines.size) return;
  const cards = [...machines.values()].map(record => {
    // A freshly uploaded buffered sample can still describe an old machine state.
    const data = record.data, age = Math.max(0, Math.floor((Date.now() - Math.min(record.ts, record.received_at)) / 1000));
    const card = element('article', undefined, 'card'), title = element('div', undefined, 'machine-title');
    title.append(element('span', data.host || data.source), element('span', age > 15 ? `${age}s old` : 'Live', age > 15 ? 'stale' : 'muted'));
    card.append(title, element('p', data.source, 'muted'));
    const stats = element('div', undefined, 'stats'), m = data.metrics || {};
    for (const [label, value] of [['CPU', `${format(m.cpu_percent)}%`], ['RAM', `${format(m.memory_used_bytes / 2 ** 30)} / ${format(m.memory_total_bytes / 2 ** 30)} GiB`]]) {
      const cell = element('div'); cell.append(element('div', value, 'value'), element('div', label, 'label')); stats.append(cell);
    }
    card.append(stats);
    for (const gpu of data.gpus || []) card.append(element('p', `GPU ${gpu.index} · ${format(gpu.utilization_percent)}% · ${format(gpu.memory_used_bytes / 2 ** 30)} / ${format(gpu.memory_total_bytes / 2 ** 30)} GiB · ${format(gpu.temperature_c)} °C`, 'gpu'));
    if (data.gpu_status === 'unavailable') card.append(element('p', 'GPU telemetry unavailable on this source.', 'gpu muted'));
    return card;
  });
  $('machines').replaceChildren(...cards);
}

function draw() {
  const svg = $('chart'), metric = $('metric').value, run = $('run').value;
  const { axis, groups } = chartSeries(records, metric, run), points = groups.flatMap(group => group.points);
  svg.replaceChildren();
  $('chart-legend').replaceChildren();
  const node = (tag, attrs, text) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [name, value] of Object.entries(attrs)) n.setAttribute(name, value); if (text !== undefined) n.textContent = text; svg.append(n); return n; };
  if (!points.length) {
    node('text', { x: 450, y: 140, 'text-anchor': 'middle' }, 'Waiting for metric samples');
    $('chart-summary').textContent = 'No samples for this metric and source selection.';
    svg.setAttribute('aria-label', 'No matching metric samples'); return;
  }
  const xs = points.map(p => p.x), ys = points.map(p => p.y), lo = Math.min(...ys), hi = Math.max(...ys), minX = Math.min(...xs), maxX = Math.max(...xs);
  const pad = hi === lo ? Math.abs(lo) * 0.05 || 1 : 0, yMin = lo - pad, yMax = hi + pad;
  const x = value => 72 + (value - minX) / (maxX - minX || 1) * 804, y = value => 236 - (value - yMin) / (yMax - yMin) * 212;
  for (let i = 0; i < 5; i++) {
    const value = yMin + (yMax - yMin) * i / 4, height = y(value);
    node('line', { x1: 72, y1: height, x2: 876, y2: height, class: 'grid' });
    node('text', { x: 62, y: height + 4, 'text-anchor': 'end' }, format(value));
  }
  const palette = matchMedia('(prefers-color-scheme:light)').matches
    ? ['#087c55', '#2768c5', '#b1551a', '#8145ba', '#b12e69'] : ['#84e4b7', '#7ec8ff', '#ffb480', '#c6a6ff', '#f998bb'];
  groups.forEach((group, i) => {
    const color = palette[i % palette.length];
    const path = node('path', { d: group.points.map((p, j) => `${j ? 'L' : 'M'}${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`).join(' '), class: 'series' });
    path.style.stroke = color;
    if (group.points.length === 1) node('circle', { cx: x(group.points[0].x), cy: y(group.points[0].y), r: 4, fill: color });
    const label = element('span', `● ${group.label}: ${format(group.points.at(-1).y)}`); label.style.color = color;
    $('chart-legend').append(label);
  });
  const tick = value => axis === 'step' ? `Step ${format(value)}` : new Date(value).toLocaleTimeString();
  node('text', { x: 72, y: 266 }, tick(minX)); node('text', { x: 876, y: 266, 'text-anchor': 'end' }, tick(maxX));
  const summary = `${metric} · ${points.length} samples across ${groups.length} source/run series · min ${format(lo)} · max ${format(hi)}`;
  svg.setAttribute('aria-label', summary); $('chart-summary').textContent = summary;
}

function render() {
  // Bound selector metadata by the same window as the chart records.
  runs.clear(); metrics.clear();
  for (const record of records) {
    runs.add(key(record.data));
    for (const [name, value] of Object.entries(record.data.metrics || record.data))
      if (number(value) && !['step', 'ts', 'timestamp', 'epoch'].includes(name)) metrics.add(name);
  }
  options('run', runs, 'All sources'); if (metrics.size) options('metric', metrics);
  renderMachines(); draw();
  if (logRows.length) {
    const run = $('run').value, selectedRun = run ? JSON.parse(run)[1] : null;
    $('logs').replaceChildren(...logRows.filter(r => !run || (r.data.run || 'machine') === selectedRun).map(record => {
      const row = element('p', undefined, 'logline');
      row.append(element('time', new Date(record.ts).toLocaleTimeString() + ' '), element('span', `[${record.data.source}] ${record.data.line ?? ''}`));
      return row;
    }));
    if (follow) $('logs').scrollTop = $('logs').scrollHeight;
  }
}

const streamNames = ['machine.utilization', 'training.metrics', 'training.logs'], subscribed = new Set();
let initializing = false, retryInitialization = false, initializationError = null;
async function initializeStreams() {
  if (subscribed.size === streamNames.length) return;
  // A recovery may arrive before an earlier discovery request has failed.
  // Remember it, but keep at most one request in flight.
  if (initializing) { retryInitialization = true; return; }
  initializing = true;
  try {
    const { streams } = await t.streams.list();
    if (initializationError && $('notice').textContent === initializationError) $('notice').hidden = true;
    initializationError = null;
    for (const name of streamNames) {
      if (subscribed.has(name)) continue;
      const stream = streams.find(item => item.name === name);
      if (!stream) { notice(`Stream ${name} is not configured yet. Run the dashboard setup script.`); continue; }
      t.streams.subscribe(name, add, {
        ...(stream.durability === 'durable' ? { after: 0 } : {}),
        onGap(history) { notice(`${name}: history before sequence ${history.missing_through + 1} is no longer available.`); },
        onError(error) { notice(`${name}: ${error.message || 'stream unavailable'}`); },
      });
      subscribed.add(name);
    }
  } catch (error) {
    initializationError = error.message || 'Could not load stream configuration.';
    notice(initializationError);
  } finally {
    initializing = false;
    if (retryInitialization) { retryInitialization = false; void initializeStreams(); }
  }
}

$('run').addEventListener('change', schedule); $('metric').addEventListener('change', schedule);
$('follow').addEventListener('click', () => { follow = !follow; $('follow').textContent = follow ? 'Following' : 'Paused scrolling'; $('follow').setAttribute('aria-pressed', String(follow)); schedule(); });
t.on('connect', () => { connection(); void initializeStreams(); }); t.on('disconnect', connection); connection();
setInterval(renderMachines, 1000);
void initializeStreams();
