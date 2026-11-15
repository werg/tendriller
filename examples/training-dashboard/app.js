import { chartSeries, sourceKey, sourceLabel } from './model.mjs';
const t = window.tendril, $ = id => document.getElementById(id);
const machines = new Map(), records = [], logRows = [], runs = new Set(), metrics = new Set();
let follow = true, paint;
const element = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const number = value => typeof value === 'number' && Number.isFinite(value);
const format = value => number(value) ? value.toLocaleString(undefined, { maximumSignificantDigits: 4 }) : '—';
const gib = value => number(value) ? format(value / 2 ** 30) : '—';
const gpuFields = { utilization_percent: 'utilization', memory_used_bytes: 'used memory', memory_total_bytes: 'total memory', temperature_c: 'temperature' };
const unavailable = { not_available: 'not available (N/A)', not_supported: 'not supported', not_reported: 'not reported', invalid_value: 'invalid reading' };
const key = sourceKey;
function notice(text) { $('notice').hidden = false; $('notice').textContent = text; }
function connection() { $('connection').textContent = t.connected ? 'Connected' : 'Reconnecting'; $('connection').classList.toggle('live', t.connected); }
function schedule() {
  paint ||= window.tendrilSnippets.streamView.batch(render);
  paint.schedule();
}

function add(record) {
  const data = record.data || {};
  if (record.type === 'host') machines.set(data.source ?? record.producer, record);
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
    for (const [label, value] of [['CPU', `${format(m.cpu_percent)}%`], ['RAM', `${gib(m.memory_used_bytes)} / ${gib(m.memory_total_bytes)} GiB`]]) {
      const cell = element('div'); cell.append(element('div', value, 'value'), element('div', label, 'label')); stats.append(cell);
    }
    card.append(stats);
    for (const gpu of data.gpus || []) {
      card.append(element('p', `GPU ${gpu.index} · ${format(gpu.utilization_percent)}% · ${gib(gpu.memory_used_bytes)} / ${gib(gpu.memory_total_bytes)} GiB · ${format(gpu.temperature_c)} °C`, 'gpu'));
      const reasons = Object.entries(gpuFields).filter(([field]) => !number(gpu[field]) && gpu.unavailable?.[field])
        .map(([field, label]) => `${label}: ${unavailable[gpu.unavailable[field]] || 'unavailable'}`);
      if (reasons.length) card.append(element('p', `GPU ${gpu.index} ${reasons.join('; ')}.`, 'gpu muted'));
    }
    if (data.gpu_status === 'unavailable') card.append(element('p', 'GPU telemetry unavailable on this source.', 'gpu muted'));
    return card;
  });
  $('machines').replaceChildren(...cards);
}

let chart;
function draw() {
  const metric = $('metric').value, run = $('run').value;
  const { axis, groups } = chartSeries(records, metric, run);
  chart ||= window.tendrilSnippets.chart.mount('#chart', { title: 'Metric history', maxPoints: 2000, crosshair: true });
  const result = chart.update(groups.slice(0, 24).map(group => ({ id: group.key, label: group.label, points: group.points })), {
    title: metric, xLabel: axis === 'step' ? 'Step' : 'Time', yLabel: metric,
    xFormat: axis === 'step' ? format : value => new Date(value).toLocaleTimeString(), yFormat: format,
  });
  $('chart-summary').textContent = result.samples
    ? `${result.samples} samples across ${result.series} source/run series${groups.length > 24 ? ' · Showing the first 24 series; select a source for the rest.' : ''}`
    : 'No samples for this metric and source selection.';
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
    $('logs').replaceChildren(...logRows.filter(r => !run || String(r.data.run ?? 'machine') === selectedRun).map(record => {
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
