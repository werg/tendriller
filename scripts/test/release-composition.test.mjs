import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { prepareRelease, REQUIRED_SDK_EXPORTS, sourceIdentity } from '../release-composition.mjs';
import { runtimeManifest } from '../runtime-manifest.mjs';
import { TUTORIAL_FILES } from '../onboarding.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function fixture(t, { sessionDirty = false, sqlEngines = [] } = {}) {
  const scratch = resolve(import.meta.dirname, '../../.build');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'composition-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['dist', '.build', 'server/public/downloads', 'docs/tutorial']) mkdirSync(join(root, directory), { recursive: true });
  const version = '1.2.3', contract = 3;
  writeFileSync(join(root, '.gitignore'), 'dist/\n.build/\nserver/public/\n');
  writeJson(join(root, 'package.json'), { version, devDependencies: { '@chronolog/peer-session': 'file:session.tgz' } });
  for (const file of TUTORIAL_FILES) {
    mkdirSync(dirname(join(root, 'docs/tutorial', file)), { recursive: true });
    writeFileSync(join(root, 'docs/tutorial', file), `fixture ${file}\n`);
  }
  const chronolog = { repository: 'werg/chronolog-db', source: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
    dirty: false, profile: 'peer-generation-v1' };
  const pack = (name, files, destination) => {
    const directory = join(root, '.build', name);
    rmSync(directory, { recursive: true, force: true });
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, 'package', file)), { recursive: true });
      writeFileSync(join(directory, 'package', file), typeof content === 'string' ? content : JSON.stringify(content));
    }
    execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', destination, '-C', directory, 'package']);
  };
  pack('session', { 'package.json': { name: '@chronolog/peer-session', exports: Object.fromEntries(['.', './native', './browser', './worker'].map(key => [key, './index.mjs'])) },
    'index.mjs': 'export const session = true;', 'provenance.json': { ...chronolog, dirty: sessionDirty, sqlEngines } }, join(root, 'session.tgz'));
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
    engine: { 'package.json': { ...metadata('@tendriller/engine'), exports: { '.': './index.mjs', './provenance': './provenance.json', './peer-generation-provenance': './peer-generation-provenance.json' } },
      'index.mjs': 'export const engine = true;', 'provenance.json': { ...identity, files: { 'index.mjs': digest('export const engine = true;') } }, 'peer-generation-provenance.json': chronolog },
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
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf',
    join(root, 'server/public/downloads/tendriller-first-app.tgz'), '-C', join(root, 'docs/tutorial'), ...TUTORIAL_FILES]);
  return { root, version, contract, identity, runtime, files, packAll, prepare: () => prepareRelease({ root, version, contract }),
    editProof(name, changes) { const path = join(root, 'dist', name); writeJson(path, { ...readJson(path), ...changes }); } };
}

test('release identity binds actual package bytes, starter, companion and complete install archive deterministically', t => {
  const f = fixture(t), manifest = f.prepare();
  const composition = readJson(join(f.root, 'dist/composition.json'));
  const { id, ...body } = composition;
  assert.equal(id, digest(JSON.stringify(body)));
  assert.equal(manifest.composition.id, id);
  assert.deepEqual(composition.components.map(item => item.role), ['sdk', 'runtime', 'engine', 'tools', 'session', 'starter']);
  assert.equal(composition.core.source, f.identity.source);
  assert.equal(composition.chronolog.session.source, 'a'.repeat(40));
  const archive = join(f.root, 'dist', manifest.first_app.file);
  for (const file of TUTORIAL_FILES)
    assert.equal(execFileSync('tar', ['-xOf', archive, file]).toString(), readFileSync(join(f.root, 'docs/tutorial', file), 'utf8'));
  for (const component of composition.components.filter(item => ['sdk', 'tools', 'session'].includes(item.role)))
    assert.equal(digest(execFileSync('tar', ['-xOf', archive, `packages/${component.file}`])), component.sha256);
  const bytes = digest(readFileSync(archive));
  assert.deepEqual(f.prepare(), manifest);
  assert.equal(digest(readFileSync(archive)), bytes);
  for (const item of manifest.artifacts) assert.equal(digest(readFileSync(join(f.root, 'dist', item.file))), item.sha256);
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
    writeFileSync(join(directory, file), file === 'assistant.mjs' ? 'stale' : readFileSync(join(f.root, 'docs/tutorial', file)));
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
