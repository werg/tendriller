/** Account login and device authority remain separate: these requests never grant access by themselves. */
export const DEVICE_PAIRING_DOMAIN = 'tendriller-device-pairing-v1';
export const DEVICE_PAIRING_LIMITS = Object.freeze({ lifetimeMs: 10 * 60_000, pendingPerAccount: 20,
  retainedPerApplication: 1024, invalidProofs: 5, challengesPerMinute: 10, requestBytes: 4096, commitBytes: 512 * 1024 });
const hex = /^[0-9a-f]{64}$/;
const isHex = value => typeof value === 'string' && hex.test(value);
const fail = message => Object.assign(new Error(message), { code: 'invalid_pairing' });
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const origin = value => {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.origin === value && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); }
  catch { return false; }
};
export function validateDevicePairingChallenge(value) {
  if (!fields(value, ['version', 'domain', 'pairingId', 'requestId', 'serviceOrigin', 'pageOrigin', 'applicationId',
    'accountId', 'publicKey', 'rights', 'expectedGeneration', 'controlRevision', 'nonce', 'expiresAt']) ||
    value.version !== 1 || value.domain !== DEVICE_PAIRING_DOMAIN || !isHex(value.pairingId) ||
    typeof value.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.requestId) ||
    !origin(value.serviceOrigin) || !origin(value.pageOrigin) || !isHex(value.applicationId) ||
    typeof value.accountId !== 'string' || !value.accountId.length || value.accountId.length > 200 ||
    !isHex(value.publicKey) || !fields(value.rights, ['reader', 'writer']) || value.rights.reader !== true ||
    typeof value.rights.writer !== 'boolean' || !isHex(value.expectedGeneration) ||
    !Number.isSafeInteger(value.controlRevision) || value.controlRevision < 0 || !isHex(value.nonce) ||
    !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) throw fail('Invalid bounded device pairing challenge');
  return Object.freeze({ ...value, rights: Object.freeze({ ...value.rights }) });
}

/** Fixed-position, domain-separated UTF-8 bytes; JSON object insertion order is never signed. */
export function pairingProofBytes(input) {
  const c = validateDevicePairingChallenge(input);
  return new TextEncoder().encode(JSON.stringify([c.domain, c.version, c.pairingId, c.requestId, c.serviceOrigin,
    c.pageOrigin, c.applicationId, c.accountId, c.publicKey, c.rights.reader, c.rights.writer,
    c.expectedGeneration, c.controlRevision, c.nonce, c.expiresAt]));
}
const toHex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const fromHex = value => Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
/** Accept the public Chronolog PeerIdentity without exporting or copying its private key. */
export async function signDevicePairingChallenge(challenge, identity) {
  const bytes = pairingProofBytes(challenge);
  if (identity?.publicKey !== challenge.publicKey || !identity.privateKey) throw fail('The retained device must match the challenged public key');
  return toHex(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.privateKey, bytes)));
}
export async function verifyDevicePairingProof(challenge, signature) {
  const bytes = pairingProofBytes(challenge);
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', fromHex(challenge.publicKey), 'Ed25519', false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, fromHex(signature), bytes);
}

/** The caller persists requestId/device and any signed transition before invoking these methods. */
export function createDevicePairingClient({ url, fetch: transport = globalThis.fetch, headers = {} }) {
  const endpoint = new URL(url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !origin(endpoint.origin)) throw fail('Use one exact pairing endpoint');
  async function call(body, pairingId, { signal } = {}) {
    const target = new URL(endpoint);
    if (pairingId !== undefined) {
      if (!isHex(pairingId)) throw fail('Invalid pairing identity');
      target.searchParams.set('pairingId', pairingId);
    }
    const requestHeaders = new Headers(headers);
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    const response = await transport(target.href, { method: body === undefined ? 'GET' : 'POST', headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal });
    let value;
    try { value = await response.json(); }
    catch { throw Object.assign(new Error('Pairing response could not be read; inspect the retained request before retrying'), { code: 'pairing_response_unavailable', status: response.status }); }
    if (!response.ok) throw Object.assign(new Error(value.message || value.error?.message || 'Pairing request was refused'),
      { code: typeof value.error === 'string' ? value.error : value.code || value.error?.code || 'pairing_failed', status: response.status, detail: value });
    return value;
  }
  return Object.freeze({
    async challenge(input, options) {
      const result = await call({ action: 'challenge', ...input }, undefined, options);
      const challenge = validateDevicePairingChallenge(result.challenge);
      if (challenge.pageOrigin !== endpoint.origin || challenge.requestId !== input.requestId || challenge.publicKey !== input.publicKey ||
        challenge.rights.reader !== input.rights?.reader || challenge.rights.writer !== input.rights?.writer || result.pairingId !== challenge.pairingId)
        throw fail('The returned challenge does not match this page and retained request');
      return { ...result, challenge };
    },
    prove: (pairingId, signature, options) => call({ action: 'prove', pairingId, signature }, undefined, options),
    inspect: (pairingId, options) => call(undefined, pairingId, options),
    pending: options => call(undefined, undefined, options),
    prepare: (pairingId, prepared, options) => call({ action: 'prepare', pairingId, request: prepared.request, control: prepared.control }, undefined, options),
    commit: (pairingId, prepared, options) => call({ action: 'commit', pairingId, request: prepared.request, control: prepared.control }, undefined, options),
  });
}
