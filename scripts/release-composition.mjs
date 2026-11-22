import { buildPlugin } from '../plugin/build.mjs';
import { ARCHIVE_METADATA } from './archive-metadata.mjs';
// Bind exact public packages and first-app inputs before release publication.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { TUTORIAL_DOWNLOAD, TUTORIAL_FILES, tutorialSource, copyTutorialSources } from './onboarding.mjs';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const fail = message => { throw Error(message); };
const sha = /^[0-9a-f]{40}$/;
const roles = ['sdk', 'runtime', 'engine', 'tools'];
export const REQUIRED_SDK_EXPORTS = ['.', './contract', './onboarding', './setup', './pairing', './application', './signals', './peers',
  './assistant', './archive', './release-verify', './probe', './serverless',
  './browser-owner', './worker-owner', './native-owner', './ipc', './outbox', './participation', './native-rtc',
  './transport-diagnostics', './diagnostics', './collaboration', './schema'];

export const COMPOSITION_V2_PROFILES = Object.freeze({
  'events-relay-only': Object.freeze({ sql: false, nativeRtc: false, wasmSql: false, nativeSql: false }),
  'events-full': Object.freeze({ sql: false, nativeRtc: true, wasmSql: false, nativeSql: false }),
  'sql-portable-relay-only': Object.freeze({ sql: true, nativeRtc: false, wasmSql: true, nativeSql: false }),
  'sql-full': Object.freeze({ sql: true, nativeRtc: true, wasmSql: true, nativeSql: true }),
});

/**
 * Construct a versioned v2 multi-profile composition manifest binding all four explicit
 * profiles (`events-relay-only`, `events-full`, `sql-portable-relay-only`, `sql-full`) cleanly.
 */
export function buildCompositionV2({ version, contract, runtime, core, chronolog, profiles }) {
  if (!profiles || typeof profiles !== 'object') fail('Composition v2 requires a profiles map.');
  const normalized = {};
  for (const [name, spec] of Object.entries(profiles)) {
    if (!Object.hasOwn(COMPOSITION_V2_PROFILES, name)) fail(`Unknown composition v2 profile: ${name}`);
    const rules = COMPOSITION_V2_PROFILES[name];
    if (Boolean(spec.sql) !== rules.sql || Boolean(spec.nativeRtc) !== rules.nativeRtc) {
      fail(`Profile ${name} capabilities do not match its declared v2 contract.`);
    }
    normalized[name] = {
      profile: name,
      sql: rules.sql,
      nativeRtc: rules.nativeRtc,
      wasmSql: Boolean(spec.wasmSql),
      nativeSql: Boolean(spec.nativeSql),
      components: spec.components ?? [],
    };
  }
  const body = { format: 'tendriller-release-composition-v2', version, contract, runtime, core, chronolog, profiles: normalized };
  return { ...body, id: digest(JSON.stringify(body)) };
}

export function sourceIdentity(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  return { repository: 'werg/tendriller', source: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'),
    dirty: git('status', '--porcelain', '--untracked-files=normal').length !== 0 };
}

function cleanIdentity(proof, repository, label, expected) {
  if (proof.repository !== repository || proof.dirty !== false || !sha.test(proof.source) || !sha.test(proof.sourceTree))
    fail(`${label} must identify a clean exact source commit and tree.`);
  if (expected && (proof.source !== expected.source || proof.sourceTree !== expected.sourceTree))
    fail(`${label} does not match the checked-out source; rebuild all artifacts from the same clean checkpoint.`);
  return { repository, source: proof.source, sourceTree: proof.sourceTree, dirty: false };
}

export function packedArchive(path) {
  const entries = execFileSync('tar', ['-tzf', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n');
  const roots = ['package/', './', ''].filter(prefix => entries.includes(prefix + 'package.json'));
  if (roots.length !== 1) fail(`Archive must have one package root: ${path}`);
  const prefix = roots[0];
  const read = name => {
    if (!entries.includes(prefix + name)) fail(`Packed file is missing: ${path}: ${name}`);
    return execFileSync('tar', ['-xOf', path, prefix + name], { maxBuffer: 32 * 1024 * 1024 });
  };
  const parsed = name => JSON.parse(read(name).toString('utf8'));
  return { read, json: parsed, package: parsed('package.json'), has: name => entries.includes(prefix + name) };
}

function packageExports(archive, required, label) {
  const exports = archive.package.exports;
  if (!exports || required.some(name => {
    const value = exports[name];
    return typeof value !== 'string' && !(value && typeof value === 'object' &&
      (typeof value.import === 'string' || typeof value.default === 'string'));
  })) fail(`${label} is missing an advertised public export.`);
  function target(value) {
    if (typeof value === 'string') {
      if (!value.startsWith('./') || value.split('/').includes('..')) fail(`${label} has an invalid public export target.`);
      if (!value.includes('*') && !archive.has(value.slice(2))) fail(`${label} export points to an unpackaged file: ${value}`);
    } else if (value && typeof value === 'object') Object.values(value).forEach(target);
  }
  Object.values(exports).forEach(target);
}

function component(dist, role, file) {
  const bytes = readFileSync(join(dist, file));
  return { role, file, sha256: digest(bytes), size: bytes.length };
}
function matchesRecorded(component, proof, label) {
  const record = proof.artifacts?.find(item => item.file === component.file);
  if (!record || record.sha256 !== component.sha256 || record.size !== undefined && record.size !== component.size)
    fail(`${label} does not match recorded artifact bytes: ${component.file}`);
}

// Publication is a separate process from preparation. Recheck its complete
// local graph before contacting GitHub, even if an earlier build was qualified.
export function verifyReleaseArtifacts(root, manifest) {
  const identity = sourceIdentity(root), dist = join(root, 'dist');
  cleanIdentity(identity, 'werg/tendriller', 'Release checkout');
  if (manifest.format !== 'tendriller-core-release' || manifest.source_commit !== identity.source ||
      manifest.source_tree !== identity.sourceTree || !Number.isSafeInteger(manifest.contract) ||
      manifest.contract < 1 || !/^[a-f0-9]{64}$/.test(manifest.runtime ?? ''))
    fail('Release manifest must identify the exact clean source tree, contract and runtime.');
  const required = [...roles, 'session', 'starter', 'composition', 'first-app', 'core-provenance', 'tools-provenance', 'plugin'];
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== required.length + (manifest.artifacts.some(item => item.role === 'deployment') ? 1 : 0) ||
      required.some(role => manifest.artifacts.filter(item => item.role === role).length !== 1))
    fail('Release manifest must contain the complete SDK/runtime/engine/tools/session/starter composition and its proofs.');
  const names = new Set();
  for (const item of manifest.artifacts) {
    if (typeof item.file !== 'string' || item.file !== basename(item.file) || !/^[a-zA-Z0-9._-]+$/.test(item.file) ||
        names.has(item.file) || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? ''))
      fail('Release artifact records require unique safe filenames, sizes and SHA-256 hashes.');
    if (item.url !== `https://github.com/werg/tendriller/releases/download/source-${identity.source}/${item.file}`)
      fail('Release artifacts must use canonical source-qualified URLs.');
    names.add(item.file);
    const bytes = readFileSync(join(dist, item.file));
    if (bytes.length !== item.size || digest(bytes) !== item.sha256)
      fail(`Built release asset does not match manifest: ${item.file}`);
  }
  const byRole = Object.fromEntries(manifest.artifacts.map(item => [item.role, item]));
  if (manifest.composition?.file !== byRole.composition.file || manifest.first_app?.file !== byRole['first-app'].file ||
      manifest.first_app?.profile !== 'events' || JSON.stringify(manifest.first_app?.packages) !== JSON.stringify(['sdk', 'tools', 'session']))
    fail('Release discovery must reference its exact composition and complete events first-app kit.');
  const composition = json(join(dist, byRole.composition.file));
  const { id, ...body } = composition;
  if (id !== digest(JSON.stringify(body)) || id !== manifest.composition.id ||
      composition.format !== 'tendriller-release-composition-v1' || composition.version !== manifest.version ||
      composition.contract !== manifest.contract || composition.runtime !== manifest.runtime)
    fail('Release composition identity does not match the manifest and its contents.');
  cleanIdentity(composition.core ?? {}, 'werg/tendriller', 'Release composition source', identity);
  for (const role of ['session', 'generation'])
    cleanIdentity(composition.chronolog?.[role] ?? {}, 'werg/chronolog-db', `Release composition ${role}`);
  const componentRoles = [...roles, 'session', 'starter'];
  if (!Array.isArray(composition.components) || composition.components.length !== componentRoles.length ||
      componentRoles.some(role => {
        const entries = composition.components.filter(item => item.role === role);
        return entries.length !== 1 || ['file', 'size', 'sha256'].some(key => entries[0][key] !== byRole[role][key]);
      })) fail('Release manifest and composition must bind the same complete component graph.');
  const core = json(join(dist, byRole['core-provenance'].file));
  const tools = json(join(dist, byRole['tools-provenance'].file));
  cleanIdentity(core, 'werg/tendriller', 'Release core provenance', identity);
  cleanIdentity({ repository: 'werg/tendriller', source: tools.source_commit, sourceTree: tools.source_tree, dirty: tools.dirty },
    'werg/tendriller', 'Release tools provenance', identity);
  for (const role of roles) matchesRecorded(byRole[role], role === 'tools' ? tools : core, 'Release provenance');
  if (tools.version !== manifest.version || tools.contract !== manifest.contract || tools.runtime !== manifest.runtime)
    fail('Release tools provenance must match its version, contract and runtime.');
  return identity;
}

export function prepareRelease({ root, version, contract }) {
  const dist = join(root, 'dist'), identity = sourceIdentity(root);
  cleanIdentity(identity, 'werg/tendriller', 'Release checkout');
  const expected = roles.map(role => `tendriller-${role}-${version}.tgz`);
  const actual = readdirSync(dist).filter(name => /^tendriller-(sdk|runtime|engine|tools)-.*\.tgz$/.test(name));
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...expected].sort()))
    fail('Build exactly one matching SDK/runtime/engine/tools release before publication.');
  const core = json(join(dist, 'provenance.json')), tools = json(join(dist, 'tools-manifest.json'));
  cleanIdentity(core, 'werg/tendriller', 'Core provenance', identity);
  cleanIdentity({ repository: 'werg/tendriller', source: tools.source_commit, sourceTree: tools.source_tree, dirty: tools.dirty },
    'werg/tendriller', 'Tools provenance', identity);
  const components = roles.map((role, index) => component(dist, role, expected[index]));
  for (const item of components) matchesRecorded(item, item.role === 'tools' ? tools : core, 'Build provenance');
  const packages = Object.fromEntries(components.map(item => [item.role, packedArchive(join(dist, item.file))]));
  const names = { sdk: '@tendriller/core', runtime: '@tendriller/runtime', engine: '@tendriller/engine', tools: '@tendriller/tools' };
  for (const item of components) {
    const pkg = packages[item.role].package;
    if (pkg.name !== names[item.role] || pkg.version !== version || pkg.tendriller?.contract !== contract)
      fail(`Packed ${item.role} name, version or contract does not match the release.`);
  }
  packageExports(packages.sdk, REQUIRED_SDK_EXPORTS, 'SDK');
  packageExports(packages.runtime, ['./kernel', './voice', './manifest'], 'Runtime');
  packageExports(packages.engine, ['.', './provenance', './peer-generation-provenance'], 'Engine');
  packageExports(packages.tools, ['./pack', './session', './preview'], 'Tools');
  const runtime = verifyRuntimeManifest(packages.runtime.json('assets/manifest.json'));
  for (const asset of runtime.assets) {
    const bytes = packages.runtime.read(`assets/${asset.path}`);
    if (digest(bytes) !== asset.sha256 || bytes.length !== asset.size)
      fail(`Packed runtime asset does not match its immutable manifest: ${asset.path}`);
  }
  if (runtime.version !== version || runtime.contract !== contract || tools.version !== version ||
      tools.contract !== contract || tools.runtime !== runtime.id || packages.runtime.package.tendriller.runtime !== runtime.id ||
      packages.tools.package.tendriller.runtime !== runtime.id)
    fail('Packed runtime and tools identities must match the release.');
  const hostProof = packages.engine.json('provenance.json');
  cleanIdentity(hostProof, 'werg/tendriller', 'Packed engine provenance', identity);
  for (const [file, hash] of Object.entries(hostProof.files ?? {}))
    if (digest(packages.engine.read(file)) !== hash) fail(`Packed engine provenance mismatch: ${file}`);
  const generationProof = packages.engine.json('peer-generation-provenance.json');
  const generation = cleanIdentity(generationProof, 'werg/chronolog-db', 'Embedded generation dependency');
  if (generationProof.profile !== 'peer-generation-v1') fail('Embedded generation profile is not supported.');

  const pin = json(join(root, 'package.json')).devDependencies?.['@chronolog/peer-session'];
  if (typeof pin !== 'string' || !pin.startsWith('file:')) fail('Pin the public Chronolog session archive in package.json.');
  const sessionPath = resolve(root, pin.slice(5)), sessionArchive = packedArchive(sessionPath);
  const sessionProof = sessionArchive.json('provenance.json');
  const session = cleanIdentity(sessionProof, 'werg/chronolog-db', 'Chronolog session dependency');
  if (sessionArchive.package.name !== '@chronolog/peer-session' || sessionProof.profile !== 'peer-generation-v1' ||
      !Array.isArray(sessionProof.sqlEngines) || sessionProof.sqlEngines.length !== 0)
    fail('The first-app composition requires the pinned SQL-free public session package.');
  packageExports(sessionArchive, ['.', './native', './browser', './worker', './webrtc', './webrtc-native', './websocket'], 'Chronolog session');
  if (sessionProof.nativeRtc !== true || sessionArchive.package.dependencies?.werift !== '0.27.0' ||
      sessionArchive.package.peerDependencies?.werift !== undefined || sessionArchive.package.peerDependenciesMeta?.werift !== undefined)
    fail('The default session must include native RTC with the normal pinned werift@0.27.0 dependency.');
  const sessionFile = `chronolog-peer-session-${session.source}.tgz`;
  copyFileSync(sessionPath, join(dist, sessionFile));
  components.push(component(dist, 'session', sessionFile));

  const starterFile = `tendriller-starter-${version}.tgz`;
  const starterPath = join(root, 'server/public', TUTORIAL_DOWNLOAD);
  const entries = execFileSync('tar', ['-tzf', starterPath], { encoding: 'utf8' }).trim().split('\n');
  if (JSON.stringify(entries.sort()) !== JSON.stringify([...TUTORIAL_FILES].sort()))
    fail('The starter must contain exactly the maintained source allowlist. Rebuild onboarding assets.');
  for (const file of TUTORIAL_FILES) {
    const bytes = execFileSync('tar', ['-xOf', starterPath, file]);
    if (digest(bytes) !== digest(readFileSync(tutorialSource(root, file)))) fail(`Starter source is stale: ${file}`);
  }
  copyFileSync(starterPath, join(dist, starterFile));
  components.push(component(dist, 'starter', starterFile));
  const compositionBody = { format: 'tendriller-release-composition-v1', version, contract, core: identity,
    runtime: runtime.id, chronolog: { session, generation }, components };
  const composition = { ...compositionBody, id: digest(JSON.stringify(compositionBody)) };
  writeJson(join(dist, 'composition.json'), composition);

  const firstAppFile = `tendriller-first-app-${version}.tgz`, directory = mkdtempSync(join(dist, 'first-app-'));
  try {
    // Exact allowlisted bytes checked against the served starter above. Never
    // package an existing developer application directory or its private state.
    copyTutorialSources(root, directory);
    copyFileSync(join(dist, 'composition.json'), join(directory, 'composition.json'));
    mkdirSync(join(directory, 'packages'));
    const localPackages = components.filter(item => ['sdk', 'tools', 'session'].includes(item.role));
    for (const item of localPackages) copyFileSync(join(dist, item.file), join(directory, 'packages', item.file));
    writeFileSync(join(directory, 'packages/SHA256SUMS'), localPackages.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
    execFileSync('tar', [...ARCHIVE_METADATA,
      '-czf', join(dist, firstAppFile), '-C', directory, ...TUTORIAL_FILES, 'composition.json', 'packages']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  buildPlugin(root);
  const extras = [component(dist, 'plugin', 'tendriller-chatgpt-plugin.zip'), component(dist, 'composition', 'composition.json'), component(dist, 'first-app', firstAppFile),
    component(dist, 'core-provenance', 'provenance.json'), component(dist, 'tools-provenance', 'tools-manifest.json')];
  const releaseUrl = `https://github.com/werg/tendriller/releases/download/source-${identity.source}`;
  const artifacts = [...components, ...extras].map(item => ({ ...item, url: `${releaseUrl}/${item.file}`,
    type: item.file.endsWith('.tgz') ? 'application/gzip' : item.file.endsWith('.zip') ? 'application/zip' : 'application/json' }));
  const manifest = { format: 'tendriller-core-release', version, contract, source_commit: identity.source,
    source_tree: identity.sourceTree, runtime: runtime.id, composition: { id: composition.id, file: 'composition.json' },
    first_app: { file: firstAppFile, profile: 'events', packages: ['sdk', 'tools', 'session'], build_dependency: 'esbuild@0.28.2' }, artifacts };
  writeJson(join(dist, 'manifest.json'), manifest);
  writeFileSync(join(dist, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
  return manifest;
}
