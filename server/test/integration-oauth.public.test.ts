import { beforeAll, expect, it } from 'vitest';
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Env } from '../src/env';
import { route } from '../src/router';
import { CORE_RELEASE } from '../../contract/index.mjs';
import { base64url, challengeFor, oauthConfig, signAccessToken } from '../src/accounts/oauth-support';
import { sha256Hex } from '../src/ids';
import { bytesToHex, eventExecutionManifest, executionManifestArtifacts, exportSigningIdentity } from '@chronolog/peer-session';
import { createSigningIdentity, signAppDescriptor, signMembership, epochKeyCommitment, encodeRecord, recordDigest } from '@chronolog/authority';
import { authorityRecord } from '../../contract/authority.mjs';
import { sealHostedKeys } from '../src/mcp-crypto';
import { doltliteExecutionManifestDigest } from '../src/mcp-sql';
import { PUBLICATION_WATCH_PROTOCOL } from '../src/publication-watch';
import { create, inDO, ownerHeaders } from './helpers';

const ISSUER = 'https://tendriller.dev', RESOURCE = ISSUER + '/mcp';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
let privateJwk: JsonWebKey, publicJwk: JsonWebKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
});
function configured(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    OAUTH_CONFIG_JSON: JSON.stringify({
      resource: RESOURCE,
      clients: [
        {
          id: 'chatgpt',
          name: 'ChatGPT',
          redirectUris: [REDIRECT],
          scopes: ['tendrils:create', 'tendrils:list', 'applications:read', 'applications:write', 'events:subscribe'],
          allowRefresh: true,
        },
      ],
    }),
    OAUTH_SIGNING_JWK: JSON.stringify({ ...privateJwk, kid: 'signing-1', alg: 'ES256' }),
    ...overrides,
  };
}
function request(path: string, settings: Env = configured(), init: RequestInit = {}) {
  const headers = new Headers(init.headers), bytes = crypto.getRandomValues(new Uint8Array(2));
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', `198.18.${bytes[0]}.${bytes[1]}`);
  const target = /^https?:\/\//u.test(path) ? path : ISSUER + path;
  return route(new Request(target, { ...init, headers }), settings);
}

async function hostFixture(applicationId?: string) {
  const page = await create(applicationId ? { application: { id: applicationId } } : {}), subject = await inDO(page.id, t => t.db.get<string>('owner_account', ''));
  const raw = 'browser-' + crypto.randomUUID(), now = Date.now();
  await env.ACCOUNTS.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)')
    .bind(await sha256Hex(raw), subject, now, now + 3600000).run();
  const settings = configured();
  return { page, subject, settings, raw, cookie: '__Host-tendriller=' + raw };
}
function jsonPost(path: string, input: unknown, settings: Env, secret: string) {
  return request(path, settings, { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}
function formPost(path: string, input: Record<string, string>, settings: Env, cookie: string, origin = ISSUER) {
  return request(path, settings, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(input) });
}
function serviceForm(path: string, input: Record<string, string>, settings: Env, authorization?: string) {
  return request(path, settings, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(authorization ? { Authorization: authorization } : {}) },
    body: new URLSearchParams(input),
  });
}
function decodePart(value: string) { return JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))); }
async function authorization(f: Awaited<ReturnType<typeof hostFixture>>, overrides: Record<string, string> = {}, decision = 'allow') {
  const verifier = 'verifier-' + 'v'.repeat(43), state = 'state-' + crypto.randomUUID();
  const params = new URLSearchParams({
    response_type: 'code', client_id: 'chatgpt', redirect_uri: REDIRECT, resource: RESOURCE,
    scope: 'tendrils:create tendrils:list applications:read applications:write events:subscribe',
    code_challenge_method: 'S256', code_challenge: await challengeFor(verifier), state, ...overrides,
  });
  const response = await request('/oauth/authorize?' + params, f.settings, { headers: { Cookie: f.cookie } });
  expect(response.status).toBe(200);
  const html = await response.text(), token = /name="intent" value="([^"]+)"/u.exec(html)![1];
  expect(html).toContain('Allow access'); expect(html).toContain('Individual apps keep their own permissions');
  const result = await formPost('/oauth/authorize', { intent: token, decision }, f.settings, f.cookie);
  expect(result.status).toBe(303);
  const location = new URL(result.headers.get('Location')!);
  expect(location.searchParams.get('iss')).toBe(ISSUER); expect(location.searchParams.get('state')).toBe(state);
  return { code: location.searchParams.get('code'), error: location.searchParams.get('error'), verifier, token };
}
async function tokens(f: Awaited<ReturnType<typeof hostFixture>>, scopeOverrides?: string) {
  const approved = await authorization(f, scopeOverrides ? { scope: scopeOverrides } : {});
  const response = await serviceForm('/oauth/token', {
    client_id: 'chatgpt', grant_type: 'authorization_code', resource: RESOURCE,
    redirect_uri: REDIRECT, code: approved.code!, code_verifier: approved.verifier,
  }, f.settings);
  expect(response.status).toBe(200);
  const result = await response.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
  return { ...result, approved, grantId: decodePart(result.access_token.split('.')[1]).sid as string };
}
async function accessActive(token: string, settings: Env) {
  const response = await jsonPost('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, settings, token);
  return response.status === 200;
}
async function mcpCall(settings: Env, token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await jsonPost('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, settings, token);
  const body = await response.json() as any;
  return { response, body, result: body?.result, value: body?.result?.structuredContent };
}

async function seedPageAuthorityAndDomain(
  page: { id: string; application: { id: string } },
  writers: readonly string[],
  epochKey: Uint8Array,
  manifestDigest: string,
  executionProfile: string,
  domainSource: string,
) {
  const signer = await createSigningIdentity();
  const descriptor = await signAppDescriptor({
    applicationId: page.application.id,
    rootPrincipal: writers[0],
    authorityPublicKey: signer.publicKey,
    executionManifestDigest: manifestDigest,
    finalityPolicy: { kind: 'none' },
  }, signer);
  const membership = await signMembership({
    applicationId: page.application.id,
    revision: 0,
    previous: null,
    authorTimeAfterMs: -1n,
    epoch: 0,
    epochKeyDigest: await epochKeyCommitment(page.application.id, 0, epochKey),
    members: writers.map(publicKey => ({ publicKey, reader: true, writer: true, administrator: true, publisher: false, finalizer: false })),
  }, signer);
  const bundle = { descriptor, memberships: [membership] };
  const configuration = { executionManifestDigest: manifestDigest, executionProfile, publisherKeys: [signer.publicKey] };
  const configurationDigest = await recordDigest(configuration);
  const domainBytes = new TextEncoder().encode(domainSource);
  const domainHash = await sha256Hex(domainSource);
  await env.FILES.put(`t/${page.id}/files/${domainHash}`, domainBytes, { httpMetadata: { contentType: 'text/javascript; charset=utf-8' } });
  await inDO(page.id, t => {
    t.db.set('application_configuration', configuration);
    t.db.set('application_configuration_digest', configurationDigest);
    t.db.set('application_authority', authorityRecord(encodeRecord(bundle)));
    t.db.run("INSERT OR REPLACE INTO versions(version, created_at, runtime_id, runtime_version, runtime_features, entry, message) VALUES(1, ?, 'test-rt', '1', '[]', 'index.html', 'test')", t.now());
    t.db.run("INSERT OR REPLACE INTO version_files(version, path, hash, type, size) VALUES(1, 'domain.js', ?, 'text/javascript; charset=utf-8', ?)", domainHash, domainBytes.byteLength);
    t.db.set('current', 1);
  });
  return { bundle, signer };
}

it('first-party OAuth stays disabled until explicitly configured and remains on the service origin', async () => {
  expect((await request('/.well-known/oauth-authorization-server', { ...env, OAUTH_CONFIG_JSON: undefined })).status).toBe(404);
  expect((await route(new Request('https://other.example/.well-known/oauth-authorization-server'), configured())).status).toBe(404);
  expect((await request('/.well-known/oauth-authorization-server', configured({ OAUTH_SIGNING_JWK: undefined }))).status).toBe(503);
});

it('challenges an empty OAuth setup probe and serves the public resource-template catalog', async () => {
  const settings = configured({
    OAUTH_CONFIG_JSON: JSON.stringify({
      resource: ISSUER + '/mcp',
      clients: [{ id: 'chatgpt', name: 'ChatGPT', redirectUris: [REDIRECT], scopes: ['applications:read'] }],
    }),
  });
  const probe = await request('/mcp', settings, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' } });
  expect(probe.status).toBe(401);
  expect(probe.headers.get('WWW-Authenticate')).toContain(ISSUER + '/.well-known/oauth-protected-resource/mcp');
  const resource = await (await request('/.well-known/oauth-protected-resource/mcp', settings)).json() as { scopes_supported: string[] };
  expect(resource.scopes_supported).toEqual(['applications:read']);
  const authorizationResp = await request('/oauth/authorize?' + new URLSearchParams({
    client_id: 'chatgpt', redirect_uri: REDIRECT, state: 'chatgpt-discovery', resource: ISSUER + '/mcp',
    response_type: 'code', scope: resource.scopes_supported.join(' '),
    code_challenge_method: 'S256', code_challenge: await challengeFor('s'.repeat(43)),
  }), settings);
  expect(authorizationResp.status).toBe(303);
  expect(new URL(authorizationResp.headers.get('Location')!, ISSUER).pathname).toBe('/auth');
  const templates = await request('/mcp', settings, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/templates/list' }),
  });
  expect(templates.status).toBe(200);
  expect(await templates.json()).toMatchObject({ result: { resourceTemplates: [] } });
});

it('provides a complete public MCP onboarding route without browsing or account access, including staging', async () => {
  const origin = 'https://staging.tendriller.dev';
  const settings = configured({
    PUBLIC_BASE: origin, SERVICE_ENVIRONMENT: 'Staging QA', SERVICE_SOURCE_COMMIT: 'c'.repeat(40), SERVICE_COMPOSITION_ID: 'd'.repeat(64),
    OAUTH_CONFIG_JSON: JSON.stringify({
      resource: origin + '/mcp',
      clients: [{ id: 'chatgpt', name: 'ChatGPT', redirectUris: [REDIRECT], scopes: ['applications:read'] }],
    }),
  });
  const call = async (method: string, params: object = {}) => {
    const response = await route(new Request(origin + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }), settings);
    return { response, body: await response.json() as Record<string, any> };
  };
  const before = await env.ACCOUNTS.prepare('SELECT COUNT(*) AS count FROM tendrils').first();
  const initialized = await call('initialize', { protocolVersion: '2025-11-25' });
  expect(initialized.body.result.instructions).toContain('tendril_guide');
  expect(initialized.body.result.instructions).toContain(origin);
  expect(initialized.body.result.instructions).toContain(origin + '/docs/MCP_AGENT_GUIDE.md');
  expect(initialized.body.result.serverInfo.version).toBe(CORE_RELEASE);
  expect(initialized.body.result._meta['tendriller/service']).toMatchObject({
    serviceOrigin: origin,
    environment: { id: origin, label: 'Staging QA', kind: 'deployment' },
    build: { coreRelease: CORE_RELEASE, sourceCommit: 'c'.repeat(40), compositionId: 'd'.repeat(64), runtimeId: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
  expect((await call('server/discover')).body.result._meta['tendriller/service']).toEqual(initialized.body.result._meta['tendriller/service']);
  const catalog = await call('tools/list');
  const guideTool = catalog.body.result.tools.find((item: any) => item.name === 'tendril_guide');
  expect(guideTool.securitySchemes).toEqual([{ type: 'noauth' }]);
  expect(guideTool.inputSchema.properties.topic.enum).toContain('build');
  expect(guideTool.inputSchema.properties.topic.enum).toContain('conversation');
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
  expect(start.setup).toMatchObject({
    startHere: origin + '/docs/MCP_AGENT_GUIDE.md', originPolicy: 'same-origin-only',
    guideUnavailableAction: expect.stringContaining(origin + '/.well-known/tendriller.json'),
  });
  expect(start.readiness).toMatchObject({ serviceOrigin: origin, mode: 'open', creation: { available: true } });
  expect(start.setup.readinessUrl).toBe(origin + '/api/readiness');
  expect(start.setup).toMatchObject({ conversationGuide: origin + '/docs/CONVERSATION_DELIVERY.md',
    conversationWake: 'not-established', conversationNextAction: expect.stringContaining('same existing thread') });
  expect(start.text).toContain('Node 24');
  expect(start.text).toContain('register_agent');
  expect(start.text).toContain('tendril workspace adopt');
  expect(start.text).not.toContain('prepare_tendril_setup');
  expect(start.text).not.toContain('https://tendriller.dev');
  expect(start.onboarding.interfaces.create_page.url).toBe(origin + '/api/agent/pages');
  const build = await readGuide({ topic: 'build' });
  expect(build.text).toContain('npm run page:new');
  expect(build.text).toContain(origin + '/downloads/tendriller-first-app.tgz');
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='creation_paused' WHERE id=1").run();
  try {
    const paused = await readGuide({ topic: 'build' });
    expect(paused.readiness).toMatchObject({ mode: 'creation_paused', creation: { available: false }, writes: { available: true } });
    expect(paused.text).toMatch(/^New application setup is blocked:/);
    expect(paused.text.indexOf('Stop new-app setup before downloading')).toBeLessThan(paused.text.indexOf('npm install'));
    expect(paused.text).not.toContain('https://tendriller.dev');
  } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
  for (const topic of ['capabilities', 'connect', 'delivery', 'conversation', 'troubleshooting']) {
    const guide = await readGuide({ topic });
    expect(guide.url).toBe(origin + '/docs/' + ({ capabilities: 'CAPABILITIES', connect: 'CLOUDFLARE_ASSISTANT', delivery: 'AGENT_DELIVERY', conversation: 'CONVERSATION_DELIVERY', troubleshooting: 'TROUBLESHOOTING' } as Record<string, string>)[topic] + '.md');
    expect(guide.text.length).toBeGreaterThan(100);
  }
  const resources = await call('resources/list');
  expect(resources.body.result.resources).toContainEqual(expect.objectContaining({ uri: start.url, mimeType: 'text/markdown' }));
  expect((await call('resources/read', { uri: start.url })).body.result.contents[0].text).toBe(start.text);
  const invalid = await call('tools/call', { name: 'tendril_guide', arguments: { topic: 'https://untrusted.example/' } });
  expect(invalid.body.result).toMatchObject({ isError: true, structuredContent: { code: 'invalid_guide_topic' } });
  const absentGuide = await route(new Request(origin + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tendril_guide' } }),
  }), { ...settings, ASSETS: { fetch: async () => new Response('Missing', { status: 404 }) } as unknown as Fetcher });
  const absent = (await absentGuide.json() as any).result;
  expect(absent).toMatchObject({
    isError: true,
    structuredContent: { code: 'guide_unavailable', message: expect.stringContaining(origin + '/.well-known/tendriller.json') },
  });
  expect(absent.structuredContent.message).not.toContain('https://tendriller.dev');
  expect((await call('tools/call', { name: 'list_tendrils', arguments: {} })).response.status).toBe(401);
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS count FROM tendrils').first()).toEqual(before);
});

it('enabled OAuth names its missing account schema while the ordinary host still works with OAuth disabled', async () => {
  const settings = configured();
  await env.ACCOUNTS.prepare('ALTER TABLE integration_oauth_access RENAME TO temporarily_absent_oauth_access').run();
  try {
    const metadata = await request('/.well-known/oauth-authorization-server', settings);
    expect(metadata.status).toBe(503); expect((await metadata.json() as { error_description: string }).error_description).toContain('0001_accounts.sql');
    const disabled = { ...settings, OAUTH_CONFIG_JSON: undefined };
    expect((await request('/.well-known/oauth-authorization-server', disabled)).status).toBe(404);
    expect((await request('/api/service', disabled)).status).toBe(200);
  } finally {
    await env.ACCOUNTS.prepare('ALTER TABLE temporarily_absent_oauth_access RENAME TO integration_oauth_access').run();
  }
});

it('discovery binds the exact resource issuer, PKCE and preconfigured client authentication', async () => {
  const response = await request('/.well-known/oauth-authorization-server');
  expect(response.status).toBe(200);
  const value = await response.json() as Record<string, unknown>;
  expect(value).toMatchObject({
    issuer: ISSUER, authorization_endpoint: ISSUER + '/oauth/authorize', token_endpoint: ISSUER + '/oauth/token',
    code_challenge_methods_supported: ['S256'], response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: false,
  });
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

it('authorization code flow issues X25519 wrap key in tokens only and clears transient code key at redemption', async () => {
  const f = await hostFixture(), issued = await tokens(f), [header, payload, signature] = issued.access_token.split('.');
  const claims = decodePart(payload);
  expect(decodePart(header)).toEqual({ typ: 'at+jwt', alg: 'ES256', kid: 'signing-1' });
  expect(claims).toMatchObject({ iss: ISSUER, sub: f.subject, aud: RESOURCE, client_id: 'chatgpt', sid: issued.grantId });
  expect(typeof claims.wk).toBe('string');
  expect(claims.wk.length).toBeGreaterThan(20);
  expect(issued.refresh_token).toMatch(/^rt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  expect(claims.exp - claims.iat).toBe(300); expect(issued.expires_in).toBeGreaterThan(0); expect(issued.expires_in).toBeLessThanOrEqual(300);
  const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
  expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes, new TextEncoder().encode(header + '.' + payload))).toBe(true);
  expect(await accessActive(issued.access_token, f.settings)).toBe(true);
  const grantRow = await env.ACCOUNTS.prepare('SELECT wrap_public_key FROM integration_oauth_grants WHERE id=?').bind(issued.grantId).first<{ wrap_public_key: string }>();
  expect(grantRow?.wrap_public_key).toMatch(/^[a-f0-9]{64}$/u);
  const codeRow = await env.ACCOUNTS.prepare('SELECT sealed_wrap_key, used_at FROM integration_oauth_codes WHERE grant_id=?').bind(issued.grantId).first<{ sealed_wrap_key: string | null; used_at: number | null }>();
  expect(codeRow?.used_at).toBeGreaterThan(0);
  expect(codeRow?.sealed_wrap_key).toBeNull();
  const rows = await env.ACCOUNTS.prepare('SELECT hash FROM integration_oauth_access WHERE grant_id=?').bind(issued.grantId).all();
  expect(JSON.stringify(rows.results)).not.toContain(issued.access_token);
  expect(rows.results[0]).toMatchObject({ hash: await sha256Hex(issued.access_token) });
});

it('authorization rejects unregistered redirects, duplicate parameters, missing S256 and excessive scopes', async () => {
  const f = await hostFixture(), base = {
    response_type: 'code', client_id: 'chatgpt', redirect_uri: REDIRECT, resource: RESOURCE,
    scope: 'applications:read', code_challenge_method: 'S256', code_challenge: await challengeFor('v'.repeat(43)), state: 'same-state',
  };
  const anonymous = await request('/oauth/authorize?' + new URLSearchParams(base), f.settings);
  expect(anonymous.status).toBe(303); expect(anonymous.headers.get('Location')).toMatch(/^\/auth\?return_to=/u);
  const unregistered = await request('/oauth/authorize?' + new URLSearchParams({ ...base, redirect_uri: 'https://attacker.example/callback' }), f.settings);
  expect(unregistered.status).toBe(400); expect(unregistered.headers.has('Location')).toBe(false);
  const duplicate = await request('/oauth/authorize?' + new URLSearchParams(base) + '&client_id=chatgpt', f.settings);
  expect(duplicate.status).toBe(400); expect(duplicate.headers.has('Location')).toBe(false);
  for (const [override, error] of [
    [{ code_challenge_method: 'plain' }, 'invalid_request'], [{ scope: 'pages:publish' }, 'invalid_scope'],
    [{ resource: 'https://other.example/mcp' }, 'invalid_target'], [{ response_type: 'token' }, 'unsupported_response_type'],
  ] as const) {
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
  expect(await accessActive(issued.access_token, f.settings)).toBe(true);
  expect((await serviceForm('/oauth/token', { ...input, code_verifier: 'wrong'.repeat(12) }, f.settings)).status).toBe(400);
  expect(await accessActive(issued.access_token, f.settings)).toBe(true);
  expect((await serviceForm('/oauth/token', input, f.settings)).status).toBe(400);
  expect(await accessActive(issued.access_token, f.settings)).toBe(false);
});

it('refresh rotates one-use tokens preserving wrap key, permits narrower scopes and revokes the entire grant on replay', async () => {
  const f = await hostFixture(), issued = await tokens(f);
  const input = { grant_type: 'refresh_token', client_id: 'chatgpt', resource: RESOURCE, refresh_token: issued.refresh_token };
  expect((await serviceForm('/oauth/token', { ...input, scope: 'pages:publish' }, f.settings)).status).toBe(400);
  const refreshed = await serviceForm('/oauth/token', { ...input, scope: 'applications:read' }, f.settings); expect(refreshed.status).toBe(200);
  const renewed = await refreshed.json() as { access_token: string; refresh_token: string; scope: string };
  expect(renewed.refresh_token).not.toBe(issued.refresh_token); expect(renewed.access_token).not.toBe(issued.access_token);
  expect(renewed.scope).toBe('applications:read'); expect(await accessActive(renewed.access_token, f.settings)).toBe(true);
  expect(decodePart(renewed.access_token.split('.')[1]).wk).toBeTruthy();
  expect((await serviceForm('/oauth/token', input, f.settings)).status).toBe(400);
  expect(await accessActive(issued.access_token, f.settings)).toBe(false);
  expect(await accessActive(renewed.access_token, f.settings)).toBe(false);
  expect((await serviceForm('/oauth/token', { ...input, refresh_token: renewed.refresh_token }, f.settings)).status).toBe(400);
});

it('concurrent refresh claims cannot create two usable replacements', async () => {
  const f = await hostFixture(), issued = await tokens(f), input = { grant_type: 'refresh_token', client_id: 'chatgpt', resource: RESOURCE, refresh_token: issued.refresh_token };
  const results = await Promise.all([serviceForm('/oauth/token', input, f.settings), serviceForm('/oauth/token', input, f.settings)]);
  expect(results.filter(response => response.status === 200).length).toBeLessThanOrEqual(1);
  expect(results.some(response => response.status === 400)).toBe(true);
  for (const response of results) if (response.status === 200) {
    const value = await response.json() as { access_token: string };
    expect(await accessActive(value.access_token, f.settings)).toBe(false);
  }
  expect(await accessActive(issued.access_token, f.settings)).toBe(false);
});

it('token revocation is idempotent and exact; another active grant does not restore it', async () => {
  const f = await hostFixture(), first = await tokens(f), second = await tokens(f);
  const input = { client_id: 'chatgpt', token: first.refresh_token, token_type_hint: 'refresh_token' };
  expect((await serviceForm('/oauth/revoke', input, f.settings)).status).toBe(200);
  expect((await serviceForm('/oauth/revoke', input, f.settings)).status).toBe(200);
  expect(await accessActive(first.access_token, f.settings)).toBe(false);
  expect(await accessActive(second.access_token, f.settings)).toBe(true);
  await env.ACCOUNTS.prepare('UPDATE accounts SET deleting_at=? WHERE id=?').bind(Date.now(), f.subject).run();
  expect(await accessActive(second.access_token, f.settings)).toBe(false);
  expect((await serviceForm('/oauth/token', { grant_type: 'refresh_token', client_id: 'chatgpt', resource: RESOURCE, refresh_token: second.refresh_token }, f.settings)).status).toBe(400);
});

it('confidential clients require their registered Basic secret as well as PKCE', async () => {
  const f = await hostFixture(), secret = 'client-private-' + 's'.repeat(43), value = JSON.parse(f.settings.OAUTH_CONFIG_JSON!);
  Object.assign(value.clients[0], { tokenEndpointAuthMethod: 'client_secret_basic', clientSecretSha256: await sha256Hex(secret) });
  f.settings.OAUTH_CONFIG_JSON = JSON.stringify(value);
  const approved = await authorization(f), input = {
    grant_type: 'authorization_code', client_id: 'chatgpt', resource: RESOURCE,
    redirect_uri: REDIRECT, code: approved.code!, code_verifier: approved.verifier,
  };
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
  expect(await accessActive(foreign.access_token, other.settings)).toBe(true);
  const again = await request('/oauth/connections', f.settings, { headers: { Cookie: f.cookie } });
  const next = /name="intent" value="([^"]+)"/u.exec(await again.text())![1];
  expect((await formPost('/oauth/connections', { intent: next, grant_id: issued.grantId }, f.settings, f.cookie)).status).toBe(303);
  expect(await accessActive(issued.access_token, f.settings)).toBe(false);
  expect((await formPost('/oauth/connections', { intent: next, grant_id: issued.grantId }, f.settings, f.cookie)).status).toBe(403);
});

it('RS256 signing and retained public keys support configured key rotation without publishing private material', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const signing = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  const settings = configured({
    OAUTH_SIGNING_JWK: JSON.stringify({ ...signing, kid: 'rsa-2', alg: 'RS256' }),
    OAUTH_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, kid: 'signing-1', alg: 'ES256' }] }),
  });
  const config = (await oauthConfig(settings))!, token = await signAccessToken(config, { sub: 'test', aud: RESOURCE });
  const [header, payload, signature] = token.split('.'); expect(decodePart(header).alg).toBe('RS256');
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
  expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, bytes, new TextEncoder().encode(header + '.' + payload))).toBe(true);
  const jwks = await (await request('/oauth/jwks', settings)).json() as { keys: { kid: string; d?: string }[] };
  expect(jwks.keys.map(key => key.kid)).toEqual(['rsa-2', 'signing-1']); expect(jwks.keys.every(key => key.d === undefined)).toBe(true);
});

it('register_agent over /mcp registers a handle + bio and rotates on repeat handle', async () => {
  const f = await hostFixture(), issued = await tokens(f);
  const kp1 = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pub1 = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp1.publicKey) as ArrayBuffer));
  const first = await mcpCall(f.settings, issued.access_token, 'register_agent', { handle: 'atlas', bio: 'Research helper', publicKey: pub1 });
  expect(first.response.status).toBe(200);
  expect(first.result.isError).not.toBe(true);
  expect(first.value).toMatchObject({ agent: { handle: 'atlas', bio: 'Research helper' }, rotated: false });
  expect(first.value.token).toMatch(/^ta_/u);

  const kp2 = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pub2 = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp2.publicKey) as ArrayBuffer));
  const second = await mcpCall(f.settings, issued.access_token, 'register_agent', { handle: 'atlas', bio: 'Updated bio', publicKey: pub2 });
  expect(second.value).toMatchObject({ agent: { id: first.value.agent.id, handle: 'atlas', bio: 'Updated bio' }, rotated: true });
  expect(second.value.token).not.toBe(first.value.token);

  const invalid = await mcpCall(f.settings, issued.access_token, 'register_agent', { handle: 'Bad Handle!', publicKey: pub2 });
  expect(invalid.result.isError).toBe(true);
});

it('executes hosted MCP Events domain.js in QuickJS-WASM with OAuth-wrapped keys, zero plaintext keys at rest, multi-agent messaging, HTTP gateway, and revocation', async () => {
  const f = await hostFixture();
  const issued = await tokens(f);
  const restore = await inDO(f.page.id, t => ({ OAUTH_CONFIG_JSON: t.env.OAUTH_CONFIG_JSON, OAUTH_SIGNING_JWK: t.env.OAUTH_SIGNING_JWK }));
  await inDO(f.page.id, t => {
    t.env.OAUTH_CONFIG_JSON = f.settings.OAUTH_CONFIG_JSON;
    t.env.OAUTH_SIGNING_JWK = f.settings.OAUTH_SIGNING_JWK;
  });
  try {
    const pageBase = f.page.page_url;
    const pageOwner = ownerHeaders(pageBase);
    const grantsResp = await request(pageBase + '_tendril/mcp/grants', f.settings, { headers: pageOwner });
    expect(grantsResp.status).toBe(200);
    const grantsData = await grantsResp.json() as { configured: boolean; grants: Array<{ id: string; wrap_public_key: string }> };
    expect(grantsData.configured).toBe(true);
    const grantInfo = grantsData.grants.find(g => g.id === issued.grantId)!;
    expect(grantInfo.wrap_public_key).toMatch(/^[a-f0-9]{64}$/u);

    const hostedIdentity = await exportSigningIdentity(await createSigningIdentity());
    const epochKey = crypto.getRandomValues(new Uint8Array(32));
    const eventsDomain = `
      export default {
        id: 'notes-hosted-test',
        version: '1',
        commands: {
          putNote: {
            description: 'Save a note',
            input: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
            prepare: ({ id, text }) => ({ steps: [{ kind: 'emit', topic: 'note', payload: { id, text } }] }),
          },
        },
        queries: {
          notes: {
            description: 'List saved notes',
            input: { type: 'null' },
            read: (view) => view.readEvents({ topics: ['note'] }).events.map(e => e.payload),
          },
        },
      };
    `;
    const eventManifest = await executionManifestArtifacts(await eventExecutionManifest());
    await seedPageAuthorityAndDomain(f.page, [hostedIdentity.publicKey], epochKey, bytesToHex(eventManifest.executionManifestDigest), 'event-v1', eventsDomain);

    const aad = `${f.page.id}:${f.page.application.id}:${issued.grantId}`;
    const wrapped = await sealHostedKeys(grantInfo.wrap_public_key, {
      signingSeedHex: hostedIdentity.privateKey,
      signingPublicKey: hostedIdentity.publicKey,
      epochKeys: { '0': bytesToHex(epochKey) },
    }, aad);

    const connectResp = await request(pageBase + '_tendril/mcp/connect', f.settings, {
      method: 'POST',
      headers: { ...pageOwner, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grantId: issued.grantId,
        handle: 'chatgpt',
        bio: 'Hosted notes assistant',
        publicKey: hostedIdentity.publicKey,
        wrappedKeysBase64: base64url(wrapped),
        label: 'Hosted Notes',
      }),
    });
    expect(connectResp.status).toBe(201);
    await connectResp.json();

    // Appears in page roster as hosted-mcp agent; owner can promote it to primary.
    const rosterResp = await request(pageBase + '_tendril/agents', f.settings, { headers: pageOwner });
    expect(rosterResp.status).toBe(200);
    const roster = await rosterResp.json() as { primary_agent_id: string; agents: Array<{ id: string; handle: string; kind: string }> };
    expect(roster.primary_agent_id).toBe(f.page.agent.id);
    expect(roster.agents).toContainEqual(expect.objectContaining({ id: `mcp:${issued.grantId}`, handle: 'chatgpt', kind: 'hosted-mcp' }));
    const promoteResp = await request(pageBase + '_tendril/agents/primary', f.settings, {
      method: 'PUT',
      headers: { ...pageOwner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: `mcp:${issued.grantId}` }),
    });
    expect(promoteResp.status).toBe(200);
    expect((await promoteResp.json() as { primary_agent_id: string }).primary_agent_id).toBe(`mcp:${issued.grantId}`);

    // list_tendrils + describe_application + agents_list
    const listed = await mcpCall(f.settings, issued.access_token, 'list_tendrils');
    expect(listed.value.applications).toContainEqual(expect.objectContaining({ applicationId: f.page.application.id, handle: 'chatgpt', label: 'Hosted Notes' }));

    const described = await mcpCall(f.settings, issued.access_token, 'describe_application', { applicationId: f.page.application.id });
    expect(described.value.hasDomainBundle).toBe(true);
    expect(described.value.hostedParticipant).toMatchObject({ handle: 'chatgpt', isPrimary: true, keyCustody: 'oauth-token-wrapped' });
    expect(described.value.commands.map((c: any) => c.name)).toContain('putNote');
    expect(described.value.queries.map((q: any) => q.name)).toContain('notes');

    const agents = await mcpCall(f.settings, issued.access_token, 'agents_list', { applicationId: f.page.application.id });
    expect(agents.value.selfHandle).toBe('chatgpt');

    // Execute command + query through QuickJS-NG WASM sandbox
    const write = await mcpCall(f.settings, issued.access_token, 'call_application_command', {
      applicationId: f.page.application.id,
      command: 'putNote',
      input: { id: 'n1', text: 'Zero plaintext keys at rest!' },
      operationId: 'op-note-1',
    });
    expect(write.value, JSON.stringify(write.result)).toMatchObject({ materialized: { outcome: 'accepted' } });
    expect(write.result.isError).not.toBe(true);

    const read = await mcpCall(f.settings, issued.access_token, 'query_application', {
      applicationId: f.page.application.id,
      query: 'notes',
      input: null,
    });
    expect(read.result.isError).not.toBe(true);
    expect(read.value.value).toEqual([{ id: 'n1', text: 'Zero plaintext keys at rest!' }]);

    // Multi-agent Chronolog pipe: agent_message + agent_feed
    const sent = await mcpCall(f.settings, issued.access_token, 'agent_message', {
      applicationId: f.page.application.id,
      channel: 'chat',
      text: 'Saved note n1 for you.',
      expectReply: false,
      operationId: 'op-chat-1',
    });
    expect(sent.result.isError).not.toBe(true);
    const feed = await mcpCall(f.settings, issued.access_token, 'agent_feed', { applicationId: f.page.application.id });
    expect(feed.value.value.messages).toEqual([expect.objectContaining({ text: 'Saved note n1 for you.', expectReply: false })]);

    // Outbound HTTPS gateway `/v1/apps/:appId/*` works identically
    const httpQuery = await request(`/v1/apps/${f.page.application.id}/query?query=notes&input=null`, f.settings, {
      headers: { Authorization: 'Bearer ' + issued.access_token },
    });
    expect(httpQuery.status).toBe(200);
    expect(await httpQuery.json()).toMatchObject({ value: [{ id: 'n1', text: 'Zero plaintext keys at rest!' }] });

    // Blind envelope sync returns encrypted envelopes without revealing plaintext
    const syncResp = await request(pageBase + '_tendril/mcp/sync', f.settings, {
      method: 'POST',
      headers: { ...pageOwner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelopes: [], knownIds: [] }),
    });
    expect(syncResp.status).toBe(200);
    const synced = await syncResp.json() as { envelopes: Array<{ proposalId: string; envelopeBase64: string }> };
    expect(synced.envelopes.length).toBeGreaterThanOrEqual(2);

    // Zero plaintext signing seed or epoch key stored anywhere in DO SQLite
    const leaked = await inDO(f.page.id, t => {
      const storeRows = t.db.all<{ k: string; v: ArrayBuffer }>('SELECT k, v FROM mcp_store');
      const connRows = t.db.all<{ wrapped_keys: ArrayBuffer }>('SELECT wrapped_keys FROM mcp_connections');
      const text = [
        ...storeRows.map(r => r.k + ':' + new TextDecoder().decode(new Uint8Array(r.v))),
        ...connRows.map(r => new TextDecoder().decode(new Uint8Array(r.wrapped_keys))),
      ].join('\n');
      return {
        hasSeed: text.includes(hostedIdentity.privateKey),
        hasEpoch: text.includes(bytesToHex(epochKey)),
        hasPlaintext: text.includes('Zero plaintext keys at rest!'),
        keys: storeRows.map(r => r.k),
      };
    });
    expect(leaked.hasSeed).toBe(false);
    expect(leaked.hasEpoch).toBe(false);
    expect(leaked.hasPlaintext).toBe(false);
    expect(leaked.keys.some(k => /signer|epoch|private/i.test(k))).toBe(false);

    // Evict DO and verify encrypted persistence + re-hydration on next request
    await evictDurableObject(env.TENDRIL.get(env.TENDRIL.idFromName(f.page.id)));
    await inDO(f.page.id, t => {
      t.env.OAUTH_CONFIG_JSON = f.settings.OAUTH_CONFIG_JSON;
      t.env.OAUTH_SIGNING_JWK = f.settings.OAUTH_SIGNING_JWK;
    });
    const afterEvict = await mcpCall(f.settings, issued.access_token, 'query_application', {
      applicationId: f.page.application.id,
      query: 'notes',
      input: null,
    });
    expect(afterEvict.value.value).toEqual([{ id: 'n1', text: 'Zero plaintext keys at rest!' }]);

    // Disconnecting immediately revokes hosted MCP access and updates roster
    const disconnect = await request(pageBase + `_tendril/mcp/${issued.grantId}`, f.settings, {
      method: 'DELETE',
      headers: pageOwner,
    });
    expect(disconnect.status).toBe(200);
    await disconnect.json();
    const denied = await mcpCall(f.settings, issued.access_token, 'query_application', {
      applicationId: f.page.application.id,
      query: 'notes',
      input: null,
    });
    expect(denied.result.isError).toBe(true);
    expect(denied.value.code).toBe('application_not_connected');
  } finally {
    await inDO(f.page.id, t => { Object.assign(t.env, restore); });
  }
});

it('executes hosted MCP SQL domain.js using QuickJS-WASM + ephemeral in-memory DoltLite WASM (MEMFS)', async () => {
  const f = await hostFixture();
  const issued = await tokens(f);
  const restore = await inDO(f.page.id, t => ({ OAUTH_CONFIG_JSON: t.env.OAUTH_CONFIG_JSON, OAUTH_SIGNING_JWK: t.env.OAUTH_SIGNING_JWK }));
  await inDO(f.page.id, t => {
    t.env.OAUTH_CONFIG_JSON = f.settings.OAUTH_CONFIG_JSON;
    t.env.OAUTH_SIGNING_JWK = f.settings.OAUTH_SIGNING_JWK;
  });
  try {
    const pageBase = f.page.page_url;
    const pageOwner = ownerHeaders(pageBase);
    const grantsData = await (await request(pageBase + '_tendril/mcp/grants', f.settings, { headers: pageOwner })).json() as {
      grants: Array<{ id: string; wrap_public_key: string }>;
    };
    const grantInfo = grantsData.grants.find(g => g.id === issued.grantId)!;

    const hostedIdentity = await exportSigningIdentity(await createSigningIdentity());
    const epochKey = crypto.getRandomValues(new Uint8Array(32));
    const sqlDomain = `
      export default {
        id: 'inventory-hosted-sql-test',
        version: '1',
        commands: {
          init: {
            description: 'Create items table',
            input: { type: 'null' },
            prepare: () => ({
              steps: [
                { kind: 'sql', sql: 'CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, qty INTEGER NOT NULL)', params: [] },
              ],
            }),
          },
          addItem: {
            description: 'Insert an item',
            input: { type: 'object', properties: { id: { type: 'string' }, qty: { type: 'integer' } }, required: ['id', 'qty'] },
            prepare: ({ id, qty }) => ({
              steps: [
                { kind: 'sql', sql: 'INSERT INTO items (id, qty) VALUES (?, ?)', params: [id, qty] },
              ],
            }),
          },
        },
        queries: {
          items: {
            description: 'List all items',
            input: { type: 'null' },
            read: (view) => {
              const res = view.query('SELECT id, qty FROM items ORDER BY id');
              return res.rows.map(([id, qty]) => ({ id, qty }));
            },
          },
        },
      };
    `;
    const sqlDigest = await doltliteExecutionManifestDigest();
    await seedPageAuthorityAndDomain(f.page, [hostedIdentity.publicKey], epochKey, sqlDigest, 'sql-doltlite-v1', sqlDomain);

    const aad = `${f.page.id}:${f.page.application.id}:${issued.grantId}`;
    const wrapped = await sealHostedKeys(grantInfo.wrap_public_key, {
      signingSeedHex: hostedIdentity.privateKey,
      signingPublicKey: hostedIdentity.publicKey,
      epochKeys: { '0': bytesToHex(epochKey) },
    }, aad);

    const connectResp = await request(pageBase + '_tendril/mcp/connect', f.settings, {
      method: 'POST',
      headers: { ...pageOwner, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grantId: issued.grantId,
        handle: 'stockbot',
        bio: 'Hosted SQL inventory assistant',
        publicKey: hostedIdentity.publicKey,
        wrappedKeysBase64: base64url(wrapped),
        label: 'Hosted SQL Inventory',
      }),
    });
    expect(connectResp.status).toBe(201);
    await connectResp.json();

    const initRes = await mcpCall(f.settings, issued.access_token, 'call_application_command', {
      applicationId: f.page.application.id,
      command: 'init',
      input: null,
      operationId: 'op-sql-init',
    });
    expect(initRes.value, JSON.stringify(initRes.result)).toMatchObject({ materialized: { outcome: 'accepted' } });
    expect(initRes.result.isError).not.toBe(true);

    const add1 = await mcpCall(f.settings, issued.access_token, 'call_application_command', {
      applicationId: f.page.application.id,
      command: 'addItem',
      input: { id: 'bolts', qty: 42 },
      operationId: 'op-sql-bolts',
    });
    expect(add1.result.isError).not.toBe(true);
    expect(add1.value.materialized.outcome).toBe('accepted');

    const queried = await mcpCall(f.settings, issued.access_token, 'query_application', {
      applicationId: f.page.application.id,
      query: 'items',
      input: null,
    });
    expect(queried.result.isError).not.toBe(true);
    expect(queried.value.value).toEqual([{ id: 'bolts', qty: 42 }]);

    // Verify encrypted SQL checkpointing (threshold = 2) + live `mcp-sync` push notice + DO eviction recovery
    await inDO(f.page.id, t => { t.db.set('mcp_sql_checkpoint_threshold', 2); });
    const watchResp = await request(pageBase + '_tendril/publication-ready', f.settings, {
      headers: { ...pageOwner, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PUBLICATION_WATCH_PROTOCOL },
    });
    expect(watchResp.status).toBe(101);
    const watchSock = watchResp.webSocket!;
    const watchMsgs: any[] = [];
    watchSock.addEventListener('message', ev => { watchMsgs.push(JSON.parse(ev.data as string)); });
    watchSock.accept();
    await expect.poll(() => watchMsgs.length).toBeGreaterThanOrEqual(1);

    const add2 = await mcpCall(f.settings, issued.access_token, 'call_application_command', {
      applicationId: f.page.application.id,
      command: 'addItem',
      input: { id: 'nuts', qty: 10 },
      operationId: 'op-sql-nuts',
    });
    expect(add2.result.isError).not.toBe(true);
    expect(add2.value.materialized.outcome).toBe('accepted');
    await expect.poll(() => watchMsgs.some(m => m.type === 'mcp-sync' && m.version === 1)).toBe(true);
    watchSock.close();

    // Encrypted SQL checkpoint exists in mcp_store with ZERO plaintext SQLite header or row values
    const ckptCheck = await inDO(f.page.id, t => {
      const row = t.db.one<{ v: ArrayBuffer }>('SELECT v FROM mcp_store WHERE k=?', `sql-checkpoint/${f.page.application.id}`);
      if (!row) return { exists: false, hasPlaintext: false, hasSqliteHeader: false };
      const text = new TextDecoder().decode(new Uint8Array(row.v));
      return {
        exists: true,
        bytes: row.v.byteLength,
        hasPlaintext: text.includes('bolts') || text.includes('nuts'),
        hasSqliteHeader: text.includes('SQLite format 3'),
      };
    });
    expect(ckptCheck.exists).toBe(true);
    expect(ckptCheck.hasPlaintext).toBe(false);
    expect(ckptCheck.hasSqliteHeader).toBe(false);

    // Evict DO and verify hydrated checkpoint + tail query returns all items accurately
    await evictDurableObject(env.TENDRIL.get(env.TENDRIL.idFromName(f.page.id)));
    await inDO(f.page.id, t => {
      t.env.OAUTH_CONFIG_JSON = f.settings.OAUTH_CONFIG_JSON;
      t.env.OAUTH_SIGNING_JWK = f.settings.OAUTH_SIGNING_JWK;
    });
    const afterCkptEvict = await mcpCall(f.settings, issued.access_token, 'query_application', {
      applicationId: f.page.application.id,
      query: 'items',
      input: null,
    });
    expect(afterCkptEvict.result.isError).not.toBe(true);
    expect(afterCkptEvict.value.value).toEqual([{ id: 'bolts', qty: 42 }, { id: 'nuts', qty: 10 }]);
  } finally {
    await inDO(f.page.id, t => { Object.assign(t.env, restore); });
  }
});
