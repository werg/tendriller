import { beforeAll, expect, it, vi } from 'vitest';
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Env } from '../src/env';
import { route } from '../src/router';
import { CORE_RELEASE } from '../../contract/index.mjs';
import { oauthConfig, signAccessToken } from '../src/accounts/oauth-support';
import { challengeFor } from '../src/accounts/oauth-support';
import { sha256Hex } from '../src/ids';
import { bytesDigest, bytesToHex, createApplicationTools, describeApplication, eventExecutionManifest, executionManifestArtifacts, MemoryBytesStore,
  openApplicationDevice, openPeerApplication, participantGrant, signTransitionRequest } from '@chronolog/peer-session';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { resolveConnection } from '../src/assistant-shared';
import { createPeersClient } from '../../contract/peers.mjs';
import { defineApplication, defineCommand, defineQuery, emit, program, type ApplicationReadView } from '@chronolog/peer-session';
import { connectApplicationAssistant, createAssistantKey, createApplicationAgentKey, forwardApplicationEvents, proposeApplicationAssistant, type AssistantParticipant } from '../../contract/assistant.mjs';
import { peerApiJson } from './peer-exchange';
import { createPeerIdentity } from '@chronolog/peer-session';
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

it('challenges an empty OAuth setup probe and serves the public resource-template catalog', async () => {
  const settings = configured({ OAUTH_CONFIG_JSON: JSON.stringify({ resource: ISSUER + '/mcp', clients: [{
    id: 'chatgpt', name: 'ChatGPT', redirectUris: [REDIRECT], scopes: ['applications:read'],
  }] }) });
  const probe = await request('/mcp', settings, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' } });
  expect(probe.status).toBe(401);
  expect(probe.headers.get('WWW-Authenticate')).toContain(ISSUER + '/.well-known/oauth-protected-resource/mcp');
  // ChatGPT requests all scopes advertised by the protected resource, rather
  // than limiting itself to those in authorization-server metadata.
  const resource = await (await request('/.well-known/oauth-protected-resource/mcp', settings)).json() as { scopes_supported: string[] };
  expect(resource.scopes_supported).toEqual(['applications:read']);
  const authorization = await request('/oauth/authorize?' + new URLSearchParams({
    client_id: 'chatgpt', redirect_uri: REDIRECT, state: 'chatgpt-discovery', resource: ISSUER + '/mcp',
    response_type: 'code', scope: resource.scopes_supported.join(' '),
    code_challenge_method: 'S256', code_challenge: await challengeFor('s'.repeat(43)),
  }), settings);
  expect(authorization.status).toBe(303);
  expect(new URL(authorization.headers.get('Location')!, ISSUER).pathname).toBe('/auth');
  const templates = await request('/mcp', settings, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/templates/list' }) });
  expect(templates.status).toBe(200);
  expect(await templates.json()).toMatchObject({ result: { resourceTemplates: [] } });
});

it('provides a complete public MCP onboarding route without browsing or account access, including staging', async () => {
  const origin = 'https://staging.tendriller.dev';
  const settings = configured({ PUBLIC_BASE: origin, SERVICE_ENVIRONMENT: 'Staging QA', SERVICE_SOURCE_COMMIT: 'c'.repeat(40), SERVICE_COMPOSITION_ID: 'd'.repeat(64),
    OAUTH_CONFIG_JSON: JSON.stringify({ resource: origin + '/mcp', clients: [
    { id: 'chatgpt', name: 'ChatGPT', redirectUris: [REDIRECT], scopes: ['applications:read'] },
  ] }) });
  const call = async (method: string, params: object = {}) => {
    const response = await route(new Request(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), settings);
    return { response, body: await response.json() as Record<string, any> };
  };
  const before = await env.ACCOUNTS.prepare('SELECT COUNT(*) AS count FROM tendrils').first();
  const initialized = await call('initialize', { protocolVersion: '2025-11-25' });
  expect(initialized.body.result.instructions).toContain('tendril_guide');
  expect(initialized.body.result.instructions).toContain(origin);
  expect(initialized.body.result.instructions).toContain(origin + '/docs/MCP_AGENT_GUIDE.md');
  expect(initialized.body.result.serverInfo.version).toBe(CORE_RELEASE);
  expect(initialized.body.result._meta['tendriller/service']).toMatchObject({ serviceOrigin: origin,
    environment: { id: origin, label: 'Staging QA', kind: 'deployment' },
    build: { coreRelease: CORE_RELEASE, sourceCommit: 'c'.repeat(40), compositionId: 'd'.repeat(64), runtimeId: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
  expect((await call('server/discover')).body.result._meta['tendriller/service']).toEqual(initialized.body.result._meta['tendriller/service']);
  const catalog = await call('tools/list');
  const guideTool = catalog.body.result.tools.find((item: any) => item.name === 'tendril_guide');
  expect(guideTool.securitySchemes).toEqual([{ type: 'noauth' }]);
  expect(guideTool.inputSchema.properties.topic.enum).toContain('build');
  const readGuide = async (args: object = {}) => {
    const reply = await call('tools/call', { name: 'tendril_guide', arguments: args });
    expect(reply.response.status).toBe(200);
    expect(reply.body.result.isError).not.toBe(true);
    return reply.body.result.structuredContent;
  };
  const start = await readGuide();
  expect(start.topic).toBe('start');
  expect(start.serviceOrigin).toBe(origin);
  expect(start.environment.id).toBe(origin);
  expect(start.build).toEqual(initialized.body.result._meta['tendriller/service'].build);
  expect(start.setup).toMatchObject({ startHere: origin + '/docs/MCP_AGENT_GUIDE.md', originPolicy: 'same-origin-only',
    guideUnavailableAction: expect.stringContaining(origin + '/.well-known/tendriller.json') });
  expect(start.readiness).toMatchObject({ serviceOrigin: origin, mode: 'open', creation: { available: true } });
  expect(start.setup.readinessUrl).toBe(origin + '/api/readiness');
  expect(start.text).toContain('Node 24');
  expect(start.text).toContain('prepare_tendril_setup');
  expect(start.text).toContain('inspect_tendril_setup');
  expect(start.text).toContain('setup:finish');
  expect(start.text).not.toContain('https://tendriller.dev');
  expect(start.onboarding.interfaces.create_page.url).toBe(origin + '/api/tendrils');
  const build = await readGuide({ topic: 'build' });
  expect(build.text).toContain('npm run create');
  expect(build.text).toContain(origin + '/downloads/tendriller-first-app.tgz');
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='creation_paused' WHERE id=1").run();
  try {
    const paused = await readGuide({ topic: 'build' });
    expect(paused.readiness).toMatchObject({ mode: 'creation_paused', creation: { available: false }, writes: { available: true } });
    expect(paused.text).toMatch(/^New application setup is blocked:/);
    expect(paused.text.indexOf('Stop new-app setup before downloading')).toBeLessThan(paused.text.indexOf('npm install'));
    expect(paused.text).not.toContain('https://tendriller.dev');
  } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
  for (const topic of ['capabilities', 'connect', 'delivery', 'troubleshooting']) {
    const guide = await readGuide({ topic });
    expect(guide.url).toBe(origin + '/docs/' + ({ capabilities: 'CAPABILITIES', connect: 'CLOUDFLARE_ASSISTANT', delivery: 'AGENT_DELIVERY', troubleshooting: 'TROUBLESHOOTING' } as Record<string, string>)[topic] + '.md');
    expect(guide.text.length).toBeGreaterThan(100);
  }
  const resources = await call('resources/list');
  expect(resources.body.result.resources).toContainEqual(expect.objectContaining({ uri: start.url, mimeType: 'text/markdown' }));
  expect((await call('resources/read', { uri: start.url })).body.result.contents[0].text).toBe(start.text);
  const invalid = await call('tools/call', { name: 'tendril_guide', arguments: { topic: 'https://untrusted.example/' } });
  expect(invalid.body.result).toMatchObject({ isError: true, structuredContent: { code: 'invalid_guide_topic' } });
  const absentGuide = await route(new Request(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tendril_guide' } }),
  }), { ...settings, ASSETS: { fetch: async () => new Response('Missing', { status: 404 }) } as unknown as Fetcher });
  const absent = (await absentGuide.json() as any).result;
  expect(absent).toMatchObject({ isError: true, structuredContent: { code: 'guide_unavailable',
    message: expect.stringContaining(origin + '/.well-known/tendriller.json') } });
  expect(absent.structuredContent.message).not.toContain('https://tendriller.dev');
  expect((await call('tools/call', { name: 'list_tendrils', arguments: {} })).response.status).toBe(401);
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS count FROM tendrils').first()).toEqual(before);
});

it('prepares assistant permissions before claim and activates their review only for the verified owner', async () => {
  const f = await hostFixture();
  const email = (await env.ACCOUNTS.prepare('SELECT email FROM accounts WHERE id=?').bind(f.subject).first<{ email: string }>())!.email;
  const h = await create({ claim: false, owner: email });
  const settings = configured({ OAUTH_CONFIG_JSON: JSON.stringify({ resource: ISSUER + '/mcp', clients: [
    { id: 'chatgpt', name: 'ChatGPT', redirectUris: [REDIRECT], scopes: ['applications:read'] },
  ] }) });
  const restore = await inDO(h.id, t => ({ OAUTH_CONFIG_JSON: t.env.OAUTH_CONFIG_JSON, OAUTH_SIGNING_JWK: t.env.OAUTH_SIGNING_JWK }));
  await inDO(h.id, t => { t.env.OAUTH_CONFIG_JSON = settings.OAUTH_CONFIG_JSON; t.env.OAUTH_SIGNING_JWK = settings.OAUTH_SIGNING_JWK; });
  try {
    const device = await createPeerIdentity();
    await peerApiJson(h, 'control/configure', { historyId: 'prepared-assistant', executionManifestDigest: '12'.repeat(32),
      schemaAdministrator: device.publicKey, epoch: 0, keyDigest: '34'.repeat(32), members: [{ grant: participantGrant(device.publicKey, { administrator: true }) }],
      schema: null, definition: { id: 'prepared-notes', version: '1', schema: null,
        commands: [{ name: 'addNote', description: 'Add a note', input: { type: 'null' } }],
        queries: [{ name: 'notes', description: 'Read notes', input: { type: 'null' } }] } });
    const response = await request(new URL(h.api).pathname + '/assistant/propose', settings, {
      method: 'POST', headers: { Authorization: 'Bearer ' + h.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Prepared notes', adapterHashes: ['a'.repeat(64)], queries: ['notes'], commands: ['addNote'], events: [] }),
    });
    expect(response.status).toBe(200);
    const prepared = await response.json() as { proposed: string; approved: boolean; reviewUrl: string };
    expect(prepared.approved).toBe(false);
    expect(await env.ACCOUNTS.prepare('SELECT * FROM assistant_connections WHERE page_id=?').bind(h.id).first()).toBeNull();
    expect((await request(new URL(prepared.reviewUrl).pathname, settings, { headers: { Cookie: f.cookie } })).status).toBe(404);
    const claim = await request('/auth/page?' + new URLSearchParams({ tendril: h.id, key: new URL(h.page_url).pathname.split('/')[2] }), settings,
      { headers: { Cookie: f.cookie }, redirect: 'manual' });
    expect(claim.status).toBe(303);
    const review = await request(new URL(prepared.reviewUrl).pathname, settings, { headers: { Cookie: f.cookie } });
    expect(review.status).toBe(200);
    const text = await review.text();
    expect(text).toContain('Prepared notes');
    expect(await env.ACCOUNTS.prepare('SELECT enabled,owner_account FROM assistant_connections WHERE page_id=?').bind(h.id).first())
      .toEqual({ enabled: 0, owner_account: f.subject });
    expect(await inDO(h.id, t => t.db.get('assistant_connection', null))).toBeNull();
    const csrf = /name="csrf" value="([^"]+)"/u.exec(text)![1];
    expect((await formPost(new URL(prepared.reviewUrl).pathname, { csrf, action: 'approve', queries: 'notes', commands: 'addNote' }, settings, f.cookie)).status).toBe(303);
    expect(await env.ACCOUNTS.prepare('SELECT enabled FROM assistant_connections WHERE page_id=?').bind(h.id).first()).toEqual({ enabled: 1 });
  } finally { await inDO(h.id, t => { Object.assign(t.env, restore); }); }
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

async function hostFixture(applicationId?: string) {
  const page = await create(applicationId ? { application: { id: applicationId } } : {}), subject = await inDO(page.id, t => t.db.get<string>('owner_account', ''));
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

const notes = defineApplication({
  id: 'notes-mcp-integration', version: '1',
  commands: { addNote: defineCommand({
    description: 'Save text in the notebook.', input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    prepare: ({ text }) => program(emit('note', { text })),
  }) },
  queries: { notes: defineQuery({ description: 'Read retained notes.', input: { type: 'null' },
    read: (view: ApplicationReadView) => view.readEvents({ topics: ['note'] }).events.map(event => event.payload) }),
    privateNotes: defineQuery({ description: 'Read private note status.', input: { type: 'null' }, read: () => true }) },
});
const counter = defineApplication({
  id: 'counter-mcp-integration', version: '1',
  commands: { count: defineCommand({
    description: 'Add one reading.',
    input: { type: 'integer', minimum: 1, maximum: 10 },
    prepare: value => program(emit('reading', { value })),
  }) },
  queries: { readings: defineQuery({ description: 'Return the retained meter readings.',
    input: { type: 'null' }, read: (view: ApplicationReadView) => view.readEvents({ topics: ['reading'] }).events.map(event => event.payload),
  }) },
});

it('serves unrelated native applications through one MCP endpoint and retains inbox and signed push across eviction', async () => {
  const a = await hostFixture(), b = await hostFixture(), now = Date.now(), resource = ISSUER + '/mcp';
  const scopes = 'tendrils:list applications:read applications:write events:subscribe';
  const bind = configured({ OAUTH_CONFIG_JSON: JSON.stringify({ resource, clients: [
    { id: 'chatgpt', redirectUris: [REDIRECT], scopes: scopes.split(' ') },
  ] }),
  ASSISTANT_STORE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), ASSISTANT_CALLBACK_ORIGINS: 'https://callback.example' });
  const settings = Object.fromEntries(['OAUTH_CONFIG_JSON', 'OAUTH_SIGNING_JWK', 'ASSISTANT_STORE_KEY', 'ASSISTANT_CALLBACK_ORIGINS']
    .map(key => [key, bind[key as keyof Env]]));
  const restore = await inDO(a.page.id, t => {
    const previous = Object.fromEntries(Object.keys(settings).map(key => [key, t.env[key as keyof Env]]));
    Object.assign(t.env, settings); return previous;
  });
  await inDO(b.page.id, t => { Object.assign(t.env, settings); });
  const oauth = (await oauthConfig(bind))!, adapters: AssistantParticipant[] = [], sessions: { close(): Promise<void> }[] = [];
  const traffic: TestHostTraffic = { httpRequests: 0, requestBodyBytes: 0, rendezvousUpgrades: 0,
    rendezvousSentBytes: 0, rendezvousReceivedBytes: 0, invitationUpgrades: 0, invitationSentBytes: 0, invitationReceivedBytes: 0,
    relayUpgrades: 0, relaySentBytes: 0, relayReceivedBytes: 0 };
  async function open<D extends typeof notes | typeof counter>(f: typeof a, definition: D, query: string, command: string, eventName: string) {
    const pagePath = new URL(f.page.api).pathname, headers = { Authorization: 'Bearer ' + f.page.token, 'Content-Type': 'application/json' };
    const peers = createPeersClient({ base: f.page.api, applicationId: f.page.application.id,
      request: async (path, options = {}) => {
        const res = await request(pagePath + '/' + path, bind, { method: options.method, headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
        if (!res.ok) throw Error(path + ': ' + res.status + ': ' + await res.text());
        return res.json();
      },
      socket: (raw, protocols) => {
        const url = new URL(raw);
        return testPeerSocket(() => request(url.pathname + url.search, bind, { headers: {
          ...headers, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols.join(', '),
        } }), traffic, 'relay');
      },
    });
    const device = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    const backupDevice = f === a ? await openApplicationDevice({ store: new MemoryBytesStore(), create: true }) : null;
    const epoch = crypto.getRandomValues(new Uint8Array(32)), manifest = await executionManifestArtifacts(await eventExecutionManifest());
    const base = await peers.configureApplication({ historyId: 'generic-mcp-test', definition: describeApplication(definition),
      schema: null, executionManifestDigest: bytesToHex(manifest.executionManifestDigest), schemaAdministrator: device.identity.publicKey,
      epoch: 0, keyDigest: await bytesDigest(epoch), members: [{ grant: participantGrant(device.identity.publicKey, { administrator: true }) },
        ...(backupDevice ? [{ grant: participantGrant(backupDevice.identity.publicKey) }] : [])],
    });
    const descriptor = base.descriptor.payload;
    await peers.selectGeneration(await signTransitionRequest({ applicationId: descriptor.applicationId, profile: descriptor.profile,
      policy: descriptor.policy, transitionId: 'initial', expectedGeneration: null, requester: device.identity.publicKey,
      coordinator: device.identity.publicKey, controlRevision: 0, reason: 'create', base: null,
    }, device.identity));
    const session = await openPeerApplication({ device, definition, authority: await peers.application(), epochKeys: new Map([[0, epoch]]) });
    sessions.push(session);
    const key = createAssistantKey(), backupKey = createAssistantKey(), reviewPath = '/connections/' + f.page.id;
    const extraQuery = f === a ? ['privateNotes'] : [];
    const blueprints = { queries: [query, ...extraQuery], commands: [command],
      events: [{ name: eventName, description: 'An approved app event.' }] };
    const proposal = await proposeApplicationAssistant({ api: f.page.api, token: f.page.token, key,
      backupKeys: backupDevice ? [backupKey] : [], label: f.page.name,
      ...blueprints, fetcher: (url, init) => request(new URL(String(url)).pathname, bind, init) });
    expect(proposal.approved).toBe(false);
    expect(proposal.reviewUrl).toBe(ISSUER + reviewPath);
    expect((await request(reviewPath, bind, { headers: { Cookie: f === a ? b.cookie : a.cookie } })).status).toBe(404);
    const upgrade = (protocols: string[]) => request(pagePath + '/assistant/adapter', bind, { headers: {
      Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols.join(', '),
    } });
    expect((await upgrade(['tendriller.application-mcp.v1', key, 'td_device_' + session.deviceId])).status).toBe(401);
    const review = async (queries: string[], origin = ISSUER) => {
      const page = await request(reviewPath, bind, { headers: { Cookie: f.cookie } });
      expect(page.status).toBe(200);
      const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
      const form = new URLSearchParams({ csrf, action: 'approve', commands: command, events: eventName });
      for (const name of queries) form.append('queries', name);
      return request(reviewPath, bind, { method: 'POST', headers: { Origin: origin, Cookie: f.cookie }, body: form });
    };
    const reviewAction = async (action: string, fields: Record<string, string>) => {
      const page = await request(reviewPath, bind, { headers: { Cookie: f.cookie } });
      const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1];
      return request(reviewPath, bind, { method: 'POST', headers: { Origin: ISSUER, Cookie: f.cookie },
        body: new URLSearchParams({ csrf, action, ...fields }) });
    };
    expect((await review(blueprints.queries, 'https://evil.example')).status).toBe(403);
    expect((await review(blueprints.queries)).status).toBe(303);
    let dropNextResult = false, droppedResult: Record<string, any> | null = null;
    const start = (whichKey = key, peer = session) => {
      const adapter = connectApplicationAssistant({ api: f.page.api, key: whichKey, session: peer, tools: createApplicationTools(peer),
        ...blueprints, openSocket: (_url, protocols) => {
          const socket = testPeerSocket(() => upgrade(protocols), traffic, 'rendezvous'), send = socket.send.bind(socket);
          socket.send = data => {
            const frame = typeof data === 'string' ? JSON.parse(data) : null;
            if (dropNextResult && frame?.type === 'result' && frame.value?.operationReference) {
              dropNextResult = false; droppedResult = frame.value;
              // The real native tool saved/applied this operation. Only its
              // transport response is lost, so another dispatch is unsafe.
              socket.close(1000, 'Lost reply after native save'); return;
            }
            send(data);
          };
          return socket as unknown as globalThis.WebSocket;
        } });
      adapters.push(adapter);
      return adapter;
    };
    const adapter = start();
    await vi.waitFor(() => expect(adapter.online).toBe(true));
    const startBackup = async () => {
      if (!backupDevice) throw Error('No backup configured');
      const backup = await openPeerApplication({ device: backupDevice, definition, authority: await peers.application(), epochKeys: new Map([[0, epoch]]) });
      sessions.push(backup);
      expect((await upgrade(['tendriller.application-mcp.v1', key, 'td_device_' + backup.deviceId])).status).toBe(409);
      const channel = 'backup:' + crypto.randomUUID();
      const firstRelay = peers.relay(channel, session.deviceId, { remotePeerId: backup.deviceId });
      const secondRelay = peers.relay(channel, backup.deviceId, { remotePeerId: session.deviceId });
      const [left, right] = await Promise.all([firstRelay, secondRelay].map(relay =>
        openWebSocketConnection(relay as Parameters<typeof openWebSocketConnection>[0], { ready: relay.ready })));
      const [primary, replica] = await Promise.all([
        session.connectPeer({ connection: left, peerIdentity: backup.deviceId }),
        backup.connectPeer({ connection: right, peerIdentity: session.deviceId }),
      ]);
      await Promise.all([primary.synchronize(), replica.synchronize()]);
      const standby = start(backupKey, backup);
      await vi.waitFor(() => expect(standby.online).toBe(true));
      return { standby, backup };
    };
    const gid = crypto.randomUUID(), jti = crypto.randomUUID();
    const bearer = await signAccessToken(oauth, { iss: ISSUER, aud: resource, sub: f.subject, sid: gid, jti, scope: scopes,
      exp: Math.floor((now + 300_000) / 1000) });
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare('INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .bind(gid, f.subject, 'chatgpt', resource, scopes, now, now + 600_000),
      env.ACCOUNTS.prepare('INSERT INTO integration_oauth_access(hash,grant_id,jti,scope,created_at,expires_at) VALUES (?,?,?,?,?,?)')
        .bind(await sha256Hex(bearer), gid, jti, scopes, now, now + 300_000),
    ]);
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const res = await jsonPost('/mcp', { jsonrpc: '2.0', id: 1, method, params }, bind, bearer);
      return res.json<any>();
    };
    const tool = (name: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args });
    return { adapter, session, eventName, gid, rpc, tool, review, reviewAction, startBackup, backupKey, id: f.page.application.id,
      loseNextResult: () => { dropNextResult = true; droppedResult = null; }, lostResult: () => droppedResult };
  }
  const sent: { id: string; body: string }[] = [];
  let mounted: WebSocket | undefined;
  const secrets = [new Uint8Array(32).fill(9), new Uint8Array(32).fill(10)];
  const [secret, rotatedSecret] = secrets.map(bytes => 'whsec_' + btoa(String.fromCharCode(...bytes)));
  let verifications = 0, rejectCallback = false;
  const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    expect(req.url).toBe('https://callback.example/events');
    const body = await req.text(), value = JSON.parse(body), id = req.headers.get('webhook-id')!;
    const signatures = await Promise.all(secrets.map(async bytes => {
      const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${req.headers.get('webhook-timestamp')}.${body}`));
      return 'v1,' + btoa(String.fromCharCode(...new Uint8Array(signature)));
    }));
    expect(req.headers.get('X-MCP-Subscription-Id')).toMatch(/^sub_/);
    if (value.type === 'verification') {
      expect(req.headers.get('webhook-signature')).toBe(signatures[verifications++]);
      return Response.json({ challenge: value.challenge });
    }
    expect(req.headers.get('webhook-signature')).toBe(sent.length === 0 ? signatures[0] : [signatures[1], signatures[0]].join(' '));
    sent.push({ id, body });
    return new Response(null, { status: sent.length === 1 || rejectCallback ? 503 : 204 });
  });
  try {
    const anonymous = async (method: string, params = {}) => request('/mcp', bind, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': method },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    expect(await (await anonymous('tools/list')).json()).toMatchObject({ result: { resultType: 'complete' } });
    expect((await anonymous('tools/call', { name: 'list_tendrils', arguments: {} })).status).toBe(401);
    const first = await open(a, notes, 'notes', 'addNote', 'note.added');
    const second = await open(b, counter, 'readings', 'count', 'counter.changed');
    expect((await first.rpc('initialize')).result.capabilities.events).toEqual({});
    expect((await first.tool('list_tendrils')).result.structuredContent.applications).toEqual([
      { applicationId: first.id, label: a.page.name, pageId: a.page.id },
    ]);
    expect((await first.tool('describe_application', { applicationId: second.id })).result.isError).toBe(true);
    expect((await first.tool('get_profile')).result.structuredContent.id).not.toEqual((await second.tool('get_profile')).result.structuredContent.id);
    expect((await second.rpc('events/list')).result.events.map((e: {name: string}) => e.name)).toEqual(['application.event']);
    expect((await first.tool('describe_application', { applicationId: first.id })).result.structuredContent.queries[0].name).toBe('notes');
    expect((await first.tool('call_application_command', { applicationId: first.id, command: 'addNote', input: {},
      operationId: 'invalid-before-admission' })).result.structuredContent.code).toBe('invalid_application_input');
    await inDO(a.page.id, t => expect(t.db.one('SELECT COUNT(*) AS n FROM assistant_commands')).toEqual({ n: 0 }));
    const announcement = (await first.tool('open_application_inbox', { applicationId: first.id })).result;
    expect(announcement.structuredContent).not.toHaveProperty('activity');
    const proof = announcement._meta.activity.proof;
    const mount = (pageId: string, token: string) => request('/api/t/' + pageId + '/assistant/activity', bind, { headers: {
      Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'tendriller.application-activity.v1, td_watch.' + token,
    } });
    expect((await mount(b.page.id, proof)).status).toBe(401);
    expect((await mount(a.page.id, proof.replace(/^[\w-]/u, proof[0] === 'A' ? 'B' : 'A'))).status).toBe(401);
    const watched = await mount(a.page.id, proof);
    expect(watched.status).toBe(101);
    mounted = watched.webSocket!;
    const notices: string[] = [];
    mounted.addEventListener('message', event => { notices.push(String(event.data)); });
    mounted.accept();
    await inDO(a.page.id, t => {
      expect(t.ctx.getWebSockets('application-mcp')).toHaveLength(1);
      expect(t.ctx.getWebSockets('application-activity')).toHaveLength(1);
      expect(t.db.one('SELECT 1 FROM assistant_jobs')).toBeNull();
    });
    expect((await first.tool('query_application', { applicationId: first.id, query: 'readings', input: null })).result.isError).toBe(true);
    const write = { applicationId: first.id, command: 'addNote', operationId: 'reply-one', input: { text: 'Rope checked' } };
    expect((await first.tool('call_application_command', write)).result.isError).toBeUndefined();
    expect((await first.tool('call_application_command', write)).result.isError).toBeUndefined();
    expect((await second.tool('call_application_command', { applicationId: second.id, command: 'count', operationId: 'count-one', input: 7 })).result.isError).toBeUndefined();
    expect((await first.tool('query_application', { applicationId: first.id, query: 'notes', input: null })).result.structuredContent.value).toMatchObject([{ text: 'Rope checked' }]);
    expect((await second.tool('query_application', { applicationId: second.id, query: 'readings', input: null })).result.structuredContent.value).toEqual([{ value: 7 }]);

    const capture = new AbortController();
    const bareAlarm = await inDO(b.page.id, async t => t.ctx.storage.getAlarm());
    const consumer = forwardApplicationEvents({
      session: second.session, assistant: second.adapter, topics: ['reading'], signal: capture.signal,
      checkpoint: { load: () => undefined, save: () => capture.abort() },
      project: event => ({ name: second.eventName, payload: event.payload }),
    });
    await consumer.catch(error => { if (!capture.signal.aborted) throw error; });
    expect((await second.tool('read_application_events', { applicationId: second.id })).result.structuredContent.events)
      .toMatchObject([{ data: { payload: { value: 7 } } }]);
    await inDO(b.page.id, async t => {
      expect(await t.ctx.storage.getAlarm()).toBe(bareAlarm);
      expect(t.db.one('SELECT 1 FROM assistant_jobs')).toBeNull();
    });

    const tuning = { name: 'application.event', arguments: { application_id: first.id, event: 'note.added' },
      delivery: { mode: 'webhook', url: 'https://callback.example/events' } };
    const subscribe = (secret: string) => first.rpc('events/subscribe', { ...tuning, delivery: { ...tuning.delivery, secret } });
    const watch = await subscribe(secret);
    expect(watch.result?.id, JSON.stringify(watch)).toMatch(/^sub_/);
    expect((await subscribe(secret)).result.id).toBe(watch.result.id);
    expect(verifications).toBe(1);
    const view = await first.session.readView(), batch = view.readEvents({ topics: ['note'] });
    await view.release();
    expect(batch.events).toHaveLength(1);
    const emitted = { name: 'note.added', sourceEventId: batch.events[0].id, generation: batch.revision.generation, payload: { ready: true } };
    // Establish the outage before enqueueing work. The real alarm may fire
    // immediately after publication; racing it here would test fixture timing.
    await inDO(a.page.id, t => { t.env.OAUTH_CONFIG_JSON = undefined; });
    const sequence = await first.adapter.publish(emitted);
    expect(await first.adapter.publish(emitted)).toBe(sequence);

    // A deployment with OAuth temporarily unavailable preserves existing jobs.
    await advance(a.page.id, 100);
    await runAlarm(a.page.id);
    expect(sent).toHaveLength(0);
    await inDO(a.page.id, t => {
      Object.assign(t.env, settings);
      expect(t.db.one('SELECT block_reason,attempts FROM assistant_jobs')).toMatchObject({ block_reason: 'oauth_unavailable', attempts: 0 });
      t.db.run('UPDATE assistant_jobs SET due=?', t.now() - 1);
    });
    const inbox = (await first.tool('read_application_events', { applicationId: first.id })).result.structuredContent;
    expect(inbox.events).toMatchObject([{ sequence, data: { payload: { ready: true } } }]);
    expect((await first.tool('read_application_events', { applicationId: first.id, after: inbox.next })).result.structuredContent.events).toEqual([]);
    await runAlarm(a.page.id);
    expect(sent).toHaveLength(1);
    expect((await first.review(['notes'])).status).toBe(303);
    expect(first.adapter.online).toBe(true);
    expect((await first.tool('query_application', { applicationId: first.id, query: 'privateNotes', input: null })).result.structuredContent.code)
      .toBe('operation_not_approved');
    expect((await subscribe(rotatedSecret)).result.id).toBe(watch.result.id);
    expect(verifications).toBe(2);
    await evictDurableObject(stub(a.page.id));
    await inDO(a.page.id, t => {
      Object.assign(t.env, settings);
      expect(t.ctx.getWebSockets('application-mcp')).toHaveLength(1);
      expect(t.ctx.getWebSockets('application-activity')).toHaveLength(1);
    });
    await advance(a.page.id, 3000);
    await runAlarm(a.page.id);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect((await first.tool('query_application', { applicationId: first.id, query: 'notes', input: null })).result.structuredContent.value).toMatchObject([{ text: 'Rope checked' }]);
    await inDO(a.page.id, t => expect(t.db.one('SELECT 1 FROM assistant_jobs')).toBeNull());

    const accepted = (await first.tool('get_application_delivery', { applicationId: first.id })).result.structuredContent;
    expect(accepted.recent).toMatchObject([{ outcome: 'accepted', attempts: 2, sourceEventId: emitted.sourceEventId }]);

    // Keep an old event pinned by a webhook while the visible inbox moves on.
    rejectCallback = true;
    const later = { ...emitted, sourceEventId: 'pinned-after-retry' };
    const pinned = await first.adapter.publish(later);
    await vi.waitFor(() => expect(notices).toEqual(['{"type":"changed"}']));
    await inDO(a.page.id, t => {
      t.transaction(() => {
        for (let i = 0; i < 258; i++)
          t.db.run('INSERT INTO assistant_events(source_id,generation,name,payload,created_at) VALUES(?,?,?,?,?)',
            'retention-fixture-' + i, later.generation, later.name, '{}', t.now());
      });
    });
    await first.adapter.publish({ ...later, sourceEventId: 'new-inbox-tail' });
    const gap = (await first.tool('read_application_events', { applicationId: first.id, after: { ...inbox.next, sequence: pinned }, limit: 1 })).result.structuredContent;
    expect(gap.truncated).toBe(true);
    expect(gap.resetRequired).toBe(true); expect(gap.reason).toBe('retention_truncated'); expect(gap.events).toEqual([]);
    const resumed = (await first.tool('read_application_events', { applicationId: first.id, after: gap.next, limit: 1 })).result.structuredContent;
    expect(resumed.events[0].sequence).toBeGreaterThan(pinned + 1);
    await inDO(a.page.id, t => expect(t.db.one('SELECT seq FROM assistant_events WHERE seq=?', pinned)).toBeTruthy());

    // The host may deliver immediately after emission. Let that attempt finish
    // before preparing the final retry, so its lease cannot overwrite this setup.
    await runAlarm(a.page.id);
    await expect.poll(() => inDO(a.page.id, t =>
      t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM assistant_jobs WHERE lease IS NOT NULL')!.n)).toBe(0);
    await inDO(a.page.id, async t => {
      t.db.run('UPDATE assistant_jobs SET attempts=7,due=? WHERE event_seq=?', t.now() - 1, pinned);
      await t.ctx.storage.setAlarm(t.now());
    });
    await runAlarm(a.page.id);
    const failed = (await first.tool('get_application_delivery', { applicationId: first.id })).result.structuredContent;
    expect(failed.recent).toEqual(expect.arrayContaining([expect.objectContaining({ sourceEventId: later.sourceEventId, outcome: 'retry_exhausted', attempts: 8 })]));

    await env.ACCOUNTS.prepare("UPDATE service_state SET mode='read_only' WHERE id=1").run();
    try {
      expect((await subscribe(rotatedSecret)).error.data.code).toBe('read_only');
      // Access withdrawal remains available during a service pause.
      expect((await first.rpc('events/unsubscribe', tuning)).result).toEqual({});
    } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
    expect((await first.rpc('events/unsubscribe', tuning)).result).toEqual({});
    await inDO(a.page.id, t => expect(t.db.one('SELECT 1 FROM assistant_watchers')).toBeNull());

    const { standby } = await first.startBackup();
    await first.adapter.close();
    // close() settles the local loop; wait for the remote close handshake before
    // testing the separate already-offline-provider scenario.
    await vi.waitFor(async () => expect(await inDO(a.page.id, t =>
      t.ctx.getWebSockets('application-mcp').filter(socket => socket.readyState === WebSocket.READY_STATE_OPEN).length)).toBe(1));
    expect((await first.tool('query_application', { applicationId: first.id, query: 'notes', input: null })).result)
      .toMatchObject({ structuredContent: { value: [{ text: 'Rope checked' }] } });
    const unresolved = (await first.tool('call_application_command', write)).result.structuredContent;
    expect(unresolved).toMatchObject({ code: 'operation_uncertain', outcome: 'uncertain', operationReference: { deviceId: first.session.deviceId } });
    expect((await first.tool('call_application_command', { ...write, operationId: 'standby-write', input: { text: 'Backup checked' } })).result.structuredContent.code)
      .toBe('provider_offline');
    const provider = (await first.tool('describe_application', { applicationId: first.id })).result.structuredContent.provider;
    expect((await first.reviewAction('select-provider', { provider: await sha256Hex(first.backupKey), epoch: String(provider.selectionEpoch) })).status).toBe(303);
    expect((await first.tool('call_application_command', { ...write, operationId: 'standby-write', input: { text: 'Backup checked' } })).result.isError)
      .toBeUndefined();
    await vi.waitFor(async () => expect((await createApplicationTools(first.session).call('query', { name: 'notes', input: null }) as { value: unknown }).value)
      .toMatchObject([{ text: 'Rope checked' }, { text: 'Backup checked' }]), { timeout: 5000 });

    // Model an internal request that was admitted by the gateway, then
    // waited behind another page operation until its OAuth grant was revoked.
    await env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET revoked_at=? WHERE id=?').bind(Date.now(), first.gid).run();
    const stale = await stub(a.page.id).fetch(new Request('https://tendril.internal/assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId: first.id, method: 'call_application_command',
        params: { ...write, operationId: 'queued-revocation' },
        principal: { account: a.subject, grant: first.gid, client: 'chatgpt', scopes: scopes.split(' '), expires: Date.now() + 10_000 },
      }),
    }));
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: { code: 'authorization_revoked' } });
    await inDO(a.page.id, t => expect(t.db.one('SELECT COUNT(*) AS n FROM assistant_commands')).toEqual({ n: 2 }));
    await standby.close();
    expect((await first.rpc('initialize')).error).toBe('invalid_token');
    expect((await second.tool('query_application', { applicationId: second.id, query: 'readings', input: null })).result.structuredContent.value).toEqual([{ value: 7 }]);

    // Two separately approved agents behind the same OAuth client can retain
    // the same short operation ID without sharing authority or progress.
    const reviewerKey = createApplicationAgentKey(), plannerKey = createApplicationAgentKey();
    const register = (key: string, label: string) => second.tool('register_application_agent', { applicationId: second.id, bindingToken: key,
      label, queries: ['readings'], commands: ['count'], events: ['counter.changed'], route: 'on-demand' });
    const reviewer = (await register(reviewerKey, 'Reviewer')).result.structuredContent;
    const planner = (await register(plannerKey, 'Planner')).result.structuredContent;
    expect(reviewer.status).toBe('pending'); expect(planner.agentBindingId).not.toBe(reviewer.agentBindingId);
    expect((await register(reviewerKey, 'Reviewer')).result.structuredContent.agentBindingId).toBe(reviewer.agentBindingId);
    expect((await second.tool('call_application_command', { applicationId: second.id, bindingToken: reviewerKey,
      command: 'count', input: 2, operationId: 'same-local-id' })).result.structuredContent.code).toBe('agent_binding_approval_required');
    expect((await second.reviewAction('approve-agent', { binding: reviewer.agentBindingId, revision: '1' })).status).toBe(303);
    expect((await second.reviewAction('approve-agent', { binding: planner.agentBindingId, revision: '1' })).status).toBe(303);
    const agentWrite = (key: string, input: number) => second.tool('call_application_command', {
      applicationId: second.id, bindingToken: key, command: 'count', input, operationId: 'same-local-id',
      context: { endpointId: 'tool-endpoint', runId: 'run-' + input },
    });
    const [reviewed, planned] = await Promise.all([agentWrite(reviewerKey, 2), agentWrite(plannerKey, 3)]);
    const reviewedRef = reviewed.result.structuredContent.operationReference, plannedRef = planned.result.structuredContent.operationReference;
    expect(reviewedRef.deviceId).toBe(second.session.deviceId); expect(plannedRef.deviceId).toBe(second.session.deviceId);
    expect(reviewedRef.operationId).not.toBe(plannedRef.operationId);
    expect(reviewedRef.agentBindingId).toBe(reviewer.agentBindingId);
    expect((await agentWrite(reviewerKey, 2)).result.structuredContent.operationReference.operationId).toBe(reviewedRef.operationId);
    expect((await agentWrite(reviewerKey, 4)).result.structuredContent.code).toBe('operation_id_conflict');
    const inspection = (await second.tool('inspect_application_operation', { applicationId: second.id,
      bindingToken: reviewerKey, operationId: 'same-local-id' })).result.structuredContent;
    expect(inspection.operationReference.attemptId).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspection.operation.state.operationId).toBe(reviewedRef.operationId);
    expect((await second.tool('wait_application_operation', { applicationId: second.id, bindingToken: reviewerKey,
      operationId: 'same-local-id' })).result.structuredContent.outcome).toBe('applied');
    expect((await second.tool('retry_application_operation', { applicationId: second.id, bindingToken: reviewerKey,
      operationId: 'same-local-id' })).result.structuredContent.operationReference.operationId).toBe(reviewedRef.operationId);
    const agentInbox = (await second.tool('read_application_events', { applicationId: second.id, bindingToken: reviewerKey })).result.structuredContent;
    expect((await second.tool('read_application_events', { applicationId: second.id, bindingToken: plannerKey,
      after: agentInbox.next })).result.structuredContent).toMatchObject({ resetRequired: true, reason: 'binding_changed', events: [] });
    expect((await second.tool('read_application_events', { applicationId: second.id, bindingToken: reviewerKey,
      after: { ...agentInbox.next, generation: 'f'.repeat(64) } })).result.structuredContent.reason).toBe('generation_changed');
    expect((await second.tool('read_application_events', { applicationId: second.id, bindingToken: reviewerKey,
      after: agentInbox.next, events: [] })).result.structuredContent.reason).toBe('filter_changed');
    const rotated = createApplicationAgentKey(reviewer.agentBindingId);
    expect((await second.tool('rotate_application_agent', { applicationId: second.id, bindingToken: reviewerKey,
      nextBindingToken: rotated })).result.structuredContent.agentBindingId).toBe(reviewer.agentBindingId);
    expect((await second.tool('describe_application', { applicationId: second.id, bindingToken: reviewerKey })).result.structuredContent.code).toBe('invalid_agent_binding');
    expect((await second.tool('inspect_application_operation', { applicationId: second.id, bindingToken: rotated,
      operationId: 'same-local-id' })).result.structuredContent.operationReference.operationId).toBe(reviewedRef.operationId);
    expect((await second.tool('revoke_application_agent', { applicationId: second.id, bindingToken: rotated })).result.structuredContent.status).toBe('revoked');
    expect((await second.tool('describe_application', { applicationId: second.id, bindingToken: rotated })).result.structuredContent.code).toBe('agent_binding_revoked');
    expect((await second.tool('describe_application', { applicationId: second.id, bindingToken: plannerKey })).result.structuredContent.caller.verification).toBe('approved-binding');
    const beforeLoss = (await second.tool('describe_application', { applicationId: second.id })).result.structuredContent.provider;
    second.loseNextResult();
    const uncertain = (await second.tool('call_application_command', { applicationId: second.id, bindingToken: plannerKey,
      command: 'count', input: 5, operationId: 'reply-lost-after-save', context: { runId: 'original-run' } })).result.structuredContent;
    expect(uncertain).toMatchObject({ code: 'operation_uncertain', outcome: 'uncertain', operationReference: { deviceId: second.session.deviceId } });
    expect(['saved', 'applied']).toContain(second.lostResult()!.status);
    expect(second.lostResult()!.attemptId).toMatch(/^[a-f0-9]{64}$/u);
    await vi.waitFor(() => expect(second.adapter.online).toBe(true), { timeout: 5000 });
    const restored = (await second.tool('inspect_application_operation', { applicationId: second.id,
      bindingToken: plannerKey, operationId: 'reply-lost-after-save' })).result.structuredContent;
    expect(restored.operationReference).toMatchObject({ operationId: uncertain.operationReference.operationId,
      attemptId: second.lostResult()!.attemptId, deviceId: second.session.deviceId, historyId: 'generic-mcp-test',
      sourceContext: { runId: 'original-run', evidence: 'caller-asserted' } });
    const retried = (await second.tool('retry_application_operation', { applicationId: second.id,
      bindingToken: plannerKey, operationId: 'reply-lost-after-save' })).result.structuredContent;
    expect(retried.operationReference.attemptId).toBe(restored.operationReference.attemptId);
    expect(retried.operationReference.sourceContext.runId).toBe('original-run');
    expect((await second.tool('query_application', { applicationId: second.id, bindingToken: plannerKey, query: 'readings', input: null }))
      .result.structuredContent.value.filter((value: { value: number }) => value.value === 5)).toHaveLength(1);
    const afterLoss = (await second.tool('describe_application', { applicationId: second.id })).result.structuredContent.provider;
    expect(afterLoss.bindingId).toBe(beforeLoss.bindingId);
    expect(afterLoss.selectionEpoch).toBe(beforeLoss.selectionEpoch);
    expect(afterLoss.connectionEpoch).toBeGreaterThan(beforeLoss.connectionEpoch);

    // Simulate a command admitted under the pre-binding gateway, whose
    // assistant_commands row has no assistant_operation_context counterpart.
    // Its original signed operation already exists, but the provider's reply
    // was lost before the caller could distinguish saved from applied.
    const legacyClientId = 'pre-upgrade-reply-lost', legacyInput = 8;
    const legacyNativeId = 'assistant_' + await sha256Hex(JSON.stringify([second.id, b.subject, legacyClientId]));
    const legacyDigest = await sha256Hex(JSON.stringify(['count', legacyInput, null]));
    const originalLegacy = await (await second.session.command('count', legacyInput, { operationId: legacyNativeId })).applied();
    await inDO(b.page.id, t => {
      t.db.run('INSERT INTO assistant_commands(operation_id,input_hash,device_id) VALUES(?,?,?)',
        legacyNativeId, legacyDigest, second.session.deviceId);
      expect(t.db.one('SELECT 1 FROM assistant_operation_context WHERE operation_id=?', legacyNativeId)).toBeNull();
    });
    const legacyRequest = { applicationId: second.id, command: 'count', input: legacyInput, operationId: legacyClientId };
    expect((await second.tool('inspect_application_operation', { applicationId: second.id,
      operationId: legacyClientId })).result.structuredContent.code).toBe('legacy_operation_requires_original_command');
    expect((await second.tool('call_application_command', { ...legacyRequest, input: 9 }))
      .result.structuredContent.code).toBe('operation_id_conflict');
    expect((await second.tool('call_application_command', { ...legacyRequest, context: { runId: 'forged-later' } }))
      .result.structuredContent.code).toBe('operation_id_conflict');
    const recoveredLegacy = (await second.tool('call_application_command', legacyRequest)).result.structuredContent;
    expect(recoveredLegacy.operationReference).toMatchObject({ operationId: legacyNativeId, deviceId: second.session.deviceId,
      generation: second.session.status.generation, sourceContext: { evidence: 'pre-upgrade-admission', generationEvidence: 'not-retained' } });
    expect(recoveredLegacy.operation.state.attemptId).toBe(originalLegacy.attemptId);
    expect(recoveredLegacy.outcome).toBe('applied');
    expect((await second.tool('inspect_application_operation', { applicationId: second.id,
      operationId: legacyClientId })).result.structuredContent.operationReference.operationId).toBe(legacyNativeId);
    expect((await second.tool('call_application_command', legacyRequest)).result.structuredContent.operationReference.operationId)
      .toBe(legacyNativeId);
    expect((await second.tool('query_application', { applicationId: second.id, query: 'readings', input: null }))
      .result.structuredContent.value.filter((item: { value: number }) => item.value === legacyInput)).toHaveLength(1);
    await inDO(b.page.id, t => {
      expect(t.db.one('SELECT COUNT(*) AS n FROM assistant_commands WHERE operation_id=?', legacyNativeId)).toEqual({ n: 1 });
      expect(t.db.one('SELECT COUNT(*) AS n FROM assistant_operation_context WHERE operation_id=?', legacyNativeId)).toEqual({ n: 1 });
    });

    // A legacy gateway admission without a native attempt cannot be silently
    // treated as a new v2 operation (even if the signer is still online).
    const missingClient = 'pre-upgrade-not-yet-saved';
    const missingId = 'assistant_' + await sha256Hex(JSON.stringify([second.id, b.subject, missingClient]));
    await inDO(b.page.id, t => t.db.run('INSERT INTO assistant_commands(operation_id,input_hash,device_id) VALUES(?,?,?)',
      missingId, legacyDigest, second.session.deviceId));
    const absent = (await second.tool('call_application_command', {
      ...legacyRequest, operationId: missingClient })).result.structuredContent;
    expect(absent).toMatchObject({ outcome: 'not-found', code: 'legacy_operation_not_found',
      operationReference: { operationId: missingId, deviceId: second.session.deviceId } });
    expect((await second.tool('query_application', { applicationId: second.id, query: 'readings', input: null }))
      .result.structuredContent.value.filter((item: { value: number }) => item.value === legacyInput)).toHaveLength(1);
  } finally {
    outbound.mockRestore();
    mounted?.close();
    await Promise.all(adapters.map(item => item.close()));
    await Promise.all(sessions.map(item => item.close()));
    await inDO(a.page.id, t => { Object.assign(t.env, restore); });
    await inDO(b.page.id, t => { Object.assign(t.env, restore); });
  }
}, 60_000);

it('uses an operator-pinned client metadata document for public PKCE without fetching caller-controlled URLs', async () => {
  const f = await hostFixture(), id = 'https://chatgpt.com/oauth/client.json';
  const settings = configured({ OAUTH_CONFIG_JSON: JSON.stringify({
    resource: ISSUER + '/mcp', clients: [{
      id, name: 'ChatGPT', redirectUris: [REDIRECT], scopes: ['tendrils:list'], metadataDocument: true,
    }],
  }) });
  const redirect = { client_id: id, redirect_uri: REDIRECT, state: 'cimd-browser-state', resource: ISSUER + '/mcp',
    scope: 'tendrils:list', response_type: 'code', code_challenge_method: 'S256',
    code_challenge: await challengeFor('s'.repeat(43)) };
  let valid = false;
  const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe(id);
    expect(init?.redirect).toBe('manual');
    return Response.json({ client_id: id, redirect_uris: valid ? [REDIRECT] : ['https://chatgpt.com/unregistered'],
      token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'], token_endpoint_auth_method: 'private_key_jwt' });
  });
  try {
    const discovery = await request('/.well-known/oauth-authorization-server', settings);
    expect(await discovery.json()).toMatchObject({ client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none'] });
    const open = (params = redirect) => request('/oauth/authorize?' + new URLSearchParams(params), settings, { headers: { Cookie: f.cookie } });
    expect((await open({ ...redirect, client_id: 'https://unknown.example/client.json' })).status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
    const rejected = await open();
    expect(rejected.status).toBe(303);
    expect(new URL(rejected.headers.get('Location')!).searchParams.get('error')).toBe('invalid_client');
    valid = true;
    const review = await open();
    expect(review.status).toBe(200);
    expect(review.headers.get('Content-Security-Policy')).toContain("form-action 'self' https://chatgpt.com;");
    const connections = await request('/oauth/connections', settings, { headers: { Cookie: f.cookie } });
    expect(connections.headers.get('Content-Security-Policy')).toContain("form-action 'self';");
    const intent = /name="intent" value="([^"]+)"/u.exec(await review.text())![1];
    const approved = await formPost('/oauth/authorize', { intent, decision: 'allow' }, settings, f.cookie);
    expect(approved.status).toBe(303);
    const code = new URL(approved.headers.get('Location')!).searchParams.get('code')!;
    const response = await serviceForm('/oauth/token', { client_id: id, grant_type: 'authorization_code',
      resource: ISSUER + '/mcp', redirect_uri: REDIRECT, code, code_verifier: 's'.repeat(43) }, settings);
    expect(response.status).toBe(200);
    const result = await response.json() as { access_token: string };
    const listed = await jsonPost('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_tendrils', arguments: {} } }, settings, result.access_token);
    const listing = (await listed.json() as any).result.structuredContent;
    expect(listing).toMatchObject({ applications: [], serviceOrigin: ISSUER,
      environment: { id: ISSUER, label: new URL(ISSUER).host, kind: 'deployment' },
      build: { coreRelease: CORE_RELEASE, sourceCommit: null }, setup: {
      guideTool: 'tendril_guide', topic: 'start', serviceOrigin: ISSUER,
      startHere: ISSUER + '/docs/MCP_AGENT_GUIDE.md', nextAction: expect.stringContaining('For a new app'),
      originPolicy: 'same-origin-only', guideUnavailableAction: expect.stringContaining('Refresh the installed plugin'),
    } });
    const profile = await jsonPost('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_profile', arguments: {} } }, settings, result.access_token);
    const identity = (await profile.json() as any).result.structuredContent;
    expect(identity.id).toMatch(/^profile_[a-f0-9]{64}$/);
    expect(identity).toMatchObject({ serviceOrigin: listing.serviceOrigin, environment: listing.environment, build: listing.build,
      setup: { startHere: listing.setup.startHere, guideUnavailableAction: listing.setup.guideUnavailableAction } });
    expect(identity).not.toHaveProperty('email');
    expect(identity).not.toHaveProperty('account');
    await env.ACCOUNTS.prepare("UPDATE service_state SET mode='creation_paused' WHERE id=1").run();
    try {
      const blocked = await jsonPost('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'list_tendrils', arguments: {} } }, settings, result.access_token);
      expect((await blocked.json() as any).result.structuredContent).toMatchObject({ applications: [], serviceOrigin: ISSUER,
        readiness: { mode: 'creation_paused', creation: { available: false } },
        setup: { nextAction: expect.stringContaining('Stop new-app setup before downloading or installing packages') } });
    } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
  } finally { outbound.mockRestore(); }
});

it('reserves application routing only for enabled pages in the same account', async () => {
  const applicationId = await sha256Hex('shared-app-id-' + crypto.randomUUID());
  const [a, b] = await Promise.all([hostFixture(applicationId), hostFixture(applicationId)]);
  const add = (pageId: string, account: string, enabled: number) => env.ACCOUNTS
    .prepare('INSERT INTO assistant_connections(page_id,application_id,owner_account,label,enabled) VALUES(?,?,?,?,?)')
    .bind(pageId, applicationId, account, 'Connections test', enabled).run();
  const pendingPage = await create({ claim: false, application: { id: applicationId } });
  await add(pendingPage.id, a.subject, 0);
  await add(a.page.id, a.subject, 1);
  await add(b.page.id, b.subject, 1);
  expect((await resolveConnection(env, a.subject, applicationId)).pageId).toBe(a.page.id);
  expect((await resolveConnection(env, b.subject, applicationId)).pageId).toBe(b.page.id);
  await expect(env.ACCOUNTS.prepare('UPDATE assistant_connections SET enabled=1 WHERE page_id=?').bind(pendingPage.id).run())
    .rejects.toThrow(/UNIQUE constraint failed/);
});
