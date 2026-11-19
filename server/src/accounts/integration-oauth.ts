import type { Env } from '../env';
import { metadata, oauthConfig, oauthError, oauthJson } from './oauth-support';

/** Optional first-party OAuth is isolated from upstream GitHub/Google sign-in. */
export async function routeIntegrationOAuth(req: Request, env: Env, url: URL): Promise<Response> {
  try {
    const config = await oauthConfig(env);
    if (!config) return oauthJson({ error: 'not_found' }, 404);
    if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') return oauthJson(metadata(config));
    if (url.pathname === '/oauth/jwks' && req.method === 'GET') return oauthJson({ keys: config.publicKeys });
    return oauthJson({ error: 'not_found' }, 404);
  } catch (error) { return oauthError(error); }
}
