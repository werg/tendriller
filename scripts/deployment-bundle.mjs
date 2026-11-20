// Seal and restore the bytes consumed by Wrangler; never rebuild during promotion.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARCHIVE_METADATA } from './archive-metadata.mjs';
import { verifyReleaseArtifacts } from './release-composition.mjs';

const paths = ['dist/engine', 'dist/runtime', 'dist/sdk', 'dist/tools', 'server/public'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pack = (root, file, exclude = []) => execFileSync('tar', [...ARCHIVE_METADATA,
  ...exclude.map(path => '--exclude=' + path), '-czf', file, '-C', root, ...paths]);
function previousRuntimePaths(root, current) {
  const prefix = 'server/public/_tendril/runtime', directory = join(root, prefix);
  return existsSync(directory) ? readdirSync(directory).filter(name => /^[a-f0-9]{64}$/.test(name) && name !== current)
    .map(name => prefix + '/' + name) : [];
}
const json = path => JSON.parse(readFileSync(path, 'utf8'));

export function sealDeployment(root) {
  const manifest = json(join(root, 'dist/manifest.json'));
  verifyReleaseArtifacts(root, manifest);
  const file = 'tendriller-deployment.tgz';
  // Development may retain previous immutable runtimes. Deploy only this
  // qualified graph; older published runtimes are retained independently in R2.
  pack(root, join(root, 'dist', file), previousRuntimePaths(root, manifest.runtime));
  const bytes = readFileSync(join(root, 'dist', file));
  manifest.artifacts.push({ role: 'deployment', file, size: bytes.length, sha256: hash(bytes),
    url: `https://github.com/werg/tendriller/releases/download/source-${manifest.source_commit}/${file}`, type: 'application/gzip' });
  writeFileSync(join(root, 'dist/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(root, 'dist/SHA256SUMS'), manifest.artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(''));
  return manifest;
}

export function verifyDeploymentBundle(root, expectedHash) {
  const manifestBytes = readFileSync(join(root, 'dist/manifest.json'));
  if (hash(manifestBytes) !== expectedHash) throw Error('Deployment manifest SHA-256 mismatch.');
  const manifest = JSON.parse(manifestBytes);
  verifyReleaseArtifacts(root, manifest);
  const artifact = manifest.artifacts.find(item => item.role === 'deployment');
  if (!artifact || artifact.file !== 'tendriller-deployment.tgz') throw Error('Missing sealed deployment artifact.');
  return artifact;
}

export function restoreDeployment(root, expectedHash) {
  const artifact = verifyDeploymentBundle(root, expectedHash);
  // The verified archive was generated locally from these fixed roots. Refuse
  // links and any path outside them before extracting even authenticated bytes.
  const archive = join(root, 'dist', artifact.file);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (entries.some(path => path.split('/').includes('..') || !paths.some(prefix => path === prefix || path.startsWith(prefix + '/'))))
    throw Error('Deployment archive contains an unexpected path.');
  const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (listing.some(line => !['-', 'd'].includes(line[0]))) throw Error('Deployment archive contains a link or special file.');
  for (const path of paths) rmSync(join(root, path), { recursive: true, force: true });
  execFileSync('tar', ['-xzf', archive, '-C', root]);
}

export function verifyRestoredDeployment(root, expectedHash) {
  const artifact = verifyDeploymentBundle(root, expectedHash);
  const scratch = mkdtempSync(join(tmpdir(), 'tendriller-deployment-'));
  try {
    const file = join(scratch, 'deployment.tgz');
    pack(root, file);
    if (hash(readFileSync(file)) !== artifact.sha256) throw Error('Restored deployment bytes differ from the qualified bundle.');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  restoreDeployment(resolve(import.meta.dirname, '..'), process.env.TENDRILLER_EXPECTED_MANIFEST_SHA256);
}
