// Write the Wrangler config that is actually deployed: the checked-in config plus
// static routing for the built runtime. The runtime ID is a build output, so it is
// never committed; the generated file (server/*.deploy.jsonc) is gitignored.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetRouting, builtRuntimeId } from './deployment-defaults.mjs';

export function deployConfigPath(configPath) {
  const name = basename(configPath);
  if (!/^wrangler\.[a-z0-9-]+\.jsonc$/.test(name) || name.endsWith('.deploy.jsonc'))
    throw Error('Pass a checked-in server/wrangler.<name>.jsonc config');
  return join(dirname(configPath), name.replace(/\.jsonc$/, '.deploy.jsonc'));
}

export function writeDeployConfig(configPath, { runtimeId = builtRuntimeId(), expectedRuntimeId } = {}) {
  configPath = resolve(configPath);
  if (expectedRuntimeId !== undefined && expectedRuntimeId !== runtimeId)
    throw Error(`Built runtime ${runtimeId} differs from the expected ${expectedRuntimeId}`);
  const { rawConfig } = createRequire(import.meta.url)('wrangler').experimental_readRawConfig({ config: configPath });
  if (!rawConfig.assets) throw Error(`${configPath} has no assets binding`);
  const output = deployConfigPath(configPath);
  // Same directory, so main/assets paths keep resolving relative to server/.
  writeFileSync(output, JSON.stringify({ ...rawConfig, assets: { ...rawConfig.assets, run_worker_first: assetRouting(runtimeId) } }, null, 2) + '\n');
  return { path: output, runtimeId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('Usage: node scripts/deploy-config.mjs server/wrangler.<name>.jsonc');
  const expected = process.env.TENDRILLER_EXPECTED_RUNTIME_ID || undefined;
  const { path, runtimeId } = writeDeployConfig(process.argv[2], { expectedRuntimeId: expected });
  console.log(`Wrote ${path} routing runtime ${runtimeId} statically`);
}
