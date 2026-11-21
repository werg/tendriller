import type { Env } from '../env';
import { testAccountEnabled } from './test-access';
import { safeEqual, sha256Hex } from '../ids';
import { activeGrant, cleanup, postOnly, registeredGrant, revokeGrant, type OAuthGrant } from './oauth-data';
import { requestedScopes } from './oauth-authorization';
import { checkVerifier, form, oauthJson, randomToken, reject, signAccessToken, text, type OAuthClient, type OAuthConfig } from './oauth-support';

async function clientIdentity(req: Request, params: URLSearchParams, config: OAuthConfig): Promise<OAuthClient> {
  const authorization = req.headers.get('Authorization');
  let id = params.get('client_id'), secret: string | undefined;
  if (params.has('client_secret')) reject('invalid_client', 'Use the registered client authentication method', 401);
  if (authorization !== null) {
    const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/iu.exec(authorization);
    if (!basic) reject('invalid_client', 'Invalid client authentication', 401);
    try {
      const decoded = atob(basic![1]), separator = decoded.indexOf(':');
      if (separator < 0) throw Error('Missing separator');
      const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
      const supplied = decode(decoded.slice(0, separator)); secret = decode(decoded.slice(separator + 1));
      if (id !== null && id !== supplied) throw Error('Conflicting client');
      id = supplied;
    } catch { reject('invalid_client', 'Invalid client authentication', 401); }
  }
  const client = config.clients.find(value => value.id === id);
  if (!client || client.tokenEndpointAuthMethod === 'none' && authorization !== null ||
      client.tokenEndpointAuthMethod === 'client_secret_basic' && (secret === undefined || secret.length < 32 || secret.length > 512 ||
        !safeEqual(await sha256Hex(secret), client.clientSecretSha256!))) reject('invalid_client', 'Invalid client authentication', 401);
  return client!;
}
const liveGrantSql = `SELECT 1 FROM integration_oauth_grants g JOIN accounts a ON a.id=g.account_id
  WHERE g.id=? AND g.client_id=? AND g.resource=? AND g.revoked_at IS NULL AND g.expires_at>?
    AND a.suspended_at IS NULL AND a.deleting_at IS NULL`;

/** Persist issuance before returning tokens. Rotation and its new tokens commit together. */
async function issue(env: Env, config: OAuthConfig, grant: OAuthGrant, client: OAuthClient, scope: string, previousHash?: string): Promise<Response> {
  const now = Date.now(), issuedAt = Math.floor(now / 1000), expiresAt = Math.min(Math.floor(grant.expires_at / 1000), issuedAt + config.accessTokenTtlSeconds);
  if (expiresAt <= issuedAt) reject('invalid_grant', 'Authorization expired');
  const jti = crypto.randomUUID();
  const token = await signAccessToken(config, { iss: config.issuer, sub: grant.account_id, aud: config.resource, client_id: client.id,
    scope, iat: issuedAt, exp: expiresAt, jti, sid: grant.id });
  const hash = await sha256Hex(token), refresh = client.allowRefresh ? 'rt_' + randomToken() : null;
  const refreshHash = refresh ? await sha256Hex(refresh) : null;
  const liveBindings = [grant.id, client.id, config.resource, now];
  const rotation = previousHash ? [env.ACCOUNTS.prepare(`UPDATE integration_oauth_refresh SET used_at=?,replacement_hash=?
    WHERE hash=? AND grant_id=? AND used_at IS NULL AND expires_at>? AND EXISTS(${liveGrantSql})
      AND (SELECT COUNT(*) FROM integration_oauth_refresh WHERE grant_id=?)<10000 RETURNING hash`)
    .bind(now, refreshHash, previousHash, grant.id, now, ...liveBindings, grant.id)] : [];
  const boundRotation = previousHash ? ' AND EXISTS(SELECT 1 FROM integration_oauth_refresh WHERE hash=? AND replacement_hash=?)' : '';
  const results = await env.ACCOUNTS.batch([
    ...rotation,
    env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_access(hash,grant_id,jti,scope,created_at,expires_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(${liveGrantSql})
        AND (SELECT COUNT(*) FROM integration_oauth_access WHERE grant_id=?)<1000
        AND (SELECT COUNT(*) FROM integration_oauth_refresh WHERE grant_id=?)<10000${boundRotation}`)
      .bind(hash, grant.id, jti, scope, issuedAt * 1000, expiresAt * 1000, ...liveBindings, grant.id, grant.id,
        ...(previousHash ? [previousHash, refreshHash] : [])),
    ...(refresh ? [env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_refresh(hash,grant_id,created_at,expires_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM integration_oauth_access WHERE hash=?) AND EXISTS(${liveGrantSql})`)
      .bind(refreshHash, grant.id, now, grant.expires_at, hash, ...liveBindings)] : []),
  ]);
  if (previousHash && results[0].meta.changes !== 1) {
    const previous = await env.ACCOUNTS.prepare('SELECT used_at FROM integration_oauth_refresh WHERE hash=? AND grant_id=?')
      .bind(previousHash, grant.id).first<{ used_at: number | null }>();
    if (previous?.used_at !== null && previous?.used_at !== undefined) await revokeGrant(env, grant.id);
    reject('invalid_grant', 'Refresh token expired, was already used, or requires a new authorization');
  }
  if (results.slice(rotation.length).some(result => result.meta.changes !== 1)) {
    await revokeGrant(env, grant.id); reject('invalid_grant', 'Authorization changed or token capacity reached; authorize again');
  }
  // Current account/grant revocation wins over asynchronous signing and storage.
  if (!await activeGrant(env, config, grant.id, grant.account_id)) reject('invalid_grant', 'Authorization is no longer active');
  return oauthJson({ access_token: token, token_type: 'Bearer', expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    scope, resource: config.resource, ...(refresh ? { refresh_token: refresh } : {}) });
}

export async function tokenEndpoint(req: Request, env: Env, config: OAuthConfig): Promise<Response> {
  const wrongMethod = postOnly(req); if (wrongMethod) return wrongMethod;
  const params = await form(req), client = await clientIdentity(req, params, config);
  if (params.get('resource') !== config.resource) reject('invalid_target', 'The exact configured MCP resource is required');
  await cleanup(env);
  const type = params.get('grant_type');
  if (type === 'authorization_code') {
    const raw = text(params.get('code'), 'authorization code', 128), hash = await sha256Hex(raw), uri = params.get('redirect_uri');
    if (!uri || !client.redirectUris.includes(uri)) reject('invalid_grant', 'Invalid authorization code or redirect URI');
    const code = await env.ACCOUNTS.prepare('SELECT grant_id,redirect_uri,challenge,expires_at,used_at FROM integration_oauth_codes WHERE hash=?')
      .bind(hash).first<{ grant_id: string; redirect_uri: string; challenge: string; expires_at: number; used_at: number | null }>();
    const grant = code && await activeGrant(env, config, code.grant_id);
    if (!code || !grant || grant.client_id !== client.id || code.redirect_uri !== uri) reject('invalid_grant', 'Invalid authorization code');
    await checkVerifier(params.get('code_verifier'), code!.challenge);
    if (code!.used_at !== null) { await revokeGrant(env, grant!.id); reject('invalid_grant', 'Authorization code was already used'); }
    if (code!.expires_at <= Date.now()) reject('invalid_grant', 'Authorization code expired');
    const claimed = await env.ACCOUNTS.prepare(`UPDATE integration_oauth_codes SET used_at=? WHERE hash=? AND used_at IS NULL AND expires_at>?
      AND EXISTS(${liveGrantSql}) RETURNING grant_id`).bind(Date.now(), hash, Date.now(), grant!.id, client.id, config.resource, Date.now()).first();
    if (!claimed) { await revokeGrant(env, grant!.id); reject('invalid_grant', 'Authorization code is no longer usable'); }
    return issue(env, config, grant!, client, grant!.scope);
  }
  if (type === 'refresh_token') {
    if (!client.allowRefresh) reject('invalid_grant', 'This client cannot refresh access');
    const hash = await sha256Hex(text(params.get('refresh_token'), 'refresh token', 128));
    const refresh = await env.ACCOUNTS.prepare('SELECT grant_id,used_at,expires_at FROM integration_oauth_refresh WHERE hash=?')
      .bind(hash).first<{ grant_id: string; used_at: number | null; expires_at: number }>();
    const grant = refresh && await activeGrant(env, config, refresh.grant_id);
    if (!refresh || !grant || grant.client_id !== client.id) reject('invalid_grant', 'Invalid refresh token');
    if (refresh!.used_at !== null) { await revokeGrant(env, grant!.id); reject('invalid_grant', 'Refresh token reuse revoked this authorization'); }
    if (refresh!.expires_at <= Date.now()) reject('invalid_grant', 'Refresh token expired');
    const scope = requestedScopes(params.get('scope'), grant!.scope ? grant!.scope.split(' ') : []).join(' ');
    return issue(env, config, grant!, client, scope, hash);
  }
  return reject('unsupported_grant_type', 'Only authorization_code and configured refresh_token grants are supported');
}

export async function inspectAccessToken(env: Env, config: OAuthConfig, token: string) {
  const hash = await sha256Hex(text(token, 'access token', 16384));
  const now = Date.now();
  const access = await env.ACCOUNTS.prepare(`SELECT tok.grant_id,tok.jti,tok.scope,tok.created_at,tok.expires_at,
      g.account_id,g.client_id,g.scope AS grant_scope
    FROM integration_oauth_access tok JOIN integration_oauth_grants g ON g.id=tok.grant_id
    JOIN accounts a ON a.id=g.account_id
    WHERE tok.hash=? AND tok.expires_at>? AND g.resource=? AND g.revoked_at IS NULL AND g.expires_at>?
      AND a.suspended_at IS NULL AND a.deleting_at IS NULL`).bind(hash, now, config.resource, now)
    .first<{ grant_id: string; jti: string; scope: string; created_at: number; expires_at: number;
      account_id: string; client_id: string; grant_scope: string }>();
  if (!access || !testAccountEnabled(env, access.account_id) || !registeredGrant(config, { client_id: access.client_id, scope: access.grant_scope }) ||
      !registeredGrant(config, access)) return null;
  return { active: true, token_type: 'Bearer', sub: access.account_id, iss: config.issuer, aud: config.resource,
    scope: access.scope, client_id: access.client_id, iat: Math.floor(access.created_at / 1000), exp: Math.floor(access.expires_at / 1000),
    jti: access.jti, sid: access.grant_id };
}

export async function revoke(req: Request, env: Env, config: OAuthConfig): Promise<Response> {
  const wrongMethod = postOnly(req); if (wrongMethod) return wrongMethod;
  const params = await form(req), client = await clientIdentity(req, params, config);
  const hash = await sha256Hex(text(params.get('token'), 'token', 16384));
  const found = await env.ACCOUNTS.prepare(`SELECT g.id FROM integration_oauth_grants g WHERE g.client_id=? AND g.resource=?
    AND (EXISTS(SELECT 1 FROM integration_oauth_access WHERE hash=? AND grant_id=g.id)
      OR EXISTS(SELECT 1 FROM integration_oauth_refresh WHERE hash=? AND grant_id=g.id)) LIMIT 1`)
    .bind(client.id, config.resource, hash, hash).first<{ id: string }>();
  if (found) await revokeGrant(env, found.id);
  return oauthJson({});
}
