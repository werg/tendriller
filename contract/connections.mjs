// Portable client SDK for Issue #136 outbound OAuth connections:
// - Tier A (`agent-held`): X25519-HKDF-AES256GCM unsealing using the agent's private wrapKey.
// - Tier B (`host-brokered`): client-side `K_conn` generation + `_tendril/connections` client.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64urlToBytes(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) {
    throw new TypeError('Expected even-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Generate a fresh 32-byte connection wrap key (`K_conn`) encoded as base64url. */
export function generateConnectionKey() {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Unseal a Tier A X25519-HKDF-AES256GCM sealed token envelope locally using the agent's
 * non-extractable X25519 private `CryptoKey` and public key hex.
 */
export async function unsealAgentTokens(wrapPrivateKey, wrapPublicKeyHex, envelope, aadContext) {
  const parsed = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (!parsed || parsed.v !== 1 || parsed.alg !== 'X25519-HKDF-A256GCM' ||
      typeof parsed.epk !== 'string' || typeof parsed.iv !== 'string' || typeof parsed.ct !== 'string') {
    throw new TypeError('Invalid Tier A sealed token envelope');
  }
  const epkBytes = hexToBytes(parsed.epk);
  const recipientPubBytes = hexToBytes(wrapPublicKeyHex);
  const epkKey = await crypto.subtle.importKey('raw', epkBytes, { name: 'X25519' }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'X25519', public: epkKey }, wrapPrivateKey, 256);
  const salt = new Uint8Array(64);
  salt.set(epkBytes, 0);
  salt.set(recipientPubBytes, 32);
  const aad = encoder.encode(`tendriller-agent-oauth-v1:${aadContext}`);
  const ikm = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: aad },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64urlToBytes(parsed.iv), additionalData: aad },
    aesKey,
    base64urlToBytes(parsed.ct),
  );
  return JSON.parse(decoder.decode(plain));
}

/**
 * Thin page-origin client for `_tendril/connections*`.
 * Never stores or receives raw third-party OAuth tokens; supplies `K_conn` only in the TLS header on invoke/rekey.
 */
export function createPageConnectionsClient(runtime, { fetch: fetcher = globalThis.fetch } = {}) {
  const base = runtime.identity.base;
  async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    const res = await fetcher(`${base}_tendril/${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Connection request failed (${res.status})`);
      err.status = res.status;
      err.code = data?.error?.code || 'connection_error';
      throw err;
    }
    return data;
  }

  return Object.freeze({
    list: ({ signal } = {}) => request('connections', { signal }),
    grant: ({ connectionId, actions, custody }, { signal } = {}) => request('connections/grant', {
      method: 'POST',
      body: { connection_id: connectionId, ...(actions ? { actions } : {}), ...(custody ? { custody } : {}) },
      signal,
    }),
    revoke: (connectionId, { signal } = {}) => request(`connections/${encodeURIComponent(connectionId)}`, {
      method: 'DELETE',
      signal,
    }),
    invoke: (connectionId, connectionKey, payload, { signal } = {}) => request(`connections/${encodeURIComponent(connectionId)}/invoke`, {
      method: 'POST',
      headers: { 'X-Connection-Key': connectionKey },
      body: payload,
      signal,
    }),
    rekey: (connectionId, oldKey, newKey, { signal } = {}) => request(`connections/${encodeURIComponent(connectionId)}/rekey`, {
      method: 'POST',
      body: { old_key: oldKey, new_key: newKey },
      signal,
    }),
  });
}

/**
 * Consume a zero-copy-paste `#tendril-connection=<base64url>` handoff fragment after a Tier B OAuth redirect.
 * Fragments are never sent to the host. Clears the fragment from `history` when `replaceState` is available.
 */
export function consumeConnectionCallbackFragment(loc = globalThis.location, hist = globalThis.history) {
  const hash = typeof loc?.hash === 'string' ? loc.hash : '';
  const match = /(?:^#|&)tendril-connection=([A-Za-z0-9_-]+)/u.exec(hash);
  if (!match) return null;
  try {
    const parsed = JSON.parse(decoder.decode(base64urlToBytes(match[1])));
    if (!parsed || typeof parsed !== 'object' || !parsed.connection) return null;
    if (hist && typeof hist.replaceState === 'function' && typeof loc?.pathname === 'string') {
      const cleaned = hash.replace(/(?:^#|&)tendril-connection=[A-Za-z0-9_-]+/u, '').replace(/^&/u, '#');
      hist.replaceState(null, '', `${loc.pathname}${loc.search ?? ''}${cleaned === '#' ? '' : cleaned}`);
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Listen for a Tier B OAuth completion `postMessage` from an authorization popup opened on `serviceOrigin`.
 * Strictly validates `event.origin === new URL(serviceOrigin).origin`. Returns an unsubscribe function.
 */
export function listenForConnectionPopup(serviceOrigin, onResult, target = globalThis) {
  const expectedOrigin = new URL(serviceOrigin).origin;
  const handler = event => {
    if (event.origin !== expectedOrigin) return;
    const data = event.data;
    if (!data || data.type !== 'tendriller:oauth-connection' || !data.connection) return;
    onResult({ connection: data.connection, connection_key: data.connection_key ?? null });
  };
  target.addEventListener('message', handler);
  return () => target.removeEventListener('message', handler);
}
