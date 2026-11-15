// Common source envelopes; transport/storage policy stays with the collector.
import { randomUUID } from 'node:crypto';

export const MAX_LINE_BYTES = 32 * 1024;
const MAX_RECORD_BYTES = 48 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function recordFor(source, type, value, ts = Date.now()) {
  const data = { ...(object(value) ? value : { value }), source: source.id, run: source.run ?? null };
  const record = { id: randomUUID(), ts, type, data };
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw Error('record_too_large');
  return record;
}

export function lineRecord(source, line) {
  if (source.type === 'log' || source.format === 'log') return recordFor(source, 'log', { line });
  let parsed;
  try { parsed = JSON.parse(line); }
  catch { return recordFor(source, 'collector_error', { reason: 'invalid_json' }); }
  const ts = Number.isSafeInteger(parsed?.ts) && parsed.ts >= 0 ? parsed.ts : Date.now();
  const type = typeof parsed?.type === 'string' && parsed.type.length > 0 && parsed.type.length <= 80 ? parsed.type : 'metrics';
  return recordFor(source, type, object(parsed) && Object.hasOwn(parsed, 'data') ? parsed.data : parsed, ts);
}
