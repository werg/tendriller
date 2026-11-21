import type { Env } from '../env';
import { HttpError, json, readBody } from '../http';
import { safeEqual, sha256Hex } from '../ids';
import { publicBase } from '../urls';

export const OAUTH_SCOPES = ['tendrils:list', 'tendrils:create', 'applications:read', 'applications:write', 'events:subscribe', 'pages:publish'] as const;
export class OAuthFailure extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export const reject = (code: string, message: string, status = 400): never => { throw new OAuthFailure(code, message, status); };
export function oauthJson(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const response = json(value, status, headers);
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
export function oauthError(error: unknown): Response {
  if (error instanceof OAuthFailure) return oauthJson({ error: error.code, error_description: error.message }, error.status,
    { ...(error.code === 'invalid_client' ? { 'WWW-Authenticate': 'Basic realm="Tendriller OAuth"' } : {}), ...(error.status === 429 ? { 'Retry-After': '60' } : {}) });
  if (error instanceof HttpError && [408, 413].includes(error.status))
    return oauthJson({ error: 'invalid_request', error_description: 'OAuth request exceeds the configured limit' }, error.status);
  // Never include an exception, request body, signing key, code or token in diagnostics.
  return oauthJson({ error: 'temporarily_unavailable', error_description: 'OAuth service is temporarily unavailable' }, 503);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_request', 'Expected an object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u0020\u007f]/u.test(value))
    reject('invalid_request', `Invalid ${label}`);
  return value as string;
}
function exactHttps(value: unknown): string {
  const raw = text(value, 'HTTPS URL', 2048), url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || raw.includes('*') || url.href !== raw)
    throw Error('Invalid exact HTTPS URL');
  return raw;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw Error('Invalid configuration list');
  return value;
}
function unique(values: string[]): string[] {
  if (new Set(values).size !== values.length) throw Error('Duplicate configuration value');
  return values;
}
function members(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Error('Unknown configuration field');
}
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}
function unbase64url(value: unknown): Uint8Array {
  const encoded = text(value, 'base64url value', 8192);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw Error('Invalid base64url');
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  if (base64url(bytes) !== encoded) throw Error('Noncanonical base64url');
  return bytes;
}
export const randomToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const challengeFor = async (verifier: string): Promise<string> => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
export async function checkVerifier(verifier: unknown, challenge: string): Promise<void> {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) || !safeEqual(await challengeFor(verifier), challenge))
    reject('invalid_grant', 'Authorization code or PKCE verifier is invalid');
}
export function checkedChallenge(value: unknown, method: unknown): string {
  if (method !== 'S256' || typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    reject('invalid_request', 'PKCE S256 with a SHA-256 challenge is required');
  return value as string;
}
export interface OAuthClient {
  id: string; name: string; redirectUris: string[]; scopes: string[];
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic'; clientSecretSha256?: string; allowRefresh: boolean; metadataDocument?: boolean;
}
type SigningJwk = JsonWebKey & { kid: string; alg: 'RS256' | 'ES256' };
export interface OAuthConfig {
  issuer: string; resource: string; clients: OAuthClient[];
  accessTokenTtlSeconds: number; grantTtlSeconds: number;
  privateKey: CryptoKey; publicKeys: SigningJwk[]; kid: string; algorithm: 'RS256' | 'ES256';
}
function publicKey(raw: unknown, privatePart = false): SigningJwk {
  const key = object(raw), kid = text(key.kid, 'key ID', 128);
  if (!privatePart && ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some(name => key[name] !== undefined)) throw Error('Private material in public JWKS');
  if (key.use !== undefined && key.use !== 'sig') throw Error('Signing key required');
  if (key.kty === 'EC' && key.alg === 'ES256' && key.crv === 'P-256' && unbase64url(key.x).length === 32 && unbase64url(key.y).length === 32)
    return { kty: 'EC', alg: 'ES256', crv: 'P-256', x: key.x as string, y: key.y as string, kid, use: 'sig', key_ops: ['verify'] };
  if (key.kty === 'RSA' && key.alg === 'RS256' && unbase64url(key.n).length >= 256 && unbase64url(key.e).length <= 8)
    return { kty: 'RSA', alg: 'RS256', n: key.n as string, e: key.e as string, kid, use: 'sig', key_ops: ['verify'] };
  throw Error('Use an RS256 RSA key of at least 2048 bits or an ES256 P-256 key');
}
const caches = new WeakMap<Env, { configuration: string; signing: string; previous: string; task: Promise<OAuthConfig> }>();
export async function oauthConfig(env: Env): Promise<OAuthConfig | null> {
  if (!env.OAUTH_CONFIG_JSON) return null;
  const configuration = env.OAUTH_CONFIG_JSON, signing = env.OAUTH_SIGNING_JWK ?? '', previous = env.OAUTH_PUBLIC_JWKS ?? '';
  let cached = caches.get(env);
  if (!cached || cached.configuration !== configuration || cached.signing !== signing || cached.previous !== previous) {
    const task = (async () => {
      if (configuration.length > 65536 || signing.length > 16384 || previous.length > 65536) throw Error('Configuration too large');
      const input = object(JSON.parse(configuration));
      members(input, ['resource', 'clients', 'accessTokenTtlSeconds', 'grantTtlSeconds']);
      const issuer = publicBase(env), origin = new URL(issuer);
      if (origin.protocol !== 'https:' || origin.origin !== issuer) throw Error('PUBLIC_BASE must be an exact HTTPS origin');
      const resource = exactHttps(input.resource);
      if (new URL(resource).search) throw Error('Resource must not contain a query');
      const clients = list(input.clients, 32).map(raw => {
        const client = object(raw); members(client, ['id', 'name', 'redirectUris', 'scopes', 'tokenEndpointAuthMethod', 'clientSecretSha256', 'allowRefresh', 'metadataDocument']);
        const id = text(client.id, 'client ID', 256), name = String(client.name ?? id);
        if (!name.length || name.length > 160 || /[\u0000-\u001f\u007f]/u.test(name)) throw Error('Invalid client name');
        const redirectUris = unique(list(client.redirectUris, 8).map(exactHttps));
        if (!redirectUris.length) throw Error('A registered redirect is required');
        const scopes = unique(list(client.scopes, 6).map(value => text(value, 'scope', 64)));
        if (scopes.some(scope => !(OAUTH_SCOPES as readonly string[]).includes(scope))) throw Error('Unsupported scope');
        const tokenEndpointAuthMethod = client.tokenEndpointAuthMethod ?? 'none';
        if (!['none', 'client_secret_basic'].includes(tokenEndpointAuthMethod as string)) throw Error('Unsupported client authentication');
        const clientSecretSha256 = client.clientSecretSha256;
        if (tokenEndpointAuthMethod === 'client_secret_basic' ? typeof clientSecretSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(clientSecretSha256) : clientSecretSha256 !== undefined)
          throw Error('Configure only the client authentication method in use');
        if (client.metadataDocument !== undefined && typeof client.metadataDocument !== 'boolean')
          throw Error('Invalid client metadata policy');
        if (client.metadataDocument === true) {
          const issuer = new URL(exactHttps(id));
          if (tokenEndpointAuthMethod !== 'none' || issuer.pathname === '/' || issuer.search || issuer.port ||
            redirectUris.some(uri => new URL(uri).origin !== issuer.origin))
            throw Error('Use a public client and exact metadata/redirect URLs on the same approved origin');
        }
        if (client.allowRefresh !== undefined && typeof client.allowRefresh !== 'boolean') throw Error('Invalid refresh policy');
        return { id, name, redirectUris, scopes, tokenEndpointAuthMethod, clientSecretSha256, allowRefresh: client.allowRefresh === true, ...(client.metadataDocument === true ? { metadataDocument: true } : {}) } as OAuthClient;
      });
      if (!clients.length) throw Error('At least one explicit OAuth client is required');
      unique(clients.map(client => client.id));
      const accessTokenTtlSeconds = input.accessTokenTtlSeconds ?? 300, grantTtlSeconds = input.grantTtlSeconds ?? 604800;
      if (!Number.isSafeInteger(accessTokenTtlSeconds) || Number(accessTokenTtlSeconds) < 60 || Number(accessTokenTtlSeconds) > 600 ||
          !Number.isSafeInteger(grantTtlSeconds) || Number(grantTtlSeconds) < 600 || Number(grantTtlSeconds) > 2592000) throw Error('Invalid token lifetime');
      const privateJwk = object(JSON.parse(signing)), active = publicKey(privateJwk, true);
      if (typeof privateJwk.d !== 'string') throw Error('Private signing key is required');
      const privateKey = await crypto.subtle.importKey('jwk', privateJwk as unknown as JsonWebKey,
        active.alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
      const modulusLength = (privateKey.algorithm as { modulusLength?: number }).modulusLength;
      if (active.alg === 'RS256' && (!Number.isSafeInteger(modulusLength) || modulusLength! < 2048)) throw Error('RSA key is too short');
      const publicKeys = [active, ...list(previous ? object(JSON.parse(previous)).keys : [], 4).map(value => publicKey(value))];
      unique(publicKeys.map(key => key.kid));
      const imported = await Promise.all(publicKeys.map(key => crypto.subtle.importKey('jwk', key,
        key.alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])));
      if (imported.some((key, index) => publicKeys[index].alg === 'RS256' && ((key.algorithm as { modulusLength?: number }).modulusLength ?? 0) < 2048))
        throw Error('Retained RSA key is too short');
      const signingAlgorithm = active.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5';
      const probe = new TextEncoder().encode('tendriller-oauth-configuration-v1');
      const proof = await crypto.subtle.sign(signingAlgorithm, privateKey, probe);
      if (!await crypto.subtle.verify(signingAlgorithm, imported[0], proof, probe)) throw Error('Signing key does not match the published JWKS');
      return { issuer, resource, clients, accessTokenTtlSeconds: Number(accessTokenTtlSeconds), grantTtlSeconds: Number(grantTtlSeconds),
        privateKey, publicKeys, kid: active.kid, algorithm: active.alg };
    })();
    cached = { configuration, signing, previous, task }; caches.set(env, cached);
  }
  try { return await cached.task; }
  catch { return reject('temporarily_unavailable', 'OAuth configuration is unavailable', 503); }
}
export function metadata(config: OAuthConfig) {
  const url = (path: string) => config.issuer + path;
  return { issuer: config.issuer, authorization_endpoint: url('/oauth/authorize'), token_endpoint: url('/oauth/token'),
    jwks_uri: url('/oauth/jwks'), revocation_endpoint: url('/oauth/revoke'),
    response_types_supported: ['code'], response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', ...(config.clients.some(client => client.allowRefresh) ? ['refresh_token'] : [])],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: [...new Set(config.clients.map(client => client.tokenEndpointAuthMethod))],
    scopes_supported: [...new Set(config.clients.flatMap(client => client.scopes))],
    authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: config.clients.some(client => client.metadataDocument) };
}
export function checkedParameters(input: URLSearchParams): URLSearchParams {
  if ([...input].length > 32) reject('invalid_request', 'Too many OAuth parameters');
  const keys = new Set<string>();
  for (const [key, value] of input) {
    if (keys.has(key) || key.length > 128 || value.length > 16384) reject('invalid_request', 'Duplicate or oversized OAuth parameter');
    keys.add(key);
  }
  return input;
}
export async function form(req: Request): Promise<URLSearchParams> {
  if (req.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded')
    reject('invalid_request', 'Use application/x-www-form-urlencoded', 415);
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readBody(req, 32768, 10000)); }
  catch (error) { if (error instanceof HttpError) throw error; return reject('invalid_request', 'Invalid UTF-8 form'); }
  return checkedParameters(new URLSearchParams(decoded));
}
export async function signAccessToken(config: OAuthConfig, claims: Record<string, unknown>): Promise<string> {
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const value = `${encode({ typ: 'at+jwt', alg: config.algorithm, kid: config.kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(config.algorithm === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5',
    config.privateKey, new TextEncoder().encode(value));
  return value + '.' + base64url(new Uint8Array(signature));
}
