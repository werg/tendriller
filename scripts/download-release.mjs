// Scheduled/manual qualification consumes the source-tagged public graph too.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sourceIdentity } from './release-composition.mjs';
import { verifyPublishedRelease, readPublishedManifest } from './check-published-release.mjs';
import { restoreDeployment } from './deployment-bundle.mjs';

const root = resolve(import.meta.dirname, '..'), source = sourceIdentity(root);
assert.equal(source.dirty, false, 'Download qualification requires a clean checkpoint');
const bytes = await readPublishedManifest(source.source), manifest = JSON.parse(bytes);
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
// The runtime ID is a build output; the published manifest for this exact source commit names it.
const expected = { sourceCommit: source.source, coreRelease: pkg.version, runtimeId: manifest.runtime,
  compositionId: manifest.composition?.id, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
mkdirSync(join(root, 'dist'), { recursive: true });
await verifyPublishedRelease(expected, { onVerified: (file, content) => writeFileSync(join(root, 'dist', file), content) });
restoreDeployment(root, expected.manifestSha256);
