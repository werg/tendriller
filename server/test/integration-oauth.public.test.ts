import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Env } from '../src/env';
import { route } from '../src/router';
import { oauthConfig, signAccessToken } from '../src/accounts/oauth-support';
import { challengeFor } from '../src/accounts/oauth-support';
import { sha256Hex } from '../src/ids';
import { create, inDO } from './helpers';

const ISSUER = 'https://tendriller.dev', RESOURCE = 'https://integration.example/mcp';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const MANAGEMENT = 'https://integration.example/connections/callback', BRIDGE_SECRET = 'test-bridge-' + 'b'.repeat(52);
let privateJwk: JsonWebKey, publicJwk: JsonWebKey;
let bridgeHash: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
  bridgeHash = await sha256Hex(BRIDGE_SECRET);
});
function configured(overrides: Partial<Env> = {}): Env {
  return { ...env, OAUTH_CONFIG_JSON: JSON.stringify({ resource: RESOURCE, clients: [
    { id: 'chatgpt', name: 'ChatGPT', redirectUris: [REDIRECT], scopes: ['applications:read', 'events:subscribe'], allowRefresh: true },
  ], bridges: [{ id: 'node-bridge', name: 'Tendriller connection settings', secretSha256: bridgeHash, applicationIds: [], managementRedirectUris: [MANAGEMENT] }] }),
  OAUTH_SIGNING_JWK: JSON.stringify({ ...privateJwk, kid: 'signing-1', alg: 'ES256' }), ...overrides };
}
function request(path: string, settings: Env = configured(), init: RequestInit = {}) {
  return route(new Request(ISSUER + path, init), settings);
}

it('first-party OAuth stays disabled until explicitly configured and remains on the service origin', async () => {
  expect((await request('/.well-known/oauth-authorization-server', { ...env, OAUTH_CONFIG_JSON: undefined })).status).toBe(404);
  expect((await route(new Request('https://other.example/.well-known/oauth-authorization-server'), configured())).status).toBe(404);
  expect((await request('/.well-known/oauth-authorization-server', configured({ OAUTH_SIGNING_JWK: undefined }))).status).toBe(503);
});

it('discovery binds the exact resource issuer, PKCE and preconfigured client authentication', async () => {
  const response = await request('/.well-known/oauth-authorization-server');
  expect(response.status).toBe(200);
  const value = await response.json() as Record<string, unknown>;
  expect(value).toMatchObject({ issuer: ISSUER, authorization_endpoint: ISSUER + '/oauth/authorize', token_endpoint: ISSUER + '/oauth/token',
    code_challenge_methods_supported: ['S256'], response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: false });
  expect(value.registration_endpoint).toBeUndefined();
  expect(value.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

it('JWKS contains only public keys and real JWT signatures validate against the published key', async () => {
  const settings = configured(), config = await oauthConfig(settings);
  const response = await request('/oauth/jwks', settings), text = await response.text();
  expect(text).not.toContain('"d"'); expect(text).not.toContain(privateJwk.d);
  const value = JSON.parse(text);
  expect(value.keys).toEqual([{ kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y, alg: 'ES256', kid: 'signing-1', use: 'sig', key_ops: ['verify'] }]);
  const token = await signAccessToken(config!, { iss: ISSUER, aud: RESOURCE, sub: 'owner', exp: Math.floor(Date.now() / 1000) + 300 });
  const [header, payload, signature] = token.split('.');
  const key = await crypto.subtle.importKey('jwk', value.keys[0], { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes, new TextEncoder().encode(header + '.' + payload))).toBe(true);
  expect(JSON.parse(atob(header))).toEqual({ typ: 'at+jwt', alg: 'ES256', kid: 'signing-1' });
});

it.each(['wildcard redirect', 'unsupported scope', 'duplicate client', 'private old key', 'short lifetime'])(
  'invalid OAuth configuration fails closed without exposing secrets: %s', async reason => {
    const settings = configured(), value = JSON.parse(settings.OAUTH_CONFIG_JSON!);
    if (reason === 'wildcard redirect') value.clients[0].redirectUris = ['http://client.example/callback'];
    if (reason === 'unsupported scope') value.clients[0].scopes = ['admin:*'];
    if (reason === 'duplicate client') value.clients.push(value.clients[0]);
    if (reason === 'private old key') settings.OAUTH_PUBLIC_JWKS = JSON.stringify({ keys: [{ ...privateJwk, kid: 'old', alg: 'ES256' }] });
    if (reason === 'short lifetime') value.accessTokenTtlSeconds = 0;
    settings.OAUTH_CONFIG_JSON = JSON.stringify(value);
    const response = await request('/oauth/jwks', settings);
    expect(response.status).toBe(503);
    const body = await response.text(); expect(body).not.toContain(privateJwk.d); expect(body).not.toContain('admin:*');
  });

async function hostFixture() {
  const page = await create(), subject = await inDO(page.id, t => t.db.get<string>('owner_account', ''));
  const raw = 'browser-' + crypto.randomUUID(), now = Date.now();
  await env.ACCOUNTS.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)')
    .bind(await sha256Hex(raw), subject, now, now + 3600000).run();
  const settings = configured(), value = JSON.parse(settings.OAUTH_CONFIG_JSON!);
  value.bridges[0].applicationIds = [page.application.id]; settings.OAUTH_CONFIG_JSON = JSON.stringify(value);
  return { page, subject, settings, raw, cookie: '__Host-tendriller=' + raw };
}
function jsonPost(path: string, input: unknown, settings: Env, secret = BRIDGE_SECRET) {
  return request(path, settings, { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}
function formPost(path: string, input: Record<string, string>, settings: Env, cookie: string, origin = ISSUER) {
  return request(path, settings, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(input) });
}
async function handoff(fixture: Awaited<ReturnType<typeof hostFixture>>, decision = 'allow') {
  const verifier = 'v'.repeat(43), state = 'browser-state-' + crypto.randomUUID();
  const params = new URLSearchParams({ client_id: 'node-bridge', redirect_uri: MANAGEMENT, state,
    code_challenge_method: 'S256', code_challenge: await challengeFor(verifier) });
  const response = await request('/oauth/management/login?' + params, fixture.settings, { headers: { Cookie: fixture.cookie } });
  expect(response.status).toBe(200); expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  const token = /name="intent" value="([^"]+)"/u.exec(await response.text())![1];
  const approved = await formPost('/oauth/management/login', { intent: token, decision }, fixture.settings, fixture.cookie);
  expect(approved.status).toBe(303);
  const location = new URL(approved.headers.get('Location')!);
  expect(location.origin + location.pathname).toBe(MANAGEMENT); expect(location.searchParams.get('state')).toBe(state);
  expect(location.searchParams.get('iss')).toBe(ISSUER);
  return { location, verifier, token };
}

it('service account lookup requires its own credential and derives owner/access from the current page policy', async () => {
  const f = await hostFixture(), input = { issuer: ISSUER, subject: f.subject, applicationId: f.page.application.id, pageId: f.page.id };
  expect((await jsonPost('/oauth/account-access', input, f.settings, 'x'.repeat(64))).status).toBe(401);
  expect((await request('/account/integration-access', f.settings, { headers: { 'x-account-id': f.subject, 'x-application-id': f.page.application.id } })).status).toBe(404);
  const response = await jsonPost('/oauth/account-access', input, f.settings), result = await response.json() as Record<string, unknown>;
  expect(result).toMatchObject({ active: true, access: true, owner: true, oauthAuthorized: false, scopes: [] });
  expect(JSON.stringify(result)).not.toContain(f.page.token); expect(JSON.stringify(result)).not.toContain(f.page.page_url);
  expect(await (await jsonPost('/oauth/account-access', { ...input, applicationId: 'f'.repeat(64) }, f.settings)).json()).toMatchObject({ access: false, owner: false });
  expect(await (await jsonPost('/oauth/account-access', { ...input, issuer: 'https://other.example' }, f.settings)).json()).toMatchObject({ active: false, access: false });
  const accountOnly = await (await jsonPost('/oauth/account-access', { issuer: ISSUER, subject: f.subject }, f.settings)).json() as { account: { email: string } };
  expect(accountOnly.account.email).toContain('@example.com');
  await env.ACCOUNTS.prepare('DELETE FROM identity_emails WHERE subject=?').bind(f.subject).run();
  expect(await (await jsonPost('/oauth/account-access', { issuer: ISSUER, subject: f.subject }, f.settings)).json()).not.toHaveProperty('account.email');
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), f.subject).run();
  expect(await (await jsonPost('/oauth/account-access', input, f.settings)).json()).toMatchObject({ active: false, access: false, owner: false });
});

it('guest access and grant authorization are current, exact and independent of another active grant', async () => {
  const f = await hostFixture(), guest = crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at) VALUES(?,?)').bind(guest, Date.now()).run();
  const link = await inDO(f.page.id, async t => {
    const link = await t.createLink('guest', 'OAuth test', null);
    t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)', guest, link.id, t.now());
    return link.id;
  });
  const input = { issuer: ISSUER, subject: guest, applicationId: f.page.application.id, pageId: f.page.id };
  expect(await (await jsonPost('/oauth/account-access', input, f.settings)).json()).toMatchObject({ active: true, access: true, owner: false });
  await inDO(f.page.id, t => t.db.run('DELETE FROM links WHERE id=?', link));
  expect(await (await jsonPost('/oauth/account-access', input, f.settings)).json()).toMatchObject({ active: true, access: false, owner: false });
  const now = Date.now(), granted = 'grant-' + crypto.randomUUID(), revoked = 'grant-' + crypto.randomUUID();
  for (const [id, revokedAt] of [[granted, null], [revoked, now]] as const)
    await env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,created_at,expires_at,revoked_at)
      VALUES(?,?,'chatgpt',?,'events:subscribe',?,?,?)`).bind(id, f.subject, RESOURCE, now, now + 600000, revokedAt).run();
  const ownerInput = { ...input, subject: f.subject };
  expect(await (await jsonPost('/oauth/account-access', { ...ownerInput, grantId: granted }, f.settings)).json()).toMatchObject({ oauthAuthorized: true, scopes: ['events:subscribe'] });
  expect(await (await jsonPost('/oauth/account-access', { ...ownerInput, grantId: revoked }, f.settings)).json()).toMatchObject({ oauthAuthorized: false, scopes: [] });
  expect(await (await jsonPost('/oauth/account-access', { ...input, grantId: granted }, f.settings)).json()).toMatchObject({ oauthAuthorized: false });
});

it('management handoff requires existing browser login, explicit approval, PKCE and one-time exchange', async () => {
  const f = await hostFixture(), verifier = 'v'.repeat(43), params = new URLSearchParams({ client_id: 'node-bridge', redirect_uri: MANAGEMENT,
    state: 'test-state', code_challenge_method: 'S256', code_challenge: await challengeFor(verifier) });
  const signIn = await request('/oauth/management/login?' + params, f.settings);
  expect(signIn.status).toBe(303); expect(signIn.headers.get('Location')).toMatch(/^\/auth\?return_to=/u);
  const { location } = await handoff(f), code = location.searchParams.get('code')!;
  const input = { code, redirect_uri: MANAGEMENT, code_verifier: verifier };
  expect((await jsonPost('/oauth/management/exchange', { ...input, code_verifier: 'x'.repeat(43) }, f.settings)).status).toBe(400);
  expect((await jsonPost('/oauth/management/exchange', input, f.settings, 'x'.repeat(64))).status).toBe(401);
  const exchanged = await jsonPost('/oauth/management/exchange', input, f.settings);
  expect(exchanged.status).toBe(200);
  const value = await exchanged.json() as { id: string; issuer: string; expiresAt: number };
  expect(value).toMatchObject({ id: f.subject, issuer: ISSUER }); expect(value.expiresAt).toBeGreaterThan(Date.now());
  expect(value.expiresAt).toBeLessThanOrEqual(Date.now() + 900000);
  expect(JSON.stringify(value)).not.toContain(f.raw);
  expect((await jsonPost('/oauth/management/exchange', input, f.settings)).status).toBe(400);
  expect((await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM integration_oauth_grants WHERE account_id=?').bind(f.subject).first<{ n: number }>())!.n).toBe(0);
});

it('handoff denial, changed session, hostile origin and logout cannot produce a management identity', async () => {
  const f = await hostFixture();
  const denied = await handoff(f, 'deny'); expect(denied.location.searchParams.get('error')).toBe('access_denied');
  expect(denied.location.searchParams.has('code')).toBe(false);
  const verifier = 'v'.repeat(43), params = new URLSearchParams({ client_id: 'node-bridge', redirect_uri: MANAGEMENT,
    state: 'test-state', code_challenge_method: 'S256', code_challenge: await challengeFor(verifier) });
  const response = await request('/oauth/management/login?' + params, f.settings, { headers: { Cookie: f.cookie } });
  const token = /name="intent" value="([^"]+)"/u.exec(await response.text())![1];
  expect((await formPost('/oauth/management/login', { intent: token, decision: 'allow' }, f.settings, f.cookie, 'https://attacker.example')).status).toBe(403);
  const other = 'other-' + crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)').bind(await sha256Hex(other), f.subject, Date.now(), Date.now() + 60000).run();
  expect((await formPost('/oauth/management/login', { intent: token, decision: 'allow' }, f.settings, '__Host-tendriller=' + other)).status).toBe(403);
  const { location } = await handoff(f);
  await env.ACCOUNTS.prepare('DELETE FROM sessions WHERE hash=?').bind(await sha256Hex(f.raw)).run();
  expect((await jsonPost('/oauth/management/exchange', { code: location.searchParams.get('code'), redirect_uri: MANAGEMENT, code_verifier: verifier }, f.settings)).status).toBe(400);
});
