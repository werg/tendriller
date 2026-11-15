export const sourceKey = data => JSON.stringify([String(data?.source ?? 'source'), String(data?.run ?? 'machine')]);
export const sourceLabel = value => { const [source, run] = JSON.parse(value); return `${source} / ${run}`; };
const numeric = value => typeof value === 'number' && Number.isFinite(value);

/** A training step is meaningful only within its own source/run series. */
export function chartSeries(records, metric, selected = '') {
  const values = records.filter(record => (!selected || sourceKey(record.data) === selected)
    && numeric((record.data?.metrics || record.data || {})[metric]));
  const steps = values.every(record => numeric(record.data.step));
  const groups = new Map();
  for (const record of values) {
    const key = sourceKey(record.data);
    if (!groups.has(key)) groups.set(key, { key, label: sourceLabel(key), points: [] });
    groups.get(key).points.push({ x: steps ? record.data.step : record.ts, y: (record.data.metrics || record.data)[metric] });
  }
  return { axis: steps ? 'step' : 'time', groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
    .map(group => ({ ...group, points: group.points.sort((a, b) => a.x - b.x) })) };
}
