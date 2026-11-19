import type { Env } from '../env';
import { sha256Hex, TENDRIL_ID_RE } from '../ids';
import { servicePage } from './ui';
import { activeAccount, authorizationRedirect, bodyObject, browserIdentity, consumeIntent, intent, postOnly, redirect, sameOrigin, scopesOf } from './oauth-data';
import { bridgeIdentity, checkedChallenge, checkedParameters, checkVerifier, form, oauthJson, randomToken, reject, text, type OAuthConfig } from './oauth-support';

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export function authorizationPage(title: string, body: string, callbackOrigin?: string): Response {
  const response = servicePage(title, body);
  // Browsers also apply form-action to the redirect after the same-origin POST.
  const formTargets = callbackOrigin ? `'self' ${callbackOrigin}` : "'self'";
  response.headers.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action ${formTargets}; base-uri 'none'; frame-ancestors 'none'`);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
export function decisionForm(token: string, button: string): string {
  return `<form method="post"><input type="hidden" name="intent" value="${escapeHtml(token)}"><div class="actions"><button type="submit" name="decision" value="allow">${escapeHtml(button)}</button><button class="secondary" type="submit" name="decision" value="deny">Cancel</button></div></form>`;
}

export async function bridgeStatus(req: Request, env: Env, config: OAuthConfig): Promise<Response> {
  const wrongMethod = postOnly(req); if (wrongMethod) return wrongMethod;
  const bridge = await bridgeIdentity(req, config, env);
  await bodyObject(req, []);
  return oauthJson({ bridgeId: bridge.id, resource: config.resource, applicationIds: bridge.applicationIds,
    managementRedirectUris: bridge.managementRedirectUris, authorizationServerReady: true });
}

export async function accountAccess(req: Request, env: Env, config: OAuthConfig): Promise<Response> {
  const wrongMethod = postOnly(req); if (wrongMethod) return wrongMethod;
  const bridge = await bridgeIdentity(req, config, env);
  const input = await bodyObject(req, ['issuer', 'subject', 'applicationId', 'pageId', 'grantId', 'managementSessionId'], ['issuer', 'subject']);
  const subject = text(input.subject, 'subject', 512), issuer = text(input.issuer, 'issuer', 2048);
  const scoped = input.applicationId !== undefined || input.pageId !== undefined;
  if (scoped && (typeof input.applicationId !== 'string' || !/^[a-f0-9]{64}$/u.test(input.applicationId) || typeof input.pageId !== 'string' || !TENDRIL_ID_RE.test(input.pageId)))
    reject('invalid_request', 'applicationId and pageId must identify one configured page');
  const grantId = input.grantId === undefined ? undefined : text(input.grantId, 'grant ID', 128);
  const managementHash = input.managementSessionId === undefined ? undefined : await sha256Hex(text(input.managementSessionId, 'management session', 128));
  const managementActive = async () => {
    if (managementHash === undefined) return true;
    const now = Date.now();
    const ticket = await env.ACCOUNTS.prepare(`SELECT m.redirect_uri FROM integration_oauth_management_sessions m
      JOIN sessions s ON s.hash=m.session_hash AND s.account_id=m.account_id JOIN accounts a ON a.id=m.account_id
      WHERE m.hash=? AND m.bridge_id=? AND m.account_id=? AND m.resource=? AND m.expires_at>? AND s.expires_at>?
        AND a.suspended_at IS NULL AND a.deleting_at IS NULL`)
      .bind(managementHash, bridge.id, subject, config.resource, now, now).first<{ redirect_uri: string }>();
    return !!ticket && bridge.managementRedirectUris.includes(ticket.redirect_uri);
  };
  const active = issuer === config.issuer && await activeAccount(env, subject) && await managementActive();
  let access = false, owner = false;
  if (active && scoped && bridge.applicationIds.includes(input.applicationId as string)) {
    const stub = env.TENDRIL.get(env.TENDRIL.idFromName(input.pageId as string));
    const response = await stub.fetch(new Request('https://tendril.internal/account/integration-access', {
      headers: { 'x-account-id': subject, 'x-application-id': input.applicationId as string },
    }));
    if (response.ok) {
      const result = await response.json() as { access: boolean; owner: boolean };
      access = result.access === true; owner = access && result.owner === true;
    } else if (![403, 404].includes(response.status)) { await response.body?.cancel(); reject('temporarily_unavailable', 'Current page access cannot be established', 503); }
    else await response.body?.cancel();
  }
  const verified = active && !scoped ? await env.ACCOUNTS.prepare(`SELECT e.email FROM identity_emails e JOIN identities i
    ON i.provider=e.provider AND i.subject=e.subject JOIN accounts a ON a.id=i.account_id
    WHERE a.id=? AND a.suspended_at IS NULL AND a.deleting_at IS NULL ORDER BY CASE WHEN lower(e.email)=lower(a.email) THEN 0 ELSE 1 END,e.email LIMIT 1`)
    .bind(subject).first<{ email: string }>() : null;
  const now = Date.now();
  const final = active ? await env.ACCOUNTS.prepare(`SELECT
      (SELECT m.redirect_uri FROM integration_oauth_management_sessions m
        JOIN sessions s ON s.hash=m.session_hash AND s.account_id=m.account_id
        WHERE m.hash=? AND m.bridge_id=? AND m.account_id=a.id AND m.resource=? AND m.expires_at>? AND s.expires_at>?) AS management_uri,
      (SELECT json_object('client_id', g.client_id, 'scope', g.scope) FROM integration_oauth_grants g
        WHERE g.id=? AND g.resource=? AND g.account_id=a.id AND g.revoked_at IS NULL AND g.expires_at>?) AS grant_json
    FROM accounts a WHERE a.id=? AND a.suspended_at IS NULL AND a.deleting_at IS NULL`)
    .bind(managementHash ?? null, bridge.id, config.resource, now, now, grantId ?? null, config.resource, now, subject)
    .first<{ management_uri: string | null; grant_json: string | null }>() : null;
  const stillActive = !!final && (managementHash === undefined || !!final.management_uri &&
    bridge.managementRedirectUris.includes(final.management_uri));
  const grant = final?.grant_json ? JSON.parse(final.grant_json) as { client_id: string; scope: string } : null;
  const scopes = grant ? scopesOf(grant) : [];
  const client = grant && config.clients.find(value => value.id === grant.client_id);
  const oauthAuthorized = stillActive && !!client && scopes.every(scope => client.scopes.includes(scope));
  return oauthJson({ active: stillActive, access: stillActive && access, owner: stillActive && owner,
    oauthAuthorized, scopes: oauthAuthorized ? scopes : [],
    ...(stillActive ? { account: { id: subject, issuer: config.issuer, ...(verified ? { email: verified.email } : {}) } } : {}),
    ...(scoped ? { applicationId: input.applicationId, pageId: input.pageId } : {}) });
}

export async function managementLogin(req: Request, env: Env, config: OAuthConfig, url: URL): Promise<Response> {
  if (!['GET', 'POST'].includes(req.method)) return oauthJson({ error: 'invalid_request' }, 405, { Allow: 'GET, POST' });
  if (req.method === 'GET') {
    const params = checkedParameters(url.searchParams), id = text(params.get('client_id'), 'bridge ID', 128);
    const bridge = config.bridges.find(value => value.id === id), uri = params.get('redirect_uri');
    if (!bridge || !uri || !bridge.managementRedirectUris.includes(uri)) reject('invalid_request', 'Unregistered management callback');
    const state = text(params.get('state'), 'state', 2048), challenge = checkedChallenge(params.get('code_challenge'), params.get('code_challenge_method'));
    const browser = await browserIdentity(req, env);
    if (!browser) return redirect('/auth?return_to=' + encodeURIComponent(url.pathname + url.search));
    const token = await intent(env, browser, 'handoff', { bridgeId: id, uri, state, challenge, resource: config.resource });
    return authorizationPage('Sign in to integration management', `<h1>Sign in to ${escapeHtml(bridge!.name)}</h1>
      <p>Continue as ${escapeHtml(browser.email ?? browser.id)} to manage your integration connections at <strong>${escapeHtml(new URL(uri!).origin)}</strong>.</p>
      <p>This signs you in to that service. You will choose individual application permissions there; this step grants no page, device or publication authority.</p>
      ${decisionForm(token, 'Continue to connection settings')}`);
  }
  sameOrigin(req, config);
  const browser = await browserIdentity(req, env);
  if (!browser) reject('access_denied', 'Sign in before continuing', 401);
  const params = await form(req);
  if ([...params.keys()].some(key => !['intent', 'decision'].includes(key)) || !['allow', 'deny'].includes(params.get('decision') ?? '')) reject('invalid_request', 'Choose allow or deny');
  const value = await consumeIntent(env, browser!, 'handoff', text(params.get('intent'), 'form token', 128));
  const bridge = config.bridges.find(item => item.id === value.bridgeId);
  if (!bridge || !bridge.managementRedirectUris.includes(value.uri as string) || value.resource !== config.resource) reject('access_denied', 'Management configuration changed', 403);
  if (params.get('decision') === 'deny') return authorizationRedirect(config, value.uri as string, value.state as string, { error: 'access_denied' });
  const code = randomToken(), now = Date.now();
  const saved = await env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_handoffs(hash,bridge_id,account_id,session_hash,redirect_uri,challenge,expires_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions s JOIN accounts a ON a.id=s.account_id
      WHERE s.hash=? AND s.account_id=? AND s.expires_at>? AND a.suspended_at IS NULL AND a.deleting_at IS NULL)
    AND (SELECT COUNT(*) FROM integration_oauth_handoffs WHERE account_id=?)<20`)
    .bind(await sha256Hex(code), bridge!.id, browser!.id, browser!.sessionHash, value.uri, value.challenge, now + 60000,
      browser!.sessionHash, browser!.id, now, browser!.id).run();
  if (saved.meta.changes !== 1) reject('access_denied', 'The browser session expired or too many sign-ins are pending', 403);
  return authorizationRedirect(config, value.uri as string, value.state as string, { code });
}

export async function managementExchange(req: Request, env: Env, config: OAuthConfig): Promise<Response> {
  const wrongMethod = postOnly(req); if (wrongMethod) return wrongMethod;
  const bridge = await bridgeIdentity(req, config, env);
  const input = await bodyObject(req, ['code', 'redirect_uri', 'code_verifier']);
  const code = text(input.code, 'handoff code', 128), uri = text(input.redirect_uri, 'callback', 2048);
  if (!bridge.managementRedirectUris.includes(uri)) reject('invalid_grant', 'Invalid management handoff');
  const hash = await sha256Hex(code);
  const pending = await env.ACCOUNTS.prepare(`SELECT challenge FROM integration_oauth_handoffs
    WHERE hash=? AND bridge_id=? AND redirect_uri=? AND expires_at>?`).bind(hash, bridge.id, uri, Date.now()).first<{ challenge: string }>();
  if (!pending) reject('invalid_grant', 'Management handoff expired or was already used');
  await checkVerifier(input.code_verifier, pending!.challenge);
  const claimed = await env.ACCOUNTS.prepare(`DELETE FROM integration_oauth_handoffs WHERE hash=? AND bridge_id=? AND redirect_uri=? AND expires_at>?
    AND EXISTS(SELECT 1 FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.hash=integration_oauth_handoffs.session_hash
      AND s.account_id=integration_oauth_handoffs.account_id AND s.expires_at>? AND a.suspended_at IS NULL AND a.deleting_at IS NULL)
    RETURNING account_id,session_hash`).bind(hash, bridge.id, uri, Date.now(), Date.now()).first<{ account_id: string; session_hash: string }>();
  if (!claimed) reject('invalid_grant', 'Management handoff expired or was already used');
  // This opaque proof is bound to the original host session, including after exchange.
  // Deleting that session cascades to the ticket; expiration and suspension are checked on each use.
  const managementSessionId = randomToken(), now = Date.now();
  const session = await env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_management_sessions
      (hash,bridge_id,account_id,session_hash,resource,redirect_uri,expires_at)
    SELECT ?,?,s.account_id,s.hash,?,?,MIN(s.expires_at,?) FROM sessions s JOIN accounts a ON a.id=s.account_id
    WHERE s.hash=? AND s.account_id=? AND s.expires_at>? AND a.suspended_at IS NULL AND a.deleting_at IS NULL
      AND (SELECT COUNT(*) FROM integration_oauth_management_sessions WHERE account_id=s.account_id AND expires_at>?)<20
    RETURNING expires_at`)
    .bind(await sha256Hex(managementSessionId), bridge.id, config.resource, uri, now + 900000,
      claimed!.session_hash, claimed!.account_id, now, now).first<{ expires_at: number }>();
  if (!session) reject('invalid_grant', 'The browser session expired or too many management sessions are active');
  return oauthJson({ id: claimed!.account_id, issuer: config.issuer, expiresAt: session!.expires_at, managementSessionId });
}
