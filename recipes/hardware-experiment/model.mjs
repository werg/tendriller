export const MAX_RAW = 1200, MAX_SERIES = 300, MAX_NOTES = 50;
export function parseReading(line) {
  if (!String(line).trim()) return null;
  let value;
  try { const parsed = JSON.parse(String(line)); value = typeof parsed === "number" ? parsed : parsed?.value; }
  catch { value = Number(String(line).trim()); }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function createRun({ id, source, unit, session_id = "initial", now = Date.now() }) {
  return { id, source, unit, session_id, started_at: now, ended_at: null, count: 0, sum: 0, min: null, max: null, raw: [], series: [], interventions: [], discarded_raw: 0, discarded_series: 0 };
}
export function record(run, value, at = Date.now()) {
  if (!Number.isFinite(value)) return false;
  run.count++; run.sum += value;
  run.min = run.min === null ? value : Math.min(run.min, value); run.max = run.max === null ? value : Math.max(run.max, value);
  run.raw.push({ at, value }); if (run.raw.length > MAX_RAW) { run.raw.shift(); run.discarded_raw++; }
  const bucket = Math.floor(at / 1000) * 1000;
  let point = run.series.at(-1);
  if (!point || point.at !== bucket) {
    point = { at: bucket, count: 0, sum: 0, min: value, max: value, mean: value }; run.series.push(point);
    if (run.series.length > MAX_SERIES) { run.series.shift(); run.discarded_series++; }
  }
  point.count++; point.sum += value; point.min = Math.min(point.min, value); point.max = Math.max(point.max, value); point.mean = point.sum / point.count;
  return true;
}
export function annotate(run, text, at = Date.now()) {
  if (run.interventions.length >= MAX_NOTES) return null;
  const note = { id: `${run.id}-n${run.interventions.length}-${at}`, at, text: String(text).trim().slice(0, 2000) };
  if (!note.text) return null;
  run.interventions.push(note);
  return note;
}
export function snapshot(run) {
  return { id: run.id, source: run.source, unit: run.unit, session_id: run.session_id, started_at: run.started_at, ended_at: run.ended_at, count: run.count,
    min: run.min, max: run.max, mean: run.count ? run.sum / run.count : null,
    series: run.series.map(({ sum, ...point }) => ({ ...point })), interventions: run.interventions.map(note => ({ ...note })),
    retained_raw: run.raw.length, discarded_raw: run.discarded_raw, discarded_series: run.discarded_series };
}
export function csv(run) {
  return "timestamp_iso,value,source,unit\n" + run.raw.map(point =>
    [new Date(point.at).toISOString(), point.value, run.source, run.unit].map(v => '"' + String(v).replaceAll('"', '""') + '"').join(",")).join("\n") + "\n";
}
