import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CONTRACT_VERSION, CORE_RELEASE } from '../../contract/index.mjs';

const script = fileURLToPath(new URL('../check-deployment.mjs', import.meta.url));
const runtime = JSON.parse(readFileSync(new URL('../../server/src/runtime-release.json', import.meta.url), 'utf8'));
const base = 'https://preview-test.tendriller.dev';
const sourceCommit = 'b'.repeat(40), compositionId = 'c'.repeat(64);
const guidePaths = {
  'durable-state': '/docs/STATE_MODELS.md', 'sql-transactions': '/docs/STATE_MODELS.md',
  'reactive-view': '/docs/APP_PATTERNS.md', 'operation-state': '/docs/APP_PATTERNS.md',
  signals: '/docs/APPLICATION_SIGNALS.md', 'reviewed-evidence': '/docs/AI_INPUT.md', camera: '/docs/AI_INPUT.md',
  'sensor-observation': '/docs/BROWSER_API.md', voice: '/docs/HANDS_FREE.md', preview: '/docs/tools/PREVIEW.md',
  'credential-protected-inference': '/docs/AI_INPUT.md', 'agent-runtime': '/docs/AGENT_DELIVERY.md',
  'signed-publication': '/docs/BUILD_AN_APP.md',
};

function fixture() {
  const build = { coreRelease: CORE_RELEASE, runtimeId: runtime.id, sourceCommit, compositionId };
  const readiness = { schemaVersion: 1, serviceOrigin: base, environment: { id: base, label: 'Fixture preview', kind: 'preview' }, build,
    checkedAt: '2026-11-20T10:00:00.000Z',
    mode: 'open', creation: { available: true, code: null, message: 'Ready', nextAction: 'Continue' },
    writes: { available: true, code: null }, readinessUrl: base + '/api/readiness', statusUrl: base + '/status' };
  return {
    base, runtime: runtime.id, readiness,
    tools: [{ name: 'get_application_delivery' }, { name: 'tendril_guide' }],
    guide: { topic: 'start', serviceOrigin: base, build, readiness,
      onboarding: { interfaces: { create_page: { url: base + '/api/tendrils' } } },
      text: `Node 24: create at ${base}/api/tendrils` },
    service: { contract: CONTRACT_VERSION, core_release: CORE_RELEASE, limits: { participant: {} } },
    onboarding: { serviceOrigin: base, interfaces: { readiness: base + '/api/readiness' },
      start_here: base + '/docs/BUILD_AN_APP.md', starter: base + '/downloads/tendriller-first-app.tgz',
      capabilities: base + '/.well-known/tendriller-capabilities.json' },
    catalog: { schema_version: 1, contract: CONTRACT_VERSION, core_release: CORE_RELEASE,
      device_permissions_probed: false, guide: base + '/docs/CAPABILITIES.md',
      starter: base + '/downloads/tendriller-first-app.tgz',
      capabilities: Object.entries(guidePaths).map(([id, guide]) => ({ id, guide: base + guide,
        owner: 'explicit fixture owner', availability: 'provided-with-example', imports: ['example-module'],
        api: ['exampleApi'], keywords: ['example task'], example: 'example.mjs', boundary: 'Explicit fixture capability boundary.' })),
    },
  };
}

function runSmoke(value, { assistant = false, attested = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tendriller-smoke-onboarding-'));
  const preload = join(directory, 'fetch.mjs'), calls = join(directory, 'calls.json');
  try {
    // Exercise the actual deployment entrypoint with an entirely local HTTP
    // fixture. An unexpected origin/path fails instead of reaching a network.
    writeFileSync(preload, `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const fixture = ${JSON.stringify(value)}, calls = [];
process.on('exit', () => writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls)));
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input); assert.equal(url.origin, fixture.base);
  assert.equal(init.redirect, 'error', 'Smoke requests must not follow another service origin.');
  const path = url.pathname; calls.push(path);
  if (path === '/health') return Response.json({ ok: true });
  if (path === '/status') return new Response('Operational');
  if (path === '/api/t/aaaaaaaaaaaa') return Response.json({ error: { message: 'No such tendril' } }, { status: 404 });
  if (path === '/api/service') return Response.json(fixture.service);
  if (path === '/api/readiness') return Response.json(fixture.readiness, { status: fixture.readinessStatus ?? 200 });
  if (path === '/.well-known/tendriller.json') return Response.json(fixture.onboarding);
  if (path === '/.well-known/tendriller-capabilities.json') return Response.json(fixture.catalog);
  if (path === '/') return new Response('<a href="' + fixture.base + '/docs/BUILD_AN_APP.md">Build an app</a>');
  if (path === '/downloads/tendriller-first-app.tgz') return new Response(new Uint8Array([0x1f, 0x8b]),
    { headers: { 'Content-Disposition': 'attachment; filename="tendriller-first-app.tgz"' } });
  if (path === '/_tendril/runtime/' + fixture.runtime + '/manifest.json') return Response.json({ id: fixture.runtime });
  if (path === '/.well-known/oauth-protected-resource/mcp') return Response.json({ resource: fixture.base + '/mcp',
    authorization_servers: [fixture.base], scopes_supported: ['applications:read'] });
  if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: fixture.base,
    authorization_endpoint: fixture.base + '/oauth/authorize', token_endpoint: fixture.base + '/oauth/token',
    scopes_supported: ['applications:read'], authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  if (path === '/oauth/jwks') return Response.json({ keys: [{ kid: 'fixture', kty: 'RSA' }] });
  if (path === '/mcp') {
    const unauthorized = () => new Response(null, { status: 401, headers: {
      'WWW-Authenticate': 'Bearer resource_metadata="' + fixture.base + '/.well-known/oauth-protected-resource/mcp"' } });
    if (new Headers(init.headers).get('Content-Type') === 'application/octet-stream') return unauthorized();
    const request = JSON.parse(init.body);
    if (request.method === 'tools/list') return Response.json({ result: { tools: fixture.tools } });
    if (request.method === 'resources/templates/list') return Response.json({ result: { resourceTemplates: [] } });
    if (request.method === 'tools/call' && request.params.name === 'tendril_guide') return Response.json({ result: { structuredContent: fixture.guide } });
    if (request.method === 'tools/call' && request.params.name === 'get_profile') return unauthorized();
  }
  if (['/agent.md', '/AGENTS.md', '/llms.txt', '/llms-full.txt'].includes(path) || Object.values(${JSON.stringify(guidePaths)}).includes(path) ||
      ['/docs/CAPABILITIES.md', '/docs/SESSION_BOOTSTRAP.md', '/docs/TROUBLESHOOTING.md'].includes(path))
    return new Response('Tendriller public guide', { headers: { 'Content-Type': path.endsWith('.txt') ? 'text/plain' : 'text/markdown' } });
  throw Error('Unexpected smoke path: ' + path);
};
`);
    const flags = [...assistant ? ['--assistant'] : [], ...attested ? ['--source-commit', sourceCommit,
      '--composition-id', compositionId, '--runtime-id', runtime.id, '--core-release', CORE_RELEASE] : []];
    const stdout = execFileSync(process.execPath, ['--import', preload, script, base, ...flags], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    });
    return { stdout, calls: JSON.parse(readFileSync(calls, 'utf8')) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('deployment smoke follows capability discovery and every advertised guide on the selected origin', () => {
  const result = runSmoke(fixture());
  assert.match(result.stdout, /Deployment and agent onboarding smoke check passed/);
  assert(result.calls.includes('/.well-known/tendriller-capabilities.json'));
  for (const path of new Set(Object.values(guidePaths))) assert(result.calls.includes(path), `Smoke missed ${path}`);
});

test('deployment smoke verifies the selected readiness and complete expected deployment identity', () => {
  const result = runSmoke(fixture(), { assistant: true, attested: true });
  assert.match(result.stdout, /Matched deployed source/);
  assert(result.calls.includes('/api/readiness'));
  assert(result.calls.includes('/mcp'));
});

test('deployment smoke fails for missing readiness or mismatched deployment identity', async t => {
  for (const [name, change, error] of [
    ['missing readiness', value => { value.readinessStatus = 404; }, /does not expose \/api\/readiness/],
    ['incomplete environment', value => { delete value.readiness.environment.kind; }, /incompatible readiness document/],
    ['missing observation time', value => { delete value.readiness.checkedAt; }, /incompatible readiness document/],
    ['wrong readiness origin', value => { value.readiness.serviceOrigin = 'https://wrong.example'; }, /Readiness identifies another service/],
    ['wrong release', value => { value.readiness.build.coreRelease = 'old-release'; }, /Readiness does not match/],
    ['wrong runtime', value => { value.readiness.build.runtimeId = 'd'.repeat(64); }, /Readiness does not match/],
    ['missing source', value => { value.readiness.build.sourceCommit = null; }, /Readiness does not match/],
    ['wrong source', value => { value.readiness.build.sourceCommit = 'e'.repeat(40); }, /Readiness does not match/],
    ['missing composition', value => { value.readiness.build.compositionId = null; }, /Readiness does not match/],
    ['wrong composition', value => { value.readiness.build.compositionId = 'f'.repeat(64); }, /Readiness does not match/],
  ]) await t.test(name, () => {
    const value = fixture(); change(value);
    assert.throws(() => runSmoke(value, { attested: true }), failure => {
      assert.match(String(failure.stderr), error); return true;
    });
  });
});

test('assistant smoke uses the structured creation URL rather than incidental guide wording', () => {
  const value = fixture();
  value.guide.text = 'Use Node 24 and follow the build guide for account-bound setup.';
  runSmoke(value, { assistant: true, attested: true });
  value.guide.onboarding.interfaces.create_page.url = 'https://another.example/api/tendrils';
  assert.throws(() => runSmoke(value, { assistant: true, attested: true }), failure => {
    assert.match(String(failure.stderr), /app-building guidance/); return true;
  });
});

test('assistant smoke requires tendril_guide in tools/list even when an unadvertised call succeeds', () => {
  const value = fixture();
  value.tools = value.tools.filter(tool => tool.name !== 'tendril_guide');
  assert.throws(() => runSmoke(value, { assistant: true, attested: true }), failure => {
    assert.match(String(failure.stderr), /tendril_guide must both appear in tools\/list/); return true;
  });
});

test('assistant smoke rejects guidance from another deployment build', () => {
  const value = fixture();
  value.guide.build = { ...value.guide.build, compositionId: 'd'.repeat(64) };
  assert.throws(() => runSmoke(value, { assistant: true, attested: true }), failure => {
    assert.match(String(failure.stderr), /Assistant guide does not match/); return true;
  });
});

test('deployment smoke rejects stale, incomplete or misleading capability discovery', async t => {
  for (const [name, change, error] of [
    ['navigation to another deployment', value => { value.onboarding.capabilities = 'https://tendriller.dev/.well-known/tendriller-capabilities.json'; }, /Onboarding navigation must target/],
    ['guide to another deployment', value => { value.catalog.capabilities[0].guide = 'https://tendriller.dev/docs/STATE_MODELS.md'; }, /guide must target this deployment/],
    ['missing reviewed-input capability', value => { value.catalog.capabilities = value.catalog.capabilities.filter(entry => entry.id !== 'reviewed-evidence'); }, /missing reviewed-evidence/],
    ['mismatched release', value => { value.catalog.core_release = 'old-release'; }, /Capability discovery must match/],
    ['discovery presented as a device probe', value => { value.catalog.device_permissions_probed = true; }, /without probing device permissions/],
  ]) await t.test(name, () => {
    const value = fixture(); change(value);
    assert.throws(() => runSmoke(value), failure => {
      assert.match(String(failure.stderr), error); return true;
    });
  });
});
