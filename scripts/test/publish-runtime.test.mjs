import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { publishRuntime } from '../publish-runtime.mjs';
import { runtimeManifest } from '../runtime-manifest.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const scratch = resolve(import.meta.dirname, '../../.build');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'runtime-publication-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bodies = [Buffer.from('first dependency'), Buffer.from('second dependency')];
  const registry = bodies.map((bytes, index) => ({
    name: `resource-${index}.bin`, sha256: digest(bytes), type: 'application/octet-stream',
    size: bytes.length, etag: createHash('md5').update(bytes).digest('hex'),
    source: `https://resources.example/releases/pinned/resource-${index}.bin`,
    url: `_tendril/assets/${digest(bytes)}/resource-${index}.bin`,
  }));
  const runtime = Buffer.from('console.log("runtime")');
  const manifest = runtimeManifest({ version: '1.2.3', contract: 2,
    assets: [{ path: 'tendril.js', sha256: digest(runtime), size: runtime.length, type: 'text/javascript' }],
    resources: registry.map(({ url, sha256, type }) => ({ url, sha256, type })),
  });
  await writeFile(join(directory, 'tendril.js'), runtime);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const configPath = join(directory, 'candidate.jsonc');
  await writeFile(configPath, `{
    // Use the selected config, including its account, for every upload.
    "account_id": "${'a'.repeat(32)}",
    "r2_buckets": [{ "binding": "FILES", "bucket_name": "candidate-files", }],
  }`);
  const fetches = [], uploads = [];
  const options = { directory, configPath, registry, list: async () => new Map(),
    fetcher: async url => { fetches.push(url); return new Response(bodies[registry.findIndex(resource => resource.source === url)]); },
    upload: async file => { uploads.push({ ...file, bytes: await readFile(file.path) }); },
  };
  return { options, manifest, registry, bodies, runtime, fetches, uploads };
}

test('publication installs the complete declared graph in the selected bucket and publishes its manifest last', async t => {
  const f = await fixture(t);
  const result = await publishRuntime(f.options);
  assert.deepEqual(result, { id: f.manifest.id, files: 2, resources: 2 });
  assert.deepEqual(f.fetches, f.registry.map(resource => resource.source));
  assert.deepEqual(f.uploads.map(file => file.key), [
    ...f.registry.map(resource => resource.url.slice('_tendril/'.length)),
    `runtime/${f.manifest.id}/tendril.js`, `runtime/${f.manifest.id}/manifest.json`,
  ]);
  assert.deepEqual(f.uploads.map(file => file.bytes), [...f.bodies, f.runtime, Buffer.from(JSON.stringify(f.manifest))]);
  for (const upload of f.uploads) {
    assert.equal(upload.bucket, 'candidate-files');
    assert.equal(upload.configPath, f.options.configPath);
    assert.equal(upload.remote, true);
  }
  for (const upload of f.uploads.slice(0, 2)) await assert.rejects(readFile(upload.path), { code: 'ENOENT' });
});

test('a stale or incomplete resource registry fails before downloads or uploads', async t => {
  const f = await fixture(t);
  for (const registry of [
    f.registry.slice(1),
    f.registry.map((resource, index) => index ? resource : { ...resource, type: 'text/plain' }),
    [f.registry[0], f.registry[0]],
  ]) {
    await assert.rejects(publishRuntime({ ...f.options, registry }), /registry/);
  }
  await writeFile(join(f.options.directory, 'manifest.json'), JSON.stringify({ ...f.manifest, resources: [] }));
  await assert.rejects(publishRuntime(f.options), /manifest identity/);
  assert.deepEqual(f.fetches, []);
  assert.deepEqual(f.uploads, []);
});

test('corrupted dependency bytes never publish a runtime manifest', async t => {
  const f = await fixture(t);
  await assert.rejects(publishRuntime({ ...f.options,
    fetcher: async url => new Response(url === f.registry[0].source ? f.bodies[0] : 'corrupted bytes'),
  }), /integrity mismatch/);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].key, f.registry[0].url.slice('_tendril/'.length));
  await assert.rejects(readFile(f.uploads[0].path), { code: 'ENOENT' });
});

test('local runtime integrity is checked before any resource is downloaded or uploaded', async t => {
  const f = await fixture(t);
  await writeFile(join(f.options.directory, 'tendril.js'), 'changed runtime');
  await assert.rejects(publishRuntime(f.options), /Runtime integrity check failed/);
  assert.deepEqual(f.fetches, []);
  assert.deepEqual(f.uploads, []);
});

test('an upload failure prevents the manifest from claiming a complete graph', async t => {
  const f = await fixture(t);
  await assert.rejects(publishRuntime({ ...f.options, upload: async file => {
    if (file.key.endsWith('/tendril.js')) throw Error('upload unavailable');
    await f.options.upload(file);
  } }), /upload unavailable/);
  assert.deepEqual(f.uploads.map(file => file.key), f.registry.map(resource => resource.url.slice('_tendril/'.length)));
});

test('a warm deploy reuses immutable files and downloads only missing dependencies', async t => {
  const f = await fixture(t);
  await publishRuntime(f.options);
  const entries = new Map(f.uploads.map(file => [file.key, {
    size: file.bytes.length, etag: createHash('md5').update(file.bytes).digest('hex'),
    http_metadata: { contentType: file.type },
  }]));
  f.uploads.length = f.fetches.length = 0;
  const list = async () => entries;
  assert.deepEqual(await publishRuntime({ ...f.options, list }), { id: f.manifest.id, files: 0, resources: 0 });
  assert.deepEqual(f.uploads, []);
  assert.deepEqual(f.fetches, []);
  const resourceKey = f.registry[1].url.slice('_tendril/'.length);
  entries.get(resourceKey).etag = 'wrong';
  entries.get(`runtime/${f.manifest.id}/tendril.js`).etag = 'wrong';
  assert.deepEqual(await publishRuntime({ ...f.options, list }), { id: f.manifest.id, files: 1, resources: 1 });
  assert.deepEqual(f.uploads.map(file => file.key), [resourceKey, `runtime/${f.manifest.id}/tendril.js`]);
  assert.deepEqual(f.fetches, [f.registry[1].source]);
});
