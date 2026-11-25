import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployConfigPath, writeDeployConfig } from '../deploy-config.mjs';
import { assetRouting } from '../deployment-defaults.mjs';

test('checked-in Wrangler configs carry no runtime ID; the generated deploy config routes the built one statically', t => {
  for (const name of ['wrangler.jsonc', 'wrangler.public-test.jsonc', 'wrangler.staging.jsonc', 'wrangler.production.jsonc'])
    assert.doesNotMatch(readFileSync(new URL(`../../server/${name}`, import.meta.url), 'utf8'), /_tendril\/runtime\/[a-f0-9]{64}/, name);
  const directory = mkdtempSync(join(tmpdir(), 'deploy-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'wrangler.staging.jsonc');
  writeFileSync(source, `{
    // comments and trailing commas are accepted
    "name": "w", "main": "../dist/engine/worker.mjs",
    "assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": ["/*"], },
  }`);
  const id = 'a'.repeat(64);
  assert.throws(() => writeDeployConfig(source, { runtimeId: id, expectedRuntimeId: 'b'.repeat(64) }), /differs from the expected/);
  const { path } = writeDeployConfig(source, { runtimeId: id, expectedRuntimeId: id });
  assert.equal(path, join(directory, 'wrangler.staging.deploy.jsonc'));
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.main, '../dist/engine/worker.mjs');
  assert.deepEqual(config.assets, { directory: './public', binding: 'ASSETS', run_worker_first: assetRouting(id) });
  assert.throws(() => deployConfigPath(path), /checked-in/);
  assert.throws(() => assetRouting('not-an-id'), /runtime identity/);
});
