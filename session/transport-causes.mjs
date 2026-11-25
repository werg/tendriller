// Transport diagnostics are observations, never evidence that a write was rejected.
// Keep this vocabulary closed: arbitrary codes can contain credentials or addresses.
const codes = new Set([
  'EAI_AGAIN', 'EAI_FAIL', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',
  'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EPIPE',
  'ERR_SOCKET_CLOSED', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
]);
const MAX_DEPTH = 6, MAX_NODES = 32, MAX_MEMBERS = 8, MAX_CODES = 12;
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');

/** A bounded code-only summary, also revalidated when it crosses owner IPC.
 * Never reads messages, stacks, URLs, addresses, headers, getters or iterators.
 * The fixed vocabulary and code count bound serialized output below 512 bytes. */
export function transportCauseSummary(error) {
  const found = new Set(), seen = new Set(), pending = [{ value: error, depth: 0 }];
  let truncated = false, visited = 0;
  const own = (value, key) => {
    if (!object(value)) return undefined;
    try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
    catch { return undefined; }
  };
  const add = code => {
    if (typeof code !== 'string' || !codes.has(code) || found.has(code)) return;
    if (found.size === MAX_CODES) { truncated = true; return; }
    found.add(code);
  };
  const arrayLength = value => {
    try {
      const length = Array.isArray(value) ? own(value, 'length') : undefined;
      return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : 0;
    }
    catch { return 0; }
  };
  const enqueue = (value, depth) => {
    if (!object(value) || seen.has(value)) return;
    if (depth > MAX_DEPTH || visited + pending.length >= MAX_NODES) { truncated = true; return; }
    pending.push({ value, depth });
  };
  while (pending.length) {
    const { value, depth } = pending.shift();
    if (!object(value) || seen.has(value)) continue;
    seen.add(value); visited++;
    add(own(value, 'code'));
    const summary = own(value, 'transportCauses'), retained = own(summary, 'codes');
    const retainedLength = arrayLength(retained);
    for (let index = 0; index < Math.min(retainedLength, MAX_CODES); index++) add(own(retained, String(index)));
    if (retainedLength > MAX_CODES || own(summary, 'truncated') === true) truncated = true;
    enqueue(own(value, 'cause'), depth + 1);
    const errors = own(value, 'errors'), length = arrayLength(errors);
    if (length > MAX_MEMBERS) truncated = true;
    for (let index = 0; index < Math.min(length, MAX_MEMBERS); index++) enqueue(own(errors, String(index)), depth + 1);
  }
  return found.size ? { codes: [...found].sort(), truncated } : undefined;
}
