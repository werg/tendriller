import assert from 'node:assert/strict';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function readArtifact(path) {
  assert.ok((await lstat(path)).isFile(), 'Release artifact must be a regular file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.ok((await file.stat()).isFile(), 'Release artifact must be a regular file');
    return await file.readFile();
  } finally { await file.close(); }
}
export async function selectedProductVersion(root) {
  const manifest = JSON.parse(await readArtifact(resolve(root, 'dist/manifest.json')));
  assert.match(manifest.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/);
  return manifest.version;
}
export async function releaseAnchor(root) {
  const bytes = await readArtifact(resolve(root, 'dist/manifest.json'));
  const manifest = JSON.parse(bytes);
  assert.match(manifest.source_commit, /^[a-f0-9]{40}$/);
  assert.match(manifest.runtime, /^[a-f0-9]{64}$/);
  assert.match(manifest.composition.id, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0);
  const artifacts = [];
  const seen = new Set();
  for (const item of manifest.artifacts) {
    assert.equal(basename(item.file), item.file, 'Archive must remain within dist');
    assert.ok(!seen.has(item.file), 'Duplicate artifact'); seen.add(item.file);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    const content = await readArtifact(resolve(root, 'dist', item.file));
    assert.equal(content.length, item.size, 'Artifact size changed');
    assert.equal(sha256(content), item.sha256, 'Artifact bytes changed');
    artifacts.push({ file: item.file, sha256: item.sha256, size: item.size });
  }
  return { source: manifest.source_commit, runtime: manifest.runtime, composition: manifest.composition.id,
    manifestSha256: sha256(bytes), artifacts, kit: manifest.first_app?.file };
}
