// Small statistics and table helpers for the benchmark report.

export function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q, lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function summarize(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { n: 0, median: null, p90: null, min: null, max: null };
  const round = value => Math.round(value * 10) / 10;
  return { n: finite.length, median: round(quantile(finite, 0.5)), p90: round(quantile(finite, 0.9)),
    min: round(Math.min(...finite)), max: round(Math.max(...finite)) };
}

/** Summaries for every numeric key present in any run. */
export function summarizeRuns(runs, keys) {
  const names = keys ?? [...new Set(runs.flatMap(run => Object.keys(run).filter(key => typeof run[key] === 'number')))];
  return Object.fromEntries(names.map(name => [name, summarize(runs.map(run => run[name]))]));
}

/** The run whose `key` is the median, used to pick a representative waterfall. */
export function medianRun(runs, key) {
  const ranked = runs.filter(run => Number.isFinite(run.metrics?.[key])).sort((a, b) => a.metrics[key] - b.metrics[key]);
  return ranked[Math.floor((ranked.length - 1) / 2)] ?? runs[0];
}

export function table(rows, columns) {
  const cells = rows.map(row => columns.map(column => {
    const value = row[column];
    return value === null || value === undefined ? '-' : typeof value === 'number' ? String(value) : String(value);
  }));
  const widths = columns.map((column, index) => Math.max(column.length, ...cells.map(row => row[index].length)));
  const line = values => values.map((value, index) => index === 0 ? value.padEnd(widths[index]) : value.padStart(widths[index])).join('  ');
  return [line(columns), widths.map(width => '-'.repeat(width)).join('  '), ...cells.map(line)].join('\n');
}

/** Parse a Server-Timing header into {name: dur}. */
export function parseServerTiming(header) {
  const out = {};
  for (const part of String(header ?? '').split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const dur = params.map(param => /^\s*dur=([\d.]+)/.exec(param)).find(Boolean);
    out[name.trim()] = dur ? Number(dur[1]) : null;
  }
  return out;
}

/** Aggregate host request log items per method+route. */
export function aggregateRoutes(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.method} ${item.route}${item.ws ? ' [ws]' : ''}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { endpoint: key, count: 0, ms: [], statuses: {}, serverTiming: {}, bytes: 0 });
    group.count++;
    if (Number.isFinite(item.ms)) group.ms.push(item.ms);
    group.statuses[item.status ?? 'none'] = (group.statuses[item.status ?? 'none'] ?? 0) + 1;
    if (Number.isFinite(item.bytes)) group.bytes += item.bytes;
    for (const [name, dur] of Object.entries(parseServerTiming(item.serverTiming)))
      if (Number.isFinite(dur)) (group.serverTiming[name] ??= []).push(dur);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).map(group => ({
    endpoint: group.endpoint, count: group.count, statuses: group.statuses, bytes: group.bytes,
    ms: summarize(group.ms),
    serverTiming: Object.fromEntries(Object.entries(group.serverTiming).map(([name, values]) => [name, summarize(values)])),
  }));
}
