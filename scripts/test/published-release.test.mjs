import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { RELEASE_DOWNLOAD_LIMITS, verifyPublishedRelease, readPublishedManifest } from '../check-published-release.mjs';

import { FIRST_APP_PROFILES } from '../release-composition.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function fixture() {
  const version = '1.2.3-rc.4', source = 'a'.repeat(40), tree = 'b'.repeat(40), runtime = 'c'.repeat(64);
  const base = `https://github.com/werg/tendriller/releases/download/source-${source}`;
  const bytes = new Map(), overrides = new Map(), calls = [];
  const artifact = (role, file, content = `public ${role} bytes`) => {
    const value = Buffer.isBuffer(content) ? content : Buffer.from(content); bytes.set(file, value);
    return { role, file, url: `${base}/${file}`, sha256: hash(value), size: value.length,
      type: file.endsWith('.tgz') ? 'application/gzip' : 'application/json' };
  };
  const components = ['sdk', 'runtime', 'engine', 'tools'].map(role => artifact(role, `tendriller-${role}-${version}.tgz`));
  components.push(artifact('authority', `chronolog-authority-${'d'.repeat(40)}.tgz`));
  components.push(artifact('session', `chronolog-peer-session-${'d'.repeat(40)}.tgz`));
  components.push(artifact('session-sql-browser', `chronolog-peer-session-${'d'.repeat(40)}-sql-browser.tgz`));
  components.push(artifact('starter', `tendriller-starter-${version}.tgz`));
  const body = { format: 'tendriller-release-composition-v1', version, contract: 3,
    core: { repository: 'werg/tendriller', source, sourceTree: tree, dirty: false }, runtime,
    profiles: FIRST_APP_PROFILES,
    chronolog: Object.fromEntries(['authority', 'session', 'session-sql-browser'].map(role => [role, {repository:'werg/chronolog',source:'d'.repeat(40),sourceTree:'e'.repeat(40),dirty:false}])),
    components: components.map(({ role, file, sha256, size }) => ({ role, file, sha256, size })) };
  const composition = { ...body, id: hash(JSON.stringify(body)) };
  const manifest = { format: 'tendriller-core-release', version, contract: 3, source_commit: source,
    source_tree: tree, runtime, composition: { id: composition.id, file: 'composition.json' },
    first_app: { file: `tendriller-first-app-${version}.tgz`, profile: 'events', packages: FIRST_APP_PROFILES.events.packages, build_dependency: 'esbuild@0.28.2' },
    first_apps: {sql: {file:`tendriller-first-app-sql-${version}.tgz`,profile:'sql',packages:FIRST_APP_PROFILES.sql.packages,build_dependency:'esbuild@0.28.2'}},
    artifacts: [...components, artifact('composition', 'composition.json', json(composition)),
      artifact('first-app', `tendriller-first-app-${version}.tgz`), artifact('first-app-sql', `tendriller-first-app-sql-${version}.tgz`),
      artifact('core-provenance', 'provenance.json'), artifact('tools-provenance', 'tools-manifest.json'), artifact('plugin', 'tendriller-chatgpt-plugin.zip')] };
  const expected = { sourceCommit: source, coreRelease: version, runtimeId: runtime,
    compositionId: composition.id, manifestSha256: '' };
  const saveManifest = () => { const value = json(manifest); bytes.set('manifest.json', value); expected.manifestSha256 = hash(value); };
  saveManifest();
  const fetcher = async (input, options) => {
    const url = new URL(input); calls.push({ url: url.href, options });
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(new Headers(options.headers).has('cookie'), false);
    if (overrides.has(url.href)) return overrides.get(url.href)();
    const value = bytes.get(url.pathname.split('/').at(-1));
    return value ? new Response(value, { headers: { 'Content-Length': String(value.length) } }) : new Response(null, { status: 404 });
  };
  return { base, expected, manifest, composition, bytes, overrides, calls, saveManifest, fetcher,
    check: options => verifyPublishedRelease(expected, { fetcher, ...options }) };
}

test('the same exact published composition verifies the kit and every public component anonymously', async () => {
  const f = fixture(), result = await f.check();
  assert.equal(result.compositionId, f.expected.compositionId);
  assert.equal(result.artifacts, 14);
  assert.equal(f.calls.length, 15, 'Manifest plus every asset, with no fallback lookup.');
  for (const item of f.manifest.artifacts) assert(f.calls.some(call => call.url === item.url));
  assert(f.calls.every(call => call.url.startsWith(f.base + '/')));
});

test('current baseline rejects missing SQL profiles, mismatched source trees and native kit package selection', async () => {
  for (const mutate of [
    f => { delete f.composition.profiles; },
    f => { f.composition.chronolog['session-sql-browser'].sourceTree = 'f'.repeat(40); },
    f => { delete f.manifest.first_apps; },
    f => { f.manifest.first_apps.sql.packages = ['sdk', 'tools', 'authority', 'session']; },
  ]) {
    const f = fixture();
    f.composition.profiles = structuredClone(f.composition.profiles);
    f.manifest.first_apps = structuredClone(f.manifest.first_apps);
    mutate(f);
    const { id: _id, ...body } = f.composition;
    f.composition.id = hash(JSON.stringify(body)); f.expected.compositionId = f.composition.id; f.manifest.composition.id = f.composition.id;
    const bytes = json(f.composition); f.bytes.set('composition.json', bytes);
    Object.assign(f.manifest.artifacts.find(item => item.role === 'composition'), { sha256: hash(bytes), size: bytes.length });
    f.saveManifest();
    await assert.rejects(f.check(), { code: 'release_identity_mismatch' });
  }
});

test('missing or old public manifests stop before any fallback or asset acquisition', async () => {
  const missing = fixture(); missing.bytes.delete('manifest.json');
  await assert.rejects(missing.check(), { code: 'release_unavailable' });
  assert.equal(missing.calls.length, 1);
  const old = fixture(); old.bytes.set('manifest.json', json({ version: 'old' }));
  await assert.rejects(old.check(), { code: 'release_bytes_mismatch' });
  assert.equal(old.calls.length, 1);
});

test('a published manifest with a missing kit or companion cannot pass', async t => {
  for (const role of ['first-app', 'first-app-sql', 'authority', 'session', 'session-sql-browser', 'sdk', 'tools']) await t.test(role, async () => {
    const f = fixture(); f.bytes.delete(f.manifest.artifacts.find(item => item.role === role).file);
    await assert.rejects(f.check(), { code: 'release_unavailable' });
  });
});

test('source, version, runtime and composition must match expected artifact-job identity', async t => {
  for (const [name, change] of [
    ['source', manifest => { manifest.source_commit = 'e'.repeat(40); }],
    ['version', manifest => { manifest.version = '1.2.2'; }],
    ['runtime', manifest => { manifest.runtime = 'e'.repeat(64); }],
    ['composition', manifest => { manifest.composition.id = 'e'.repeat(64); }],
  ]) await t.test(name, async () => {
    const f = fixture(); change(f.manifest); f.saveManifest();
    await assert.rejects(f.check(), { code: 'release_identity_mismatch' });
  });
});

test('release metadata cannot redirect component acquisition to arbitrary or mutable URLs', async t => {
  for (const url of ['https://example.test/package.tgz', 'http://github.com/file.tgz',
    'https://github.com/other/repository/releases/download/v1/file.tgz',
    'https://github.com/werg/tendriller/archive/refs/heads/master.tar.gz',
    'https://user:password@github.com/werg/tendriller/releases/download/v1/file.tgz']) await t.test(url, async () => {
    const f = fixture(); f.manifest.artifacts[0].url = url; f.saveManifest();
    await assert.rejects(f.check(), { code: 'release_metadata_invalid' });
    assert.equal(f.calls.length, 1);
  });
});

test('legitimate GitHub asset redirects remain anonymous and verify final bytes', async () => {
  const f = fixture(), item = f.manifest.artifacts.find(item => item.role === 'first-app');
  const destination = `https://release-assets.githubusercontent.com/github-production-release-asset/123/${item.file}?signature=public-test`;
  f.overrides.set(item.url, () => new Response(null, { status: 302, headers: { Location: destination } }));
  assert.equal((await f.check()).compositionId, f.expected.compositionId);
  assert(f.calls.some(call => call.url === destination));
});

test('unsafe redirects fail before the destination is requested', async t => {
  for (const destination of ['http://release-assets.githubusercontent.com/file', 'https://127.0.0.1/file',
    'https://release-assets.githubusercontent.com.example.test/file', 'https://example.test/file',
    'https://user:password@release-assets.githubusercontent.com/file', 'https://release-assets.githubusercontent.com:8443/file',
    'https://github.com/werg/tendriller/archive/refs/heads/master.tar.gz', 'https://release-assets.githubusercontent.com/file#fragment'])
    await t.test(destination, async () => {
      const f = fixture();
      f.overrides.set(`${f.base}/manifest.json`, () => new Response(null, { status: 302, headers: { Location: destination } }));
      await assert.rejects(f.check(), { code: 'release_redirect_forbidden' });
      assert.equal(f.calls.length, 1);
    });
});

test('redirect loops have a fixed request bound', async () => {
  const f = fixture(), destination = 'https://release-assets.githubusercontent.com/loop';
  const redirect = () => new Response(null, { status: 302, headers: { Location: destination } });
  f.overrides.set(`${f.base}/manifest.json`, redirect); f.overrides.set(destination, redirect);
  await assert.rejects(f.check(), { code: 'release_redirect_limit' });
  assert.equal(f.calls.length, RELEASE_DOWNLOAD_LIMITS.redirects + 1);
});

test('changed kit bytes and inconsistent composition content are rejected', async () => {
  const kit = fixture(), file = kit.manifest.first_app.file;
  const value = kit.bytes.get(file); kit.bytes.set(file, Buffer.alloc(value.length, 1));
  await assert.rejects(kit.check(), { code: 'release_bytes_mismatch' });
  const f = fixture(); f.composition.components[0].sha256 = 'e'.repeat(64);
  const altered = json(f.composition); f.bytes.set('composition.json', altered);
  Object.assign(f.manifest.artifacts.find(item => item.role === 'composition'), { sha256: hash(altered), size: altered.length });
  f.saveManifest();
  await assert.rejects(f.check(), { code: 'release_identity_mismatch' });
});

test('metadata, streaming bodies and declared public artifacts are bounded', async () => {
  const header = fixture();
  await assert.rejects(header.check({ limits: { ...RELEASE_DOWNLOAD_LIMITS, metadataBytes: 16 } }), { code: 'release_size_limit' });
  const stream = fixture();
  stream.overrides.set(`${stream.base}/manifest.json`, () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(32)); controller.close();
  } })));
  await assert.rejects(stream.check({ limits: { ...RELEASE_DOWNLOAD_LIMITS, metadataBytes: 16 } }), { code: 'release_size_limit' });
  const declared = fixture(); declared.manifest.artifacts[0].size = RELEASE_DOWNLOAD_LIMITS.artifactBytes + 1; declared.saveManifest();
  await assert.rejects(declared.check(), { code: 'release_metadata_invalid' });
});

test('invalid expected identity fails before issuing public requests', async () => {
  const f = fixture(); f.expected.manifestSha256 = '';
  await assert.rejects(f.check(), { code: 'release_expectation_invalid' });
  assert.equal(f.calls.length, 0);
});

test('malformed or incomplete metadata fails without requesting component URLs', async () => {
  const empty = fixture(), value = json(null);
  empty.bytes.set('manifest.json', value); empty.expected.manifestSha256 = hash(value);
  await assert.rejects(empty.check(), { code: 'release_metadata_invalid' });
  assert.equal(empty.calls.length, 1);
  for (const item of [null, fixture().manifest.artifacts[0]]) {
    const f = fixture(); f.manifest.artifacts.push(item); f.saveManifest();
    await assert.rejects(f.check(), { code: 'release_metadata_invalid' });
    assert.equal(f.calls.length, 1);
  }
});

test('acquisition retains only hash-verified files and includes the exact deployment bundle', async () => {
  const f = fixture();
  const content = Buffer.from('qualified deployment');
  f.bytes.set('tendriller-deployment.tgz', content);
  f.manifest.artifacts.push({ role: 'deployment', file: 'tendriller-deployment.tgz', size: content.length,
    sha256: hash(content), url: `${f.base}/tendriller-deployment.tgz`, type: 'application/gzip' });
  f.saveManifest();
  const saved = new Map();
  await f.check({ onVerified: (file, bytes) => saved.set(file, bytes) });
  assert.deepEqual(saved.get('tendriller-deployment.tgz'), content);
  assert.equal(saved.size, f.manifest.artifacts.length + 1);
  f.bytes.set('tendriller-deployment.tgz', Buffer.from('corruption'));
  saved.clear();
  await assert.rejects(f.check({ onVerified: (file, bytes) => saved.set(file, bytes) }), { code: 'release_bytes_mismatch' });
  assert.equal(saved.has('tendriller-deployment.tgz'), false);
});

test('manual manifest acquisition pins the exact source URL and omits credentials', async () => {
  const f = fixture();
  const bytes = await readPublishedManifest(f.expected.sourceCommit, { fetcher: f.fetcher });
  assert.deepEqual(bytes, f.bytes.get('manifest.json'));
  assert.deepEqual(f.calls.map(call => call.url), [`${f.base}/manifest.json`]);
  await assert.rejects(readPublishedManifest('master', { fetcher: f.fetcher }), { code: 'release_expectation_invalid' });
  assert.equal(f.calls.length, 1);
});

test('manual manifest bootstrap rejects insecure, cross-source and excessive redirects', async () => {
  for (const target of ['http://release-assets.githubusercontent.com/asset',
    'https://example.test/manifest.json',
    `https://github.com/werg/tendriller/releases/download/source-${'b'.repeat(40)}/manifest.json`,
    'https://github.com/werg/tendriller/releases/download/v1.2.3/manifest.json']) {
    const f = fixture();
    f.overrides.set(`${f.base}/manifest.json`, () => new Response(null, { status: 302, headers: { location: target } }));
    await assert.rejects(readPublishedManifest(f.expected.sourceCommit, { fetcher: f.fetcher }), { code: 'release_redirect_forbidden' });
    assert.equal(f.calls.length, 1);
  }
  const f = fixture();
  f.overrides.set(`${f.base}/manifest.json`, () => new Response(null, { status: 302, headers: { location: `${f.base}/manifest.json` } }));
  await assert.rejects(readPublishedManifest(f.expected.sourceCommit, { fetcher: f.fetcher }), { code: 'release_redirect_limit' });
  assert.equal(f.calls.length, RELEASE_DOWNLOAD_LIMITS.redirects + 1);
});

test('manual bootstrap enforces streaming metadata bounds and never falls back on missing source assets', async () => {
  const f = fixture();
  f.overrides.set(`${f.base}/manifest.json`, () => new Response(new Uint8Array(32)));
  await assert.rejects(readPublishedManifest(f.expected.sourceCommit, {
    fetcher: f.fetcher, limits: { ...RELEASE_DOWNLOAD_LIMITS, metadataBytes: 16 },
  }), { code: 'release_size_limit' });
  const missing = fixture(); missing.bytes.delete('manifest.json');
  await assert.rejects(readPublishedManifest(missing.expected.sourceCommit, { fetcher: missing.fetcher }), { code: 'release_unavailable' });
  assert.deepEqual(missing.calls.map(call => call.url), [`${missing.base}/manifest.json`]);
});

test('manual bootstrap accepts the signed HTTPS asset redirect and carries one bounded signal', async () => {
  const f = fixture(), target = 'https://release-assets.githubusercontent.com/release-id/manifest.json?sig=opaque';
  f.overrides.set(`${f.base}/manifest.json`, () => new Response(null, { status: 302, headers: { location: target } }));
  const bytes = await readPublishedManifest(f.expected.sourceCommit, { fetcher: f.fetcher });
  assert.deepEqual(bytes, f.bytes.get('manifest.json'));
  assert.deepEqual(f.calls.map(call => call.url), [`${f.base}/manifest.json`, target]);
  assert(f.calls[0].options.signal instanceof AbortSignal);
  assert.equal(f.calls[1].options.signal, f.calls[0].options.signal);
});


test('numeric browser/Node timeout codes retain a scoped release download error', async () => {
  const { readPublishedManifest } = await import('../check-published-release.mjs');
  const failure = () => Object.assign(Error('private transport diagnostic'), { code: 23 });
  for (const fetcher of [async () => { throw failure(); },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(failure()); } }))]) {
    await assert.rejects(readPublishedManifest('a'.repeat(40), { fetcher }),
      error => error.code === 'release_download_failed' && !error.message.includes('private transport diagnostic'));
  }
});
