// Ordinary deployments may advertise only an already available exact release.
// Read-only public downloads: no API token, source fallback, upload or deployment.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE_DOWNLOAD_LIMITS, createReleaseDownloader, readPublishedManifest } from '../contract/release-verify.mjs';
import { verifyFirstAppProfiles } from './release-composition.mjs';

export { RELEASE_DOWNLOAD_LIMITS, readPublishedManifest };
const hash = value => createHash('sha256').update(value).digest('hex');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const componentRoles = ['sdk', 'runtime', 'engine', 'tools', 'authority', 'session', 'session-sql-browser', 'starter'];
const requiredRoles = [...componentRoles, 'composition', 'first-app', 'first-app-sql', 'core-provenance', 'tools-provenance', 'plugin'];

function releaseDownload(base, options = {}) {
  return createReleaseDownloader(base, options);
}

export async function verifyPublishedRelease(expected, { fetcher = globalThis.fetch, limits = RELEASE_DOWNLOAD_LIMITS, signal, onVerified } = {}) {
  if (!commit(expected.sourceCommit) || !sha256(expected.compositionId) || !sha256(expected.runtimeId) ||
      !sha256(expected.manifestSha256) || typeof expected.coreRelease !== 'string' || expected.coreRelease.length > 64 ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected.coreRelease))
    fail('release_expectation_invalid', 'Require the exact source, release, runtime, composition and manifest SHA-256 from the artifacts job.');
  const base = `https://github.com/werg/tendriller/releases/download/source-${expected.sourceCommit}`;
  const downloader = releaseDownload(base, { fetcher, limits, signal, onVerified });
  const { download } = downloader;
  function parse(bytes, file) {
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { fail('release_metadata_invalid', `Public release metadata ${file} is not valid JSON.`); }
  }
  const manifest = parse(await download('manifest.json', expected.manifestSha256, undefined, true), 'manifest.json');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    fail('release_metadata_invalid', 'The public release manifest must be an object.');
  if (manifest.format !== 'tendriller-core-release' || manifest.version !== expected.coreRelease ||
      manifest.source_commit !== expected.sourceCommit || !commit(manifest.source_tree) ||
      manifest.runtime !== expected.runtimeId || manifest.composition?.id !== expected.compositionId ||
      manifest.composition?.file !== 'composition.json' ||
      manifest.first_app?.file !== `tendriller-first-app-${expected.coreRelease}.tgz` ||
      manifest.first_app?.profile !== 'events')
    fail('release_identity_mismatch', 'The public release manifest does not identify the exact prepared source/release/runtime/composition.');
  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length > limits.artifacts ||
      artifacts.some(item => !item || typeof item !== 'object' || Array.isArray(item)) ||
      requiredRoles.some(role => artifacts.filter(item => item.role === role).length !== 1))
    fail('release_metadata_invalid', 'The public release must include every core, starter, companion and first-app artifact exactly once.');
  const files = new Set(), roles = new Set();
  let declaredBytes = 0;
  for (const item of artifacts) {
    if (typeof item.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(item.file) || files.has(item.file) ||
        typeof item.role !== 'string' || roles.has(item.role) || !sha256(item.sha256) ||
        !Number.isSafeInteger(item.size) || item.size < 1 || item.size > limits.artifactBytes || item.url !== `${base}/${item.file}`)
      fail('release_metadata_invalid', 'Public release artifact names, URLs, hashes and sizes must be unique, canonical and bounded.');
    declaredBytes += item.size; files.add(item.file); roles.add(item.role);
  }
  if (declaredBytes > limits.totalBytes) fail('release_size_limit', 'The public release exceeds the aggregate download bound.');
  const byRole = role => artifacts.find(item => item.role === role);
  if (byRole('composition').file !== 'composition.json' || byRole('first-app').file !== manifest.first_app.file)
    fail('release_metadata_invalid', 'The public release points to different composition or first-app files.');
  const compositionAsset = byRole('composition');
  const composition = parse(await download(compositionAsset.file, compositionAsset.sha256, compositionAsset.size, true), compositionAsset.file);
  if (!composition || typeof composition !== 'object' || Array.isArray(composition))
    fail('release_metadata_invalid', 'The public release composition must be an object.');
  const { id, ...body } = composition;
  if (id !== expected.compositionId || hash(JSON.stringify(body)) !== id ||
      composition.format !== 'tendriller-release-composition-v1' || composition.version !== expected.coreRelease ||
      composition.contract !== manifest.contract || composition.runtime !== expected.runtimeId ||
      composition.core?.source !== expected.sourceCommit || composition.core?.sourceTree !== manifest.source_tree || composition.core?.dirty !== false ||
      !Array.isArray(composition.components) || composition.components.length !== componentRoles.length ||
      composition.components.some(item => !item || typeof item !== 'object' || Array.isArray(item)) ||
      componentRoles.some(role => composition.components.filter(item => item.role === role).length !== 1))
    fail('release_identity_mismatch', 'The published composition does not match the complete prepared release identity.');
  try { verifyFirstAppProfiles(composition, manifest); }
  catch (error) { fail('release_identity_mismatch', error.message); }
  for (const item of composition.components) {
    const artifact = byRole(item.role);
    if (artifact?.file !== item.file || artifact.sha256 !== item.sha256 || artifact.size !== item.size)
      fail('release_identity_mismatch', 'The published composition and release manifest bind different component bytes.');
  }
  // Verify every referenced public asset, including the kit and all companion
  // packages. Merely publishing metadata cannot pass an incomplete release.
  for (const item of artifacts) if (item !== compositionAsset) await download(item.file, item.sha256, item.size);
  return { sourceCommit: expected.sourceCommit, coreRelease: expected.coreRelease, runtimeId: expected.runtimeId,
    compositionId: expected.compositionId, artifacts: artifacts.length, downloadedBytes: downloader.downloadedBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const expected = Object.fromEntries(Object.entries({ sourceCommit: 'SOURCE_COMMIT', compositionId: 'COMPOSITION_ID',
    coreRelease: 'CORE_RELEASE', runtimeId: 'RUNTIME_ID', manifestSha256: 'MANIFEST_SHA256' })
    .map(([key, name]) => [key, process.env[`TENDRILLER_EXPECTED_${name}`]]));
  const result = await verifyPublishedRelease(expected);
  console.log(`Verified ${result.artifacts} public release assets for ${result.coreRelease}; source ${result.sourceCommit}; composition ${result.compositionId}`);
}
