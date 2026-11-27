// Install the exact content-addressed dependencies of a built runtime manifest.
import { createHash } from 'node:crypto';
import { mkdir, readFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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
export const DEFAULT_SPEECH_CACHE_DIR = process.env.TENDRIL_SPEECH_CACHE
  || join(homedir(), '.cache', 'tendriller-e2e', 'speech-4.0.0');

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

export async function uploadRuntimeFile({ bucket, key, path, type, remote = false, configPath, jurisdiction }) {
  if (!/^[a-z0-9-]+$/.test(bucket ?? '')) throw Error('Pass an R2 bucket name');
  const args = [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'r2', 'object', 'put',
    `${bucket}/${key}`, '--file', path, '--content-type', type,
    '--cache-control', 'public, max-age=31536000, immutable', remote ? '--remote' : '--local',
    ...(configPath ? ['--config', configPath] : []), ...(jurisdiction ? ['--jurisdiction', jurisdiction] : [])];
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

function matchesIntegrity(bytes, resource) {
  if (createHash('sha256').update(bytes).digest('hex') !== resource.sha256) return false;
  if (resource.etag && (bytes.length !== resource.size || createHash('md5').update(bytes).digest('hex') !== resource.etag)) return false;
  return true;
}

export async function installRuntimeResources({ bucket, manifest, registry = RUNTIME_RESOURCES,
  remote = false, configPath, jurisdiction, cacheDir, fetcher = fetch, upload = uploadRuntimeFile, needed = () => true }) {
  if (!/^[a-z0-9-]+$/.test(bucket ?? '')) throw Error('Pass an R2 bucket name');
  const resources = declaredRuntimeResources(manifest, registry).filter(resource => needed(resource.url.slice('_tendril/'.length)));
  if (!resources.length) return 0;
  const directory = cacheDir ? resolve(cacheDir) : await mkdtemp(join(tmpdir(), 'tendriller-resources-'));
  if (cacheDir) await mkdir(directory, { recursive: true });
  try {
    for (const resource of resources) {
      const target = join(directory, resource.name);
      let bytes;
      if (cacheDir) {
        try {
          const cached = await readFile(target);
          if (matchesIntegrity(cached, resource)) bytes = cached;
        } catch { /* download below */ }
      }
      if (!bytes) {
        const response = await fetcher(resource.source);
        if (!response.ok) throw Error(`${resource.name}: HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (!matchesIntegrity(bytes, resource)) throw Error(`${resource.name}: integrity mismatch`);
        if (cacheDir) {
          const temp = `${target}.${process.pid}.tmp`;
          await writeFile(temp, bytes);
          await rename(temp, target);
        } else {
          await writeFile(target, bytes);
        }
      }
      await upload({ bucket, key: resource.url.slice('_tendril/'.length), path: target, type: resource.type, remote, configPath, jurisdiction });
    }
    return resources.length;
  } finally {
    if (!cacheDir) await rm(directory, { recursive: true, force: true });
  }
}

/** Ensure pinned speech/runtime resources are seeded in local Wrangler R2 (fast-pathed when already installed). */
export async function ensureLocalRuntimeResources({
  bucket = 'tendriller-local-files',
  manifestPath = join(root, 'dist/runtime/assets/manifest.json'),
  configPath = join(root, 'server/wrangler.jsonc'),
  cacheDir = DEFAULT_SPEECH_CACHE_DIR,
  stateDir = join(root, 'server/.wrangler/state/v3/r2'),
  fetcher = fetch,
  upload = uploadRuntimeFile,
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const declared = declaredRuntimeResources(manifest);
  const stampPath = join(stateDir, `${bucket}.runtime-resources.json`);
  const wanted = Object.fromEntries(declared.map(r => [r.url.slice('_tendril/'.length), r.sha256]));
  let installed = {};
  try {
    const raw = JSON.parse(await readFile(stampPath, 'utf8'));
    if (raw && typeof raw === 'object') installed = raw;
  } catch { /* not seeded yet */ }
  const missing = declared.filter(r => installed[r.url.slice('_tendril/'.length)] !== r.sha256);
  if (!missing.length) return { installed: 0, total: declared.length };
  const missingKeys = new Set(missing.map(r => r.url.slice('_tendril/'.length)));
  const count = await installRuntimeResources({
    bucket,
    manifest,
    remote: false,
    configPath,
    cacheDir,
    fetcher,
    upload,
    needed: key => missingKeys.has(key),
  });
  await mkdir(stateDir, { recursive: true });
  await writeFile(stampPath, JSON.stringify({ ...installed, ...wanted }, null, 2) + '\n');
  return { installed: count, total: declared.length };
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
