import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CHRONOLOG_SOURCE, installedSessionProvenance } from '../deploy/common.mjs';
const run = promisify(execFile);
const valid = { format: 'chronolog-peer-session-package/v1', repository: 'werg/chronolog-db', source: 'a'.repeat(40), sourceTree: 'b'.repeat(40), dirty: false };
test('deployment source follows the installed public package in repository and portable-release layouts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tendriller-deploy-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [layout, source] of [['core', 'c'.repeat(40)], ['portable', 'd'.repeat(40)]]) {
    const base = join(root, layout), integration = join(base, 'integrations/chatgpt');
    const packageRoot = join(layout === 'core' ? base : integration, 'node_modules/@chronolog/peer-session');
    const common = join(integration, 'deploy/common.mjs');
    await mkdir(join(integration, 'deploy'), { recursive: true }); await mkdir(packageRoot, { recursive: true });
    await copyFile(new URL('../deploy/common.mjs', import.meta.url), common);
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@chronolog/peer-session', type: 'module', exports: './index.mjs' }));
    await writeFile(join(packageRoot, 'index.mjs'), '// public entry\n');
    await writeFile(join(packageRoot, 'provenance.json'), JSON.stringify({ ...valid, source }));
    const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', `const m = await import(${JSON.stringify(pathToFileURL(common).href)}); console.log(m.CHRONOLOG_SOURCE);`], { timeout: 5000 });
    assert.equal(stdout.trim(), source);
  }
  const actual = await installedSessionProvenance(); assert.equal(CHRONOLOG_SOURCE, actual.source); assert.equal(actual.dirty, false);
});
test('derived session identity rejects dirty, missing or malformed public provenance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tendriller-deploy-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@chronolog/peer-session' }));
  const resolveSession = () => pathToFileURL(join(root, 'index.mjs')).href;
  for (const patch of [{ dirty: true }, { source: 'old-short-ref' }, { sourceTree: null }, { repository: 'other' }, { format: 'other' }]) {
    await writeFile(join(root, 'provenance.json'), JSON.stringify({ ...valid, ...patch }));
    await assert.rejects(installedSessionProvenance(resolveSession), { code: 'DEPLOYMENT_SESSION_PROVENANCE_INVALID' });
  }
  await rm(join(root, 'provenance.json'));
  await assert.rejects(installedSessionProvenance(resolveSession), { code: 'DEPLOYMENT_SESSION_PROVENANCE_INVALID' });
  await assert.rejects(installedSessionProvenance(() => 'https://untrusted.invalid/index.mjs'), { code: 'DEPLOYMENT_SESSION_PROVENANCE_INVALID' });
});
