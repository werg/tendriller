/** Host account checks select administrative actions; Chronolog signs and verifies every group decision. */
export function createMembersClient({ base, headers = () => ({}), fetch: fetcher = globalThis.fetch }) {
  const prefix = base.replace(/\/+$/, '') + '/members';
  async function call(path = '', { method = 'GET', body, signal, binary = false } = {}) {
    const response = await fetcher(prefix + path, { method, signal, cache: 'no-store',
      headers: { ...headers(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      let error;
      try { error = (await response.json()).error; } catch { /* Preserve the HTTP failure if the route failed before JSON. */ }
      throw Object.assign(new Error(error?.message || `Membership HTTP ${response.status}`), { code: error?.code || 'membership_http', status: response.status });
    }
    if (!binary) return response.json();
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Membership history response has no body');
    const chunks = []; let length = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        length += item.value.length;
        if (length > 2 * 1024 * 1024) throw new Error('Membership history exceeds its bounded response');
        chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  return Object.freeze({
    info: options => call('', options),
    configure: (configuration, options) => call('', { ...options, method: 'PUT', body: configuration }),
    sync: options => call('/sync', { ...options, method: 'POST' }),
    requestEnrollment: (signedRequest, options) => call('/requests', { ...options, method: 'POST', body: { signedRequest } }),
    requestStatus: (requestId, options) => call('/requests/' + encodeURIComponent(requestId), options),
    approve: (input, options) => call('/approve', { ...options, method: 'POST', body: input }),
    revoke: (input, options) => call('/revoke', { ...options, method: 'POST', body: input }),
    history: ({ after, limit = 128, signal }) => {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new TypeError('Invalid membership history range');
      return call(`/history?after=${after}&limit=${limit}`, { signal, binary: true });
    },
  });
}
