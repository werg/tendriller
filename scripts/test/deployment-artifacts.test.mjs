import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { verifyDeploymentArtifacts } from '../check-deployment-artifacts.mjs';
import { runtimeManifest } from '../runtime-manifest.mjs';
import { sourceIdentity } from '../release-composition.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const scratch = resolve(import.meta.dirname, '../../.build'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'deployment-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, data) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), typeof data === 'string' ? data : JSON.stringify(data)); };
  const runtime = runtimeManifest({ version: '1.2.3', contract: 3,
    assets: [{ path: 'kernel.mjs', sha256: hash('runtime'), size: 7 }], resources: [] });
  put('.gitignore', 'dist/\nserver/public/\n');
  put('package.json', { version: '1.2.3' });
  put('server/src/runtime-release.json', { id: runtime.id });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Deployment test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Source fixture'], { cwd: root });
  const identity = sourceIdentity(root), engineSha256 = hash('engine'), starterSha256 = hash('starter');
  put('dist/provenance.json', { ...identity, artifacts: [{ file: 'tendriller-engine-1.2.3.tgz', sha256: engineSha256 }] });
  put('dist/tendriller-engine-1.2.3.tgz', 'engine');
  put('dist/runtime/assets/manifest.json', runtime);
  put(`server/public/_tendril/runtime/${runtime.id}/manifest.json`, runtime);
  put(`server/public/_tendril/runtime/${runtime.id}/kernel.mjs`, 'runtime');
  put('server/public/downloads/tendriller-first-app.tgz', 'starter');
  const expected = { sourceCommit: identity.source, compositionId: 'c'.repeat(64), coreRelease: '1.2.3',
    runtimeId: runtime.id, engineSha256, starterSha256 };
  return { root, put, expected, check: () => verifyDeploymentArtifacts(root, expected) };
}

test('predeploy check binds a clean checkout to the prepared engine, runtime and starter bytes', t => {
  const f = fixture(t);
  assert.equal(f.check().compositionId, f.expected.compositionId);
  f.put('dist/tendriller-engine-1.2.3.tgz', 'other engine');
  assert.throws(f.check, /engine bytes do not match/);
});

test('predeploy check rejects changed served source or runtime assets', t => {
  const f = fixture(t);
  f.put('server/public/downloads/tendriller-first-app.tgz', 'other starter');
  assert.throws(f.check, /starter bytes do not match/);
  f.put('server/public/downloads/tendriller-first-app.tgz', 'starter');
  f.put(`server/public/_tendril/runtime/${f.expected.runtimeId}/kernel.mjs`, 'other runtime');
  assert.throws(f.check, /runtime asset changed/);
});

test('predeploy check rejects missing identity, different source and dirty checkout', t => {
  const f = fixture(t);
  assert.throws(() => verifyDeploymentArtifacts(f.root, { ...f.expected, compositionId: '' }), /requires exact source/);
  assert.throws(() => verifyDeploymentArtifacts(f.root, { ...f.expected, sourceCommit: 'd'.repeat(40) }), /clean artifact-job checkpoint/);
  f.put('uncommitted.txt', 'local edit');
  assert.throws(f.check, /clean artifact-job checkpoint/);
});
