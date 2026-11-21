import type { Env } from '../env';
import { metadata, oauthConfig, oauthError, oauthJson, reject } from './oauth-support';
import { authorize } from './oauth-authorization';
import { revoke, tokenEndpoint } from './oauth-tokens';
import { oauthConnections } from './oauth-connections';
import { ensureOAuthSchema } from './oauth-data';

/** First-party OAuth for the hosted /mcp endpoint, isolated from upstream GitHub/Google sign-in. */
export async function routeIntegrationOAuth(req: Request, env: Env, url: URL): Promise<Response> {
  try {
    const config = await oauthConfig(env);
    if (!config) return oauthJson({ error: 'not_found' }, 404);
    await ensureOAuthSchema(env);
    if (url.href.length > 8192) reject('invalid_request', 'OAuth URL exceeds its limit', 414);
    if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') return oauthJson(metadata(config));
    if (url.pathname === '/oauth/jwks' && req.method === 'GET') return oauthJson({ keys: config.publicKeys });
    if (env.AUTH_RATE &&
        !(await env.AUTH_RATE.limit({ key: 'integration-oauth:' + url.pathname + ':' + (req.headers.get('CF-Connecting-IP') ?? 'unknown') })).success)
      reject('temporarily_unavailable', 'OAuth request rate limit reached', 429);
    if (url.pathname === '/oauth/authorize') return await authorize(req, env, config, url);
    if (url.pathname === '/oauth/token') return await tokenEndpoint(req, env, config);
    if (url.pathname === '/oauth/revoke') return await revoke(req, env, config);
    if (url.pathname === '/oauth/connections') return await oauthConnections(req, env, config);
    return oauthJson({ error: 'not_found' }, 404);
  } catch (error) { return oauthError(error); }
}
