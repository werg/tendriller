// Retain a complete immutable runtime graph in FILES before deploying its service.
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';
import { installRuntimeResources, uploadRuntimeFile } from './install-runtime-resources.mjs';

const root = resolve(import.meta.dirname, '..');

export async function publishRuntime({ configPath, directory = join(root, 'dist/runtime/assets'),
  registry, fetcher, upload = uploadRuntimeFile }) {
  configPath = resolve(configPath);
  directory = resolve(directory);
  const { experimental_readRawConfig } = createRequire(import.meta.url)('wrangler');
  const { rawConfig: config } = experimental_readRawConfig({ config: configPath });
  const bucket = config.r2_buckets?.find(binding => binding.binding === 'FILES')?.bucket_name;
  if (!bucket) throw Error('The selected deployment has no FILES bucket.');
  const manifest = verifyRuntimeManifest(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')));
  const paths = new Set(['manifest.json']);
  const files = manifest.assets.map(file => {
    const path = resolve(directory, file.path);
    if (!path.startsWith(directory + '/') || paths.has(file.path)) throw Error('Unsafe or duplicate runtime asset path.');
    paths.add(file.path);
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error(`Runtime integrity check failed: ${file.path}`);
    return { key: `runtime/${manifest.id}/${file.path}`, path, type: file.type };
  });
  const destination = { bucket, remote: true, configPath };
  const resources = await installRuntimeResources({ ...destination, manifest, registry, fetcher, upload });
  for (const file of files) await upload({ ...destination, ...file });
  // Publish the manifest only after every declared file and dependency exists.
  await upload({ ...destination, key: `runtime/${manifest.id}/manifest.json`,
    path: join(directory, 'manifest.json'), type: 'application/json' });
  return { id: manifest.id, files: files.length + 1, resources };
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  if (!values.config) throw Error('Usage: node scripts/publish-runtime.mjs --config server/wrangler.<environment>.jsonc');
  const result = await publishRuntime({ configPath: resolve(root, values.config) });
  console.log(`Retained runtime ${result.id} (${result.files} immutable files, ${result.resources} resources).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
