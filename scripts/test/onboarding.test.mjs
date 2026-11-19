import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildOnboardingAssets, combinedOnboarding, ONBOARDING_DOCS, TUTORIAL_FILES, TUTORIAL_DOWNLOAD } from '../onboarding.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicRoot = join(root, 'server/public');
const links = content => [...content.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g)].map(match => match[1]);
const digest = value => createHash('sha256').update(value).digest('hex');
const dynamicPaths = new Set(['/', '/api/service', '/.well-known/tendriller.json', '/contract/v3.json']);

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
    if (path.endsWith('.mjs')) execFileSync(process.execPath, ['--check', join(root, 'docs/tutorial', path)]);
  }
  assert(TUTORIAL_FILES.includes('session.mjs') && TUTORIAL_FILES.includes('local.mjs') && TUTORIAL_FILES.includes('worker.mjs'));
});

test('building a starter cannot include private identity, keys, generated UI or dependencies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tendriller-onboarding-'));
  try {
    for (const path of [...ONBOARDING_DOCS, ...TUTORIAL_FILES.map(path => `docs/tutorial/${path}`)]) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      cpSync(join(root, path), join(directory, path));
    }
    for (const path of ['.tendriller/handle.json', '.tendriller/device.sqlite', '.tendriller/epoch.json', 'node_modules/secret.txt', 'page/config.mjs']) {
      const destination = join(directory, 'docs/tutorial', path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, 'NEVER_PUBLISH_THIS_PRIVATE_RECORD');
    }
    const out = join(directory, 'public');
    mkdirSync(out);
    buildOnboardingAssets(directory, out);
    const archive = join(out, TUTORIAL_DOWNLOAD);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert(!/\.tendriller|node_modules|page\/config/.test(entries));
    const content = execFileSync('tar', ['-xOf', archive], { encoding: 'utf8' });
    assert(!content.includes('NEVER_PUBLISH_THIS_PRIVATE_RECORD'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
