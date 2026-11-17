export const RELEASE_SOCKET_PROTOCOL = 'tendriller.releases.v1';
const digestPattern = /^[0-9a-f]{64}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = value => {
  if (typeof value !== 'string' || !digestPattern.test(value)) fail('invalid_release_digest', 'Expected a lowercase SHA-256 digest');
  return value;
};
const signed = value => value && typeof value === 'object' && value.payload?.profile === 'chronolog-release-v1' && typeof value.signature === 'string';
const response = (condition, value) => {
  if (!condition) fail('invalid_response', 'Invalid release transport response');
  return value;
};

/** Exact bytes and signed evidence only. Chronolog owns verification and publication authority. */
export function createReleaseClient({ request, raw, openWatch, initial }) {
  return Object.freeze({
    initial: initial === undefined ? null : structuredClone(initial),
    async state(options = {}) {
      const value = await request('peers/releases', { signal: options.signal });
      return response(value?.profile === 'chronolog-release-v1' && Array.isArray(value.policies) && Array.isArray(value.activations), value);
    },
    async configure(configuration, options = {}) {
      const value = await request('peers/releases/policy', { method: 'PUT', body: configuration, signal: options.signal });
      return response(signed(value), value);
    },
    async publish(manifest, options = {}) {
      const value = await request('peers/releases/manifests', { method: 'POST', body: manifest, signal: options.signal });
      return response(digestPattern.test(value?.id) && signed(value?.manifest), value);
    },
    async manifest(id, options = {}) {
      const value = await request(`peers/releases/manifests/${digest(id)}`, { signal: options.signal });
      return response(value === null || signed(value), value);
    },
    async activate(activation, options = {}) {
      const value = await request('peers/releases/activations', { method: 'POST', body: activation, signal: options.signal });
      return response(signed(value) && digestPattern.test(value.id), value);
    },
    content: Object.freeze({
      async put(id, bytes, options = {}) {
        digest(id);
        if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new TypeError('Release content requires exact bytes');
        const result = await raw(`peers/releases/content/${id}`, { method: 'PUT', body: bytes, signal: options.signal,
          headers: { 'Content-Type': options.mediaType || 'application/octet-stream' } });
        const value = await result.json();
        return response(value?.digest === id && value.bytes === bytes.byteLength, value);
      },
      async get(id, options = {}) {
        const result = await raw(`peers/releases/content/${digest(id)}`, { signal: options.signal });
        const reader = result.body?.getReader();
        if (!reader) return new Uint8Array();
        const chunks = []; let length = 0;
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break;
            length += next.value.byteLength;
            if (length > 32 * 1024 * 1024) fail('release_content_limit', 'Release content exceeds the transfer limit');
            chunks.push(next.value);
          }
        } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
      },
    }),
    /** Explicit durable selection hints. No polling, heartbeat, or automatic page reload. */
    watch(options = {}) { options.signal?.throwIfAborted(); return createReleaseWatch(openWatch(), options); },
  });
}

/** One coalesced current activation, independently verified by the portable release client. */
export function createReleaseWatch(socket, { signal } = {}) {
  let current, ended = false, error, waiting, reading = false;
  const finish = reason => {
    if (ended) return;
    ended = true; error = reason;
    signal?.removeEventListener('abort', abort);
    for (const [name, listener] of listeners) socket.removeEventListener(name, listener);
    waiting?.(); waiting = undefined;
  };
  const close = reason => {
    finish(reason);
    if (socket.readyState < 2) socket.close(reason ? 1008 : 1000, reason ? 'Release subscription ended' : 'Release subscription closed');
  };
  const abort = () => close(signal.reason || new DOMException('Aborted', 'AbortError'));
  const receive = event => {
    try {
      if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > 16 * 1024)
        fail('invalid_release_notice', 'Release notices must be bounded signed selections');
      const value = JSON.parse(event.data);
      if (!signed(value) || !digestPattern.test(value.id)) fail('invalid_release_notice', 'Expected a signed release activation');
      current = value; waiting?.(); waiting = undefined;
    } catch (reason) { close(reason); }
  };
  const listeners = [['message', receive], ['close', () => finish()], ['error', () => close(Object.assign(new Error('Release transport failed'), { code: 'release_transport_failed' }))]];
  for (const [name, listener] of listeners) socket.addEventListener(name, listener);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  else if (socket.readyState > 1) finish();
  return {
    async *[Symbol.asyncIterator]() {
      if (reading) fail('release_reader_exists', 'A release subscription has one reader');
      reading = true;
      try {
        while (true) {
          if (current !== undefined) { const value = current; current = undefined; yield value; continue; }
          if (ended) { if (error) throw error; return; }
          await new Promise(resolve => { waiting = resolve; });
        }
      } finally { close(); }
    },
  };
}
