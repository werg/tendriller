import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeWorkspace, upgradeWorkspace, verifyWorkspaceComposition } from '../lib/workspace.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function makeFakeTarball(dir, filename, pkgJson, extraFiles = {}) {
  const stage = await mkdtemp(join(tmpdir(), 'tgz-stage-'));
  try {
    const pkgDir = join(stage, 'package');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');
    for (const [name, content] of Object.entries(extraFiles)) {
      await writeFile(join(pkgDir, name), content);
    }
    const out = join(dir, filename);
    execFileSync('tar', ['-czf', out, '-C', stage, 'package']);
    const bytes = await readFile(out);
    return { file: filename, sha256: sha256(bytes), size: bytes.length };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function buildFakeKit(dir, { version = '0.3.0-rc.17', sourceCommit, runtimeId, marker }) {
  await mkdir(join(dir, 'packages'), { recursive: true });
  const sdk = await makeFakeTarball(join(dir, 'packages'), `tendriller-sdk-${version}.tgz`, {
    name: '@tendriller/core',
    version,
    type: 'module',
    tendriller: { contract: 3, sourceCommit },
  }, { 'index.mjs': `export const marker = ${JSON.stringify(marker)};\n` });
  const tools = await makeFakeTarball(join(dir, 'packages'), `tendriller-tools-${version}.tgz`, {
    name: '@tendriller/tools',
    version,
    type: 'module',
    tendriller: { contract: 3, runtime: runtimeId, sourceCommit },
  }, { 'index.mjs': `export const marker = ${JSON.stringify(marker)};\n` });

  const body = {
    format: 'tendriller-release-composition-v1',
    version,
    contract: 3,
    core: { repository: 'werg/tendriller', source: sourceCommit, sourceTree: sourceCommit, dirty: false },
    runtime: runtimeId,
    profiles: { events: { session: 'tools', packages: ['sdk', 'tools'] } },
    components: [
      { role: 'sdk', ...sdk },
      { role: 'tools', ...tools },
    ],
  };
  const composition = { ...body, id: sha256(Buffer.from(JSON.stringify(body))) };
  await writeFile(join(dir, 'composition.json'), JSON.stringify(composition, null, 2) + '\n');
  await writeFile(join(dir, 'first-app-profile.json'), JSON.stringify({ profile: 'events', packages: ['sdk', 'tools'] }, null, 2) + '\n');
  return composition;
}

test('upgradeWorkspace catches stale same-version lockfiles, cleanly regenerates package-lock.json, and preserves private state', async t => {
  const work = await mkdtemp(join(tmpdir(), 'ws-upgrade-'));
  const kitOldDir = await mkdtemp(join(tmpdir(), 'kit-old-'));
  const kitNewDir = await mkdtemp(join(tmpdir(), 'kit-new-'));
  t.after(async () => {
    await rm(work, { recursive: true, force: true });
    await rm(kitOldDir, { recursive: true, force: true });
    await rm(kitNewDir, { recursive: true, force: true });
  });

  const oldCommit = '1'.repeat(40);
  const newCommit = '2'.repeat(40);
  const oldRuntime = 'a'.repeat(64);
  const newRuntime = 'b'.repeat(64);

  await buildFakeKit(kitOldDir, { version: '0.3.0-rc.17', sourceCommit: oldCommit, runtimeId: oldRuntime, marker: 'old-release' });
  const newComp = await buildFakeKit(kitNewDir, { version: '0.3.0-rc.17', sourceCommit: newCommit, runtimeId: newRuntime, marker: 'new-release' });

  // Private workspace state and authored pages must survive untouched.
  await mkdir(join(work, '.tendriller/agent'), { recursive: true });
  await writeFile(join(work, '.tendriller/agent/credential.json'), '{"secret":"keep"}');
  await mkdir(join(work, 'pages/notes'), { recursive: true });
  await writeFile(join(work, 'pages/notes/domain.mjs'), 'export const keep = true;\n');

  // Initial install from old kit (version 0.3.0-rc.17).
  const first = await upgradeWorkspace(work, { kit: kitOldDir });
  assert.equal(first.upgraded, true);
  assert.equal(first.sourceCommit, oldCommit);
  assert.match(await readFile(join(work, 'node_modules/@tendriller/tools/index.mjs'), 'utf8'), /old-release/);

  // Reproduce #143: overwrite packages/ and composition.json with the NEW same-version kit WITHOUT regenerating package-lock.json.
  await writeFile(join(work, 'composition.json'), await readFile(join(kitNewDir, 'composition.json')));
  await writeFile(join(work, 'packages/tendriller-sdk-0.3.0-rc.17.tgz'), await readFile(join(kitNewDir, 'packages/tendriller-sdk-0.3.0-rc.17.tgz')));
  await writeFile(join(work, 'packages/tendriller-tools-0.3.0-rc.17.tgz'), await readFile(join(kitNewDir, 'packages/tendriller-tools-0.3.0-rc.17.tgz')));

  const staleCheck = await verifyWorkspaceComposition(work, { requireInstalled: true });
  assert.equal(staleCheck.ok, false, 'verifyWorkspaceComposition must catch stale lockfile & installed packages for same-version archives');
  assert.ok(staleCheck.issues.some(i => i.kind === 'lockfile_archive_mismatch'));
  assert.ok(staleCheck.issues.some(i => i.kind === 'installed_package_mismatch'));

  // Run verified upgrade -> cleanly regenerates package-lock.json in a fresh staging dir, runs npm ci, and verifies!
  const upgraded = await upgradeWorkspace(work, { kit: kitNewDir });
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.compositionId, newComp.id);
  assert.equal(upgraded.sourceCommit, newCommit);
  assert.match(await readFile(join(work, 'node_modules/@tendriller/tools/index.mjs'), 'utf8'), /new-release/);

  const cleanCheck = await verifyWorkspaceComposition(work, { requireInstalled: true });
  assert.equal(cleanCheck.ok, true, `expected verified workspace, got: ${JSON.stringify(cleanCheck.issues)}`);
  assert.equal(await readFile(join(work, '.tendriller/agent/credential.json'), 'utf8'), '{"secret":"keep"}');
  assert.equal(await readFile(join(work, 'pages/notes/domain.mjs'), 'utf8'), 'export const keep = true;\n');
});

test('describeWorkspace compares immutable compositionId even when semver core_release is identical (0.3.0-rc.17)', async t => {
  const work = await mkdtemp(join(tmpdir(), 'ws-comp-catchup-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const oldCommit = '3'.repeat(40);
  const hostCommit = '4'.repeat(40);
  const oldComp = await buildFakeKit(work, { version: '0.3.0-rc.17', sourceCommit: oldCommit, runtimeId: 'c'.repeat(64), marker: 'old' });
  await upgradeWorkspace(work, {});

  const fakeWorkspace = {
    root: work,
    paths: { owner: join(work, '.tendriller/agent/owner'), broadcasts: join(work, '.tendriller/agent/broadcasts.json') },
    config: { service: 'https://service.example', agent: { id: 'ag_1', handle: 'atlas' }, kit: null },
    pages: async () => [],
    client: async () => ({
      self: async () => ({ id: 'ag_1', handle: 'atlas' }),
      pages: { async *all() {} },
      broadcastKeys: async () => ({ keys: [] }),
      broadcasts: async () => ({ issuer: 'https://service.example', latest_seq: 0, verified: [], rejected: [] }),
    }),
  };

  // Stub global fetch for describeService, describeReadiness, and fetchChangelog.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.endsWith('/api/service')) return new Response(JSON.stringify({ contract: 3, core_release: '0.3.0-rc.17', limits: {} }), { status: 200 });
    if (u.endsWith('/api/readiness')) {
      return new Response(JSON.stringify({
        schemaVersion: 1,
        serviceOrigin: 'https://service.example',
        mode: 'open',
        environment: { id: 'https://service.example', label: 'Test', kind: 'deployment' },
        creation: { available: true, code: null, message: 'Open', nextAction: 'Proceed' },
        writes: { available: true, code: null, message: 'Open', nextAction: 'Proceed' },
        checkedAt: new Date().toISOString(),
        readinessUrl: 'https://service.example/api/readiness',
        statusUrl: 'https://service.example/status',
        build: { coreRelease: '0.3.0-rc.17', sourceCommit: hostCommit, compositionId: 'f'.repeat(64), runtimeId: 'd'.repeat(64) },
      }), { status: 200 });
    }
    if (u.includes('/api/changelog')) return new Response(JSON.stringify({ issuer: 'https://service.example', entries: [] }), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  t.after(() => { globalThis.fetch = origFetch; });

  const status = await describeWorkspace(fakeWorkspace, { remote: true });
  assert.equal(status.composition.id, oldComp.id);
  assert.equal(status.composition.verified, true);
  assert.ok(status.catchup, 'must flag catchup when immutable compositionId differs despite same 0.3.0-rc.17 version');
  assert.ok(status.catchup.reasons.includes('composition_behind_host'));
  assert.equal(status.catchup.installedCompositionId, oldComp.id);
  assert.equal(status.catchup.hostCompositionId, 'f'.repeat(64));
  assert.match(status.catchup.nextAction, /tendril workspace upgrade/);
});
