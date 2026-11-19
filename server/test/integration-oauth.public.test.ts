import { beforeAll, expect, it, vi } from 'vitest';
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Env } from '../src/env';
import { route } from '../src/router';
import { oauthConfig, signAccessToken } from '../src/accounts/oauth-support';
import { challengeFor } from '../src/accounts/oauth-support';
import { sha256Hex } from '../src/ids';
import { bytesDigest, bytesToHex, describeApplication, eventExecutionManifest, executionManifestArtifacts, MemoryBytesStore,
  openApplicationDevice, openPeerApplication, participantGrant, signTransitionRequest } from '@chronolog/peer-session';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { createPeerIntroductions, createPeersClient } from '../../contract/peers.mjs';
import { definition } from '../../integrations/chatgpt/examples/kitchen/domain.mjs';
import { testPeerSocket, type TestHostTraffic } from './fixture-peer-socket';
import { advance, create, inDO, runAlarm, stub } from './helpers';

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
  const headers = new Headers(init.headers), bytes = crypto.getRandomValues(new Uint8Array(2));
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', `198.18.${bytes[0]}.${bytes[1]}`);
  return route(new Request(ISSUER + path, { ...init, headers }), settings);
}

it('first-party OAuth stays disabled until explicitly configured and remains on the service origin', async () => {
  expect((await request('/.well-known/oauth-authorization-server', { ...env, OAUTH_CONFIG_JSON: undefined })).status).toBe(404);
  expect((await route(new Request('https://other.example/.well-known/oauth-authorization-server'), configured())).status).toBe(404);
  expect((await request('/.well-known/oauth-authorization-server', configured({ OAUTH_SIGNING_JWK: undefined }))).status).toBe(503);
});

it('enabled OAuth names its missing additive migration while the ordinary host still works with OAuth disabled', async () => {
  const settings = configured();
  await env.ACCOUNTS.prepare('ALTER TABLE integration_oauth_management_sessions RENAME TO temporarily_absent_management_sessions').run();
  try {
    const metadata = await request('/.well-known/oauth-authorization-server', settings);
    expect(metadata.status).toBe(503); expect((await metadata.json() as { error_description: string }).error_description).toContain('0002_integration_oauth.sql');
    expect((await jsonPost('/oauth/bridge-status', {}, settings)).status).toBe(503);
    const disabled = { ...settings, OAUTH_CONFIG_JSON: undefined };
    expect((await request('/.well-known/oauth-authorization-server', disabled)).status).toBe(404);
    expect((await request('/api/service', disabled)).status).toBe(200);
  } finally {
    await env.ACCOUNTS.prepare('ALTER TABLE temporarily_absent_management_sessions RENAME TO integration_oauth_management_sessions').run();
  }
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
  const value = await exchanged.json() as { id: string; issuer: string; expiresAt: number; managementSessionId: string };
  expect(value).toMatchObject({ id: f.subject, issuer: ISSUER }); expect(value.expiresAt).toBeGreaterThan(Date.now());
  expect(value.expiresAt).toBeLessThanOrEqual(Date.now() + 900000);
  expect(value.managementSessionId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(await (await jsonPost('/oauth/account-access', { issuer: ISSUER, subject: f.subject, managementSessionId: value.managementSessionId }, f.settings)).json()).toMatchObject({ active: true });
  expect(JSON.stringify(value)).not.toContain(f.raw);
  expect((await jsonPost('/oauth/management/exchange', input, f.settings)).status).toBe(400);
  expect((await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM integration_oauth_grants WHERE account_id=?').bind(f.subject).first<{ n: number }>())!.n).toBe(0);
});

it('management tickets stay bound to the exact bridge, account, resource, callback and original host session', async () => {
  const f = await hostFixture(), { location, verifier } = await handoff(f), now = Date.now();
  await env.ACCOUNTS.prepare('UPDATE sessions SET expires_at=? WHERE hash=?').bind(now + 90000, await sha256Hex(f.raw)).run();
  const exchanged = await jsonPost('/oauth/management/exchange', { code: location.searchParams.get('code'), redirect_uri: MANAGEMENT, code_verifier: verifier }, f.settings);
  expect(exchanged.status).toBe(200);
  const result = await exchanged.json() as { managementSessionId: string; expiresAt: number };
  expect(result.expiresAt).toBe(now + 90000);
  const input = { issuer: ISSUER, subject: f.subject, managementSessionId: result.managementSessionId, applicationId: f.page.application.id, pageId: f.page.id };
  const lookup = async (value = input, settings = f.settings, secret = BRIDGE_SECRET) =>
    (await jsonPost('/oauth/account-access', value, settings, secret)).json();
  const denied = { active: false, access: false, owner: false, oauthAuthorized: false, scopes: [], applicationId: f.page.application.id, pageId: f.page.id };
  expect(await lookup()).toMatchObject({ active: true, access: true, owner: true });
  expect(await lookup({ ...input, managementSessionId: 'unknown' })).toEqual(denied);
  const other = await hostFixture();
  expect(await lookup({ ...input, subject: other.subject })).toEqual(denied);
  const bridgeSecret = 'second-' + 'c'.repeat(48), config = JSON.parse(f.settings.OAUTH_CONFIG_JSON!);
  config.bridges.push({ ...config.bridges[0], id: 'second-bridge', secretSha256: await sha256Hex(bridgeSecret) });
  expect(await lookup(input, { ...f.settings, OAUTH_CONFIG_JSON: JSON.stringify(config) }, bridgeSecret)).toEqual(denied);
  config.bridges.pop(); config.resource = 'https://changed.example/mcp';
  expect(await lookup(input, { ...f.settings, OAUTH_CONFIG_JSON: JSON.stringify(config) })).toEqual(denied);
  config.resource = RESOURCE; config.bridges[0].managementRedirectUris = [];
  expect(await lookup(input, { ...f.settings, OAUTH_CONFIG_JSON: JSON.stringify(config) })).toEqual(denied);
  const ticketHash = await sha256Hex(result.managementSessionId);
  expect(await env.ACCOUNTS.prepare('SELECT hash FROM integration_oauth_management_sessions WHERE hash=?').bind(ticketHash).first()).toEqual({ hash: ticketHash });
  await env.ACCOUNTS.prepare('UPDATE integration_oauth_management_sessions SET expires_at=? WHERE hash=?').bind(now - 1, ticketHash).run();
  expect(await lookup()).toEqual(denied);
  await env.ACCOUNTS.prepare('UPDATE integration_oauth_management_sessions SET expires_at=? WHERE hash=?').bind(now + 90000, ticketHash).run();
  await env.ACCOUNTS.prepare('UPDATE sessions SET expires_at=? WHERE hash=?').bind(now - 1, await sha256Hex(f.raw)).run();
  expect(await lookup()).toEqual(denied);
  await env.ACCOUNTS.prepare('UPDATE sessions SET expires_at=? WHERE hash=?').bind(now + 90000, await sha256Hex(f.raw)).run();
  expect((await formPost('/auth/logout', {}, f.settings, f.cookie)).status).toBe(302);
  expect(await lookup()).toEqual(denied);
  expect(await env.ACCOUNTS.prepare('SELECT hash FROM integration_oauth_management_sessions WHERE hash=?').bind(ticketHash).first()).toBeNull();
  // Account-only service authorization is separate; a management caller must always supply its ticket.
  const { managementSessionId: ignored, ...accountOnly } = input;
  expect(await (await jsonPost('/oauth/account-access', accountOnly, f.settings)).json()).toMatchObject({ active: true, access: true, owner: true });
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

function serviceForm(path: string, input: Record<string, string>, settings: Env, authorization?: string) {
  return request(path, settings, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(authorization ? { Authorization: authorization } : {}) },
    body: new URLSearchParams(input) });
}
function decodePart(value: string) { return JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))); }
async function authorization(f: Awaited<ReturnType<typeof hostFixture>>, overrides: Record<string, string> = {}, decision = 'allow') {
  const verifier = 'verifier-' + 'v'.repeat(43), state = 'state-' + crypto.randomUUID();
  const params = new URLSearchParams({ response_type: 'code', client_id: 'chatgpt', redirect_uri: REDIRECT, resource: RESOURCE,
    scope: 'applications:read events:subscribe', code_challenge_method: 'S256', code_challenge: await challengeFor(verifier), state, ...overrides });
  const response = await request('/oauth/authorize?' + params, f.settings, { headers: { Cookie: f.cookie } });
  expect(response.status).toBe(200);
  const html = await response.text(), token = /name="intent" value="([^"]+)"/u.exec(html)![1];
  expect(html).toContain('Allow these permissions'); expect(html).toContain('Individual applications still need explicit connection permission');
  const result = await formPost('/oauth/authorize', { intent: token, decision }, f.settings, f.cookie);
  expect(result.status).toBe(303);
  const location = new URL(result.headers.get('Location')!);
  expect(location.searchParams.get('iss')).toBe(ISSUER); expect(location.searchParams.get('state')).toBe(state);
  return { code: location.searchParams.get('code'), error: location.searchParams.get('error'), verifier, token };
}
async function tokens(f: Awaited<ReturnType<typeof hostFixture>>) {
  const approved = await authorization(f);
  const response = await serviceForm('/oauth/token', { client_id: 'chatgpt', grant_type: 'authorization_code', resource: RESOURCE,
    redirect_uri: REDIRECT, code: approved.code!, code_verifier: approved.verifier }, f.settings);
  expect(response.status).toBe(200);
  const result = await response.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
  return { ...result, approved, grantId: decodePart(result.access_token.split('.')[1]).sid as string };
}
async function introspection(token: string, settings: Env) {
  const response = await serviceForm('/oauth/introspect', { token }, settings, 'Bearer ' + BRIDGE_SECRET);
  expect(response.status).toBe(200); return response.json() as Promise<Record<string, unknown>>;
}

it('authorization code flow uses the actual browser account, exact audience and real asymmetric JWT', async () => {
  const f = await hostFixture(), issued = await tokens(f), [header, payload, signature] = issued.access_token.split('.');
  const claims = decodePart(payload);
  expect(decodePart(header)).toEqual({ typ: 'at+jwt', alg: 'ES256', kid: 'signing-1' });
  expect(claims).toMatchObject({ iss: ISSUER, sub: f.subject, aud: RESOURCE, client_id: 'chatgpt', scope: 'applications:read events:subscribe', sid: issued.grantId });
  expect(claims.exp - claims.iat).toBe(300); expect(issued.expires_in).toBeGreaterThan(0); expect(issued.expires_in).toBeLessThanOrEqual(300);
  const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
  expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes, new TextEncoder().encode(header + '.' + payload))).toBe(true);
  expect(await introspection(issued.access_token, f.settings)).toMatchObject({ active: true, sub: f.subject, sid: issued.grantId, aud: RESOURCE });
  const lookup = await jsonPost('/oauth/account-access', { issuer: ISSUER, subject: f.subject, applicationId: f.page.application.id, pageId: f.page.id, grantId: issued.grantId }, f.settings);
  expect(await lookup.json()).toMatchObject({ access: true, owner: true, oauthAuthorized: true, scopes: ['applications:read', 'events:subscribe'] });
  const rows = await env.ACCOUNTS.prepare('SELECT hash FROM integration_oauth_access WHERE grant_id=?').bind(issued.grantId).all();
  expect(JSON.stringify(rows.results)).not.toContain(issued.access_token);
  expect(rows.results[0]).toMatchObject({ hash: await sha256Hex(issued.access_token) });
});

it('authorization rejects unregistered redirects, duplicate parameters, missing S256 and excessive scopes', async () => {
  const f = await hostFixture(), base = { response_type: 'code', client_id: 'chatgpt', redirect_uri: REDIRECT, resource: RESOURCE,
    scope: 'applications:read', code_challenge_method: 'S256', code_challenge: await challengeFor('v'.repeat(43)), state: 'same-state' };
  const anonymous = await request('/oauth/authorize?' + new URLSearchParams(base), f.settings);
  expect(anonymous.status).toBe(303); expect(anonymous.headers.get('Location')).toMatch(/^\/auth\?return_to=/u);
  const unregistered = await request('/oauth/authorize?' + new URLSearchParams({ ...base, redirect_uri: 'https://attacker.example/callback' }), f.settings);
  expect(unregistered.status).toBe(400); expect(unregistered.headers.has('Location')).toBe(false);
  const duplicate = await request('/oauth/authorize?' + new URLSearchParams(base) + '&client_id=chatgpt', f.settings);
  expect(duplicate.status).toBe(400); expect(duplicate.headers.has('Location')).toBe(false);
  for (const [override, error] of [[{ code_challenge_method: 'plain' }, 'invalid_request'], [{ scope: 'pages:publish' }, 'invalid_scope'],
    [{ resource: 'https://other.example/mcp' }, 'invalid_target'], [{ response_type: 'token' }, 'unsupported_response_type']] as const) {
    const response = await request('/oauth/authorize?' + new URLSearchParams({ ...base, ...override }), f.settings);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('Location')!);
    expect(location.searchParams.get('error')).toBe(error); expect(location.searchParams.get('iss')).toBe(ISSUER);
    expect(location.searchParams.get('state')).toBe('same-state'); expect(location.searchParams.has('code')).toBe(false);
  }
  const denied = await authorization(f, {}, 'deny'); expect(denied.error).toBe('access_denied'); expect(denied.code).toBeNull();
});

it('code redemption binds PKCE, redirect and resource; reusing an exchanged code revokes its tokens', async () => {
  const f = await hostFixture(), approved = await authorization(f);
  const input = { grant_type: 'authorization_code', client_id: 'chatgpt', resource: RESOURCE, redirect_uri: REDIRECT, code: approved.code!, code_verifier: approved.verifier };
  for (const change of [{ resource: 'https://other.example/mcp' }, { redirect_uri: 'https://attacker.example/cb' }, { code_verifier: 'wrong'.repeat(12) }])
    expect((await serviceForm('/oauth/token', { ...input, ...change }, f.settings)).status).toBe(400);
  const valid = await serviceForm('/oauth/token', input, f.settings); expect(valid.status).toBe(200);
  const issued = await valid.json() as { access_token: string };
  expect((await introspection(issued.access_token, f.settings)).active).toBe(true);
  expect((await serviceForm('/oauth/token', { ...input, code_verifier: 'wrong'.repeat(12) }, f.settings)).status).toBe(400);
  expect((await introspection(issued.access_token, f.settings)).active).toBe(true);
  expect((await serviceForm('/oauth/token', input, f.settings)).status).toBe(400);
  expect(await introspection(issued.access_token, f.settings)).toEqual({ active: false });
});

it('refresh rotates one-use tokens, permits narrower scopes and revokes the entire grant on replay', async () => {
  const f = await hostFixture(), issued = await tokens(f);
  const input = { grant_type: 'refresh_token', client_id: 'chatgpt', resource: RESOURCE, refresh_token: issued.refresh_token };
  expect((await serviceForm('/oauth/token', { ...input, scope: 'pages:publish' }, f.settings)).status).toBe(400);
  const refreshed = await serviceForm('/oauth/token', { ...input, scope: 'applications:read' }, f.settings); expect(refreshed.status).toBe(200);
  const renewed = await refreshed.json() as { access_token: string; refresh_token: string; scope: string };
  expect(renewed.refresh_token).not.toBe(issued.refresh_token); expect(renewed.access_token).not.toBe(issued.access_token);
  expect(renewed.scope).toBe('applications:read'); expect((await introspection(renewed.access_token, f.settings)).active).toBe(true);
  expect((await serviceForm('/oauth/token', input, f.settings)).status).toBe(400);
  expect(await introspection(issued.access_token, f.settings)).toEqual({ active: false });
  expect(await introspection(renewed.access_token, f.settings)).toEqual({ active: false });
  expect((await serviceForm('/oauth/token', { ...input, refresh_token: renewed.refresh_token }, f.settings)).status).toBe(400);
});

it('concurrent refresh claims cannot create two usable replacements', async () => {
  const f = await hostFixture(), issued = await tokens(f), input = { grant_type: 'refresh_token', client_id: 'chatgpt', resource: RESOURCE, refresh_token: issued.refresh_token };
  const results = await Promise.all([serviceForm('/oauth/token', input, f.settings), serviceForm('/oauth/token', input, f.settings)]);
  expect(results.filter(response => response.status === 200).length).toBeLessThanOrEqual(1);
  expect(results.some(response => response.status === 400)).toBe(true);
  for (const response of results) if (response.status === 200) {
    const value = await response.json() as { access_token: string };
    expect(await introspection(value.access_token, f.settings)).toEqual({ active: false });
  }
  expect(await introspection(issued.access_token, f.settings)).toEqual({ active: false });
});

it('token revocation is idempotent and exact; another active grant does not restore it', async () => {
  const f = await hostFixture(), first = await tokens(f), second = await tokens(f);
  const input = { client_id: 'chatgpt', token: first.refresh_token, token_type_hint: 'refresh_token' };
  expect((await serviceForm('/oauth/revoke', input, f.settings)).status).toBe(200);
  expect((await serviceForm('/oauth/revoke', input, f.settings)).status).toBe(200);
  expect(await introspection(first.access_token, f.settings)).toEqual({ active: false });
  expect((await introspection(second.access_token, f.settings)).active).toBe(true);
  expect(await (await jsonPost('/oauth/account-access', { issuer: ISSUER, subject: f.subject, grantId: first.grantId }, f.settings)).json()).toMatchObject({ oauthAuthorized: false });
  expect(await (await jsonPost('/oauth/account-access', { issuer: ISSUER, subject: f.subject, grantId: second.grantId }, f.settings)).json()).toMatchObject({ oauthAuthorized: true });
  await env.ACCOUNTS.prepare('UPDATE accounts SET deleting_at=? WHERE id=?').bind(Date.now(), f.subject).run();
  expect(await introspection(second.access_token, f.settings)).toEqual({ active: false });
  expect((await serviceForm('/oauth/token', { grant_type: 'refresh_token', client_id: 'chatgpt', resource: RESOURCE, refresh_token: second.refresh_token }, f.settings)).status).toBe(400);
});

it('confidential clients require their registered Basic secret as well as PKCE', async () => {
  const f = await hostFixture(), secret = 'client-private-' + 's'.repeat(43), value = JSON.parse(f.settings.OAUTH_CONFIG_JSON!);
  Object.assign(value.clients[0], { tokenEndpointAuthMethod: 'client_secret_basic', clientSecretSha256: await sha256Hex(secret) });
  f.settings.OAUTH_CONFIG_JSON = JSON.stringify(value);
  const approved = await authorization(f), input = { grant_type: 'authorization_code', client_id: 'chatgpt', resource: RESOURCE,
    redirect_uri: REDIRECT, code: approved.code!, code_verifier: approved.verifier };
  expect((await serviceForm('/oauth/token', input, f.settings)).status).toBe(401);
  expect((await serviceForm('/oauth/token', { ...input, client_secret: secret }, f.settings)).status).toBe(401);
  expect((await serviceForm('/oauth/token', input, f.settings, 'Basic ' + btoa('chatgpt:wrong'))).status).toBe(401);
  expect((await serviceForm('/oauth/token', input, f.settings, 'Basic ' + btoa('chatgpt:' + encodeURIComponent(secret)))).status).toBe(200);
});

it('browser grant management revokes only the authenticated account and requires its current form', async () => {
  const f = await hostFixture(), other = await hostFixture(), issued = await tokens(f), foreign = await tokens(other);
  const page = await request('/oauth/connections', f.settings, { headers: { Cookie: f.cookie } });
  const html = await page.text(), token = /name="intent" value="([^"]+)"/u.exec(html)![1];
  expect(html).toContain(issued.grantId); expect(html).not.toContain(foreign.grantId);
  expect((await formPost('/oauth/connections', { intent: token, grant_id: issued.grantId }, f.settings, f.cookie, 'https://attacker.example')).status).toBe(403);
  expect((await formPost('/oauth/connections', { intent: token, grant_id: foreign.grantId }, f.settings, f.cookie)).status).toBe(303);
  expect((await introspection(foreign.access_token, other.settings)).active).toBe(true);
  const again = await request('/oauth/connections', f.settings, { headers: { Cookie: f.cookie } });
  const next = /name="intent" value="([^"]+)"/u.exec(await again.text())![1];
  expect((await formPost('/oauth/connections', { intent: next, grant_id: issued.grantId }, f.settings, f.cookie)).status).toBe(303);
  expect(await introspection(issued.access_token, f.settings)).toEqual({ active: false });
  expect((await formPost('/oauth/connections', { intent: next, grant_id: issued.grantId }, f.settings, f.cookie)).status).toBe(403);
});

it('RS256 signing and retained public keys support configured key rotation without publishing private material', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const signing = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  const settings = configured({ OAUTH_SIGNING_JWK: JSON.stringify({ ...signing, kid: 'rsa-2', alg: 'RS256' }),
    OAUTH_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, kid: 'signing-1', alg: 'ES256' }] }) });
  const config = (await oauthConfig(settings))!, token = await signAccessToken(config, { sub: 'test', aud: RESOURCE });
  const [header, payload, signature] = token.split('.'); expect(decodePart(header).alg).toBe('RS256');
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
  expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, bytes, new TextEncoder().encode(header + '.' + payload))).toBe(true);
  const jwks = await (await request('/oauth/jwks', settings)).json() as { keys: { kid: string; d?: string }[] };
  expect(jwks.keys.map(key => key.kid)).toEqual(['rsa-2', 'signing-1']); expect(jwks.keys.every(key => key.d === undefined)).toBe(true);
});

it('authenticated bridge preflight returns only its exact deployment settings without a user identity', async () => {
  const f = await hostFixture();
  expect((await jsonPost('/oauth/bridge-status', {}, f.settings, 'x'.repeat(64))).status).toBe(401);
  expect((await jsonPost('/oauth/bridge-status', { subject: f.subject }, f.settings)).status).toBe(400);
  const response = await jsonPost('/oauth/bridge-status', {}, f.settings);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ bridgeId: 'node-bridge', resource: RESOURCE, applicationIds: [f.page.application.id],
    managementRedirectUris: [MANAGEMENT], authorizationServerReady: true });
});


it('uses the page Worker for MCP, selected-event delivery and retry after eviction', async () => {
  const f = await hostFixture(), now = Date.now(), resource = ISSUER + '/mcp';
  const config = JSON.parse(f.settings.OAUTH_CONFIG_JSON!), scopes = 'applications:read applications:write events:subscribe';
  config.resource = resource;
  config.bridges = [];
  config.clients[0].scopes = scopes.split(' ');
  const settings: Partial<Env> = {
    OAUTH_CONFIG_JSON: JSON.stringify(config), OAUTH_SIGNING_JWK: f.settings.OAUTH_SIGNING_JWK,
    ASSISTANT_PAGE_ID: f.page.id, ASSISTANT_PAGE_TOKEN: f.page.token,
    ASSISTANT_STORE_KEY: btoa('test-local-assistant-store-key!!'),
    ASSISTANT_CALLBACK_ORIGINS: 'https://callback.example',
  };
  const previous = await inDO(f.page.id, t => {
    const before = Object.fromEntries(Object.keys(settings).map(key => [key, t.env[key as keyof Env]]));
    Object.assign(t.env, settings); return before;
  });
  const bind = { ...f.settings, ...settings }, oauth = (await oauthConfig(bind))!;
  const transportHeaders = { Authorization: 'Bearer ' + f.page.token, 'Content-Type': 'application/json' };
  const traffic: TestHostTraffic = { httpRequests: 0, requestBodyBytes: 0, rendezvousUpgrades: 0,
    rendezvousSentBytes: 0, rendezvousReceivedBytes: 0, invitationUpgrades: 0, invitationSentBytes: 0,
    invitationReceivedBytes: 0, relayUpgrades: 0, relaySentBytes: 0, relayReceivedBytes: 0 };
  const peers = createPeersClient({ base: f.page.api, applicationId: f.page.application.id,
    request: async (path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}) => {
      const response = await request(new URL(f.page.api).pathname + '/' + path, bind,
        { method: options.method, headers: transportHeaders, signal: options.signal,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
      if (!response.ok) throw Error(`${path}: ${response.status} ${await response.text()}`);
      return response.json();
    },
    socket: (raw: string, protocols: readonly string[]) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/relay')) traffic.relayUpgrades++;
      return testPeerSocket(() => request(url.pathname + url.search, bind,
        { headers: { ...transportHeaders, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols.join(', ') } }),
        traffic, url.pathname.endsWith('/relay') ? 'relay' : 'invitation');
    },
  });
  const pagePath = new URL(f.page.api).pathname;
  const deviceRequest = () => request(pagePath + '/assistant/device', bind, { method: 'POST', headers: transportHeaders });
  const generated = await deviceRequest();
  expect(generated.status, await generated.clone().text()).toBe(200);
  const { publicKey } = await generated.json() as { publicKey: string };
  expect((await (await deviceRequest()).json() as { publicKey: string }).publicKey).toBe(publicKey);
  const device = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
  const epochKey = crypto.getRandomValues(new Uint8Array(32)), manifest = await executionManifestArtifacts(await eventExecutionManifest());
  const base = await peers.configureApplication({
    historyId: 'kitchen-worker-assistant', definition: describeApplication(definition), schema: null,
    executionManifestDigest: bytesToHex(manifest.executionManifestDigest), schemaAdministrator: device.identity.publicKey,
    epoch: 0, keyDigest: await bytesDigest(epochKey),
    members: [
      { grant: participantGrant(device.identity.publicKey, { administrator: true }) },
      { grant: { ...participantGrant(publicKey), recovery: false, coordinator: false } },
    ],
  });
  const desc = base.descriptor.payload;
  await peers.selectGeneration(await signTransitionRequest({
    applicationId: desc.applicationId, profile: desc.profile, policy: desc.policy,
    transitionId: 'create-worker-assistant', expectedGeneration: null, requester: device.identity.publicKey,
    coordinator: device.identity.publicKey, controlRevision: 0, reason: 'create', base: null,
  }, device.identity));
  const session = await openPeerApplication({ device, definition, authority: await peers.application(), epochKeys: new Map([[0, epochKey]]) });
  const sent: { id: string; body: string }[] = [];
  const secretBytes = new Uint8Array(32).fill(9), secret = 'whsec_' + btoa(String.fromCharCode(...secretBytes));
  const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    expect(req.url).toBe('https://callback.example/events');
    const data = await req.text(), event = JSON.parse(data), id = req.headers.get('webhook-id')!;
    const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${req.headers.get('webhook-timestamp')}.${data}`));
    expect(req.headers.get('webhook-signature')).toBe('v1,' + btoa(String.fromCharCode(...new Uint8Array(signature))));
    if (event.type === 'verification') return Response.json({ challenge: event.challenge });
    sent.push({ id, body: data });
    return new Response(null, { status: sent.length === 1 ? 503 : 204 });
  });
  try {
    const control = session.connectControlParticipant({ exchange: (message, options) => peers.exchange(message, options) });
    await session.participate({ control, ...createPeerIntroductions({ peers, identity: session.deviceId, directTimeoutMs: 1,
      openDirectConnection: async () => { throw Error('Relay only test'); },
      openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay as Parameters<typeof openWebSocketConnection>[0], { ready: relay.ready, signal }) }) });
    const started = await session.command('setCookingStep', { stepId: 'first', text: 'Slice apples' } as never, { operationId: 'set-step' });
    await started.applied();

    const consent = await request('/connections', bind, { headers: { Cookie: f.cookie } });
    expect(consent.status, await consent.clone().text()).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await consent.text())?.[1];
    expect(csrf).toBeTruthy();
    const management = await formPost('/connections', { csrf: csrf!, action: 'grant',
      applicationId: f.page.application.id, queries: 'kitchenContext', commands: 'replyToAssistance', events: 'assistant.help_requested', days: '1' }, bind, f.cookie);
    expect(management.status, await management.clone().text()).toBe(303);
    const gid = 'assistant-' + crypto.randomUUID(), jti = 'jti-' + crypto.randomUUID();
    const token = await signAccessToken(oauth, { iss: ISSUER, aud: resource, sub: f.subject, sid: gid, jti,
      scope: scopes, exp: Math.floor((now + 300_000) / 1000) });
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare('INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .bind(gid, f.subject, 'chatgpt', resource, scopes, now, now + 600_000),
      env.ACCOUNTS.prepare('INSERT INTO integration_oauth_access(hash,grant_id,jti,scope,created_at,expires_at) VALUES (?,?,?,?,?,?)')
        .bind(await sha256Hex(token), gid, jti, scopes, now, now + 300_000),
    ]);
    const mcp = (method: string, params = {}) => jsonPost('/mcp', { jsonrpc: '2.0', id: 1, method, params }, bind, token);
    expect((await mcp('initialize')).status).toBe(200);
    expect(traffic.relayUpgrades).toBe(0);
    const idle = await request(pagePath + '/assistant/wake', bind, { method: 'POST', headers: transportHeaders });
    expect(idle.status).toBe(204);
    await inDO(f.page.id, t => expect(t.db.get('assistant_work', null)).toBeNull());
    const read = await mcp('tools/call', { name: 'query_application', arguments: {
      applicationId: f.page.application.id, query: 'kitchenContext', input: null,
    } });
    const result = await read.json() as { result?: { isError?: boolean; structuredContent?: unknown } };
    expect(result.result?.isError, JSON.stringify({ result, traffic, state: session.status, participation: session.participation?.status })).not.toBe(true);
    expect(JSON.stringify(result.result?.structuredContent)).toContain('Slice apples');
    expect(traffic.relayUpgrades).toBeGreaterThan(0);
    await inDO(f.page.id, t => {
      expect(t.ctx.getWebSockets('peer-relay').every(socket => socket.readyState !== WebSocket.READY_STATE_OPEN)).toBe(true);
      expect(t.db.get('assistant_work', null)).toBeNull();
    });
    const subscribed = await mcp('events/subscribe', { name: 'assistant.help_requested',
      arguments: { application_id: f.page.application.id },
      delivery: { mode: 'webhook', url: 'https://callback.example/events', secret } });
    const registration = await subscribed.json() as { result?: { id?: string } };
    expect(registration.result?.id, JSON.stringify(registration)).toMatch(/^sub_/);

    const view = await session.readView();
    const batch = view.readEvents({ topics: ['assistant'] });
    const step = batch.events.find(e => (e.payload as { type?: string }).type === 'step.selected')!;
    await view.release();
    const operation = await session.command('requestAssistance', {
      requestId: 'help-apples', kind: 'recipe_help', question: 'Private details about slicing?',
      cookingStepId: 'first', cookingStepEventId: step.id, contextRevision: 'observed-first',
      expiresAtMs: Date.now() + 60_000,
    } as never, { operationId: 'ask-slicing' });
    await operation.applied();
    const hint = () => request(pagePath + '/assistant/wake', bind, { method: 'POST', headers: transportHeaders });
    expect((await hint()).status).toBe(204);
    expect((await hint()).status).toBe(204);
    await advance(f.page.id, 100);
    await runAlarm(f.page.id);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 12_000 });
    expect(sent[0].body).not.toContain('Private details');
    expect(JSON.parse(sent[0].body).data.request_id).toBe('help-apples');

    await evictDurableObject(stub(f.page.id));
    await inDO(f.page.id, t => { Object.assign(t.env, settings); });
    await advance(f.page.id, 3_000);
    await runAlarm(f.page.id);
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 12_000 });
    expect(sent[1]).toEqual(sent[0]);
    const requestEventId = JSON.parse(sent[1].body).data.source_event_id;
    const reply = await mcp('tools/call', { name: 'reply_to_assistance', arguments: {
      applicationId: f.page.application.id, operationId: 'reply-to-slicing', requestId: 'help-apples',
      requestEventId, answer: 'Cut the apples into thin wedges.', suggestedSteps: [],
      basedOnContextRevision: 'observed-first', cookingStepId: 'first',
    } });
    const replyResult = await reply.json() as { result?: { isError?: boolean; structuredContent?: unknown } };
    expect(replyResult.result?.isError, JSON.stringify(replyResult)).toBe(false);
    await vi.waitFor(async () => {
      const status = await session.query('assistanceStatus', { requestId: 'help-apples' } as never);
      expect(JSON.stringify(status.value)).toContain('Cut the apples into thin wedges.');
    }, { timeout: 8_000 });
    await inDO(f.page.id, t => expect(t.db.get('assistant_work', null)).toBeNull());
    expect((await (await deviceRequest()).json() as { publicKey: string }).publicKey).toBe(publicKey);
    await env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET revoked_at=? WHERE id=?').bind(Date.now(), gid).run();
    expect((await mcp('initialize')).status).toBe(401);
  } finally {
    outbound.mockRestore();
    await session.close();
    await inDO(f.page.id, t => { Object.assign(t.env, previous); });
  }
});
