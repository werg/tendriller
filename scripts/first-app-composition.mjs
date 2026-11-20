import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { packedArchive } from './release-composition.mjs';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const one = (items, predicate, label) => {
  assert(Array.isArray(items), `The exact first-app composition requires ${label} records.`);
  const matches = items.filter(predicate);
  assert.equal(matches.length, 1, `The exact first-app composition requires one ${label}.`);
  return matches[0];
};

/** Bind the actual isolated host and all local core packages before starting it. */
export async function verifyFirstAppComposition({ release, composition, coreProof, toolsProof, archives, version, contract }) {
  assert.equal(release.format, 'tendriller-core-release');
  assert.equal(composition.format, 'tendriller-release-composition-v1');
  assert.match(release.source_commit, /^[a-f0-9]{40}$/);
  assert.match(release.source_tree, /^[a-f0-9]{40}$/);
  const { id, ...identity } = composition;
  assert.equal(digest(JSON.stringify(identity)), id, 'Composition identity must bind all package inputs.');
  assert.equal(id, release.composition.id, 'The first-app kit must match its selected release.');
  assert.equal(release.version, version, 'Release version does not match the checkout.');
  assert.equal(composition.version, version, 'First-app version does not match the checkout.');
  assert.equal(release.contract, contract, 'Release contract does not match the checkout.');
  assert.equal(composition.contract, contract, 'First-app contract does not match the checkout.');
  assert.equal(composition.runtime, release.runtime, 'Release and first-app runtime identities disagree.');
  assert.equal(toolsProof.runtime, composition.runtime, 'Tools were built against another runtime.');
  assert.equal(toolsProof.version, version);
  assert.equal(toolsProof.contract, contract);
  for (const source of [composition.core, coreProof,
    { source: toolsProof.source_commit, sourceTree: toolsProof.source_tree, dirty: toolsProof.dirty }]) {
    assert.equal(source.dirty, false, 'Exact first-app qualification requires clean source identities.');
    assert.equal(source.source, release.source_commit, 'First-app package sources disagree.');
    assert.equal(source.sourceTree, release.source_tree, 'First-app package source trees disagree.');
  }
  for (const role of ['sdk', 'runtime', 'engine', 'tools']) {
    const component = one(composition.components, item => item.role === role, `${role} component`);
    const record = one(release.artifacts, item => item.role === role, `${role} release artifact`);
    const file = basename(archives[role]);
    assert.equal(component.file, file, `The ${role} archive must be the one named by the composition.`);
    for (const key of ['file', 'sha256', 'size'])
      assert.equal(component[key], record[key], `The release and first-app ${role} ${key} disagree.`);
    const bytes = await readFile(archives[role]);
    assert.equal(digest(bytes), component.sha256, `The actual ${role} archive does not match the first-app composition.`);
    assert.equal(bytes.byteLength, component.size, `The actual ${role} archive size does not match the first-app composition.`);
    const provenance = one((role === 'tools' ? toolsProof : coreProof).artifacts, item => item.file === file, `${role} provenance record`);
    assert.equal(provenance.sha256, component.sha256, `The ${role} provenance does not match the first-app composition.`);
  }
  const runtime = verifyRuntimeManifest(packedArchive(archives.runtime).json('assets/manifest.json'));
  assert.equal(runtime.id, composition.runtime, 'The packed runtime does not match the first-app runtime identity.');
  assert.equal(runtime.version, version);
  assert.equal(runtime.contract, contract);
}
