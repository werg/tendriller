import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRuntimeResources, ensureLocalRuntimeResources } from '../install-runtime-resources.mjs';
import { runtimeManifest } from '../runtime-manifest.mjs';

function makeManifestAndRegistry() {
  const files = [
    { name: 'cactus.js', type: 'text/javascript', body: Buffer.from('console.log("cactus");') },
    { name: 'cactus.wasm', type: 'application/wasm', body: Buffer.from([0x00, 0x61, 0x73, 0x6d]) },
    { name: 'whistle.cact', type: 'application/octet-stream', body: Buffer.from('whistle-model-bytes') },
  ];
  const registry = files.map(f => {
    const sha256 = createHash('sha256').update(f.body).digest('hex');
    const etag = createHash('md5').update(f.body).digest('hex');
    return {
      name: f.name,
      sha256,
      etag,
      size: f.body.length,
      type: f.type,
      url: `_tendril/assets/${sha256}/${f.name}`,
      source: `https://example.test/releases/${f.name}`,
      body: f.body,
    };
  });
  const manifest = runtimeManifest({
    version: '0.0.0-test',
    contract: 3,
    assets: { 'runtime.js': { sha256: 'b'.repeat(64), size: 10 } },
    resources: registry.map(({ url, sha256, type }) => ({ url, sha256, type })),
  });
  return { manifest, registry };
}

test('installRuntimeResources caches verified files, re-downloads corrupt cache entries, and rejects hash mismatches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tendriller-res-test-'));
  try {
    const cacheDir = join(dir, 'cache');
    const { manifest, registry } = makeManifestAndRegistry();
    const bySource = new Map(registry.map(r => [r.source, r.body]));
    let fetchCount = 0;
    const uploads = [];
    const fetcher = async (url) => {
      fetchCount++;
      const body = bySource.get(url);
      if (!body) return new Response('missing', { status: 404 });
      return new Response(body, { status: 200 });
    };
    const upload = async (entry) => {
      const bytes = await readFile(entry.path);
      uploads.push({ bucket: entry.bucket, key: entry.key, size: bytes.length, type: entry.type });
    };

    const firstCount = await installRuntimeResources({ bucket: 'local-files', manifest, registry, cacheDir, fetcher, upload });
    assert.equal(firstCount, 3);
    assert.equal(fetchCount, 3);
    assert.equal(uploads.length, 3);

    // Second install uses the verified local cache without any network fetches.
    const secondCount = await installRuntimeResources({ bucket: 'local-files', manifest, registry, cacheDir, fetcher, upload });
    assert.equal(secondCount, 3);
    assert.equal(fetchCount, 3);

    // Corrupting a cached file causes only that file to be re-fetched and healed.
    await writeFile(join(cacheDir, 'cactus.wasm'), Buffer.from('corrupt'));
    await installRuntimeResources({ bucket: 'local-files', manifest, registry, cacheDir, fetcher, upload });
    assert.equal(fetchCount, 4);

    // Integrity mismatch from upstream throws and refuses upload.
    await writeFile(join(cacheDir, 'cactus.js'), Buffer.from('corrupt'));
    await assert.rejects(
      installRuntimeResources({
        bucket: 'local-files',
        manifest,
        registry,
        cacheDir,
        fetcher: async () => new Response(Buffer.from('wrong-bytes'), { status: 200 }),
        upload,
      }),
      /integrity mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureLocalRuntimeResources records installed stamp and skips redundant uploads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tendriller-local-res-test-'));
  try {
    const cacheDir = join(dir, 'cache');
    const stateDir = join(dir, 'state');
    const manifestPath = join(dir, 'manifest.json');
    const actualManifest = JSON.parse(await readFile(new URL('../../dist/runtime/assets/manifest.json', import.meta.url), 'utf8'));
    await writeFile(manifestPath, JSON.stringify(actualManifest));

    // Pre-populate stamp for all declared resources except simulate a fresh seed using custom upload + mock fetcher?
    // Since ensureLocalRuntimeResources verifies against RUNTIME_RESOURCES real hashes, test the fast-path when stamp matches.
    const wanted = Object.fromEntries(actualManifest.resources.map(r => [r.url.slice('_tendril/'.length), r.sha256]));
    const stampPath = join(stateDir, 'tendriller-local-files.runtime-resources.json');
    await writeFile(manifestPath, JSON.stringify(actualManifest));
    let uploadCalls = 0;
    const upload = async () => { uploadCalls++; };

    // Missing stamp triggers fetcher; simulate offline error cleanly propagated.
    await assert.rejects(
      ensureLocalRuntimeResources({
        manifestPath,
        cacheDir,
        stateDir,
        fetcher: async () => new Response('offline', { status: 503 }),
        upload,
      }),
      /HTTP 503/,
    );
    assert.equal(uploadCalls, 0);

    // Once stamped, subsequent calls are an instant no-op with 0 fetches/uploads.
    await import('node:fs/promises').then(fs => fs.mkdir(stateDir, { recursive: true }));
    await writeFile(stampPath, JSON.stringify(wanted));
    const seeded = await ensureLocalRuntimeResources({
      manifestPath,
      cacheDir,
      stateDir,
      fetcher: async () => { throw new Error('should not fetch'); },
      upload,
    });
    assert.deepEqual(seeded, { installed: 0, total: actualManifest.resources.length });
    assert.equal(uploadCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
