import type { Env } from '../env';
import { metadata, oauthConfig, oauthError, oauthJson, reject } from './oauth-support';
import { accountAccess, bridgeStatus, managementExchange, managementLogin } from './oauth-management';
import { authorize } from './oauth-authorization';
import { introspect, revoke, tokenEndpoint } from './oauth-tokens';
import { oauthConnections } from './oauth-connections';

/** Optional first-party OAuth is isolated from upstream GitHub/Google sign-in. */
export async function routeIntegrationOAuth(req: Request, env: Env, url: URL): Promise<Response> {
  try {
    const config = await oauthConfig(env);
    if (!config) return oauthJson({ error: 'not_found' }, 404);
    if (url.href.length > 8192) reject('invalid_request', 'OAuth URL exceeds its limit', 414);
    if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') return oauthJson(metadata(config));
    if (url.pathname === '/oauth/jwks' && req.method === 'GET') return oauthJson({ keys: config.publicKeys });
    if (!['/oauth/bridge-status', '/oauth/account-access', '/oauth/introspect', '/oauth/management/exchange'].includes(url.pathname) && env.AUTH_RATE &&
        !(await env.AUTH_RATE.limit({ key: 'integration-oauth:' + url.pathname + ':' + (req.headers.get('CF-Connecting-IP') ?? 'unknown') })).success)
      reject('temporarily_unavailable', 'OAuth request rate limit reached', 429);
    if (url.pathname === '/oauth/authorize') return await authorize(req, env, config, url);
    if (url.pathname === '/oauth/token') return await tokenEndpoint(req, env, config);
    if (url.pathname === '/oauth/revoke') return await revoke(req, env, config);
    if (url.pathname === '/oauth/introspect') return await introspect(req, env, config);
    if (url.pathname === '/oauth/connections') return await oauthConnections(req, env, config);
    if (url.pathname === '/oauth/bridge-status') return await bridgeStatus(req, env, config);
    if (url.pathname === '/oauth/account-access') return await accountAccess(req, env, config);
    if (url.pathname === '/oauth/management/login') return await managementLogin(req, env, config, url);
    if (url.pathname === '/oauth/management/exchange') return await managementExchange(req, env, config);
    return oauthJson({ error: 'not_found' }, 404);
  } catch (error) { return oauthError(error); }
}
