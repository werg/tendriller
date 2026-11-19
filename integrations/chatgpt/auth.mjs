import { createPublicKey, constants, verify } from 'node:crypto';

const SUPPORTED_ALGORITHMS = new Set(['RS256', 'ES256', 'EdDSA']);
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

export class OAuthError extends Error {
  constructor(code, message, { status = 401, challenge } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
    if (challenge) this.challenge = challenge;
  }
}

function httpsUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${label} must be an absolute HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError(`${label} must be an HTTPS URL without credentials or fragment`);
  }
  return url;
}

function decodeUrl(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new OAuthError('invalid_token', 'Malformed token encoding');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new OAuthError('invalid_token', 'Non-canonical token encoding');
  return bytes;
}

// JSON.parse alone silently accepts repeated security-sensitive members. Scan
// bounded JSON first, including escaped names and nested objects, then parse it.
function uniqueJson(text) {
  let offset = 0;
  const space = () => { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++; };
  function string() {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') { offset += 2; continue; }
      if (text[offset++] === '"') return JSON.parse(text.slice(start, offset));
    }
    throw new Error('Unterminated string');
  }
  function value(depth = 0) {
    if (depth > 32) throw new Error('JSON is too deeply nested');
    space();
    if (text[offset] === '"') { string(); return; }
    if (text[offset] === '{') {
      offset++; space();
      const keys = new Set();
      if (text[offset] === '}') { offset++; return; }
      while (true) {
        space();
        if (text[offset] !== '"') throw new Error('Expected member');
        const key = string();
        if (keys.has(key)) throw new Error('Duplicate member');
        keys.add(key); space();
        if (text[offset++] !== ':') throw new Error('Expected colon');
        value(depth + 1); space();
        const next = text[offset++];
        if (next === '}') return;
        if (next !== ',') throw new Error('Expected comma');
      }
    }
    if (text[offset] === '[') {
      offset++; space();
      if (text[offset] === ']') { offset++; return; }
      while (true) {
        value(depth + 1); space();
        const next = text[offset++];
        if (next === ']') return;
        if (next !== ',') throw new Error('Expected comma');
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(offset));
    if (!match) throw new Error('Invalid JSON value');
    offset += match[0].length;
  }
  value(); space();
  if (offset !== text.length) throw new Error('Trailing JSON');
  const parsed = JSON.parse(text);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Expected JSON object');
  return parsed;
}

function parsePart(part) {
  try {
    const bytes = decodeUrl(part);
    return uniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new OAuthError('invalid_token', 'Malformed token JSON'); }
}

function scopes(value, label) {
  if (!Array.isArray(value) || value.some(scope => typeof scope !== 'string' || !SCOPE.test(scope))) {
    throw new TypeError(`${label} must be an array of OAuth scope names`);
  }
  return [...new Set(value)].sort();
}

export function requireScopes(principal, required) {
  const wanted = scopes(required, 'Required scopes');
  const available = new Set(principal?.scopes ?? []);
  if (wanted.some(scope => !available.has(scope))) {
    throw new OAuthError('insufficient_scope', 'The linked account has not granted the required scopes', { status: 403 });
  }
  return principal;
}

function header(request, name) {
  if (Array.isArray(request?.rawHeaders) && request.rawHeaders.filter((value, index) => index % 2 === 0 && String(value).toLowerCase() === name).length > 1) return null;
  if (typeof request?.headers?.get === 'function') return request.headers.get(name);
  const entries = Object.entries(request?.headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  return entries.length === 1 && typeof entries[0][1] === 'string' ? entries[0][1] : null;
}

async function boundedBody(response, limit) {
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && Number(declared) > limit) throw new Error('JWKS response too large');
  if (!response.body?.getReader) throw new Error('Expected a streaming JWKS response');
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('JWKS response too large');
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
}

function verificationKeys(jwks, algorithms) {
  if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 128) throw new Error('Invalid JWKS key count');
  const keys = new Map();
  const identifiers = new Set();
  for (const jwk of jwks.keys) {
    if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) throw new Error('Invalid JWK');
    if (typeof jwk.kid !== 'string' || !jwk.kid || jwk.kid.length > 256) throw new Error('JWK requires a bounded kid');
    if (identifiers.has(jwk.kid)) throw new Error('Duplicate JWK identifier');
    identifiers.add(jwk.kid);
    if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some(key => Object.hasOwn(jwk, key))) throw new Error('JWKS contains private key material');
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify')) continue;
    let algorithm;
    if (jwk.kty === 'RSA') algorithm = 'RS256';
    if (jwk.kty === 'EC' && jwk.crv === 'P-256') algorithm = 'ES256';
    if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') algorithm = 'EdDSA';
    if (!algorithm || !algorithms.has(algorithm) || (jwk.alg !== undefined && jwk.alg !== algorithm)) continue;
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (algorithm === 'RS256' && key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('RSA keys require at least 2048 bits');
    keys.set(jwk.kid, { key, algorithm });
  }
  if (!keys.size) throw new Error('JWKS contains no supported verification keys');
  return keys;
}

/** Verify an external OAuth provider's JWT access tokens; never mint peer grants. */
export function createOAuthVerifier({
  issuer, resource, audience = resource, jwksUri,
  metadataUrl, scopesSupported = [],
  algorithms = ['RS256', 'ES256', 'EdDSA'],
  fetch: fetcher = globalThis.fetch, clock = Date.now,
  cacheTtlMs = 300_000, minRefreshIntervalMs = 5_000,
  clockToleranceSeconds = 0, requestTimeoutMs = 5_000,
} = {}) {
  const resourceUrl = httpsUrl(resource, 'Resource');
  httpsUrl(issuer, 'Issuer');
  httpsUrl(jwksUri, 'JWKS URI');
  if (typeof audience !== 'string' || !audience) throw new TypeError('Audience must be a nonempty string');
  if (!Array.isArray(algorithms) || !algorithms.length || algorithms.some(alg => !SUPPORTED_ALGORITHMS.has(alg))) throw new TypeError('Unsupported JWT algorithm');
  for (const [name, value, maximum] of [
    ['cacheTtlMs', cacheTtlMs, 3_600_000], ['minRefreshIntervalMs', minRefreshIntervalMs, 60_000],
    ['clockToleranceSeconds', clockToleranceSeconds, 120], ['requestTimeoutMs', requestTimeoutMs, 30_000],
  ]) if (!Number.isSafeInteger(value) || value < 0 || value > maximum || (name === 'requestTimeoutMs' && value === 0)) throw new TypeError(`Invalid ${name}`);
  if (typeof fetcher !== 'function' || typeof clock !== 'function') throw new TypeError('fetch and clock must be functions');
  const supportedScopes = scopes(scopesSupported, 'Supported scopes');
  const discoveryUrl = httpsUrl(metadataUrl ?? new URL('/.well-known/oauth-protected-resource', resourceUrl).href, 'Protected-resource metadata URL').href;
  const allowedAlgorithms = new Set(algorithms);
  const metadata = Object.freeze({
    resource,
    authorization_servers: Object.freeze([issuer]),
    scopes_supported: Object.freeze(supportedScopes),
    bearer_methods_supported: Object.freeze(['header']),
  });
  let keys = new Map();
  let fetchedAt = -Infinity;
  let attemptedAt = -Infinity;
  let inflight;

  function challenge(required = [], error) {
    let result = `Bearer resource_metadata="${discoveryUrl}"`;
    if (required.length) result += `, scope="${scopes(required, 'Required scopes').join(' ')}"`;
    if (error === 'invalid_token' || error === 'insufficient_scope') result += `, error="${error}"`;
    return result;
  }

  async function refresh(force = false) {
    const now = clock();
    if (!force && keys.size && now - fetchedAt < cacheTtlMs) return;
    if (inflight) return inflight;
    if (now - attemptedAt < minRefreshIntervalMs) {
      if (keys.size && now - fetchedAt < cacheTtlMs) return;
      throw new OAuthError('authorization_unavailable', 'Authorization signing keys are temporarily unavailable', { status: 503 });
    }
    attemptedAt = now;
    inflight = (async () => {
      try {
        const response = await fetcher(jwksUri, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
          headers: { accept: 'application/json' },
        });
        if (!response.ok || response.redirected) throw new Error('JWKS request failed');
        const next = verificationKeys(uniqueJson(await boundedBody(response, 1_048_576)), allowedAlgorithms);
        keys = next;
        fetchedAt = clock();
      } catch {
        throw new OAuthError('authorization_unavailable', 'Authorization signing keys could not be verified', { status: 503 });
      }
    })();
    try { await inflight; } finally { inflight = undefined; }
  }

  async function authenticate(request, { requiredScopes = [] } = {}) {
    try {
      const authorization = header(request, 'authorization');
      if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]+$/i.test(authorization) || authorization.length > 16_384) {
        throw new OAuthError('invalid_token', 'A valid Bearer access token is required');
      }
      const token = authorization.slice(7);
      const parts = token.split('.');
      if (parts.length !== 3) throw new OAuthError('invalid_token', 'Malformed access token');
      const protectedHeader = parsePart(parts[0]);
      const claims = parsePart(parts[1]);
      const signature = decodeUrl(parts[2]);
      if (!allowedAlgorithms.has(protectedHeader.alg) || typeof protectedHeader.kid !== 'string' || !protectedHeader.kid || protectedHeader.kid.length > 256) throw new OAuthError('invalid_token', 'Unsupported token signing key');
      if (['crit', 'b64', 'jku', 'jwk', 'x5u', 'x5c'].some(key => Object.hasOwn(protectedHeader, key))) throw new OAuthError('invalid_token', 'Unsupported token header');
      if (protectedHeader.typ !== undefined && !['JWT', 'at+jwt'].includes(protectedHeader.typ)) throw new OAuthError('invalid_token', 'Unsupported token type');
      await refresh();
      let candidate = keys.get(protectedHeader.kid);
      if (!candidate) { await refresh(true); candidate = keys.get(protectedHeader.kid); }
      if (!candidate || candidate.algorithm !== protectedHeader.alg) throw new OAuthError('invalid_token', 'Unknown token signing key');
      const input = Buffer.from(`${parts[0]}.${parts[1]}`);
      let valid = false;
      try {
        if (candidate.algorithm === 'RS256') valid = verify('sha256', input, { key: candidate.key, padding: constants.RSA_PKCS1_PADDING }, signature);
        if (candidate.algorithm === 'ES256' && signature.length === 64) valid = verify('sha256', input, { key: candidate.key, dsaEncoding: 'ieee-p1363' }, signature);
        if (candidate.algorithm === 'EdDSA' && signature.length === 64) valid = verify(null, input, candidate.key, signature);
      } catch { /* Normalize all verification failures; never expose token bytes. */ }
      if (!valid) throw new OAuthError('invalid_token', 'Invalid access token signature');
      const now = clock() / 1000;
      const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
      if (claims.iss !== issuer || !Array.isArray(audiences) || audiences.some(value => typeof value !== 'string' || !value) || !audiences.includes(audience)) throw new OAuthError('invalid_token', 'Access token issuer or audience does not match');
      if (!Number.isSafeInteger(claims.exp) || claims.exp <= now - clockToleranceSeconds || claims.exp > 8_640_000_000_000) throw new OAuthError('invalid_token', 'Access token has expired or has invalid expiry');
      if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + clockToleranceSeconds)) throw new OAuthError('invalid_token', 'Access token is not yet valid');
      if (claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || claims.iat > now + clockToleranceSeconds)) throw new OAuthError('invalid_token', 'Access token issuance time is invalid');
      if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 512) throw new OAuthError('invalid_token', 'Access token has no stable subject');
      let granted;
      try {
        if (claims.scope !== undefined && typeof claims.scope !== 'string') throw new Error('Malformed scope');
        granted = scopes(claims.scope === undefined || !claims.scope ? [] : claims.scope.split(' '), 'Token scopes');
        if (claims.scp !== undefined) {
          const alternate = scopes(claims.scp, 'Token scp');
          if (claims.scope !== undefined && JSON.stringify(alternate) !== JSON.stringify(granted)) throw new Error('Conflicting scopes');
          granted = alternate;
        }
      } catch { throw new OAuthError('invalid_token', 'Access token scopes are invalid'); }
      const principal = { id: claims.sub, scopes: granted, issuer, expiresAt: claims.exp * 1000 };
      return requireScopes(principal, requiredScopes);
    } catch (error) {
      if (error instanceof OAuthError) error.challenge = challenge(requiredScopes, error.code);
      throw error;
    }
  }

  return Object.freeze({ authenticate, metadata, metadataUrl: discoveryUrl, challenge });
}
