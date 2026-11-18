// Retain a complete immutable runtime graph in FILES before deploying its service.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';
import { declaredRuntimeResources, installRuntimeResources, uploadRuntimeFile } from './install-runtime-resources.mjs';

const root = resolve(import.meta.dirname, '..');

export async function publishRuntime({ configPath, directory = join(root, 'dist/runtime/assets'),
  registry, fetcher, upload = uploadRuntimeFile, list = listRetainedObjects }) {
  configPath = resolve(configPath);
  directory = resolve(directory);
  const { experimental_readRawConfig } = createRequire(import.meta.url)('wrangler');
  const { rawConfig: config } = experimental_readRawConfig({ config: configPath });
  const binding = config.r2_buckets?.find(binding => binding.binding === 'FILES');
  const bucket = binding?.bucket_name;
  if (!bucket) throw Error('The selected deployment has no FILES bucket.');
  const manifest = verifyRuntimeManifest(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')));
  const paths = new Set(['manifest.json']);
  const files = manifest.assets.map(file => {
    const path = resolve(directory, file.path);
    if (!path.startsWith(directory + '/') || paths.has(file.path)) throw Error('Unsafe or duplicate runtime asset path.');
    paths.add(file.path);
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error(`Runtime integrity check failed: ${file.path}`);
    return { key: `runtime/${manifest.id}/${file.path}`, path, type: file.type,
      size: bytes.length, etag: createHash('md5').update(bytes).digest('hex') };
  });
  const dependencies = declaredRuntimeResources(manifest, registry);
  const manifestPath = join(directory, 'manifest.json');
  const manifestBytes = readFileSync(manifestPath);
  const marker = { key: `runtime/${manifest.id}/manifest.json`, path: manifestPath, type: 'application/json',
    size: manifestBytes.length, etag: createHash('md5').update(manifestBytes).digest('hex') };
  const destination = { bucket, remote: true, configPath, jurisdiction: binding.jurisdiction };
  const prefixes = [`runtime/${manifest.id}/`, ...dependencies.map(resource => resource.url.slice('_tendril/'.length))];
  const retained = await list({ config, ...destination, prefixes });
  const missing = file => {
    const object = retained.get(file.key);
    return !object || object.http_metadata?.contentType !== file.type
      || !file.etag || object.size !== file.size || object.etag !== file.etag;
  };
  // Compare the actual single-PUT ETag and length with the expected bytes.
  // Resource source bytes still require SHA-256 verification on upload.
  const neededResources = new Set(dependencies
    .map(resource => ({ ...resource, key: resource.url.slice('_tendril/'.length) }))
    .filter(missing).map(resource => resource.key));
  const resources = await installRuntimeResources({ ...destination, manifest, registry, fetcher, upload,
    needed: key => neededResources.has(key) });
  let uploaded = 0;
  for (const file of files.filter(missing)) { await upload({ ...destination, ...file }); uploaded++; }
  // Publish the manifest only after every declared file and dependency exists.
  if (missing(marker)) { await upload({ ...destination, ...marker }); uploaded++; }
  return { id: manifest.id, files: uploaded, resources };
}

async function listRetainedObjects({ config, configPath, bucket, prefixes, jurisdiction }) {
  const wrangler = (...args) => JSON.parse(execFileSync(process.execPath,
    [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--json', '--config', configPath],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  let account = config.account_id || process.env.CLOUDFLARE_ACCOUNT_ID || config.vars?.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const accounts = wrangler('whoami').accounts;
    if (accounts?.length === 1) account = accounts[0].id;
  }
  if (!/^[a-f0-9]{32}$/.test(account ?? '')) throw Error('Select the Cloudflare account for the FILES bucket.');
  const credential = wrangler('auth', 'token');
  const headers = credential.token ? { Authorization: `Bearer ${credential.token}` }
    : { 'X-Auth-Key': credential.key, 'X-Auth-Email': credential.email };
  if (Object.values(headers).some(value => !value)) throw Error('Wrangler did not return R2 API credentials.');
  if (jurisdiction) headers['cf-r2-jurisdiction'] = jurisdiction;
  const retained = new Map();
  await Promise.all(prefixes.map(async prefix => {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects`);
    url.searchParams.set('prefix', prefix);
    do {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error(`Could not list immutable R2 objects (HTTP ${response.status})`);
      const body = await response.json();
      if (!body.success || !Array.isArray(body.result)) throw Error('Invalid immutable R2 listing response');
      for (const entry of body.result) retained.set(entry.key, entry);
      if (!body.result_info?.is_truncated) break;
      const cursor = body.result_info.cursor;
      if (!cursor || cursor === url.searchParams.get('cursor')) throw Error('Invalid immutable R2 list cursor');
      url.searchParams.set('cursor', cursor);
    } while (true);
  }));
  return retained;
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  if (!values.config) throw Error('Usage: node scripts/publish-runtime.mjs --config server/wrangler.<environment>.jsonc');
  const result = await publishRuntime({ configPath: resolve(root, values.config) });
  console.log(`Retained runtime ${result.id} (${result.files} file uploads, ${result.resources} resource uploads).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
