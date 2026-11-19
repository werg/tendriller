import type { Env } from '../env';
import { browserIdentity, consumeIntent, intent, redirect, sameOrigin, type OAuthGrant } from './oauth-data';
import { authorizationPage, escapeHtml } from './oauth-management';
import { form, oauthJson, reject, text, type OAuthConfig } from './oauth-support';

/** Browser owners can revoke OAuth grants independently from application consent. */
export async function oauthConnections(req: Request, env: Env, config: OAuthConfig): Promise<Response> {
  if (!['GET', 'POST'].includes(req.method)) return oauthJson({ error: 'invalid_request' }, 405, { Allow: 'GET, POST' });
  const browser = await browserIdentity(req, env);
  if (!browser) return req.method === 'GET' ? redirect('/auth?return_to=%2Foauth%2Fconnections') : oauthJson({ error: 'access_denied' }, 401);
  if (req.method === 'POST') {
    sameOrigin(req, config);
    const params = await form(req);
    if ([...params.keys()].some(key => !['intent', 'grant_id'].includes(key))) reject('invalid_request', 'Unexpected revocation fields');
    const value = await consumeIntent(env, browser, 'revoke', text(params.get('intent'), 'revocation form', 128));
    if (value.resource !== config.resource) reject('access_denied', 'Integration configuration changed', 403);
    await env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND account_id=? AND resource=?')
      .bind(Date.now(), text(params.get('grant_id'), 'grant ID', 128), browser.id, config.resource).run();
    return redirect('/oauth/connections');
  }
  const csrf = await intent(env, browser, 'revoke', { resource: config.resource });
  const rows = await env.ACCOUNTS.prepare('SELECT * FROM integration_oauth_grants WHERE account_id=? AND resource=? ORDER BY created_at DESC LIMIT 100')
    .bind(browser.id, config.resource).all<OAuthGrant>();
  return authorizationPage('Connected integrations', `<h1>Connected integrations</h1>
    <p>These authorizations identify which integration clients may act for your account. Individual application connections have their own permissions.</p>
    <p>Revoking an authorization stops future token use and subscriptions bound to that authorization. Requests already sent cannot be retracted.</p>
    ${rows.results.length ? rows.results.map(grant => {
      const client = config.clients.find(value => value.id === grant.client_id), active = grant.revoked_at === null && grant.expires_at > Date.now();
      return `<section class="card"><h2>${escapeHtml(client?.name ?? grant.client_id)}</h2><p>${active ? 'Active' : 'Revoked or expired'} · Expires ${escapeHtml(new Date(grant.expires_at).toISOString())}</p>
        <p><code>${escapeHtml(grant.resource)}</code></p><p>Permissions: ${escapeHtml(grant.scope || 'Account identity only')}</p>
        ${active ? `<form method="post"><input type="hidden" name="intent" value="${csrf}"><input type="hidden" name="grant_id" value="${escapeHtml(grant.id)}"><button type="submit">Revoke this authorization</button></form>` : ''}</section>`;
    }).join('') : '<p>No integration authorizations.</p>'}`);
}
