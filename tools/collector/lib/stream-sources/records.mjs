// Common source envelopes; transport/storage policy stays with the collector.
import { randomUUID } from 'node:crypto';
import { STREAM_RECORD_BYTES, STREAM_SNAPSHOT_RECORD_BYTES } from '@tendriller/core/contract';

export const MAX_LINE_BYTES = 32 * 1024;
export const MAX_INPUT_LINE_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = STREAM_RECORD_BYTES;
const MAX_FLATTEN_FIELDS = 1024, MAX_FLATTEN_DEPTH = 16;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const prototypeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const reserved = new Set([...prototypeKeys, 'source', 'run']);
const failure = code => Object.assign(Error(code), { code });
const recordErrors = new Set(['record_too_large', 'flatten_too_many_fields', 'flatten_too_deep']);
export const recordErrorReason = error => recordErrors.has(error?.code) ? error.code : 'record_too_large';

export function lineLimit(source) {
  const limit = source.max_line_bytes ?? MAX_LINE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > MAX_INPUT_LINE_BYTES)
    throw Error('max_line_bytes must be 1024–1048576 bytes.');
  return limit;
}

export function recordLimit(source) {
  const limit = source.max_record_bytes ?? MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > STREAM_SNAPSHOT_RECORD_BYTES)
    throw Error('max_record_bytes must be 1024–196608 bytes.');
  if (limit > MAX_RECORD_BYTES && source.durability !== 'durable')
    throw Error('max_record_bytes above 49152 requires a durable source.');
  return limit;
}

export function validateRecordOptions(source) {
  lineLimit(source);
  recordLimit(source);
  if (source.fields !== undefined) {
    if (!object(source.fields) || !Object.keys(source.fields).length || Object.keys(source.fields).length > 64)
      throw Error('fields must map 1–64 output names to arrays of literal path segments.');
    for (const [name, path] of Object.entries(source.fields)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name) || reserved.has(name))
        throw Error('fields output names must be safe identifiers and cannot replace source or run.');
      if (!Array.isArray(path) || !path.length || path.length > 16 || path.some(segment =>
        !(typeof segment === 'string' && segment.length > 0 && segment.length <= 200 && !prototypeKeys.has(segment))
        && !(Number.isSafeInteger(segment) && segment >= 0)))
        throw Error('Each fields path needs 1–16 string keys or nonnegative integer array indexes.');
    }
  }
  if (source.flatten !== undefined) {
    if (!object(source.flatten) || Object.keys(source.flatten).some(key => !['max_fields', 'numeric_only'].includes(key)))
      throw Error('flatten must be an object containing max_fields and optionally numeric_only.');
    if (!Number.isSafeInteger(source.flatten.max_fields) || source.flatten.max_fields < 1 || source.flatten.max_fields > MAX_FLATTEN_FIELDS)
      throw Error('flatten.max_fields must be an explicit integer from 1 to 1024.');
    if (source.flatten.numeric_only !== undefined && typeof source.flatten.numeric_only !== 'boolean')
      throw Error('flatten.numeric_only must be a boolean.');
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

function flatten(value, options) {
  if (options === undefined) return value;
  const result = Object.create(null);
  let count = 0;
  const escape = key => {
    const escaped = key.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
    return prototypeKeys.has(key) ? '\\' + escaped : escaped;
  };
  const visit = (selected, path) => {
    if (path.length > MAX_FLATTEN_DEPTH) throw failure('flatten_too_deep');
    if (selected !== null && typeof selected === 'object') {
      for (const key of Object.keys(selected).sort()) {
        // Identity belongs to the original payload, outside field transforms.
        if (!path.length && (key === 'source' || key === 'run')) continue;
        visit(selected[key], [...path, escape(key)]);
      }
      return;
    }
    if (options.numeric_only && !(typeof selected === 'number' && Number.isFinite(selected))) return;
    if (++count > options.max_fields) throw failure('flatten_too_many_fields');
    result[path.length ? path.join('.') : 'value'] = selected;
  };
  visit(value, []);
  return result;
}

export function recordFor(source, type, value, ts = Date.now()) {
  // Input metadata identifies the observation, not necessarily this collector.
  // Preserve it before projection so selecting metrics cannot merge distinct runs.
  const identity = { source: object(value) && Object.hasOwn(value, 'source') ? value.source : source.id };
  // Preserve explicit null, but do not inject a meaningless run:null into every observation.
  if (object(value) && Object.hasOwn(value, 'run')) identity.run = value.run;
  else if (source.run !== undefined) identity.run = source.run;
  value = flatten(project(value, source.fields), source.flatten);
  const data = { ...(object(value) ? value : { value }), ...identity };
  const record = { id: randomUUID(), ts, type, data };
  if (Buffer.byteLength(JSON.stringify(record)) > recordLimit(source)) throw failure('record_too_large');
  return record;
}

export function errorRecord(source, reason, extra = {}) {
  // Locally generated diagnostics retain their reason even with field selection.
  return recordFor({ ...source, fields: undefined, flatten: undefined, max_record_bytes: undefined }, 'collector_error', { reason, ...extra });
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
    catch (error) { const reason = recordErrorReason(error); report(reason); return errorRecord(source, reason); }
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
