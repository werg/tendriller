/**
 * System-wide Ed25519-signed broadcasts, version predicates, and client version reporting.
 * Pure Web Crypto + standard JS: runs identically in Cloudflare Workers, browsers, and Node 22+.
 */
export const BROADCAST_SCHEMA_VERSION = 1;
export const BROADCAST_SIGNING_DOMAIN = 'tendriller.broadcast.v1';

export const BROADCAST_KINDS = Object.freeze(['upgrade', 'security', 'maintenance', 'deprecation', 'announcement']);
export const BROADCAST_SEVERITIES = Object.freeze(['info', 'recommended', 'urgent', 'critical']);
export const BROADCAST_AUDIENCES = Object.freeze(['agents', 'mcp', 'page_owners', 'page_all', 'dashboard']);
export const BROADCAST_ACTION_KINDS = Object.freeze(['upgrade_dependencies', 'republish_page', 'reload_tabs', 'read_advisory']);

export const BROADCAST_ID_RE = /^bc_[a-z2-7]{26}$/;
export const BROADCAST_KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const RUNTIME_ID_RE = /^[a-f0-9]{64}$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]{1,100}$/i;
const VERSION_VALUE_RE = /^[A-Za-z0-9.+_-]{1,64}$/;
const CONSTRAINT_RE = /^(?:(?:<=|>=|<|>|=|!=)?[A-Za-z0-9.+_-]{1,64})(?:[\s,]+(?:<=|>=|<|>|=|!=)?[A-Za-z0-9.+_-]{1,64}){0,3}$/;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export const BROADCAST_LIMITS = Object.freeze({
  title: 160,
  summary: 500,
  body: 4000,
  docsUrl: 512,
  packages: 16,
  runtimeIds: 32,
  listMax: 50,
  clientVersionsBytes: 2048,
});

let cachedEncoder;
const utf8Encode = value => (cachedEncoder ??= new TextEncoder()).encode(value);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  if (typeof value !== 'string' || !value || !B64URL_RE.test(value)) {
    throw new TypeError('Invalid base64url value');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Deterministic sorted-key JSON serialization for cryptographic signing. */
export function canonicalizeBroadcastPayload(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonicalizeBroadcastPayload(item)).join(',') + ']';
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalizeBroadcastPayload(value[key])).join(',') + '}';
}

export function broadcastSigningBytes(payload) {
  return utf8Encode(`${BROADCAST_SIGNING_DOMAIN}\n${canonicalizeBroadcastPayload(payload)}`);
}

export function validateBroadcastKey(jwk) {
  if (!isPlainObject(jwk)) return false;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return false;
  if (typeof jwk.kid !== 'string' || !BROADCAST_KEY_ID_RE.test(jwk.kid)) return false;
  if (typeof jwk.x !== 'string' || !B64URL_RE.test(jwk.x)) return false;
  try {
    return fromBase64Url(jwk.x).byteLength === 32;
  } catch {
    return false;
  }
}

export function publicJwkFromPrivate(privateJwk) {
  if (!validateBroadcastKey(privateJwk) || typeof privateJwk.d !== 'string' || !B64URL_RE.test(privateJwk.d)) {
    throw new TypeError('Invalid Ed25519 private JWK for broadcast signing');
  }
  return { kid: privateJwk.kid, kty: 'OKP', crv: 'Ed25519', x: privateJwk.x };
}

export async function generateBroadcastKeyPair({ kid } = {}) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64Url(pub.x)));
  const resolvedKid = kid ?? ('bk_' + toBase64Url(digest.subarray(0, 12)));
  if (!BROADCAST_KEY_ID_RE.test(resolvedKid)) throw new TypeError('Invalid broadcast key id');
  const publicJwk = { kid: resolvedKid, kty: 'OKP', crv: 'Ed25519', x: pub.x };
  const privateJwk = { kid: resolvedKid, kty: 'OKP', crv: 'Ed25519', x: priv.x, d: priv.d };
  return { kid: resolvedKid, publicJwk, privateJwk };
}

export async function signBroadcastPayload(payload, privateJwk) {
  const pub = publicJwkFromPrivate(privateJwk);
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x, d: privateJwk.d },
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const bytes = broadcastSigningBytes(payload);
  const sigBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes));
  return {
    payload,
    signature: {
      alg: 'Ed25519',
      kid: pub.kid,
      sig: toBase64Url(sigBytes),
    },
  };
}

export async function verifyBroadcastSignature(signed, publicKeys, { issuer } = {}) {
  if (!isPlainObject(signed) || !isPlainObject(signed.payload) || !isPlainObject(signed.signature)) {
    return { valid: false, reason: 'invalid_envelope' };
  }
  const { payload, signature } = signed;
  if (payload.schema_version !== BROADCAST_SCHEMA_VERSION) {
    return { valid: false, reason: 'unsupported_schema_version' };
  }
  if (typeof payload.id !== 'string' || !BROADCAST_ID_RE.test(payload.id)) {
    return { valid: false, reason: 'invalid_broadcast_id' };
  }
  if (!Number.isSafeInteger(payload.seq) || payload.seq < 1) {
    return { valid: false, reason: 'invalid_seq' };
  }
  if (issuer !== undefined && payload.issuer !== issuer) {
    return { valid: false, reason: 'issuer_mismatch' };
  }
  if (signature.alg !== 'Ed25519' || typeof signature.kid !== 'string' || !BROADCAST_KEY_ID_RE.test(signature.kid)) {
    return { valid: false, reason: 'unsupported_signature_alg' };
  }
  if (typeof signature.sig !== 'string' || !B64URL_RE.test(signature.sig)) {
    return { valid: false, reason: 'invalid_signature_encoding' };
  }
  const keys = Array.isArray(publicKeys) ? publicKeys : [];
  const matchingKey = keys.find(key => validateBroadcastKey(key) && key.kid === signature.kid);
  if (!matchingKey) {
    return { valid: false, reason: 'unknown_key_id', kid: signature.kid };
  }
  let sigBytes;
  try {
    sigBytes = fromBase64Url(signature.sig);
    if (sigBytes.byteLength !== 64) return { valid: false, reason: 'invalid_signature_length', kid: signature.kid };
  } catch {
    return { valid: false, reason: 'invalid_signature_encoding', kid: signature.kid };
  }
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: matchingKey.x },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const bytes = broadcastSigningBytes(payload);
    const ok = await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, bytes);
    return ok ? { valid: true, kid: signature.kid } : { valid: false, reason: 'signature_mismatch', kid: signature.kid };
  } catch {
    return { valid: false, reason: 'verification_error', kid: signature.kid };
  }
}

function validHttpsUrl(value, field, maxLen = BROADCAST_LIMITS.docsUrl) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLen) throw new TypeError(`${field} must be a URL up to ${maxLen} characters`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(`${field} must be a valid URL`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password) {
    throw new TypeError(`${field} must use HTTPS`);
  }
  return parsed.href;
}

function validatePackagesMap(value, field, allowConstraints) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new TypeError(`${field} must be a JSON object`);
  const entries = Object.entries(value);
  if (entries.length > BROADCAST_LIMITS.packages) throw new TypeError(`${field} supports at most ${BROADCAST_LIMITS.packages} packages`);
  const out = {};
  for (const [name, raw] of entries) {
    if (!PACKAGE_NAME_RE.test(name)) throw new TypeError(`Invalid package name in ${field}: ${name}`);
    if (typeof raw !== 'string') throw new TypeError(`Invalid version in ${field} for ${name}`);
    const trimmed = raw.trim();
    if (!(allowConstraints ? CONSTRAINT_RE : VERSION_VALUE_RE).test(trimmed)) {
      throw new TypeError(`Invalid ${allowConstraints ? 'constraint' : 'version'} in ${field} for ${name}`);
    }
    out[name] = trimmed;
  }
  return Object.keys(out).length ? out : undefined;
}

export function validateBroadcastInput(input) {
  if (!isPlainObject(input)) throw new TypeError('Broadcast input must be an object');
  const kind = input.kind;
  if (typeof kind !== 'string' || !BROADCAST_KINDS.includes(kind)) {
    throw new TypeError(`kind must be one of ${BROADCAST_KINDS.join(', ')}`);
  }
  const severity = input.severity;
  if (typeof severity !== 'string' || !BROADCAST_SEVERITIES.includes(severity)) {
    throw new TypeError(`severity must be one of ${BROADCAST_SEVERITIES.join(', ')}`);
  }
  const rawAudiences = Array.isArray(input.audiences) ? input.audiences : [];
  const audiences = [...new Set(rawAudiences)].filter(a => typeof a === 'string' && BROADCAST_AUDIENCES.includes(a));
  if (!audiences.length || audiences.length !== new Set(rawAudiences).size) {
    throw new TypeError(`audiences must be a non-empty subset of ${BROADCAST_AUDIENCES.join(', ')}`);
  }
  audiences.sort();
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > BROADCAST_LIMITS.title) {
    throw new TypeError(`title is required and must be at most ${BROADCAST_LIMITS.title} characters`);
  }
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (!summary || summary.length > BROADCAST_LIMITS.summary) {
    throw new TypeError(`summary is required and must be at most ${BROADCAST_LIMITS.summary} characters`);
  }
  const body = input.body === undefined || input.body === null ? '' : typeof input.body === 'string' ? input.body.trim() : null;
  if (body === null || body.length > BROADCAST_LIMITS.body) {
    throw new TypeError(`body must be a string up to ${BROADCAST_LIMITS.body} characters`);
  }
  const docs_url = validHttpsUrl(input.docs_url, 'docs_url');
  let action = null;
  if (input.action !== undefined && input.action !== null) {
    if (!isPlainObject(input.action)) throw new TypeError('action must be an object');
    if (typeof input.action.kind !== 'string' || !BROADCAST_ACTION_KINDS.includes(input.action.kind)) {
      throw new TypeError(`action.kind must be one of ${BROADCAST_ACTION_KINDS.join(', ')}`);
    }
    const packages = validatePackagesMap(input.action.packages, 'action.packages', true);
    const release_manifest_url = validHttpsUrl(input.action.release_manifest_url, 'action.release_manifest_url');
    const requires_republish = input.action.requires_republish === undefined ? false : Boolean(input.action.requires_republish);
    const requires_tab_reload = input.action.requires_tab_reload === undefined ? false : Boolean(input.action.requires_tab_reload);
    action = {
      kind: input.action.kind,
      ...(packages ? { packages } : {}),
      ...(release_manifest_url ? { release_manifest_url } : {}),
      ...(requires_republish ? { requires_republish: true } : {}),
      ...(requires_tab_reload ? { requires_tab_reload: true } : {}),
    };
  }
  let match = null;
  if (input.match !== undefined && input.match !== null) {
    if (!isPlainObject(input.match)) throw new TypeError('match must be an object');
    const packages = validatePackagesMap(input.match.packages, 'match.packages', true);
    let core_release;
    if (input.match.core_release !== undefined && input.match.core_release !== null && input.match.core_release !== '') {
      if (typeof input.match.core_release !== 'string' || !CONSTRAINT_RE.test(input.match.core_release.trim())) {
        throw new TypeError('match.core_release must be a valid version constraint');
      }
      core_release = input.match.core_release.trim();
    }
    let runtime_ids;
    if (input.match.runtime_ids !== undefined && input.match.runtime_ids !== null) {
      if (!Array.isArray(input.match.runtime_ids) || input.match.runtime_ids.length > BROADCAST_LIMITS.runtimeIds ||
          input.match.runtime_ids.some(id => typeof id !== 'string' || !RUNTIME_ID_RE.test(id))) {
        throw new TypeError('match.runtime_ids must be an array of 64-hex runtime ids');
      }
      if (input.match.runtime_ids.length) runtime_ids = [...new Set(input.match.runtime_ids)].sort();
    }
    let runtime_id_not_in;
    if (input.match.runtime_id_not_in !== undefined && input.match.runtime_id_not_in !== null) {
      if (!Array.isArray(input.match.runtime_id_not_in) || input.match.runtime_id_not_in.length > BROADCAST_LIMITS.runtimeIds ||
          input.match.runtime_id_not_in.some(id => typeof id !== 'string' || !RUNTIME_ID_RE.test(id))) {
        throw new TypeError('match.runtime_id_not_in must be an array of 64-hex runtime ids');
      }
      if (input.match.runtime_id_not_in.length) runtime_id_not_in = [...new Set(input.match.runtime_id_not_in)].sort();
    }
    let published_before;
    if (input.match.published_before !== undefined && input.match.published_before !== null) {
      if (!Number.isSafeInteger(input.match.published_before) || input.match.published_before <= 0) {
        throw new TypeError('match.published_before must be a positive epoch ms integer');
      }
      published_before = input.match.published_before;
    }
    const agentless_only = input.match.agentless_only === true ? true : undefined;
    const cleaned = {
      ...(packages ? { packages } : {}),
      ...(core_release ? { core_release } : {}),
      ...(runtime_ids ? { runtime_ids } : {}),
      ...(runtime_id_not_in ? { runtime_id_not_in } : {}),
      ...(published_before !== undefined ? { published_before } : {}),
      ...(agentless_only ? { agentless_only: true } : {}),
    };
    if (Object.keys(cleaned).length) match = cleaned;
  }
  const dismissible = input.dismissible === undefined ? severity !== 'critical' : Boolean(input.dismissible);
  let expires_at = null;
  if (input.expires_at !== undefined && input.expires_at !== null && input.expires_at !== '') {
    const ts = typeof input.expires_at === 'number' ? input.expires_at : Date.parse(String(input.expires_at));
    if (!Number.isSafeInteger(ts) || ts <= 0) throw new TypeError('expires_at must be a positive timestamp or ISO date');
    expires_at = ts;
  }
  let superseded_by = null;
  if (input.superseded_by !== undefined && input.superseded_by !== null && input.superseded_by !== '') {
    if (typeof input.superseded_by !== 'string' || !BROADCAST_ID_RE.test(input.superseded_by)) {
      throw new TypeError('superseded_by must be a broadcast id');
    }
    superseded_by = input.superseded_by;
  }
  return { kind, severity, audiences, title, summary, body, docs_url, action, match, dismissible, expires_at, superseded_by };
}

export function validateClientVersions(input) {
  if (!isPlainObject(input)) throw new TypeError('Client versions must be a JSON object');
  const checkStr = (val, field) => {
    if (val === undefined || val === null || val === '') return null;
    if (typeof val !== 'string' || !VERSION_VALUE_RE.test(val.trim())) throw new TypeError(`Invalid ${field} version`);
    return val.trim();
  };
  const core = checkStr(input.core, 'core');
  const tools = checkStr(input.tools, 'tools');
  const chronolog = checkStr(input.chronolog, 'chronolog');
  const authority = checkStr(input.authority, 'authority');
  const node = checkStr(input.node, 'node');
  const kit = checkStr(input.kit, 'kit');
  const packages = validatePackagesMap(input.packages, 'packages', false) ?? null;
  const result = {
    ...(core ? { core } : {}),
    ...(tools ? { tools } : {}),
    ...(chronolog ? { chronolog } : {}),
    ...(authority ? { authority } : {}),
    ...(node ? { node } : {}),
    ...(kit ? { kit } : {}),
    ...(packages ? { packages } : {}),
  };
  if (utf8Encode(JSON.stringify(result)).byteLength > BROADCAST_LIMITS.clientVersionsBytes) {
    throw new TypeError('Client versions payload exceeds limit');
  }
  return result;
}

function parseSemver(value) {
  const m = typeof value === 'string' ? SEMVER_RE.exec(value.trim()) : null;
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/** Compare two semver strings (supports prereleases like 0.3.0-rc.17). Returns -1, 0, 1, or null if non-semver. */
export function compareSemver(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (!pa.prerelease.length && !pb.prerelease.length) return 0;
  if (!pa.prerelease.length) return 1;
  if (!pb.prerelease.length) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = pa.prerelease[i], y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Evaluate a constraint string like "<0.5.0", ">=0.3.0 <0.4.0", "=0.3.0-rc.17", or "!=0.3.0". */
export function satisfiesVersionConstraint(version, constraint) {
  if (typeof version !== 'string' || typeof constraint !== 'string') return false;
  const clauses = constraint.trim().split(/[\s,]+/).filter(Boolean);
  if (!clauses.length) return false;
  for (const clause of clauses) {
    const match = /^(<=|>=|<|>|!=|=)?(.+)$/.exec(clause);
    if (!match) return false;
    const op = match[1] || '=';
    const target = match[2];
    const cmp = compareSemver(version, target);
    if (cmp === null) {
      if (op === '=') { if (version.trim() !== target) return false; continue; }
      if (op === '!=') { if (version.trim() === target) return false; continue; }
      return false;
    }
    if (op === '=' && cmp !== 0) return false;
    if (op === '!=' && cmp === 0) return false;
    if (op === '<' && !(cmp < 0)) return false;
    if (op === '<=' && !(cmp <= 0)) return false;
    if (op === '>' && !(cmp > 0)) return false;
    if (op === '>=' && !(cmp >= 0)) return false;
  }
  return true;
}

/**
 * Evaluate whether a broadcast payload applies to the given local client/page context.
 * Returns { matched: boolean, reasons: string[] }.
 */
export function evaluateBroadcastMatch(payload, context = {}) {
  const now = context.now ?? Date.now();
  if (!isPlainObject(payload)) return { matched: false, reasons: ['invalid_payload'] };
  if (payload.expires_at !== null && payload.expires_at !== undefined && payload.expires_at <= now) {
    return { matched: false, reasons: ['expired'] };
  }
  const audiences = Array.isArray(payload.audiences) ? payload.audiences : [];
  const wanted = context.audiences
    ? context.audiences
    : context.audience
      ? [context.audience]
      : null;
  if (wanted && !wanted.some(a => audiences.includes(a))) {
    return { matched: false, reasons: ['audience_mismatch'] };
  }
  const match = payload.match;
  if (!match || !isPlainObject(match) || Object.keys(match).length === 0) {
    return { matched: true, reasons: ['all'] };
  }
  const reasons = [];
  if (match.agentless_only === true) {
    if (typeof context.activeAgents === 'number' && context.activeAgents > 0) {
      return { matched: false, reasons: ['has_active_agents'] };
    }
    if (context.activeAgents === 0) reasons.push('agentless_page');
  }
  if (match.published_before !== undefined) {
    if (typeof context.publishedAt !== 'number') return { matched: false, reasons: ['published_at_unknown'] };
    if (context.publishedAt >= match.published_before) return { matched: false, reasons: ['published_after_cutoff'] };
    reasons.push('published_before_cutoff');
  }
  if (Array.isArray(match.runtime_ids) && match.runtime_ids.length) {
    if (!context.runtimeId || !match.runtime_ids.includes(context.runtimeId)) {
      return { matched: false, reasons: ['runtime_id_not_targeted'] };
    }
    reasons.push('runtime_id_match');
  }
  if (Array.isArray(match.runtime_id_not_in) && match.runtime_id_not_in.length) {
    if (!context.runtimeId || match.runtime_id_not_in.includes(context.runtimeId)) {
      return { matched: false, reasons: ['runtime_id_current'] };
    }
    reasons.push('runtime_id_outdated');
  }
  if (match.core_release) {
    const currentCore = context.coreRelease ?? context.runtimeVersion ?? context.versions?.core ?? context.versions?.packages?.['@tendriller/core'];
    if (!currentCore) return { matched: false, reasons: ['core_release_unknown'] };
    if (!satisfiesVersionConstraint(currentCore, match.core_release)) {
      return { matched: false, reasons: ['core_release_current'] };
    }
    reasons.push(`core_release:${currentCore}`);
  }
  if (match.packages && isPlainObject(match.packages)) {
    const installed = {
      ...(isPlainObject(context.versions?.packages) ? context.versions.packages : {}),
      ...(context.versions?.core ? { '@tendriller/core': context.versions.core } : {}),
      ...(context.versions?.tools ? { '@tendriller/tools': context.versions.tools } : {}),
      ...(context.versions?.chronolog ? { '@chronolog/peer-session': context.versions.chronolog } : {}),
      ...(context.versions?.authority ? { '@chronolog/authority': context.versions.authority } : {}),
      ...(context.coreRelease ? { '@tendriller/core': context.coreRelease } : {}),
    };
    let anyMatched = false;
    for (const [pkg, constraint] of Object.entries(match.packages)) {
      const current = installed[pkg];
      if (current && satisfiesVersionConstraint(current, constraint)) {
        anyMatched = true;
        reasons.push(`${pkg}:${current}`);
      }
    }
    if (!anyMatched) return { matched: false, reasons: ['packages_not_matched'] };
  }
  return { matched: true, reasons: reasons.length ? reasons : ['matched'] };
}

export function matchesBroadcast(payload, context = {}) {
  return evaluateBroadcastMatch(payload, context).matched;
}

export async function fetchBroadcastKeys(serviceOrigin, { fetch: fetcher = globalThis.fetch, signal } = {}) {
  const origin = new URL(serviceOrigin).origin;
  const response = await fetcher(`${origin}/.well-known/tendriller-broadcast-keys.json`, {
    signal, redirect: 'error', cache: 'no-cache',
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Could not fetch broadcast signing keys (${response.status})`), {
      status: response.status, code: 'broadcast_keys_unavailable',
    });
  }
  const data = await response.json();
  if (!isPlainObject(data) || data.issuer !== origin || !Array.isArray(data.keys)) {
    throw Object.assign(new Error('Invalid broadcast signing key document'), {
      status: response.status, code: 'broadcast_keys_invalid',
    });
  }
  return { issuer: data.issuer, keys: data.keys.filter(validateBroadcastKey) };
}

export async function fetchBroadcasts(serviceOrigin, {
  audience,
  since,
  verifyKeys,
  etag,
  fetch: fetcher = globalThis.fetch,
  signal,
} = {}) {
  const origin = new URL(serviceOrigin).origin;
  const url = new URL('/api/broadcasts', origin);
  if (audience) url.searchParams.set('audience', audience);
  if (since !== undefined && since !== null) url.searchParams.set('since', String(since));
  const headers = {};
  if (etag) headers['If-None-Match'] = etag;
  const response = await fetcher(url.href, { signal, redirect: 'error', cache: 'no-cache', headers });
  if (response.status === 304) {
    return { notModified: true, etag: response.headers.get('ETag') ?? etag ?? null, issuer: origin, keys: [], latest_seq: since ?? 0, broadcasts: [], verified: [], rejected: [] };
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Could not fetch broadcasts (${response.status})`), {
      status: response.status, code: 'broadcasts_unavailable',
    });
  }
  const data = await response.json();
  if (!isPlainObject(data) || data.issuer !== origin || !Array.isArray(data.broadcasts)) {
    throw Object.assign(new Error('Invalid broadcasts response'), {
      status: response.status, code: 'broadcasts_invalid',
    });
  }
  const trustedKeys = Array.isArray(verifyKeys)
    ? verifyKeys.filter(validateBroadcastKey)
    : verifyKeys === 'discover'
      ? (await fetchBroadcastKeys(origin, { fetch: fetcher, signal })).keys
      : (Array.isArray(data.keys) ? data.keys.filter(validateBroadcastKey) : []);
  const verified = [];
  const rejected = [];
  for (const item of data.broadcasts) {
    const check = await verifyBroadcastSignature(item, trustedKeys, { issuer: origin });
    if (check.valid) verified.push(item);
    else rejected.push({ item, reason: check.reason });
  }
  return {
    notModified: false,
    etag: response.headers.get('ETag') ?? null,
    issuer: data.issuer,
    keys: trustedKeys,
    latest_seq: Number.isSafeInteger(data.latest_seq) ? data.latest_seq : 0,
    broadcasts: data.broadcasts,
    verified,
    rejected,
  };
}

/** Fetch notable release changelog entries from `/api/changelog`, optionally filtered for fallow-workspace catch-up. */
export async function fetchChangelog(serviceOrigin, {
  since,
  sinceCore,
  category,
  limit,
  fetch: fetcher = globalThis.fetch,
  signal,
} = {}) {
  const origin = new URL(serviceOrigin).origin;
  const url = new URL('/api/changelog', origin);
  if (since) url.searchParams.set('since', String(since));
  if (sinceCore) url.searchParams.set('since_core', String(sinceCore));
  if (category) url.searchParams.set('category', String(category));
  if (limit !== undefined && limit !== null) url.searchParams.set('limit', String(limit));
  const response = await fetcher(url.href, { signal, redirect: 'error', cache: 'no-cache' });
  if (!response.ok) {
    throw Object.assign(new Error(`Could not fetch changelog (${response.status})`), {
      status: response.status, code: 'changelog_unavailable',
    });
  }
  const data = await response.json();
  if (!isPlainObject(data) || data.issuer !== origin || !Array.isArray(data.entries)) {
    throw Object.assign(new Error('Invalid changelog response'), {
      status: response.status, code: 'changelog_invalid',
    });
  }
  return data;
}
