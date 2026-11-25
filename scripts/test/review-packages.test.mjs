import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewInstallArguments, verifyInstalledReviewPackages } from '../review/packages.mjs';

const composition = { packagePaths: { sdk: '/dist/sdk.tgz', authority: '/dist/authority.tgz', session: '/dist/session.tgz' },
  session: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40) } };

test('the fixture installs exactly the composition SDK, authority and session archives, with no registry name or optional fallback', () => {
  assert.deepEqual(reviewInstallArguments(composition), ['install', '--ignore-scripts', '--no-audit', '--no-fund', '/dist/sdk.tgz', '/dist/authority.tgz', '/dist/session.tgz']);
  for (const role of ['sdk', 'authority', 'session']) {
    const missing = structuredClone(composition); delete missing.packagePaths[role];
    assert.throws(() => reviewInstallArguments(missing), new RegExp('must name its ' + role + ' archive'));
    const registry = structuredClone(composition); registry.packagePaths[role] = '@chronolog/' + role + '@latest';
    assert.throws(() => reviewInstallArguments(registry), /archive/);
  }
  assert.throws(() => reviewInstallArguments({ ...composition, packagePaths: undefined }), /archive/);
});

function installed(t, overrides = {}) {
  const project = mkdtempSync(join(tmpdir(), 'review-installed-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  for (const name of ['authority', 'peer-session']) {
    const directory = join(project, 'node_modules/@chronolog', name); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'provenance.json'), JSON.stringify({ repository: 'werg/chronolog-db', dirty: false,
      source: composition.session.sourceCommit, sourceTree: composition.session.sourceTree, ...(overrides[name] ?? {}) }));
  }
  return project;
}

test('installed authority and session must both come from the qualified clean Chronolog checkpoint', t => {
  assert.deepEqual(verifyInstalledReviewPackages(installed(t), composition), {
    authority: { source: 'c'.repeat(40), sourceTree: 'd'.repeat(40) }, 'peer-session': { source: 'c'.repeat(40), sourceTree: 'd'.repeat(40) } });
  assert.throws(() => verifyInstalledReviewPackages(installed(t, { authority: { source: 'e'.repeat(40) } }), composition), /authority source differs/);
  assert.throws(() => verifyInstalledReviewPackages(installed(t, { 'peer-session': { sourceTree: 'e'.repeat(40) } }), composition), /peer-session source tree differs/);
  assert.throws(() => verifyInstalledReviewPackages(installed(t, { authority: { dirty: true } }), composition), /authority must come from a clean checkpoint/);
  assert.throws(() => verifyInstalledReviewPackages(installed(t, { authority: { repository: 'other/repo' } }), composition), /Chronolog repository/);
  const missing = installed(t); rmSync(join(missing, 'node_modules/@chronolog/authority'), { recursive: true });
  assert.throws(() => verifyInstalledReviewPackages(missing, composition), /ENOENT/, 'a missing authority package is not tolerated');
});
