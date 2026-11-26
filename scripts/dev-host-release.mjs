// Run published bytes in a separate local directory, without rebuilding a release.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { unpackTarGz } from '../contract/archive.mjs';
import { extractVerifiedTarGz, writeVerifiedFileAtomic } from '../contract/release-verify.mjs';
import { readPublishedManifest, verifyPublishedRelease } from './check-published-release.mjs';
import { isDeploymentPath } from './deployment-bundle.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** An optional artifact directory contains the same manifest and complete release assets. */
export async function prepareDevHostRelease({ release, directory, artifacts, manifestSha256, fetcher = globalThis.fetch, signal }) {
  if (!/^[a-f0-9]{40}$/.test(release ?? '')) throw Error('--release requires a full 40-character source commit SHA.');
  const base = `https://github.com/werg/tendriller/releases/download/source-${release}/`;
  const source = artifacts ? async input => {
    const url = String(input), name = url.slice(base.length);
    if (!url.startsWith(base) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw Error('Invalid local release asset request.');
    try { return new Response(await readFile(join(resolve(artifacts), name))); }
    catch (error) { if (error.code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
  } : fetcher;
  const bytes = await readPublishedManifest(release, { fetcher: source, signal });
  const hash = digest(bytes);
  if (manifestSha256 && hash !== manifestSha256) throw Error('This state directory belongs to a different release manifest. Use a new --state directory.');
  let manifest;
  try { manifest = JSON.parse(bytes); }
  catch { throw Error('The selected release manifest is not valid JSON. No local host was started.'); }
  const expected = { sourceCommit: release, coreRelease: manifest.version, runtimeId: manifest.runtime,
    compositionId: manifest.composition?.id, manifestSha256: hash };
  const contents = new Map();
  await verifyPublishedRelease(expected, { fetcher: source, signal, onVerified: (name, content) => {
    contents.set(name, content);
    writeVerifiedFileAtomic(join(directory, 'downloads', name), content);
  } });
  const deployment = manifest.artifacts.find(item => item.role === 'deployment');
  if (deployment?.file !== 'tendriller-deployment.tgz')
    throw Error('This release has no sealed deployment. Select a source release that includes tendriller-deployment.tgz.');
  const archive = contents.get(deployment.file);
  const files = unpackTarGz(archive);
  if ([...files.keys()].some(path => !isDeploymentPath(path)))
    throw Error('The deployment contains a path outside the public release graph.');
  const proof = JSON.parse(Buffer.from(files.get('dist/engine/provenance.json') ?? []).toString('utf8'));
  if (proof.dirty !== false || proof.source !== release || proof.sourceTree !== manifest.source_tree || proof.storageSchemaRevision !== 14)
    throw Error('Local hosting requires a clean matching engine with storage schema 14. Use a compatible dev-host version for other schemas.');
  for (const [path, sha256] of Object.entries(proof.files ?? {})) {
    const content = files.get('dist/engine/' + path);
    if (!content || digest(content) !== sha256) throw Error(`The packed engine failed verification: ${path}`);
  }
  for (const path of ['dist/engine/worker.mjs', 'dist/engine/testing-ratelimits.json', 'dist/engine/migrations/0001_accounts.sql', 'dist/engine/migrations/0002_agents.sql', 'dist/engine/migrations/0003_broadcasts.sql', 'dist/engine/migrations/0004_account_limits.sql', 'dist/engine/migrations/0005_billing_and_tiers.sql', 'dist/engine/migrations/0006_oauth_connections_and_groups.sql', 'server/public/llms.txt'])
    if (!files.has(path)) throw Error(`The sealed deployment is missing ${path}.`);
  // Only our dedicated release child is replaced. D1, R2, device and browser state live elsewhere.
  const destination = join(resolve(directory), 'release');
  await mkdir(resolve(directory), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  extractVerifiedTarGz(archive, destination, { expectedSha256: deployment.sha256 });
  const kit = manifest.artifacts.find(item => item.role === 'first-app');
  const kitDirectory = join(destination, 'first-app');
  extractVerifiedTarGz(contents.get(kit.file), kitDirectory, { expectedSha256: kit.sha256 });
  return { manifest, manifestSha256: hash, directory: destination, kitDirectory };
}
