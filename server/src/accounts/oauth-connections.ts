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
  return authorizationPage('Connected integrations', `<a class="back-link" href="/dashboard">← Back to dashboard</a><div class="page-head"><span class="eyebrow">Integrations</span><h1>Connected OAuth clients</h1>
    <p class="lead">Manage which external clients can act on your account. Revoking stops future token use and subscriptions.</p></div>
    <div class="stack">${rows.results.length ? rows.results.map(grant => {
      const client = config.clients.find(value => value.id === grant.client_id), active = grant.revoked_at === null && grant.expires_at > Date.now();
      return `<section class="card"><div class="card-head"><div><h2>${escapeHtml(client?.name ?? grant.client_id)}</h2><p>Expires ${escapeHtml(new Date(grant.expires_at).toISOString())}</p></div><span class="badge${active ? ' ok' : ''}">${active ? 'Active' : 'Revoked or expired'}</span></div>
        <dl class="meta-grid"><dt>Resource</dt><dd><code>${escapeHtml(grant.resource)}</code></dd><dt>Permissions</dt><dd>${escapeHtml(grant.scope || 'Account identity only')}</dd></dl>
        ${active ? `<form method="post"><input type="hidden" name="intent" value="${csrf}"><input type="hidden" name="grant_id" value="${escapeHtml(grant.id)}"><div class="actions"><button class="danger sm" type="submit">Revoke authorization</button></div></form>` : ''}</section>`;
    }).join('') : '<p class="empty">No integration authorizations.</p>'}</div>`);
}
