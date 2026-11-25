import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { prepareRelease, REQUIRED_SDK_EXPORTS, sourceIdentity, verifyReleaseArtifacts } from '../release-composition.mjs';
import { runtimeManifest } from '../runtime-manifest.mjs';
import { TUTORIAL_FILES, tutorialSource, copyTutorialSources } from '../onboarding.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function fixture(t, { sessionDirty = false, sqlEngines = [], nativeRtc = true, werift = '0.27.0',
  authoritySource = 'a'.repeat(40), corruptAuthorityBinding = false, sqlProof = {}, sqlFiles = {} } = {}) {
  const scratch = tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'composition-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['dist', '.build', 'server/public/downloads', 'docs/tutorial']) mkdirSync(join(root, directory), { recursive: true });
  const version = '1.2.3', contract = 3;
  writeFileSync(join(root, '.gitignore'), 'dist/\n.build/\nserver/public/\n');
  writeJson(join(root, 'package.json'), { version, devDependencies: { '@chronolog/peer-session': 'file:session.tgz', '@chronolog/authority': 'file:authority.tgz' } });
  for (const file of TUTORIAL_FILES) {
    mkdirSync(dirname(tutorialSource(root, file)), { recursive: true });
    writeFileSync(tutorialSource(root, file), `fixture ${file}\n`);
  }
  const chronolog = { repository: 'werg/chronolog-db', source: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
    dirty: false, profile: 'chronolog-crdt-v1' };
  const authorityProof = { ...chronolog, source: authoritySource, format: 'chronolog-authority-package/v1',
    sha256: { 'control.mjs': digest('authority fixture') } };
  const authorityInputs = { provenanceSha256: corruptAuthorityBinding ? '0'.repeat(64) : digest(JSON.stringify(authorityProof)), files: authorityProof.sha256 };
  const pack = (name, files, destination) => {
    const directory = join(root, '.build', name);
    rmSync(directory, { recursive: true, force: true });
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, 'package', file)), { recursive: true });
      writeFileSync(join(directory, 'package', file), typeof content === 'string' ? content : JSON.stringify(content));
    }
    execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', destination, '-C', directory, 'package']);
  };
  pack('session', { 'package.json': { name: '@chronolog/peer-session', dependencies: { werift }, exports: Object.fromEntries(['.', './native', './browser', './worker', './webrtc', './webrtc-native', './websocket'].map(key => [key, './index.mjs'])) },
    'index.mjs': 'export const session = true;', 'provenance.json': { ...chronolog, format: 'chronolog-peer-session-package/v1', dirty: sessionDirty, sqlEngines, nativeRtc } }, join(root, 'session.tgz'));
  const wasmManifest = { toolchain: 'fixture', wasmSha256: digest('wasm fixture'), loaderSha256: digest('loader fixture'), wasmBytes: 12 };
  const browserFiles = { 'package.json': { name: '@chronolog/peer-session', exports: Object.fromEntries(['.', './browser', './worker', './sql', './sql-browser', './websocket'].map(key => [key, './index.mjs'])) },
    'index.mjs': 'export const browser = true;', 'wasm/manifest.json': wasmManifest,
    'wasm/sqlite3.wasm': 'wasm fixture', 'wasm/sqlite3.mjs': 'loader fixture', 'wasm/sqlite3-opfs-async-proxy.js': 'proxy fixture', ...sqlFiles };
  const browserProof = { ...chronolog, format: 'chronolog-peer-session-package/v1', nativeRtc: false, sqlEngines: ['browser'], wasmEngine: wasmManifest,
    sha256: Object.fromEntries(Object.entries(browserFiles).map(([name, value]) => [name, digest(typeof value === 'string' ? value : JSON.stringify(value))])), ...sqlProof };
  pack('browser-sql', { ...browserFiles, 'provenance.json': browserProof }, join(root, 'browser-sql.tgz'));
  mkdirSync(join(root, 'scripts'));
  writeJson(join(root, 'scripts/sql-browser-session.json'), { archive: 'browser-sql.tgz', sha256: digest(readFileSync(join(root, 'browser-sql.tgz'))) });
  pack('authority', { 'package.json': { name: '@chronolog/authority', version: '0.0.0-gaaaaaaaa',
    exports: Object.fromEntries(['.', './control', './metadata', './participant', './publication', './finality'].map(key => [key, './control.mjs'])) },
    'control.mjs': 'authority fixture', 'provenance.json': authorityProof }, join(root, 'authority.tgz'));
  for (const file of ['plugin.json', 'mcp.json', 'skills/connect-tendriller/SKILL.md', 'review-app.mjs', 'review-domain.mjs', 'review-assistant.mjs',
    'review-local.mjs', 'review-page.mjs', 'review-worker.mjs', 'review-index.html']) {
    const target = join(root, 'plugin', file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(import.meta.dirname, '../../plugin', file), target);
  }
  mkdirSync(join(root, 'docs/assets'), { recursive: true });
  copyFileSync(resolve(import.meta.dirname, '../../docs/assets/tendriller-icon-180.png'), join(root, 'docs/assets/tendriller-icon-180.png'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Composition test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Source fixture'], { cwd: root });
  const identity = sourceIdentity(root);
  const runtime = runtimeManifest({ version, contract, assets: [], resources: [] });
  const metadata = name => ({ name, version, type: 'module', tendriller: { contract } });
  const files = {
    sdk: { 'package.json': { ...metadata('@tendriller/core'), exports: Object.fromEntries(REQUIRED_SDK_EXPORTS.map(key => [key, './index.mjs'])) }, 'index.mjs': 'export const sdk = true;' },
    runtime: { 'package.json': { ...metadata('@tendriller/runtime'), tendriller: { contract, runtime: runtime.id },
      exports: { './kernel': './index.mjs', './voice': './index.mjs', './manifest': './assets/manifest.json' } },
      'index.mjs': 'export const runtime = true;', 'assets/manifest.json': runtime },
    engine: { 'package.json': { ...metadata('@tendriller/engine'), exports: { '.': './index.mjs', './provenance': './provenance.json', './authority-provenance': './authority-provenance.json' } },
      'index.mjs': 'export const engine = true;',
      'provenance.json': { ...identity, files: { 'index.mjs': digest('export const engine = true;'),
        'authority-provenance.json': digest(JSON.stringify(authorityProof)),
        'authority-inputs.json': digest(JSON.stringify(authorityInputs)) } },
      'authority-provenance.json': authorityProof, 'authority-inputs.json': authorityInputs },
    tools: { 'package.json': { ...metadata('@tendriller/tools'), tendriller: { contract, runtime: runtime.id },
      exports: { './pack': './index.mjs', './session': './index.mjs', './preview': './index.mjs' } }, 'index.mjs': 'export const tools = true;' },
  };
  const artifact = role => {
    const file = `tendriller-${role}-${version}.tgz`, bytes = readFileSync(join(root, 'dist', file));
    return { file, sha256: digest(bytes), size: bytes.length };
  };
  const packAll = () => {
    for (const [role, content] of Object.entries(files)) pack(role, content, join(root, 'dist', `tendriller-${role}-${version}.tgz`));
    writeJson(join(root, 'dist/provenance.json'), { ...identity, artifacts: ['sdk', 'runtime', 'engine'].map(artifact) });
    writeJson(join(root, 'dist/tools-manifest.json'), { version, contract, runtime: runtime.id,
      source_commit: identity.source, source_tree: identity.sourceTree, dirty: false, artifacts: [artifact('tools')] });
  };
  packAll();
  const starterSources = join(root, '.build/starter-source');
  copyTutorialSources(root, starterSources);
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf',
    join(root, 'server/public/downloads/tendriller-first-app.tgz'), '-C', starterSources, ...TUTORIAL_FILES]);
  return { root, version, contract, identity, runtime, files, packAll, prepare: () => prepareRelease({ root, version, contract }),
    editProof(name, changes) { const path = join(root, 'dist', name); writeJson(path, { ...readJson(path), ...changes }); } };
}

test('browser SQL kit selects only its portable exact graph and verified packaged WASM', t => {
  const f = fixture(t), manifest = f.prepare();
  const composition = readJson(join(f.root, 'dist/composition.json'));
  assert.deepEqual(composition.profiles.sql, { session: 'session-sql-browser', packages: ['sdk', 'tools', 'authority', 'session-sql-browser'] });
  const archive = join(f.root, 'dist', manifest.first_apps.sql.file);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(JSON.parse(execFileSync('tar', ['-xOf', archive, 'first-app-profile.json'])), { profile: 'sql', ...composition.profiles.sql });
  const selected = composition.components.filter(item => composition.profiles.sql.packages.includes(item.role));
  assert.deepEqual(entries.filter(name => name.startsWith('packages/') && name.endsWith('.tgz')).sort(), selected.map(item => `packages/${item.file}`).sort());
  for (const item of selected) assert.equal(digest(execFileSync('tar', ['-xOf', archive, `packages/${item.file}`])), item.sha256);
  assert.equal(execFileSync('tar', ['-xOf', archive, 'sql/engine/sqlite3.wasm']).toString(), 'wasm fixture');
  assert.equal(execFileSync('tar', ['-xOf', archive, 'sql/engine/sqlite3.mjs']).toString(), 'loader fixture');
  assert.equal(execFileSync('tar', ['-xOf', archive, 'sql/engine/sqlite3-opfs-async-proxy.js']).toString(), 'proxy fixture');
  const defaultEntries = execFileSync('tar', ['-tzf', join(f.root, 'dist', manifest.first_app.file)], { encoding: 'utf8' });
  assert(!defaultEntries.includes('sql/engine/'));
  assert.equal(manifest.first_app.profile, 'events');
  assert.deepEqual(verifyReleaseArtifacts(f.root, manifest), f.identity);
});

for (const [name, sqlProof] of [['dirty', { dirty: true }], ['source', { source: 'c'.repeat(40) }],
  ['tree', { sourceTree: 'c'.repeat(40) }], ['native SQL', { sqlEngines: ['browser', 'native'] }],
  ['missing WASM', { wasmEngine: undefined }], ['native RTC', { nativeRtc: true }]])
  test(`release rejects browser SQL ${name} evidence`, t => assert.throws(fixture(t, { sqlProof }).prepare));

test('release rejects authority compiled from a different clean Chronolog checkpoint', t => {
  const f = fixture(t, { authoritySource: 'c'.repeat(40) });
  assert.throws(f.prepare, /same clean Chronolog checkpoint/);
});

test('release rejects a changed authority build binding even with matching outer archive hashes', t => {
  const f = fixture(t, { corruptAuthorityBinding: true });
  assert.throws(f.prepare, /exact authority bytes/);
});

test('release identity binds actual package bytes, starter, companion and complete install archive deterministically', t => {
  const f = fixture(t), manifest = f.prepare();
  const composition = readJson(join(f.root, 'dist/composition.json'));
  const { id, ...body } = composition;
  assert.equal(id, digest(JSON.stringify(body)));
  assert.equal(manifest.composition.id, id);
  assert.deepEqual(composition.components.map(item => item.role), ['sdk', 'runtime', 'engine', 'tools', 'authority', 'session', 'session-sql-browser', 'starter']);
  assert.equal(composition.core.source, f.identity.source);
  assert.equal(composition.chronolog.session.source, 'a'.repeat(40));
  const archive = join(f.root, 'dist', manifest.first_app.file);
  for (const file of TUTORIAL_FILES)
    assert.equal(execFileSync('tar', ['-xOf', archive, file]).toString(), readFileSync(tutorialSource(f.root, file), 'utf8'));
  for (const component of composition.components.filter(item => ['sdk', 'tools', 'authority', 'session'].includes(item.role)))
    assert.equal(digest(execFileSync('tar', ['-xOf', archive, `packages/${component.file}`])), component.sha256);
  const bytes = digest(readFileSync(archive));
  assert.deepEqual(f.prepare(), manifest);
  assert.equal(digest(readFileSync(archive)), bytes);
  for (const item of manifest.artifacts) assert.equal(digest(readFileSync(join(f.root, 'dist', item.file))), item.sha256);
  assert.deepEqual(verifyReleaseArtifacts(f.root, manifest), f.identity);
});

test('release rejects a dirty source checkout before emitting discovery metadata', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'uncommitted.txt'), 'uncommitted');
  assert.throws(f.prepare, /Release checkout must identify a clean/);
});

test('release rejects dirty, stale or mixed core and tools provenance', t => {
  const f = fixture(t);
  f.editProof('provenance.json', { dirty: true });
  assert.throws(f.prepare, /Core provenance must identify a clean/);
  f.packAll(); f.editProof('provenance.json', { source: 'c'.repeat(40) });
  assert.throws(f.prepare, /Core provenance does not match/);
  f.packAll(); f.editProof('tools-manifest.json', { source_tree: 'd'.repeat(40) });
  assert.throws(f.prepare, /Tools provenance does not match/);
  f.packAll(); f.editProof('tools-manifest.json', { dirty: true });
  assert.throws(f.prepare, /Tools provenance must identify a clean/);
});

test('release rejects changed archives even when their version labels still match', t => {
  const f = fixture(t), path = join(f.root, 'dist/tendriller-sdk-1.2.3.tgz');
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('changed')]));
  assert.throws(f.prepare, /does not match recorded artifact bytes/);
});

test('release inspects packed advertised exports and their targets', t => {
  const f = fixture(t);
  delete f.files.sdk['package.json'].exports['./assistant']; f.packAll();
  assert.throws(f.prepare, /SDK is missing an advertised public export/);
  f.files.sdk['package.json'].exports['./assistant'] = { types: './index.mjs' }; f.packAll();
  assert.throws(f.prepare, /SDK is missing an advertised public export/);
  f.files.sdk['package.json'].exports['./assistant'] = './missing.mjs'; f.packAll();
  assert.throws(f.prepare, /SDK export points to an unpackaged file/);
});

test('release rejects tools built against a different runtime', t => {
  const f = fixture(t);
  f.files.tools['package.json'].tendriller.runtime = 'e'.repeat(64); f.packAll();
  assert.throws(f.prepare, /Packed runtime and tools identities must match/);
});

test('release verifies actual runtime asset bytes against their content-addressed metadata', t => {
  const f = fixture(t);
  const runtime = runtimeManifest({ version: f.version, contract: f.contract,
    assets: [{ path: 'index.mjs', sha256: digest('original'), size: 8 }], resources: [] });
  f.files.runtime['assets/manifest.json'] = runtime;
  f.files.runtime['assets/index.mjs'] = 'changed!';
  f.packAll();
  assert.throws(f.prepare, /Packed runtime asset does not match/);
});

test('release rejects a stale served starter even with a matching core version', t => {
  const f = fixture(t), directory = join(f.root, '.build/stale');
  mkdirSync(directory);
  for (const file of TUTORIAL_FILES) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), file === 'assistant.mjs' ? 'stale' : readFileSync(tutorialSource(f.root, file)));
  }
  execFileSync('tar', ['-czf', join(f.root, 'server/public/downloads/tendriller-first-app.tgz'), '-C', directory, ...TUTORIAL_FILES]);
  assert.throws(f.prepare, /Starter source is stale: assistant.mjs/);
});

test('first-app composition rejects dirty or SQL-only companion packages', t => {
  assert.throws(fixture(t, { sessionDirty: true }).prepare, /Chronolog session dependency must identify a clean/);
  assert.throws(fixture(t, { sqlEngines: ['native'] }).prepare, /requires the pinned SQL-free/);
});

test('different package bytes produce a different complete composition identity', t => {
  const f = fixture(t), original = f.prepare().composition.id;
  f.files.tools['index.mjs'] += '\nexport const changed = true;'; f.packAll();
  assert.notEqual(f.prepare().composition.id, original);
});

test('deployment sealing restores all qualified bytes and rejects tampering and extra served files', async t => {
  const { sealDeployment, restoreDeployment, verifyRestoredDeployment } = await import('../deployment-bundle.mjs');
  const f = fixture(t);
  f.prepare();
  for (const path of ['dist/engine', 'dist/runtime', 'dist/sdk', 'dist/tools']) {
    mkdirSync(join(f.root, path), { recursive: true });
    writeFileSync(join(f.root, path, 'qualified.mjs'), `exact ${path} bytes`);
  }
  const manifest = sealDeployment(f.root);
  const expectedHash = digest(readFileSync(join(f.root, 'dist/manifest.json')));
  assert.equal(manifest.artifacts.at(-1).role, 'deployment');
  verifyReleaseArtifacts(f.root, manifest);
  writeFileSync(join(f.root, 'server/public/stale.html'), 'unqualified');
  assert.throws(() => verifyRestoredDeployment(f.root, expectedHash), /differ from the qualified bundle/);
  rmSync(join(f.root, 'dist/engine'), { recursive: true });
  restoreDeployment(f.root, expectedHash);
  verifyRestoredDeployment(f.root, expectedHash);
  assert.equal(readFileSync(join(f.root, 'dist/engine/qualified.mjs'), 'utf8'), 'exact dist/engine bytes');
  assert.throws(() => readFileSync(join(f.root, 'server/public/stale.html')), /ENOENT/);
  assert.throws(() => restoreDeployment(f.root, '0'.repeat(64)), /manifest SHA-256 mismatch/);
  writeFileSync(join(f.root, 'dist/tendriller-deployment.tgz'), 'tampered');
  assert.throws(() => restoreDeployment(f.root, expectedHash), /does not match manifest/);
});

test('release URLs are source qualified even when package version is unchanged', t => {
  const f = fixture(t), manifest = f.prepare();
  for (const item of manifest.artifacts)
    assert.equal(item.url, `https://github.com/werg/tendriller/releases/download/source-${f.identity.source}/${item.file}`);
});

test('publication verification rejects version-derived URLs even with unchanged artifact bytes', t => {
  const f = fixture(t), manifest = f.prepare();
  manifest.artifacts[0].url = `https://github.com/werg/tendriller/releases/download/v${f.version}/${manifest.artifacts[0].file}`;
  assert.throws(() => verifyReleaseArtifacts(f.root, manifest), /canonical source-qualified URLs/);
});

test('source-qualified graph carries the current plugin guidance and detects ZIP tampering', t => {
  const f = fixture(t), manifest = f.prepare();
  const plugin = manifest.artifacts.find(item => item.role === 'plugin');
  assert.equal(plugin.file, 'tendriller-chatgpt-plugin.zip');
  assert.equal(plugin.type, 'application/zip');
  assert.equal(plugin.url, `https://github.com/werg/tendriller/releases/download/source-${f.identity.source}/${plugin.file}`);
  const skill = 'skills/connect-tendriller/SKILL.md';
  assert.deepEqual(execFileSync('unzip', ['-p', join(f.root, 'dist', plugin.file), skill]),
    readFileSync(join(f.root, 'plugin', skill)));
  assert.deepEqual(execFileSync('unzip', ['-Z1', join(f.root, 'dist', plugin.file)], { encoding: 'utf8' }).trim().split('\n'),
    ['review/review-app.mjs', 'review/review-domain.mjs', 'review/review-assistant.mjs',
      'review/review-local.mjs', 'review/review-page.mjs', 'review/review-worker.mjs', 'review/review-index.html',
      'review/support/participant-lifecycle.mjs', 'review/support/native-session.mjs', 'review/support/cli-lifetime.mjs',
      'review/support/prepare-host.mjs', 'review/support/browser-bootstrap.mjs', 'review/support/browser-profile.mjs',
      'review/support/provisioning-view.mjs', 'plugin.json', 'mcp.json', 'assets/icon.png', skill]);
  assert.deepEqual(execFileSync('unzip', ['-p', join(f.root,'dist',plugin.file), 'review/support/participant-lifecycle.mjs']), readFileSync(join(f.root,'docs/tutorial/helpers/participant-lifecycle.mjs')));
  writeFileSync(join(f.root, 'dist', plugin.file), 'stale or altered guidance');
  assert.throws(() => verifyReleaseArtifacts(f.root, manifest), /does not match manifest/);
});


test('plugin ZIP identity is independent of checkout file permissions', async t => {
  const { buildPlugin } = await import('../../plugin/build.mjs');
  const f=fixture(t), first=join(f.root,'dist/plugin-first.zip'), second=join(f.root,'dist/plugin-second.zip');
  const skill=join(f.root,'plugin/skills/connect-tendriller/SKILL.md');
  chmodSync(skill,0o664);buildPlugin(f.root,first);chmodSync(skill,0o644);buildPlugin(f.root,second);
  assert.deepEqual(readFileSync(first),readFileSync(second));
});

test('sealing omits development runtime residue while restored-graph checks reject any extra bytes', async t => {
  const { sealDeployment, restoreDeployment, verifyRestoredDeployment } = await import('../deployment-bundle.mjs');
  const f=fixture(t);f.prepare();
  for(const path of ['dist/engine','dist/runtime','dist/sdk','dist/tools']) {mkdirSync(join(f.root,path),{recursive:true});writeFileSync(join(f.root,path,'bytes.mjs'),'qualified');}
  const old='f'.repeat(64), oldPath=join(f.root,'server/public/_tendril/runtime',old);
  mkdirSync(oldPath,{recursive:true});writeFileSync(join(oldPath,'stale.mjs'),'previous immutable runtime');
  const manifest=sealDeployment(f.root), expectedHash=digest(readFileSync(join(f.root,'dist/manifest.json')));
  const archive=readFileSync(join(f.root,'dist/tendriller-deployment.tgz'));
  assert.equal(execFileSync('tar',['-tzf',join(f.root,'dist/tendriller-deployment.tgz')],{encoding:'utf8'}).includes(old),false);
  rmSync(oldPath,{recursive:true}); f.prepare();sealDeployment(f.root);
  assert.deepEqual(readFileSync(join(f.root,'dist/tendriller-deployment.tgz')),archive);
  assert.equal(digest(readFileSync(join(f.root,'dist/manifest.json'))),expectedHash);
  restoreDeployment(f.root,expectedHash);verifyRestoredDeployment(f.root,expectedHash);
  mkdirSync(oldPath,{recursive:true});writeFileSync(join(oldPath,'stale.mjs'),'injected after restore');
  assert.throws(()=>verifyRestoredDeployment(f.root,expectedHash),/differ from the qualified bundle/);
  assert(manifest.artifacts.some(item=>item.role==='deployment'));
});


test('release requires the native factory and normal exact RTC dependency in the default session', t => {
  assert.throws(fixture(t, { nativeRtc: false }).prepare, /default session must include native RTC/);
  assert.throws(fixture(t, { werift: '^0.27.0' }).prepare, /normal pinned werift@0.27.0 dependency/);
});


test('release rejects a stale deployment launcher in the served starter before sealing the kit', t => {
  const f = fixture(t), directory = join(f.root, '.build/stale-deploy');
  for (const file of TUTORIAL_FILES) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), file === 'deploy/participant.mjs' ? 'stale launcher' : readFileSync(tutorialSource(f.root, file)));
  }
  execFileSync('tar', ['-czf', join(f.root, 'server/public/downloads/tendriller-first-app.tgz'), '-C', directory, ...TUTORIAL_FILES]);
  assert.throws(f.prepare, /Starter source is stale: deploy\/participant\.mjs/);
});
