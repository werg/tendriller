// Check local deployment bytes against the independently prepared CI artifacts.
// This script has no network access and never deploys anything.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packedArchive, sourceIdentity } from './release-composition.mjs';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function verifyDeploymentArtifacts(root, expected) {
  if (!/^[a-f0-9]{40}$/.test(expected.sourceCommit ?? '') ||
      ['compositionId', 'runtimeId', 'engineSha256', 'starterSha256'].some(key => !/^[a-f0-9]{64}$/.test(expected[key] ?? '')) ||
      typeof expected.coreRelease !== 'string' || !expected.coreRelease)
    throw Error('Deployment requires exact source, composition, release, runtime, engine and starter identities from the artifacts job.');
  const identity = sourceIdentity(root), proof = json(join(root, 'dist/provenance.json'));
  if (identity.dirty || proof.dirty !== false || identity.source !== expected.sourceCommit ||
      proof.source !== identity.source || proof.sourceTree !== identity.sourceTree)
    throw Error('Deployment source/provenance must match the clean artifact-job checkpoint.');
  if (json(join(root, 'package.json')).version !== expected.coreRelease)
    throw Error('Deployment package version does not match the artifact-job release.');
  const runtime = verifyRuntimeManifest(json(join(root, 'dist/runtime/assets/manifest.json')));
  const servedRuntime = join(root, 'server/public/_tendril/runtime', expected.runtimeId);
  if (runtime.id !== expected.runtimeId || runtime.version !== expected.coreRelease ||
      json(join(root, 'server/src/runtime-release.json')).id !== expected.runtimeId ||
      verifyRuntimeManifest(json(join(servedRuntime, 'manifest.json'))).id !== expected.runtimeId)
    throw Error('Deployment runtime does not match the artifact-job runtime.');
  for (const asset of runtime.assets) {
    if (digest(join(servedRuntime, asset.path)) !== asset.sha256)
      throw Error(`Deployment runtime asset changed: ${asset.path}`);
  }
  const file = `tendriller-engine-${expected.coreRelease}.tgz`;
  if (proof.artifacts?.find(item => item.file === file)?.sha256 !== expected.engineSha256 ||
      digest(join(root, 'dist', file)) !== expected.engineSha256)
    throw Error('Deployment engine bytes do not match the artifact-job composition.');
  // Wrangler consumes the extracted Worker, not its archive. Anchor these
  // local files to the provenance inside the already verified public archive.
  const engine = packedArchive(join(root, 'dist', file)).json('provenance.json');
  if (engine.dirty !== false || engine.source !== expected.sourceCommit || engine.sourceTree !== identity.sourceTree ||
      !/^[a-f0-9]{64}$/.test(engine.files?.['worker.mjs'] ?? ''))
    throw Error('Packed deployment engine lacks matching source and Worker provenance.');
  for (const [path, hash] of Object.entries(engine.files))
    if (digest(join(root, 'dist/engine', path)) !== hash)
      throw Error(`Deployment engine file changed after packaging: ${path}`);
  if (digest(join(root, 'server/public/downloads/tendriller-first-app.tgz')) !== expected.starterSha256)
    throw Error('Deployment starter bytes do not match the artifact-job composition.');
  return { sourceCommit: expected.sourceCommit, compositionId: expected.compositionId,
    coreRelease: expected.coreRelease, runtimeId: expected.runtimeId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const expected = Object.fromEntries(Object.entries({ sourceCommit: 'SOURCE_COMMIT', compositionId: 'COMPOSITION_ID',
    coreRelease: 'CORE_RELEASE', runtimeId: 'RUNTIME_ID', engineSha256: 'ENGINE_SHA256', starterSha256: 'STARTER_SHA256' })
    .map(([key, name]) => [key, process.env[`TENDRILLER_EXPECTED_${name}`]]));
  const result = verifyDeploymentArtifacts(resolve(import.meta.dirname, '..'), expected);
  console.log(`Matched deployment artifacts to source ${result.sourceCommit} and composition ${result.compositionId}`);
}
