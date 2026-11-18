// Install the exact content-addressed dependencies of a built runtime manifest.
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { RUNTIME_RESOURCES } from '../runtime/resources.mjs';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';

const root = resolve(import.meta.dirname, '..');
const run = promisify(execFile);

export function declaredRuntimeResources(manifest, registry = RUNTIME_RESOURCES) {
  verifyRuntimeManifest(manifest);
  if (!Array.isArray(manifest.resources) || manifest.resources.length !== registry.length) {
    throw Error('Runtime resource registry does not match the built manifest');
  }
  const resources = new Map();
  for (const resource of registry) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(resource.name) || !/^[a-f0-9]{64}$/.test(resource.sha256) ||
        resource.url !== `_tendril/assets/${resource.sha256}/${resource.name}` ||
        typeof resource.type !== 'string' || !resource.type || new URL(resource.source).protocol !== 'https:' ||
        resources.has(resource.url)) {
      throw Error('Invalid or duplicate runtime resource registry entry');
    }
    resources.set(resource.url, resource);
  }
  return manifest.resources.map(declared => {
    const resource = resources.get(declared.url);
    if (!resource || resource.sha256 !== declared.sha256 || resource.type !== declared.type) {
      throw Error(`Runtime resource registry does not match the built manifest: ${declared.url}`);
    }
    resources.delete(declared.url);
    return resource;
  });
}

export async function uploadRuntimeFile({ bucket, key, path, type, remote = false, configPath }) {
  if (!/^[a-z0-9-]+$/.test(bucket ?? '')) throw Error('Pass an R2 bucket name');
  const args = [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'r2', 'object', 'put',
    `${bucket}/${key}`, '--file', path, '--content-type', type,
    '--cache-control', 'public, max-age=31536000, immutable', remote ? '--remote' : '--local',
    ...(configPath ? ['--config', configPath] : [])];
  for (let attempt = 1; ; attempt++) {
    try {
      await run(process.execPath, args, { cwd: root });
      return;
    } catch (error) {
      if (!remote || attempt === 4 || !/ - (?:429|50[0234]):|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/.test(error.stderr ?? '')) throw error;
      console.warn(`Retrying immutable upload for ${key} after an R2 error (${attempt}/3)`);
      await delay(1000 * 2 ** (attempt - 1));
    }
  }
}

export async function installRuntimeResources({ bucket, manifest, registry = RUNTIME_RESOURCES,
  remote = false, configPath, fetcher = fetch, upload = uploadRuntimeFile }) {
  if (!/^[a-z0-9-]+$/.test(bucket ?? '')) throw Error('Pass an R2 bucket name');
  const resources = declaredRuntimeResources(manifest, registry);
  const directory = await mkdtemp(join(tmpdir(), 'tendriller-resources-'));
  try {
    for (const resource of resources) {
      const response = await fetcher(resource.source);
      if (!response.ok) throw Error(`${resource.name}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== resource.sha256) throw Error(`${resource.name}: integrity mismatch`);
      const path = join(directory, resource.name);
      await writeFile(path, bytes);
      await upload({ bucket, key: resource.url.slice('_tendril/'.length), path, type: resource.type, remote, configPath });
    }
    return resources.length;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    remote: { type: 'boolean', default: false }, config: { type: 'string' },
    manifest: { type: 'string', default: join(root, 'dist/runtime/assets/manifest.json') },
  } });
  if (positionals.length !== 1) throw Error('Usage: node scripts/install-runtime-resources.mjs <bucket> [--remote] [--config <config>] [--manifest <manifest>]');
  const count = await installRuntimeResources({ bucket: positionals[0],
    manifest: JSON.parse(await readFile(values.manifest, 'utf8')), remote: values.remote,
    configPath: values.config ? resolve(values.config) : undefined });
  console.log(`Installed ${count} immutable runtime resources.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
