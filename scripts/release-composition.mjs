import { buildPlugin } from '../plugin/build.mjs';
import { ARCHIVE_METADATA } from './archive-metadata.mjs';
// Bind exact public packages and first-app inputs before release publication.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { TUTORIAL_DOWNLOAD, TUTORIAL_FILES, tutorialSource, copyTutorialSources } from './onboarding.mjs';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';
import { readBrowserSqlPin } from './session-pin.mjs';
import { isDeepStrictEqual } from 'node:util';

export const FIRST_APP_PROFILES = Object.freeze({
  events: Object.freeze({ session: 'session', packages: Object.freeze(['sdk', 'tools', 'authority', 'session']) }),
  sql: Object.freeze({ session: 'session-sql-browser', packages: Object.freeze(['sdk', 'tools', 'authority', 'session-sql-browser']) }),
});

export function verifyFirstAppProfiles(composition, manifest) {
  if (!isDeepStrictEqual(composition.profiles, FIRST_APP_PROFILES))
    throw Error('The current release requires exact events and browser SQL composition profiles.');
  for (const [profile, spec] of Object.entries(FIRST_APP_PROFILES)) {
    const kit = profile === 'events' ? manifest.first_app : manifest.first_apps?.sql;
    const file = `tendriller-first-app-${profile === 'sql' ? 'sql-' : ''}${manifest.version}.tgz`;
    if (kit?.profile !== profile || kit.file !== file || !isDeepStrictEqual(kit.packages, spec.packages) ||
        kit.build_dependency !== 'esbuild@0.28.2' ||
        manifest.artifacts?.filter(item => item.role === (profile === 'events' ? 'first-app' : 'first-app-sql') && item.file === file).length !== 1)
      throw Error(`Release discovery must bind its exact ${profile} first-app kit and selected packages.`);
  }
  const authority = composition.chronolog?.authority;
  cleanIdentity(authority ?? {}, 'werg/chronolog-db', 'Composition authority');
  for (const role of ['session', 'session-sql-browser'])
    cleanIdentity(composition.chronolog?.[role] ?? {}, 'werg/chronolog-db', `Composition ${role}`, authority);
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const fail = message => { throw Error(message); };
const sha = /^[0-9a-f]{40}$/;
const roles = ['sdk', 'runtime', 'engine', 'tools'];
export const REQUIRED_SDK_EXPORTS = ['.', './contract', './onboarding', './setup', './authority', './application', './signals', './peers',
  './archive', './release-verify', './probe', './serverless',
  './browser-owner', './worker-owner', './native-owner', './ipc', './participation', './native-rtc',
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
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
        ['sql', 'nativeRtc', 'wasmSql', 'nativeSql'].some(key => Boolean(spec[key]) !== rules[key])) {
      fail(`Profile ${name} capabilities do not match its declared v2 contract.`);
    }
    normalized[name] = {
      profile: name,
      sql: rules.sql,
      nativeRtc: rules.nativeRtc,
      wasmSql: Boolean(spec.wasmSql),
      nativeSql: Boolean(spec.nativeSql),
      components: (spec.components ?? []).map(component => {
        if (!component || typeof component !== 'object' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(component.file) ||
            !/^[a-f0-9]{64}$/.test(component.sha256) || !Number.isSafeInteger(component.size) || component.size < 1)
          fail(`Profile ${name} must bind exact component file names, SHA-256 values and sizes.`);
        return { ...component };
      }),
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

export function verifyBrowserSqlSession(archive, expected) {
  const proof = archive.json('provenance.json');
  const identity = cleanIdentity(proof, 'werg/chronolog-db', 'Browser SQL session dependency', expected);
  if (archive.package.name !== '@chronolog/peer-session' || proof.format !== 'chronolog-peer-session-package/v2' ||
      proof.profile !== 'chronolog-crdt-v2' || proof.zeroNativeBuild !== true ||
      archive.package.os || archive.package.cpu || archive.package.libc ||
      archive.package.dependencies?.['better-sqlite3'] || archive.package.dependencies?.['fs-native-extensions'] ||
      archive.has('engine/index.cjs') || archive.has('engine/build/Release/doltlite.node'))
    fail('Browser SQL requires a portable Chronolog v2 session archive, without native C/C++ builds.');
  packageExports(archive, ['.', './browser', './worker', './kernel', './websocket'], 'Browser SQL session');
  return identity;
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
  const required = [...roles, 'authority', 'session', 'session-sql-browser', 'starter', 'composition', 'first-app', 'first-app-sql', 'core-provenance', 'tools-provenance', 'plugin'];
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
      manifest.first_app?.profile !== 'events' || JSON.stringify(manifest.first_app?.packages) !== JSON.stringify(['sdk', 'tools', 'authority', 'session']))
    fail('Release discovery must reference its exact composition and complete events first-app kit.');
  const composition = json(join(dist, byRole.composition.file));
  const { id, ...body } = composition;
  if (id !== digest(JSON.stringify(body)) || id !== manifest.composition.id ||
      composition.format !== 'tendriller-release-composition-v1' || composition.version !== manifest.version ||
      composition.contract !== manifest.contract || composition.runtime !== manifest.runtime)
    fail('Release composition identity does not match the manifest and its contents.');
  cleanIdentity(composition.core ?? {}, 'werg/tendriller', 'Release composition source', identity);
  for (const role of ['session', 'authority'])
    cleanIdentity(composition.chronolog?.[role] ?? {}, 'werg/chronolog-db', `Release composition ${role}`);
  verifyFirstAppProfiles(composition, manifest);
  const componentRoles = [...roles, 'authority', 'session', 'session-sql-browser', 'starter'];
  if (!Array.isArray(composition.components) || composition.components.length !== componentRoles.length ||
      componentRoles.some(role => {
        const entries = composition.components.filter(item => item.role === role);
        return entries.length !== 1 || ['file', 'size', 'sha256'].some(key => entries[0][key] !== byRole[role][key]);
      })) fail('Release manifest and composition must bind the same complete component graph.');
  const sqlPin = readBrowserSqlPin(root);
  if (sqlPin.sha256 !== byRole['session-sql-browser'].sha256)
    fail('Release browser SQL archive must match its explicit source pin.');
  verifyBrowserSqlSession(packedArchive(join(dist, byRole['session-sql-browser'].file)), composition.chronolog.authority);
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
  packageExports(packages.engine, ['.', './provenance', './authority-provenance'], 'Engine');
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
  const authorityBytes = packages.engine.read('authority-provenance.json');
  const authorityProof = JSON.parse(authorityBytes.toString('utf8'));
  const authority = cleanIdentity(authorityProof, 'werg/chronolog-db', 'Embedded authority dependency');
  if (authorityProof.profile !== 'chronolog-crdt-v2' || authorityProof.format !== 'chronolog-authority-package/v2')
    fail('Embedded authority profile is not supported.');
  const authorityInputBytes = packages.engine.read('authority-inputs.json');
  const authorityInputs = JSON.parse(authorityInputBytes.toString('utf8'));
  if (hostProof.files?.['authority-provenance.json'] !== digest(authorityBytes) ||
      hostProof.files?.['authority-inputs.json'] !== digest(authorityInputBytes) ||
      authorityInputs.provenanceSha256 !== digest(authorityBytes) ||
      JSON.stringify(authorityInputs.files) !== JSON.stringify(authorityProof.sha256))
    fail('The engine must bind the exact authority bytes used when compiling its Worker.');

  const pin = json(join(root, 'package.json')).devDependencies?.['@chronolog/peer-session'];
  if (typeof pin !== 'string' || !pin.startsWith('file:')) fail('Pin the public Chronolog session archive in package.json.');
  const sessionPath = resolve(root, pin.slice(5)), sessionArchive = packedArchive(sessionPath);
  const sessionProof = sessionArchive.json('provenance.json');
  const session = cleanIdentity(sessionProof, 'werg/chronolog-db', 'Chronolog session dependency');
  if (sessionArchive.package.name !== '@chronolog/peer-session' || sessionProof.profile !== 'chronolog-crdt-v2' ||
      sessionProof.format !== 'chronolog-peer-session-package/v2' || sessionProof.zeroNativeBuild !== true)
    fail('The first-app composition requires the pinned zero-native-build Chronolog v2 session package.');
  if (session.source !== authority.source || session.sourceTree !== authority.sourceTree)
    fail('Session and embedded authority must come from the same clean Chronolog checkpoint.');
  packageExports(sessionArchive, ['.', './native', './browser', './worker', './kernel', './webrtc', './webrtc-native', './websocket'], 'Chronolog session');
  if (sessionArchive.package.dependencies?.werift !== '0.27.0' ||
      sessionArchive.package.peerDependencies?.werift !== undefined || sessionArchive.package.peerDependenciesMeta?.werift !== undefined)
    fail('The default session must include native RTC with the normal pinned werift@0.27.0 dependency.');
  const authorityPin = json(join(root, 'package.json')).devDependencies?.['@chronolog/authority'];
  if (typeof authorityPin !== 'string' || !authorityPin.startsWith('file:'))
    fail('Pin the public Chronolog authority archive in package.json.');
  const authorityPath = resolve(root, authorityPin.slice(5)), authorityArchive = packedArchive(authorityPath);
  if (authorityArchive.package.name !== '@chronolog/authority' ||
      digest(authorityArchive.read('provenance.json')) !== digest(authorityBytes))
    fail('The first-app authority archive must exactly match the dependency embedded in the Worker.');
  packageExports(authorityArchive, ['.'], 'Chronolog authority');
  for (const [file, hash] of Object.entries(authorityProof.sha256 ?? {}))
    if (digest(authorityArchive.read(file)) !== hash) fail(`Authority archive digest mismatch: ${file}`);
  const authorityFile = `chronolog-authority-${authority.source}.tgz`;
  copyFileSync(authorityPath, join(dist, authorityFile));
  components.push(component(dist, 'authority', authorityFile));
  const sessionFile = `chronolog-peer-session-${session.source}.tgz`;
  copyFileSync(sessionPath, join(dist, sessionFile));
  components.push(component(dist, 'session', sessionFile));
  const sqlPin = readBrowserSqlPin(root), sqlArchive = packedArchive(sqlPin.archive);
  const sqlSession = verifyBrowserSqlSession(sqlArchive, authority);
  const sqlSessionFile = `chronolog-peer-session-${sqlSession.source}-sql-browser.tgz`;
  copyFileSync(sqlPin.archive, join(dist, sqlSessionFile));
  const sqlComponent = component(dist, 'session-sql-browser', sqlSessionFile);
  if (sqlComponent.sha256 !== sqlPin.sha256) fail('Browser SQL session changed during release preparation.');
  components.push(sqlComponent);

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
    runtime: runtime.id, chronolog: { session, authority, 'session-sql-browser': sqlSession }, profiles: FIRST_APP_PROFILES, components };
  const composition = { ...compositionBody, id: digest(JSON.stringify(compositionBody)) };
  writeJson(join(dist, 'composition.json'), composition);

  const firstApps = {};
  for (const [profile, spec] of Object.entries(FIRST_APP_PROFILES)) {
    const file = `tendriller-first-app-${profile === 'sql' ? 'sql-' : ''}${version}.tgz`;
    const directory = mkdtempSync(join(dist, 'first-app-'));
    try {
      // Only allowlisted maintained sources and this profile's exact packages;
      // never a developer application's private state or a native SQL binary.
      copyTutorialSources(root, directory);
      copyFileSync(join(dist, 'composition.json'), join(directory, 'composition.json'));
      writeJson(join(directory, 'first-app-profile.json'), { profile, ...spec });
      mkdirSync(join(directory, 'packages'));
      const localPackages = components.filter(item => spec.packages.includes(item.role));
      for (const item of localPackages) copyFileSync(join(dist, item.file), join(directory, 'packages', item.file));
      writeFileSync(join(directory, 'packages/SHA256SUMS'), localPackages.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
      execFileSync('tar', [...ARCHIVE_METADATA,
        '-czf', join(dist, file), '-C', directory, ...TUTORIAL_FILES, 'composition.json', 'first-app-profile.json', 'packages']);
      firstApps[profile] = { file, profile, packages: [...spec.packages], build_dependency: 'esbuild@0.28.2' };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  buildPlugin(root);
  const extras = [component(dist, 'plugin', 'tendriller-chatgpt-plugin.zip'), component(dist, 'composition', 'composition.json'),
    component(dist, 'first-app', firstApps.events.file), component(dist, 'first-app-sql', firstApps.sql.file),
    component(dist, 'core-provenance', 'provenance.json'), component(dist, 'tools-provenance', 'tools-manifest.json')];
  const releaseUrl = `https://github.com/werg/tendriller/releases/download/source-${identity.source}`;
  const artifacts = [...components, ...extras].map(item => ({ ...item, url: `${releaseUrl}/${item.file}`,
    type: item.file.endsWith('.tgz') ? 'application/gzip' : item.file.endsWith('.zip') ? 'application/zip' : 'application/json' }));
  const manifest = { format: 'tendriller-core-release', version, contract, source_commit: identity.source,
    source_tree: identity.sourceTree, runtime: runtime.id, composition: { id: composition.id, file: 'composition.json' },
    first_app: firstApps.events, first_apps: { sql: firstApps.sql }, artifacts };
  writeJson(join(dist, 'manifest.json'), manifest);
  writeFileSync(join(dist, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
  return manifest;
}
