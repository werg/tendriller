// Scheduled/manual qualification consumes the source-tagged public graph too.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sourceIdentity } from './release-composition.mjs';
import { verifyPublishedRelease, RELEASE_DOWNLOAD_LIMITS } from './check-published-release.mjs';
import { restoreDeployment } from './deployment-bundle.mjs';

const root = resolve(import.meta.dirname, '..'), source = sourceIdentity(root);
assert.equal(source.dirty, false, 'Download qualification requires a clean checkpoint');
const base = `https://github.com/werg/tendriller/releases/download/source-${source.source}`;
const response = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(30_000), credentials: 'omit' });
assert.equal(response.status, 200, 'Publish the qualified source graph before live qualification');
assert(['github.com', 'release-assets.githubusercontent.com'].includes(new URL(response.url).hostname));
const chunks = [];
let size = 0;
for await (const chunk of response.body) {
  size += chunk.byteLength;
  if (size > RELEASE_DOWNLOAD_LIMITS.metadataBytes) throw Error('Release manifest exceeds metadata limit');
  chunks.push(Buffer.from(chunk));
}
const bytes = Buffer.concat(chunks), manifest = JSON.parse(bytes);
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
const runtime = JSON.parse(readFileSync(join(root, 'server/src/runtime-release.json')));
const expected = { sourceCommit: source.source, coreRelease: pkg.version, runtimeId: runtime.id,
  compositionId: manifest.composition?.id, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
mkdirSync(join(root, 'dist'), { recursive: true });
await verifyPublishedRelease(expected, { onVerified: (file, content) => writeFileSync(join(root, 'dist', file), content) });
restoreDeployment(root, expected.manifestSha256);
