import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { describeReadiness, describeService, requireCreationReady, requireService, requireServiceOrigin } from '../../contract/client.mjs';
import { CORE_RELEASE, CONTRACT_VERSION } from '../../contract/index.mjs';
import { sourceIdentity } from '../release-composition.mjs';
import { readReviewAccess } from './access.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = /^[a-f0-9]{40}$/, digest = /^[a-f0-9]{64}$/;

/** Cheap source/readiness gate for CI before installing or building packages. */
export function reviewSource(root, { source = sourceIdentity(root) } = {}) {
  const pkg = json(resolve(root, 'package.json'));
  assert.equal(source.dirty, false, 'Live qualification needs a clean source checkpoint');
  assert(sha.test(source.source) && sha.test(source.sourceTree), 'Exact source identity is required');
  assert.equal(pkg.version, CORE_RELEASE, 'Source release differs from the public contract');
  // The exact source commit determines the runtime; its ID is a build output, not checked in.
  return { build: { coreRelease: pkg.version, sourceCommit: source.source },
    contract: CONTRACT_VERSION, sourceTree: source.sourceTree };
}

/** Qualify the actual release bytes, including the currently pinned session. */
export function reviewComposition(root, { source = sourceIdentity(root) } = {}) {
  const pkg = json(resolve(root, 'package.json'));
  const manifest = json(resolve(root, 'dist/manifest.json'));
  const composition = json(resolve(root, 'dist/composition.json'));
  const { id, ...body } = composition;
  assert.equal(source.dirty, false, 'Live qualification needs a clean source checkpoint');
  assert(sha.test(source.source) && sha.test(source.sourceTree), 'Exact source identity is required');
  assert.equal(manifest.format, 'tendriller-core-release');
  assert.equal(composition.format, 'tendriller-release-composition-v1');
  assert.equal(id, hash(JSON.stringify(body)), 'Composition digest mismatch');
  assert.equal(manifest.composition?.id, id, 'Release composition mismatch');
  assert.equal(manifest.composition?.file, 'composition.json');
  assert.equal(manifest.version, pkg.version, 'Release version differs from the checkout');
  assert.equal(composition.version, manifest.version);
  assert.equal(composition.contract, manifest.contract);
  assert.equal(composition.core?.repository, 'werg/tendriller');
  assert.equal(composition.core?.dirty, false);
  assert.equal(composition.core?.source, source.source, 'Rebuild artifacts from this source checkpoint');
  assert.equal(composition.core?.sourceTree, source.sourceTree);
  assert.equal(manifest.source_commit, source.source);
  assert.equal(manifest.source_tree, source.sourceTree);
  assert.equal(manifest.runtime, composition.runtime);
  assert(digest.test(manifest.runtime), 'Runtime identity is required');

  const artifacts = new Map();
  for (const item of manifest.artifacts ?? []) {
    assert(typeof item.file === 'string' && item.file === basename(item.file) && !['.', '..'].includes(item.file), 'Unsafe release artifact path');
    assert(!artifacts.has(item.file), 'Duplicate release artifact');
    assert(digest.test(item.sha256) && Number.isSafeInteger(item.size) && item.size > 0, 'Invalid artifact identity');
    const bytes = readFileSync(resolve(root, 'dist', item.file));
    assert.equal(bytes.length, item.size, 'Release artifact size mismatch: ' + item.file);
    assert.equal(hash(bytes), item.sha256, 'Release artifact digest mismatch: ' + item.file);
    artifacts.set(item.file, item);
  }
  assert(artifacts.has('composition.json'), 'Release must retain its composition artifact');
  assert(artifacts.has(manifest.first_app?.file), 'Release must retain its first-app archive');
  const components = new Map();
  for (const item of composition.components ?? []) {
    assert(!components.has(item.role), 'Duplicate composition role');
    const recorded = artifacts.get(item.file);
    assert(recorded && recorded.role === item.role && recorded.sha256 === item.sha256 && recorded.size === item.size, 'Component differs from release manifest');
    components.set(item.role, item);
  }
  for (const role of ['sdk', 'runtime', 'engine', 'tools', 'session', 'starter']) assert(components.has(role), 'Missing composition role: ' + role);
  const sdk = components.get('sdk'), session = components.get('session'), sessionSource = composition.chronolog?.session;
  assert.equal(sessionSource?.repository, 'werg/chronolog-db');
  assert.equal(sessionSource?.dirty, false);
  assert(sha.test(sessionSource.source) && sha.test(sessionSource.sourceTree), 'Exact Chronolog session provenance is required');
  const pin = pkg.devDependencies?.['@chronolog/peer-session'];
  assert(typeof pin === 'string' && pin.startsWith('file:'), 'Use the pinned public session archive');
  const pinnedPath = resolve(root, pin.slice(5)), scoped = relative(root, pinnedPath);
  assert(scoped && !isAbsolute(scoped) && scoped !== '..' && !scoped.startsWith('..' + sep), 'Session pin escapes the source checkout');
  assert.equal(hash(readFileSync(pinnedPath)), session.sha256, 'Composition uses a different session than the source pin');
  return {
    build: { coreRelease: manifest.version, runtimeId: manifest.runtime, sourceCommit: source.source, compositionId: id },
    sourceTree: source.sourceTree,
    sdk: { file: sdk.file, sha256: sdk.sha256 },
    session: { file: session.file, sha256: session.sha256, sourceCommit: sessionSource.source, sourceTree: sessionSource.sourceTree },
    packagePaths: { sdk: resolve(root, 'dist', sdk.file), session: resolve(root, 'dist', session.file) },
  };
}

/** Public, read-only checks run before renewing credentials or creating fixtures. */
async function preflight(origin, composition, keys, { fetch: fetcher = globalThis.fetch } = {}) {
  assert.equal(requireServiceOrigin(origin), origin, 'Use the exact configured service origin');
  const fetch = (url, options) => fetcher(url, { ...options, credentials: 'omit', referrerPolicy: 'no-referrer' });
  const readiness = await describeReadiness(origin, { fetch, signal: AbortSignal.timeout(15_000) });
  requireCreationReady(readiness, { service: origin });
  for (const key of keys) {
    assert.equal(readiness.build[key], composition.build[key], 'Live deployment identity mismatch: ' + key);
  }
  const service = requireService(await describeService(origin, { fetch, signal: AbortSignal.timeout(15_000) }));
  assert.equal(service.core_release, composition.build.coreRelease, 'Live service descriptor release mismatch');
  return readiness;
}

export function preflightReviewSource(origin, source, options) {
  return preflight(origin, source, ['coreRelease', 'sourceCommit'], options);
}

export function preflightReviewDeployment(origin, composition, options) {
  return preflight(origin, composition, ['coreRelease', 'runtimeId', 'sourceCommit', 'compositionId'], options);
}

export function reviewProvenance(composition, readiness) {
  return { sourceRevision: composition.build.sourceCommit, sourceTree: composition.sourceTree,
    sdkVersion: composition.build.coreRelease, compositionId: composition.build.compositionId,
    runtimeId: composition.build.runtimeId, sdkArtifact: composition.sdk, sessionArtifact: composition.session,
    deployment: { serviceOrigin: readiness.serviceOrigin, build: readiness.build, mode: readiness.mode, checkedAt: readiness.checkedAt } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, access: { type: 'string' },
    origin: { type: 'string' }, 'source-only': { type: 'boolean', default: false } } });
  const root = resolve(import.meta.dirname, '../..');
  if (values['source-only']) {
    if (!values.origin || values.config || values.access) throw Error('Source preflight requires --source-only --origin EXACT_SERVICE_ORIGIN and no private account.');
    const source = reviewSource(root), readiness = await preflightReviewSource(values.origin, source);
    console.log(JSON.stringify({ qualification: 'source-only', build: source.build, serviceOrigin: readiness.serviceOrigin,
      mode: readiness.mode, checkedAt: readiness.checkedAt }, null, 2));
  } else {
    if (!values.config || !values.access || values.origin) throw Error('Full preflight requires --config WRANGLER_CONFIG --access PRIVATE_JSON.');
    const { rawConfig } = createRequire(import.meta.url)('wrangler').experimental_readRawConfig({ config: resolve(values.config) });
    const origin = rawConfig.vars?.PUBLIC_BASE, access = readReviewAccess(resolve(values.access));
    assert.equal(origin, access.origin, 'Private account must match the explicit deployment configuration');
    const composition = reviewComposition(root);
    const readiness = await preflightReviewDeployment(origin, composition);
    console.log(JSON.stringify(reviewProvenance(composition, readiness), null, 2));
  }
}
