import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ASSISTANT_GUIDES, onboardingDescriptor } from '../../contract/onboarding.mjs';
import { buildOnboardingAssets, combinedOnboarding, ONBOARDING_DOCS, TUTORIAL_FILES, TUTORIAL_DOWNLOAD } from '../onboarding.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicRoot = join(root, 'server/public');
const links = content => [...content.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g)].map(match => match[1]);
const digest = value => createHash('sha256').update(value).digest('hex');
const dynamicPaths = new Set(['/', '/api/service', '/api/readiness', '/.well-known/tendriller.json',
  '/.well-known/tendriller-capabilities.json', '/contract/v3.json',
  '/.well-known/oauth-protected-resource/mcp', '/auth', '/connections', '/oauth/connections', '/privacy', '/terms']);

test('MCP, published onboarding and installable skill retain one current discovery route', () => {
  const guidePaths = Object.values(ASSISTANT_GUIDES);
  for (const path of guidePaths) {
    assert(ONBOARDING_DOCS.includes(path.slice(1)), `Guide is absent from combined onboarding: ${path}`);
    assert(existsSync(join(publicRoot, path)), `MCP advertises an unshipped guide: ${path}`);
  }
  const descriptor = onboardingDescriptor('https://staging.example');
  assert.equal(descriptor.documentation.mcp, 'https://staging.example' + ASSISTANT_GUIDES.start);
  assert.equal(descriptor.start_here, 'https://staging.example' + ASSISTANT_GUIDES.build);
  for (const path of ['agent.md', 'llms.txt', 'docs/BUILD_AN_APP.md', 'docs/CHATGPT_INTEGRATION.md']) {
    assert(links(readFileSync(join(root, path), 'utf8')).some(target => target.includes('MCP_AGENT_GUIDE.md')),
      `${path} lost its MCP onboarding pointer`);
  }
  const skill = readFileSync(join(root, 'integrations/chatgpt/plugin/skills/connect-tendriller/SKILL.md'), 'utf8');
  assert(skill.includes('tendril_guide') && skill.includes('serviceOrigin'));
  for (const topic of ['start', 'build', 'capabilities', 'connect', 'delivery'])
    assert(skill.includes(`topic: "${topic}"`), `Packaged skill lost the ${topic} guide route`);
  for (const path of ['AGENTS.md', 'agent.md', 'docs/MCP_AGENT_GUIDE.md',
    'integrations/chatgpt/plugin/skills/connect-tendriller/SKILL.md']) {
    const content = readFileSync(join(root, path), 'utf8');
    assert(content.includes('/api/readiness'), `${path} lost the pre-installation readiness check`);
    assert(content.includes('firstApp.release'), `${path} lost the immutable first-app composition route`);
  }
  for (const fallback of ['setup.startHere', 'setup.buildGuide', 'setup.discoveryUrl'])
    assert(skill.includes(fallback), `Packaged skill lost the stale-tool fallback ${fallback}`);
  for (const path of ['AGENTS.md', 'agent.md', 'docs/BUILD_AN_APP.md', 'docs/MCP_AGENT_GUIDE.md',
    'integrations/chatgpt/plugin/skills/connect-tendriller/SKILL.md']) {
    const content = readFileSync(join(root, path), 'utf8');
    for (const step of ['prepare_tendril_setup', 'inspect_tendril_setup', 'setup:finish'])
      assert(content.includes(step), `${path} lost the retained account-setup route ${step}`);
  }
});

test('the domain-only onboarding graph points to shipped public documents and the starter', () => {
  for (const path of ['AGENTS.md', 'llms.txt', ...ONBOARDING_DOCS]) {
    const source = new URL(path, 'https://tendriller.dev/');
    const content = readFileSync(join(root, path), 'utf8');
    for (const target of links(content)) {
      const url = new URL(target, source);
      if (url.origin !== source.origin || dynamicPaths.has(url.pathname)) continue;
      assert(existsSync(join(publicRoot, url.pathname)), `${path} links to an unshipped document: ${target}`);
      assert(url.pathname === TUTORIAL_DOWNLOAD || ['/agent.md', '/AGENTS.md', '/llms.txt', '/llms-full.txt'].includes(url.pathname)
        || /^\/docs\/(?:tools\/)?[A-Z0-9_-]+\.md$/.test(url.pathname),
      `${path} links to an asset without a public documentation route: ${target}`);
    }
  }
  const index = readFileSync(join(root, 'llms.txt'), 'utf8');
  assert.equal(new URL(links(index)[0]).pathname, '/docs/BUILD_AN_APP.md');
  assert(links(index).some(link => new URL(link).pathname === TUTORIAL_DOWNLOAD));
});

test('the combined guide is current and relative links retain their document context', () => {
  const actual = readFileSync(join(publicRoot, 'llms-full.txt'), 'utf8');
  assert.equal(digest(actual), digest(combinedOnboarding(root)), 'Combined onboarding is stale; rebuild public assets.');
  for (const path of ONBOARDING_DOCS) assert(actual.includes(`Source: https://tendriller.dev/${path}`));
  for (const link of links(actual)) assert.doesNotThrow(() => new URL(link), `Combined guide has relative link: ${link}`);
  assert(actual.includes('https://tendriller.dev/docs/APPLICATION_BACKENDS.md'));
});

test('the downloadable starter contains complete parseable source and no local project state', () => {
  const archive = join(publicRoot, TUTORIAL_DOWNLOAD);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(entries.sort(), [...TUTORIAL_FILES].sort());
  for (const path of TUTORIAL_FILES) {
    const archived = execFileSync('tar', ['-xOf', archive, path]);
    assert.equal(digest(archived), digest(readFileSync(join(root, 'docs/tutorial', path))), `Stale tutorial file: ${path}`);
    if (path.endsWith('.mjs')) {
      execFileSync(process.execPath, ['--check', join(root, 'docs/tutorial', path)]);
      // Nested helpers and optional providers must remain usable after the
      // archive is extracted independently of this repository.
      for (const [, relative] of archived.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
        const dependency = posix.normalize(posix.join(posix.dirname(path), relative));
        assert(TUTORIAL_FILES.includes(dependency), `${path} imports an unshipped tutorial module: ${relative}`);
      }
    }
  }
  for (const path of ['session.mjs', 'local.mjs', 'worker.mjs', 'account-setup.mjs', 'host-adoption.mjs',
    'helpers/live-view.mjs', 'helpers/operation-view.mjs', 'helpers/reviewed-input.mjs',
    'media/panel.mjs', 'media/inference-client.mjs', 'media/inference-peer.mjs', 'media/provider-openai.mjs',
    'sql/setup.mjs', 'sql/session.mjs', 'sql/engine.mjs', 'sql/domain.mjs', 'sql/demo.mjs', 'sql/worker.mjs'])
    assert(TUTORIAL_FILES.includes(path), `The documented starter is missing ${path}`);
});

test('building a starter excludes nested private state, provider secrets, generated UI and dependencies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tendriller-onboarding-'));
  const secret = 'NEVER_PUBLISH_THIS_PRIVATE_RECORD';
  const providerKey = process.env.OPENAI_API_KEY;
  try {
    for (const path of [...ONBOARDING_DOCS, ...TUTORIAL_FILES.map(path => `docs/tutorial/${path}`)]) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      cpSync(join(root, path), join(directory, path));
    }
    for (const path of ['.tendriller/handle.json', '.tendriller/device.sqlite', '.tendriller/epoch.json',
      '.tendriller/account-setup.json', '.tendriller/account-setup-result.json', '.tendriller/account-setup-interrupted.tmp',
      '.tendriller/host-credential.json', '.tendriller/host-adoption-private.json', '.tendriller/host-adoption-private-response.json', '.tendriller/delegation-code.txt',
      '.tendriller/owner-page-url.txt', '.tendriller/host-selection.lock',
      'node_modules/secret.txt', 'page/config.mjs', '.env',
      'helpers/.env', 'media/.env', 'media/provider-local.mjs', 'media/provider-secrets.json',
      'sql/.env', 'sql/.tendriller/handle.json', 'sql/.tendriller/device.sqlite', 'sql/.tendriller/initial-input.json',
      'sql/node_modules/secret.txt', 'sql/page/config.mjs', 'sql/engine/local-build.wasm']) {
      const destination = join(directory, 'docs/tutorial', path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, secret);
    }
    process.env.OPENAI_API_KEY = secret;
    const out = join(directory, 'public');
    mkdirSync(out);
    buildOnboardingAssets(directory, out);
    const archive = join(out, TUTORIAL_DOWNLOAD);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.deepEqual(entries.trim().split('\n').sort(), [...TUTORIAL_FILES].sort());
    assert(!/\.tendriller|node_modules|(?:^|\/)\.env|page\/config|provider-local|provider-secrets|local-build/.test(entries));
    const content = execFileSync('tar', ['-xOf', archive], { encoding: 'utf8' });
    assert(!content.includes(secret), 'Source packaging must never substitute provider credentials or include private files.');
    const provider = execFileSync('tar', ['-xOf', archive, 'media/provider-openai.mjs'], { encoding: 'utf8' });
    assert(provider.includes('process.env.OPENAI_API_KEY'), 'The native provider reads its credential at execution time.');
  } finally {
    if (providerKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = providerKey;
    rmSync(directory, { recursive: true, force: true });
  }
});

// Tool discovery is scope-filtered: a packaged connection must actually request
// the permission used by the documented account-bound setup path.
test('the installable MCP connection requests account setup permission explicitly', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'integrations/chatgpt/plugin/mcp.json'), 'utf8'));
  const auth = manifest.mcpServers.tendriller.extensions['com.openai'].auth;
  assert(auth.baseScopes.includes('tendrils:create'));
  assert.equal(new Set(auth.baseScopes).size, auth.baseScopes.length);
});

test('events and SQL starter qualification use the current pinned session source', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const archive = join(root, pkg.devDependencies['@chronolog/peer-session'].replace(/^file:/, ''));
  const provenance = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/provenance.json'], { encoding: 'utf8' }));
  const source = provenance.source;
  assert.match(source, /^[a-f0-9]{40}$/);
  const workflow = readFileSync(join(root, '.github/workflows/agent-onboarding.yml'), 'utf8');
  assert.equal(workflow.split('ref: ' + source).length - 1, 2, 'Both starter profiles must use the qualified session source');
  assert(workflow.includes(`chronolog-peer-session-${source.slice(0, 8)}-sql.tgz`));
});
