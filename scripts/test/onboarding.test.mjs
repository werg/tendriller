import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readSessionPin } from '../session-pin.mjs';
import { ASSISTANT_GUIDES, onboardingDescriptor } from '../../contract/onboarding.mjs';
import { buildOnboardingAssets, combinedOnboarding, ONBOARDING_DOCS, ONBOARDING_IMAGES, TUTORIAL_FILES, TUTORIAL_DOWNLOAD, TUTORIAL_SOURCES, tutorialSource } from '../onboarding.mjs';

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
  assert.equal(descriptor.documentation.sensors, 'https://staging.example' + ASSISTANT_GUIDES.sensors);
  assert.equal(descriptor.start_here, 'https://staging.example' + ASSISTANT_GUIDES.build);
  for (const path of ['agent.md', 'llms.txt', 'docs/BUILD_AN_APP.md', 'docs/CHATGPT_INTEGRATION.md']) {
    assert(links(readFileSync(join(root, path), 'utf8')).some(target => target.includes('MCP_AGENT_GUIDE.md')),
      `${path} lost its MCP onboarding pointer`);
  }
  const skill = readFileSync(join(root, 'plugin/skills/connect-tendriller/SKILL.md'), 'utf8');
  assert(skill.includes('tendril_guide') && skill.includes('serviceOrigin'));
  for (const topic of ['start', 'build', 'capabilities', 'sensors', 'connect', 'delivery', 'deployment'])
    assert(skill.includes(`topic: "${topic}"`), `Packaged skill lost the ${topic} guide route`);
  for (const path of ['AGENTS.md', 'agent.md', 'docs/MCP_AGENT_GUIDE.md',
    'plugin/skills/connect-tendriller/SKILL.md']) {
    const content = readFileSync(join(root, path), 'utf8');
    assert(content.includes('/api/readiness'), `${path} lost the pre-installation readiness check`);
    assert(content.includes('firstApp.release'), `${path} lost the immutable first-app composition route`);
  }
  for (const fallback of ['setup.startHere', 'setup.buildGuide', 'setup.discoveryUrl'])
    assert(skill.includes(fallback), `Packaged skill lost the stale-tool fallback ${fallback}`);
  for (const path of ['AGENTS.md', 'agent.md', 'docs/BUILD_AN_APP.md', 'docs/MCP_AGENT_GUIDE.md',
    'plugin/skills/connect-tendriller/SKILL.md']) {
    const content = readFileSync(join(root, path), 'utf8');
    for (const step of ['register_agent', 'workspace adopt'])
      assert(content.includes(step), `${path} lost the account-linked agent route ${step}`);
    for (const removed of ['prepare_tendril_setup', 'setup:prepare', 'setup:finish'])
      assert(!content.includes(removed), `${path} still describes the removed account-setup route ${removed}`);
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
        || ONBOARDING_IMAGES.includes(url.pathname.slice(1))
        || /^\/docs\/(?:tools\/)?[A-Z0-9_-]+\.md$/.test(url.pathname),
      `${path} links to an asset without a public documentation route: ${target}`);
    }
  }
  const index = readFileSync(join(root, 'llms.txt'), 'utf8');
  assert.equal(new URL(links(index)[0]).pathname, '/docs/BUILD_AN_APP.md');
  assert(links(index).some(link => new URL(link).pathname === TUTORIAL_DOWNLOAD));
});

test('the documented visual patterns ship their executable source and actual screenshots', () => {
  for (const path of ['shared/ui/patterns.mjs', 'shared/ui/showcase.html', 'shared/ui/showcase.mjs'])
    assert(TUTORIAL_FILES.includes(path), `Missing UI specimen: ${path}`);
  for (const path of ONBOARDING_IMAGES) {
    const source = readFileSync(join(root, path));
    assert.equal(source.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `Not a PNG screenshot: ${path}`);
    assert.equal(digest(readFileSync(join(publicRoot, path))), digest(source), `Stale screenshot: ${path}`);
  }
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
    assert.equal(digest(archived), digest(readFileSync(tutorialSource(root, path))), `Stale tutorial file: ${path}`);
    if (path.endsWith('.mjs')) {
      execFileSync(process.execPath, ['--check', tutorialSource(root, path)]);
      // Nested helpers and optional providers must remain usable after the
      // archive is extracted independently of this repository.
      for (const [, relative] of archived.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
        const dependency = posix.normalize(posix.join(posix.dirname(path), relative));
        assert(TUTORIAL_FILES.includes(dependency), `${path} imports an unshipped tutorial module: ${relative}`);
      }
    }
  }
  for (const path of ['setup.mjs', 'shared/local.mjs', 'shared/native-page.mjs', 'shared/cli-lifetime.mjs',
    'shared/helpers/operation-view.mjs', 'shared/helpers/reviewed-input.mjs',
    'shared/media/panel.mjs', 'shared/media/inference-client.mjs', 'shared/media/inference-peer.mjs', 'shared/media/provider-openai.mjs',
    'templates/notes/agent.mjs', 'templates/notes/setup.mjs', 'templates/notes/worker.mjs',
    'templates/inventory/setup.mjs', 'templates/inventory/agent.mjs', 'templates/inventory/engine.mjs', 'templates/inventory/domain.mjs',
    'templates/inventory/demo.mjs', 'templates/inventory/worker.mjs'])
    assert(TUTORIAL_FILES.includes(path), `The documented starter is missing ${path}`);
  // One workspace install: no per-page package, project-level private folder or per-page long-running program.
  for (const removed of ['session.mjs', 'local.mjs', 'account-setup.mjs', 'host-adoption.mjs', 'templates/inventory/package.json', 'deploy/participant.mjs'])
    assert(!TUTORIAL_FILES.includes(removed), `Removed starter file still shipped: ${removed}`);
  const scripts = JSON.parse(readFileSync(tutorialSource(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.agent, 'tendril agent run');
  assert(!Object.hasOwn(scripts, 'peer') && !Object.hasOwn(scripts, 'serve'), 'per-page programs are removed');
});

test('building a starter excludes nested private state, provider secrets, generated UI and dependencies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tendriller-onboarding-'));
  const secret = 'NEVER_PUBLISH_THIS_PRIVATE_RECORD';
  const providerKey = process.env.OPENAI_API_KEY;
  try {
    for (const path of [...ONBOARDING_DOCS, ...ONBOARDING_IMAGES, ...Object.values(TUTORIAL_SOURCES)]) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      cpSync(join(root, path), join(directory, path));
    }
    for (const path of ['.tendriller/agent/credential.json', '.tendriller/agent/identity.sqlite', '.tendriller/agent/attach.json',
      '.tendriller/pages/aaaaaaaaaaaa/page.json', '.tendriller/pages/aaaaaaaaaaaa/device.sqlite', '.tendriller/pages/aaaaaaaaaaaa/initial-input.json',
      'tendriller.json', 'node_modules/secret.txt', 'pages/notes/dist/config.mjs', 'pages/notes/domain.mjs', '.env',
      'shared/helpers/.env', 'shared/media/.env', 'shared/media/provider-local.mjs', 'shared/media/provider-secrets.json',
      'templates/inventory/.env', 'templates/inventory/.tendriller/device.sqlite',
      'templates/inventory/node_modules/secret.txt', 'templates/inventory/dist/config.mjs', 'templates/inventory/engine/local-build.wasm']) {
      const destination = join(directory, 'docs/tutorial', path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, secret);
    }
    for (const path of ['deploy/.env', 'deploy/.tendriller/device.sqlite', 'deploy/node_modules/secret.txt', 'deploy/local-run.mjs']) {
      const destination = join(directory, path);
      mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, secret);
    }
    process.env.OPENAI_API_KEY = secret;
    const out = join(directory, 'public');
    mkdirSync(out);
    buildOnboardingAssets(directory, out);
    const archive = join(out, TUTORIAL_DOWNLOAD);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.deepEqual(entries.trim().split('\n').sort(), [...TUTORIAL_FILES].sort());
    for (const file of TUTORIAL_FILES.filter(path => path.startsWith('deploy/')))
      assert.equal(digest(execFileSync('tar', ['-xOf', archive, file])), digest(readFileSync(tutorialSource(root, file))), `Stale mapped deployment file: ${file}`);
    for (const entry of entries.trim().split('\n'))
      assert(!/(?:^|\/)(?:\.tendriller|node_modules|pages|dist)(?:\/|$)|(?:^|\/)\.env|tendriller\.json|provider-local|provider-secrets|local-build|local-run/.test(entry), `Private archive path: ${entry}`);
    const content = execFileSync('tar', ['-xOf', archive], { encoding: 'utf8' });
    assert(!content.includes(secret), 'Source packaging must never substitute provider credentials or include private files.');
    const provider = execFileSync('tar', ['-xOf', archive, 'shared/media/provider-openai.mjs'], { encoding: 'utf8' });
    assert(provider.includes('process.env.OPENAI_API_KEY'), 'The native provider reads its credential at execution time.');
  } finally {
    if (providerKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = providerKey;
    rmSync(directory, { recursive: true, force: true });
  }
});

// Tool discovery is scope-filtered: a packaged connection must actually request
// the permission that register_agent needs on the documented account-linked route.
test('the installable MCP connection requests account setup permission explicitly', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'plugin/mcp.json'), 'utf8'));
  const auth = manifest.mcpServers.tendriller.extensions['com.openai'].auth;
  assert(auth.baseScopes.includes('tendrils:create'));
  assert.equal(new Set(auth.baseScopes).size, auth.baseScopes.length);
});

test('events and SQL starter qualification use the current pinned session source', () => {
  const pin = readSessionPin(root);
  assert.match(pin.source, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(pin), ['source'], 'No inferred SQL sibling archive');
  const workflow = readFileSync(join(root, '.github/workflows/agent-onboarding.yml'), 'utf8');
  assert(workflow.indexOf('path: core') < workflow.indexOf('node-version: 24'));
  assert(workflow.indexOf('node-version: 24') < workflow.indexOf('run: node scripts/session-pin.mjs'));
  assert(workflow.indexOf('run: node scripts/session-pin.mjs') < workflow.indexOf('repository: werg/chronolog-db'));
  assert.match(workflow, /id: session\s+working-directory: core\s+run: node scripts\/session-pin\.mjs/);
  assert(workflow.includes('ref: ${{ steps.session.outputs.source }}'));
  assert(!/ref: [a-f0-9]{40}/.test(workflow), 'No duplicated Chronolog source literal');
  assert(workflow.includes('name: public-packages'), 'SQL qualification must reuse the release graph');
  const service = readFileSync(join(root, '.github/workflows/service.yml'), 'utf8');
  assert(service.includes('npm run release:artifacts'), 'Events qualification prepares the pinned public session in the graph');
  assert(service.includes('test:first-app -- --first-app-archive'), 'Events qualification must use the exact kit');
  assert(workflow.includes('SQL_ARCHIVE: ${{ steps.native-sql.outputs.artifact }}'));
  assert(workflow.includes('node tools/test-peer-session-sql.mjs --artifact "$SQL_ARCHIVE"'));
  assert(workflow.includes('JSON.parse(readFileSync(process.env.RUNNER_TEMP'));
  assert(workflow.includes('tendriller-first-app-sql-'));
  assert(!workflow.includes('--sql-native-only'));
  assert(!workflow.includes('steps.session.outputs.sql_archive'));
  assert(!/chronolog-peer-session-[a-f0-9]{8}-sql\.tgz/.test(workflow));
});


test('live views have one SDK implementation and the starter page uses bounded initial readiness', () => {
  assert.equal(TUTORIAL_FILES.includes('helpers/live-view.mjs'), false);
  assert.equal(existsSync(join(root, 'docs/tutorial/shared/helpers/live-view.mjs')), false, 'Copied live-view implementation');
  const source = readFileSync(join(root, 'docs/tutorial/templates/notes/page.mjs'), 'utf8');
  assert.match(source, /import \{ createLiveView, createViewStore[^}]*\} from '@chronolog\/peer-session(?:\/browser)?'/);
  assert.match(source, /await (?:live|liveView)\.ready\(\{[^}]*timeoutMs: 30_000/);
});


test('deployment template paths resolve to maintained root sources and guide links are public routes', () => {
  const files = ['Dockerfile', 'Dockerfile.dockerignore',
    'tendriller.service', 'dev.tendriller.agent.plist', 'install-windows-task.ps1'];
  for (const name of files) {
    const path = `deploy/${name}`;
    assert(TUTORIAL_FILES.includes(path), `Unshipped deployment file: ${path}`);
    assert.equal(tutorialSource(root, path), join(root, path));
    assert(!existsSync(join(root, 'docs/tutorial', path)), 'Do not maintain duplicate deployment sources');
  }
  assert.throws(() => tutorialSource(root, 'deploy/.env'), /Unlisted/);
  const guide = readFileSync(join(root, 'docs/DEPLOYMENT_GUIDE.md'), 'utf8');
  const targets = links(guide).map(path => new URL(path, 'https://tendriller.dev/docs/DEPLOYMENT_GUIDE.md'));
  assert(targets.some(url => url.pathname === TUTORIAL_DOWNLOAD));
  for (const url of targets) if (url.origin === 'https://tendriller.dev') {
    assert(url.pathname === TUTORIAL_DOWNLOAD || /^\/docs\/(?:tools\/)?[A-Z0-9_-]+\.md$/.test(url.pathname),
      `Deployment guide advertises an unavailable public path: ${url.pathname}`);
    if (url.pathname !== TUTORIAL_DOWNLOAD) assert(existsSync(join(root, url.pathname)));
  }
});
