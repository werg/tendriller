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
const guidePaths = {
  'durable-state': '/docs/STATE_MODELS.md', 'sql-transactions': '/docs/STATE_MODELS.md',
  'reactive-view': '/docs/APP_PATTERNS.md', 'operation-state': '/docs/APP_PATTERNS.md',
  signals: '/docs/APPLICATION_SIGNALS.md', 'reviewed-evidence': '/docs/AI_INPUT.md', camera: '/docs/AI_INPUT.md',
  'sensor-observation': '/docs/BROWSER_API.md', voice: '/docs/HANDS_FREE.md', preview: '/docs/tools/PREVIEW.md',
  'credential-protected-inference': '/docs/AI_INPUT.md', 'agent-runtime': '/docs/AGENT_DELIVERY.md',
  'signed-publication': '/docs/BUILD_AN_APP.md',
};

function fixture() {
  return {
    base, runtime: runtime.id,
    service: { contract: CONTRACT_VERSION, core_release: CORE_RELEASE, limits: { participant: {} } },
    onboarding: { start_here: base + '/docs/BUILD_AN_APP.md', starter: base + '/downloads/tendriller-first-app.tgz',
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

function runSmoke(value) {
  const directory = mkdtempSync(join(tmpdir(), 'tendriller-smoke-onboarding-'));
  const preload = join(directory, 'fetch.mjs'), calls = join(directory, 'calls.json');
  try {
    // Exercise the actual deployment entrypoint with an entirely local HTTP
    // fixture. An unexpected origin/path fails instead of reaching a network.
    writeFileSync(preload, `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const fixture = ${JSON.stringify(value)}, calls = [];
process.on('exit', () => writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls)));
globalThis.fetch = async (input) => {
  const url = new URL(input); assert.equal(url.origin, fixture.base);
  const path = url.pathname; calls.push(path);
  if (path === '/health') return Response.json({ ok: true });
  if (path === '/status') return new Response('Operational');
  if (path === '/api/t/aaaaaaaaaaaa') return Response.json({ error: { message: 'No such tendril' } }, { status: 404 });
  if (path === '/api/service') return Response.json(fixture.service);
  if (path === '/.well-known/tendriller.json') return Response.json(fixture.onboarding);
  if (path === '/.well-known/tendriller-capabilities.json') return Response.json(fixture.catalog);
  if (path === '/') return new Response('<a href="' + fixture.base + '/docs/BUILD_AN_APP.md">Build an app</a>');
  if (path === '/downloads/tendriller-first-app.tgz') return new Response(new Uint8Array([0x1f, 0x8b]),
    { headers: { 'Content-Disposition': 'attachment; filename="tendriller-first-app.tgz"' } });
  if (path === '/_tendril/runtime/' + fixture.runtime + '/manifest.json') return Response.json({ id: fixture.runtime });
  if (['/agent.md', '/AGENTS.md', '/llms.txt', '/llms-full.txt'].includes(path) || Object.values(${JSON.stringify(guidePaths)}).includes(path) ||
      ['/docs/CAPABILITIES.md', '/docs/SESSION_BOOTSTRAP.md', '/docs/TROUBLESHOOTING.md'].includes(path))
    return new Response('Tendriller public guide', { headers: { 'Content-Type': path.endsWith('.txt') ? 'text/plain' : 'text/markdown' } });
  throw Error('Unexpected smoke path: ' + path);
};
`);
    const stdout = execFileSync(process.execPath, ['--import', preload, script, base], {
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
