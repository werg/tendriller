import type { Env } from '../env';
import { sha256Hex } from '../ids';
import { authorizationRedirect, browserIdentity, consumeIntent, intent, redirect, sameOrigin } from './oauth-data';
import { authorizationPage, decisionForm, escapeHtml } from './oauth-management';
import { checkedChallenge, checkedParameters, form, oauthJson, OAuthFailure, randomToken, reject, text, type OAuthClient, type OAuthConfig } from './oauth-support';

const descriptions: Record<string, string> = {
  'tendrils:list': 'List pages your account can access',
  'tendrils:create': 'Create a page for your verified account email',
  'applications:read': 'Read separately connected application data',
  'applications:write': 'Run separately permitted application commands',
  'events:subscribe': 'Subscribe to separately permitted application events',
  'pages:publish': 'Prepare and publish an explicitly reviewed, signed page release',
};
export function requestedScopes(raw: string | null, permitted: string[]): string[] {
  const scopes = raw === null ? [...permitted] : raw === '' ? [] : raw.split(' ');
  if (scopes.length > 6 || new Set(scopes).size !== scopes.length || scopes.some(scope => !permitted.includes(scope)))
    reject('invalid_scope', 'Requested scopes are not registered for this client');
  return scopes.sort();
}
const policy = (config: OAuthConfig, client: OAuthClient) => sha256Hex(JSON.stringify({ client, resource: config.resource,
  accessTokenTtlSeconds: config.accessTokenTtlSeconds, grantTtlSeconds: config.grantTtlSeconds }));
const lifetime = (seconds: number) => seconds % 86400 === 0 ? `${seconds / 86400} days` :
  seconds % 3600 === 0 ? `${seconds / 3600} hours` : seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;

export async function authorize(req: Request, env: Env, config: OAuthConfig, url: URL): Promise<Response> {
  if (!['GET', 'POST'].includes(req.method)) return oauthJson({ error: 'invalid_request' }, 405, { Allow: 'GET, POST' });
  if (req.method === 'GET') {
    const params = checkedParameters(url.searchParams), clientId = text(params.get('client_id'), 'client ID', 256);
    const client = config.clients.find(value => value.id === clientId), uri = params.get('redirect_uri');
    // Never redirect an error to a URI that has not matched an explicit registration.
    if (!client || !uri || !client.redirectUris.includes(uri)) reject('invalid_request', 'Unregistered OAuth client or redirect URI');
    const state = text(params.get('state'), 'state', 2048);
    let scope: string, challenge: string;
    try {
      if (params.get('response_type') !== 'code') reject('unsupported_response_type', 'Only authorization code is supported');
      if (params.has('response_mode') && params.get('response_mode') !== 'query') reject('invalid_request', 'Only query authorization responses are supported');
      if (params.get('resource') !== config.resource) reject('invalid_target', 'The exact configured MCP resource is required');
      if (params.get('prompt') === 'none') reject('interaction_required', 'Explicit authorization is required');
      scope = requestedScopes(params.get('scope'), client!.scopes).join(' ');
      challenge = checkedChallenge(params.get('code_challenge'), params.get('code_challenge_method'));
    } catch (error) {
      if (!(error instanceof OAuthFailure)) throw error;
      return authorizationRedirect(config, uri!, state, { error: error.code, error_description: error.message });
    }
    const browser = await browserIdentity(req, env);
    if (!browser) return redirect('/auth?return_to=' + encodeURIComponent(url.pathname + url.search));
    const token = await intent(env, browser, 'authorize', { clientId, uri, state, scope, challenge, resource: config.resource, policy: await policy(config, client!) });
    return authorizationPage('Connect an integration', `<h1>Connect ${escapeHtml(client!.name)}</h1>
      <p>Continue as ${escapeHtml(browser.email ?? browser.id)}. This client is requesting access to <code>${escapeHtml(config.resource)}</code>.</p>
      <ul>${scope! ? scope!.split(' ').map(name => `<li>${escapeHtml(descriptions[name])} <small>(${escapeHtml(name)})</small></li>`).join('') : '<li>Identify your linked account</li>'}</ul>
      <p>${client!.allowRefresh ? `Access tokens expire after ${config.accessTokenTtlSeconds} seconds. This authorization can renew access for up to ${lifetime(config.grantTtlSeconds)}, until you revoke it.` : `This authorization expires after ${config.accessTokenTtlSeconds} seconds and cannot renew itself.`}</p>
      <p>Individual applications still need explicit connection permission. Your browser login, device signing identity and page-owner privileges are never given to this client.</p>
      ${decisionForm(token, 'Allow these permissions')}<p><a href="/oauth/connections">Review existing authorizations</a></p>`);
  }
  sameOrigin(req, config);
  const browser = await browserIdentity(req, env);
  if (!browser) reject('access_denied', 'Sign in before authorizing a client', 401);
  const params = await form(req);
  if ([...params.keys()].some(key => !['intent', 'decision'].includes(key)) || !['allow', 'deny'].includes(params.get('decision') ?? '')) reject('invalid_request', 'Choose allow or deny');
  const value = await consumeIntent(env, browser!, 'authorize', text(params.get('intent'), 'authorization form', 128));
  const client = config.clients.find(item => item.id === value.clientId);
  if (!client || !client.redirectUris.includes(value.uri as string) || value.resource !== config.resource || value.policy !== await policy(config, client))
    reject('access_denied', 'Client configuration changed; review a new authorization request', 403);
  if (params.get('decision') === 'deny') return authorizationRedirect(config, value.uri as string, value.state as string, { error: 'access_denied' });
  const now = Date.now(), grantId = 'og_' + randomToken(), code = randomToken();
  const expiresAt = now + 1000 * (client!.allowRefresh ? config.grantTtlSeconds : config.accessTokenTtlSeconds);
  const results = await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,created_at,expires_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions s JOIN accounts a ON a.id=s.account_id
        WHERE s.hash=? AND s.account_id=? AND s.expires_at>? AND a.suspended_at IS NULL AND a.deleting_at IS NULL)
      AND (SELECT COUNT(*) FROM integration_oauth_grants WHERE account_id=?)<100`)
      .bind(grantId, browser!.id, client!.id, config.resource, value.scope, now, expiresAt, browser!.sessionHash, browser!.id, now, browser!.id),
    env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_codes(hash,grant_id,redirect_uri,challenge,expires_at)
      SELECT ?,id,?,?,? FROM integration_oauth_grants WHERE id=?`)
      .bind(await sha256Hex(code), value.uri, value.challenge, Math.min(expiresAt, now + 120000), grantId),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) reject('access_denied', 'Account session expired or authorization capacity reached', 403);
  return authorizationRedirect(config, value.uri as string, value.state as string, { code });
}
