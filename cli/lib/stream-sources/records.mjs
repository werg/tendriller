// Common source envelopes; transport/storage policy stays with the collector.
import { randomUUID } from 'node:crypto';

export const MAX_LINE_BYTES = 32 * 1024;
export const MAX_INPUT_LINE_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 48 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const reserved = new Set(['__proto__', 'constructor', 'prototype', 'source', 'run']);

export function lineLimit(source) {
  const limit = source.max_line_bytes ?? MAX_LINE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > MAX_INPUT_LINE_BYTES)
    throw Error('max_line_bytes must be 1024–1048576 bytes.');
  return limit;
}

export function validateRecordOptions(source) {
  lineLimit(source);
  if (source.fields === undefined) return;
  if (!object(source.fields) || !Object.keys(source.fields).length || Object.keys(source.fields).length > 64)
    throw Error('fields must map 1–64 output names to arrays of literal path segments.');
  for (const [name, path] of Object.entries(source.fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name) || reserved.has(name))
      throw Error('fields output names must be safe identifiers and cannot replace source or run.');
    if (!Array.isArray(path) || !path.length || path.length > 16 || path.some(segment =>
      !(typeof segment === 'string' && segment.length > 0 && segment.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(segment))
      && !(Number.isSafeInteger(segment) && segment >= 0)))
      throw Error('Each fields path needs 1–16 string keys or nonnegative integer array indexes.');
  }
}

function project(value, fields) {
  if (fields === undefined) return value;
  const result = {};
  for (const [name, path] of Object.entries(fields)) {
    let selected = value, found = true;
    for (const key of path) {
      if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) { found = false; break; }
      selected = selected[key];
    }
    if (found) result[name] = selected;
  }
  return result;
}

export function recordFor(source, type, value, ts = Date.now()) {
  value = project(value, source.fields);
  const data = { ...(object(value) ? value : { value }), source: source.id, run: source.run ?? null };
  const record = { id: randomUUID(), ts, type, data };
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw Error('record_too_large');
  return record;
}

export function errorRecord(source, reason, extra = {}) {
  // Locally generated diagnostics retain their reason even with field selection.
  return recordFor({ ...source, fields: undefined }, 'collector_error', { reason, ...extra });
}

export function lineRecord(source, line) {
  if (source.type === 'log' || source.format === 'log') return recordFor(source, 'log', { line });
  let parsed;
  try { parsed = JSON.parse(line); }
  catch { return errorRecord(source, 'invalid_json'); }
  const ts = Number.isSafeInteger(parsed?.ts) && parsed.ts >= 0 ? parsed.ts : Date.now();
  const type = typeof parsed?.type === 'string' && parsed.type.length > 0 && parsed.type.length <= 80 ? parsed.type : 'metrics';
  return recordFor(source, type, object(parsed) && Object.hasOwn(parsed, 'data') ? parsed.data : parsed, ts);
}

/** Bounded byte decoding shared by command stdout and SSH. Never split UTF-8. */
export function createLineDecoder(source, report = () => {}) {
  const limit = lineLimit(source);
  let buffered = Buffer.alloc(0), discarding = false;
  const decode = bytes => {
    const text = bytes.toString('utf8').replace(/\r$/, '');
    if (!text.trim()) return null;
    try { return lineRecord(source, text); }
    catch { report('record_too_large'); return errorRecord(source, 'record_too_large'); }
  };
  return {
    *push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline;
        const segment = bytes.subarray(start, end);
        if (!discarding && buffered.length + segment.length > limit) {
          buffered = Buffer.alloc(0); discarding = true; report('line_too_large');
        }
        if (!discarding && segment.length) buffered = buffered.length ? Buffer.concat([buffered, segment]) : Buffer.from(segment);
        if (newline < 0) break;
        if (!discarding) { const record = decode(buffered); if (record) yield record; }
        buffered = Buffer.alloc(0); discarding = false; start = newline + 1;
      }
    },
    // A completed local command may emit one JSON document without a newline.
    // A broken SSH session must discard its uncommitted partial line instead.
    *finish() {
      if (!discarding && buffered.length) { const record = decode(buffered); if (record) yield record; }
      buffered = Buffer.alloc(0); discarding = false;
    },
  };
}
