import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { assertValid, CONTRACT_VERSION, CORE_RELEASE } from '../../contract/index.mjs';
import type { Env } from '../src/env';
import { route } from '../src/router';
import { apiJson, BASE, create, req, signInAsOwner } from './helpers';
import { peerApi } from './peer-exchange';

const guidePath = '/docs/BUILD_AN_APP.md';
const descriptorPath = '/.well-known/tendriller.json';
const capabilityPath = '/.well-known/tendriller-capabilities.json';
const downloadPath = '/downloads/tendriller-first-app.tgz';
const documents = [
  ['/agent.md', 'text/markdown'],
  ['/AGENTS.md', 'text/markdown'],
  ['/llms.txt', 'text/plain'],
  ['/llms-full.txt', 'text/plain'],
  [guidePath, 'text/markdown'],
  ['/docs/SESSION_BOOTSTRAP.md', 'text/markdown'],
  ['/docs/MCP_AGENT_GUIDE.md', 'text/markdown'],
  ['/docs/TROUBLESHOOTING.md', 'text/markdown'],
  ['/docs/AGENT_ONBOARDING_TEST.md', 'text/markdown'],
  ['/docs/CAPABILITIES.md', 'text/markdown'],
  ['/docs/AGENT_DELIVERY.md', 'text/markdown'],
  ['/docs/APP_PATTERNS.md', 'text/markdown'],
  ['/docs/AI_INPUT.md', 'text/markdown'],
  ['/docs/STATE_MODELS.md', 'text/markdown'],
  ['/docs/tools/PREVIEW.md', 'text/markdown'],
] as const;

function expectDiscoveryLinks(response: Response, origin = BASE) {
  const links = response.headers.get('Link') ?? '';
  expect(links).toContain(`<${origin}/agent.md>; rel="describedby"; type="text/markdown"`);
  expect(links).toContain(`<${origin}${descriptorPath}>; rel="service-desc"; type="application/json"`);
}

function expectDescriptor(value: Record<string, any>, origin = BASE) {
  expect(value).toMatchObject({
    schema_version: 1,
    name: 'Tendriller',
    contract: CONTRACT_VERSION,
    core_release: CORE_RELEASE,
    serviceOrigin: origin,
    service: origin + '/',
    start_here: origin + guidePath,
    agent_instructions: origin + '/agent.md',
    starter: origin + downloadPath,
    capabilities: origin + '/.well-known/tendriller-capabilities.json',
    documentation: {
      index: origin + '/llms.txt',
      full: origin + '/llms-full.txt',
      bootstrap: origin + '/docs/SESSION_BOOTSTRAP.md',
      troubleshooting: origin + '/docs/TROUBLESHOOTING.md',
    },
    interfaces: {
      service_descriptor: origin + '/api/service',
      readiness: origin + '/api/readiness',
      contract: origin + '/contract/v3.json',
      create_page: { method: 'POST', url: origin + '/api/tendrils', required: ['owner'] },
    },
  });
  const navigation = [value.service, value.start_here, value.agent_instructions, value.starter, value.capabilities,
    ...Object.values(value.documentation), value.interfaces.service_descriptor, value.interfaces.readiness,
    value.interfaces.contract, value.interfaces.create_page.url];
  for (const target of navigation) {
    const url = new URL(String(target));
    expect(url.origin).toBe(origin);
    expect(url.username + url.password + url.search + url.hash).toBe('');
  }
  expect(value.sources).toEqual({
    core: 'https://github.com/werg/tendriller',
    chronolog: 'https://github.com/werg/chronolog-db',
    cookbooks: 'https://github.com/werg/tendriller-contrib',
    releases: 'https://github.com/werg/tendriller/releases',
  });
  for (const field of ['token', 'api', 'page_url', 'owner_account_id', 'privateKey', 'epochKeys'])
    expect(value).not.toHaveProperty(field);
}

describe('public application onboarding', () => {
  it('maps task language to real owners, imports, executable examples and explicit integration gaps', async () => {
    const counts = () => env.ACCOUNTS.prepare('SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM tendrils) AS pages').first();
    const before = await counts();
    const response = await req(capabilityPath, { anonymous: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expectDiscoveryLinks(response);
    const catalog = await response.json() as Record<string, any>;
    expect(catalog).toMatchObject({ schema_version: 1, contract: CONTRACT_VERSION,
      core_release: CORE_RELEASE, device_permissions_probed: false, guide: BASE + '/docs/CAPABILITIES.md',
      starter: BASE + downloadPath });
    const entries = new Map<string, any>(catalog.capabilities.map((entry: any) => [entry.id, entry]));
    expect(entries.size).toBe(catalog.capabilities.length);
    for (const id of ['durable-state', 'sql-transactions', 'reactive-view', 'operation-state',
      'signals', 'reviewed-evidence', 'camera', 'sensor-observation', 'screen-capture', 'location', 'motion',
      'audio-capture', 'hardware-instruments', 'agent-requested-observation', 'document-navigation', 'voice', 'preview',
      'credential-protected-inference', 'agent-runtime', 'signed-publication']) {
      const entry = entries.get(id);
      expect(entry, id).toBeTruthy();
      expect(entry.imports.length, id).toBeGreaterThan(0);
      expect(entry.keywords.length, id).toBeGreaterThan(0);
      expect(entry.api.length, id).toBeGreaterThan(0);
      expect(entry.owner.length, id).toBeGreaterThan(0);
      expect(entry.example.length, id).toBeGreaterThan(0);
      expect(entry.boundary.length, id).toBeGreaterThan(20);
      expect(new URL(entry.guide).origin, id).toBe(BASE);
      const guide = await req(entry.guide, { anonymous: true });
      expect(guide.status, id).toBe(200); await guide.text();
    }
    expect(entries.get('document-navigation').api).toContain('tendril.documentUrl');
    expect(entries.get('document-navigation').imports).toEqual(['@tendriller/runtime/kernel']);
    expect(entries.get('voice').imports).toEqual(['@tendriller/runtime/voice']);
    expect(entries.get('camera').api).toContain('navigator.mediaDevices.getUserMedia');
    expect(entries.get('sensor-observation').api).toContain('tendril.sensors.stopAll');
    expect(entries.get('sensor-observation').api).toContain('tendril.sensors.register');
    for (const id of ['screen-capture', 'location', 'motion', 'audio-capture', 'hardware-instruments', 'agent-requested-observation']) {
      expect(entries.get(id).guide).toBe(BASE + '/docs/SENSORS.md');
      expect(entries.get(id).cookbook).toMatch(/^https:\/\/github.com\/werg\/tendriller-contrib\/blob\/main\/cookbooks\//);
    }
    expect(entries.get('agent-runtime').availability).toBe('host-integration-required');
    expect(entries.get('credential-protected-inference').availability).toBe('example-requires-provider');
    const head = await req(capabilityPath, { method: 'HEAD', anonymous: true });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect(head.headers.get('Content-Type')).toBe(response.headers.get('Content-Type'));
    expectDiscoveryLinks(head);
    const write = await req(capabilityPath, { method: 'POST', anonymous: true, body: '{}' });
    expect(write.status).toBeGreaterThanOrEqual(400); await write.text();
    expect(await counts()).toEqual(before);
  });

  it('links an anonymous homepage to the first-app route and machine-readable discovery', async () => {
    const response = await req('/', { anonymous: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expectDiscoveryLinks(response);
    const html = await response.text();
    for (const path of [guidePath, '/agent.md', '/llms.txt', descriptorPath])
      expect(html).toContain(`href="${BASE}${path}"`);
    expect(html).toMatch(/<link[^>]+rel="service-desc"[^>]+type="application\/json"/);
    const primaryAction = /<a\b[^>]*\bclass="button"[^>]*>/.exec(html)?.[0];
    expect(primaryAction).toContain(`href="${BASE}${guidePath}"`);
    const head = await req('/', { method: 'HEAD', anonymous: true });
    expect(head.status).toBe(200);
    expectDiscoveryLinks(head);
    expect(await head.text()).toBe('');
  });

  it('publishes anonymous navigation without credentials or creating accounts and pages', async () => {
    const counts = () => env.ACCOUNTS.prepare('SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM tendrils) AS pages').first();
    const before = await counts();
    const response = await req(descriptorPath, { anonymous: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expectDiscoveryLinks(response);
    expectDescriptor(await response.json());
    const head = await req(descriptorPath, { method: 'HEAD', anonymous: true });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Type')).toContain('application/json');
    expectDiscoveryLinks(head);
    expect(await head.text()).toBe('');
    const write = await req(descriptorPath, { method: 'POST', anonymous: true, body: '{}' });
    expect(write.status).toBeGreaterThanOrEqual(400);
    await write.text();
    expect(await counts()).toEqual(before);

    const secret = `test-onboarding-secret-${crypto.randomUUID()}`;
    for (const path of [descriptorPath, capabilityPath]) {
      const result = await route(new Request(BASE + path, {
        headers: { Authorization: `Bearer ${secret}`, Cookie: `__Host-tendriller=${secret}` },
      }), { ...env, GITHUB_CLIENT_SECRET: secret, BUDGET_WEBHOOK_SECRET: secret });
      expect(result.status, path).toBe(200);
      expect(await result.text(), path).not.toContain(secret);
    }
  });

  it.each(documents)('serves %s as read-only documentation with empty HEAD responses', async (path, type) => {
    const response = await req(path, { anonymous: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain(type);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expectDiscoveryLinks(response);
    expect((await response.text()).trim().length).toBeGreaterThan(0);
    const head = await req(path, { method: 'HEAD', anonymous: true });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Type')).toContain(type);
    expectDiscoveryLinks(head);
    expect(await head.text()).toBe('');
    const post = await req(path, { method: 'POST', anonymous: true, body: 'replace this guide' });
    expect(post.status).toBe(405);
    expect(await post.json()).toMatchObject({ error: { code: 'method_not_allowed' } });
  });

  it.each([
    { name: 'staging', origin: 'https://staging.tendriller.dev', suffix: '' },
    { name: 'branch preview', origin: 'https://preview-0123456789ab.tendriller.dev', suffix: '--p-0123456789ab' },
  ])('keeps $name onboarding links on the selected service origin', async ({ origin, suffix }) => {
    const target: Env = { ...env, PUBLIC_BASE: origin + '/', PAGE_BASE_DOMAIN: 'tendriller.dev', PAGE_HOST_SUFFIX: suffix };
    const discovery = await route(new Request(origin + descriptorPath), target);
    expect(discovery.status).toBe(200);
    expectDiscoveryLinks(discovery, origin);
    expectDescriptor(await discovery.json(), origin);
    const capabilities = await route(new Request(origin + capabilityPath), target);
    expect(capabilities.status).toBe(200);
    expectDiscoveryLinks(capabilities, origin);
    const catalog = await capabilities.json() as Record<string, any>;
    expect(catalog.guide).toBe(origin + '/docs/CAPABILITIES.md');
    expect(catalog.starter).toBe(origin + downloadPath);
    for (const entry of catalog.capabilities) expect(new URL(entry.guide).origin, entry.id).toBe(origin);
    expect(JSON.stringify(catalog)).not.toContain(BASE);
    for (const path of ['/', '/agent.md', '/llms.txt', '/llms-full.txt', guidePath, '/AGENTS.md']) {
      const response = await route(new Request(origin + path), target);
      expect(response.status, path).toBe(200);
      expectDiscoveryLinks(response, origin);
      const body = await response.text();
      expect(body, path).not.toContain(BASE);
      if (path === '/') expect(body).toContain(`href="${origin}${guidePath}"`);
      if (suffix) expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    }
  });

  it.each(['desktop', 'phone', 'states'])('serves the %s pattern screenshot with a read-only bounded route', async name => {
    const path = `/docs/assets/app-patterns-${name}.png`;
    const response = await req(path, { anonymous: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const head = await req(path, { method: 'HEAD', anonymous: true });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    const post = await req(path, { method: 'POST', anonymous: true, body: 'replace' });
    expect(post.status).toBe(405); await post.text();
    const unknown = await req('/docs/assets/app-patterns-private.png', { anonymous: true });
    expect(unknown.status).toBe(404); await unknown.text();
  });

  it('downloads the starter as an attachment without serving its HTML or source on the service origin', async () => {
    const response = await req(downloadPath, { anonymous: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/gzip');
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="tendriller-first-app.tgz"');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expectDiscoveryLinks(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(2);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1f, 0x8b]);
    const head = await req(downloadPath, { method: 'HEAD', anonymous: true });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Disposition')).toBe(response.headers.get('Content-Disposition'));
    expect(await head.arrayBuffer()).toHaveProperty('byteLength', 0);
    for (const path of ['/docs/tutorial/index.html', '/docs/tutorial/page.mjs', '/docs/tutorial/worker.mjs', '/docs/tutorial/setup.mjs',
      '/docs/tutorial/helpers/browser-profile.mjs', '/docs/tutorial/ui/showcase.html', '/docs/tutorial/ui/patterns.mjs', '/docs/tutorial/media/inference-client.mjs',
      '/docs/tutorial/media/provider-openai.mjs', '/docs/tutorial/media/.env',
      '/docs/tutorial/sql/setup.mjs', '/docs/tutorial/sql/worker.mjs', '/docs/tutorial/sql/.tendriller/handle.json']) {
      const source = await req(path, { anonymous: true });
      expect(source.status, path).toBe(404);
      expect(await source.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('keeps the strict service JSON contract unchanged while advertising discovery in headers', async () => {
    const response = await req('/api/service', { anonymous: true });
    expect(response.status).toBe(200);
    expectDiscoveryLinks(response);
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Link');
    const value = await response.json();
    expect(() => assertValid('serviceDescriptor', value)).not.toThrow();
    expect(Object.keys(value as object).sort()).toEqual(['contract', 'core_release', 'limits']);
  });
});

describe('onboarding after page creation', () => {
  it('reveals the enrollment account only in authenticated agent info, with null before claim', async () => {
    const email = `onboarding-${crypto.randomUUID()}@example.com`;
    const h = await create({ owner: email, claim: false });
    expect(h).not.toHaveProperty('owner_account_id');
    expect(h).toHaveProperty('build_guide', BASE + guidePath);
    expect(await apiJson(h, 'GET', '')).toMatchObject({ owner_account_id: null, configured: false, application: h.application });
    const account = crypto.randomUUID();
    await env.ACCOUNTS.prepare('INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)').bind(account, Date.now(), email).run();
    const cookie = await signInAsOwner(h, account, email);
    const info = await apiJson(h, 'GET', '');
    expect(info).toMatchObject({ owner_account_id: account, configured: false, application: h.application });

    const denied = await req(h.api, { anonymous: true });
    expect(denied.status).toBe(401);
    const deniedText = await denied.text();
    expect(deniedText).not.toContain(account);
    expect(deniedText).not.toContain('owner_account_id');
    const pageInfo = await req(h.page_url + '_tendril/info', { headers: { Cookie: cookie } });
    expect(pageInfo.status).toBe(200);
    const pageValue = await pageInfo.json();
    expect(pageValue).not.toHaveProperty('owner_account_id');
    expect(JSON.stringify(pageValue)).not.toContain(account);
    const publicPageInfo = await req(h.page_url + '_tendril/info', { anonymous: true, redirect: 'manual' });
    expect(publicPageInfo.status).toBe(302);
    expect(await publicPageInfo.text()).not.toContain(account);
    const navigation = await apiJson(h, 'GET', 'guide');
    expectDescriptor(navigation);
    expect(JSON.stringify(navigation)).not.toContain(account);
    expect(JSON.stringify(navigation)).not.toContain(h.token);
  });

  it('points unconfigured authority and definition reads at the actual configuration step', async () => {
    const h = await create();
    for (const operation of ['control/read', 'publication/definition', 'publication/read']) {
      const response = await peerApi(h, operation);
      expect(response.status, operation).toBe(409);
      const result = await response.json<{ error: { code: string; message: string } }>();
      expect(result.error.code).toBe('peer_application_unconfigured');
      expect(result.error.message).toContain('host.peers.configureApplication');
      expect(result.error.message).toContain(guidePath);
    }
    expect(await apiJson(h, 'GET', 'application')).toEqual({ selection: h.application, configured: false });
  });

  it('does not expose a legacy per-page MCP route on the tendril API', async () => {
    const h = await create({ claim: false });
    const response = await req(h.api + '/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
