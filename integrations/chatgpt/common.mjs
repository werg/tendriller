import { createHash } from 'node:crypto';

export class IntegrationError extends Error {
  constructor(code, message, { status = 400, rpcCode = -32602, data } = {}) {
    super(message); this.name = 'IntegrationError';
    Object.assign(this, { code, status, rpcCode, data });
  }
}
export function fail(code, message, options) { throw new IntegrationError(code, message, options); }
export function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException('Request cancelled', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}
export function object(value, label = 'value') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail('INVALID_INPUT', `${label} must be an object`);
  return value;
}
export function fields(value, allowed, required = []) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
    fail('INVALID_INPUT', 'Missing required fields or unknown fields');
  return value;
}
export function text(value, label, max = 512) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f]/u.test(value))
    fail('INVALID_INPUT', `${label} must be a bounded nonempty string`);
  return value;
}
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  object(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function bounded(value, bytes = 65536) {
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized) > bytes) fail('RESULT_TOO_LARGE', 'Result exceeds the configured byte limit');
  return JSON.parse(serialized);
}
export function requireScope(principal, scope) {
  if (!principal || !Array.isArray(principal.scopes) || !principal.scopes.includes(scope))
    fail('INSUFFICIENT_SCOPE', `Required scope: ${scope}`, { status: 403, rpcCode: -32003 });
}
export const SCOPES = Object.freeze(['tendrils:list', 'tendrils:create', 'applications:read', 'applications:write', 'events:subscribe', 'pages:publish']);

// The protocol surface uses this deliberately small schema subset. Declared
// application inputs are additionally validated by the real native session.
export function validateArguments(schema, value, path = 'arguments') {
  if (schema.enum && !schema.enum.some(item => canonical(item) === canonical(value))) fail('INVALID_INPUT', `${path} is not an allowed value`);
  if (schema.type === 'object') {
    object(value, path);
    if (schema.additionalProperties === false) fields(value, Object.keys(schema.properties ?? {}), schema.required ?? []);
    else if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT', `${path} is missing required fields`);
    for (const [key, item] of Object.entries(value)) if (schema.properties?.[key]) validateArguments(schema.properties[key], item, `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || schema.maxItems !== undefined && value.length > schema.maxItems) fail('INVALID_INPUT', `${path} must be a bounded array`);
    for (const item of value) validateArguments(schema.items ?? {}, item, path);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 65536)) fail('INVALID_INPUT', `${path} must be a bounded string`);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? Number.MIN_SAFE_INTEGER) || value > (schema.maximum ?? Number.MAX_SAFE_INTEGER)) fail('INVALID_INPUT', `${path} must be a bounded integer`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean' || schema.type === 'null' && value !== null)
    fail('INVALID_INPUT', `${path} has the wrong type`);
}
