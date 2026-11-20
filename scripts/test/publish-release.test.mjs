import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

const fakeGh = `#!/usr/bin/env node
import {copyFileSync,existsSync,readFileSync,readdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {basename,join} from 'node:path';
const args=process.argv.slice(2),root=process.env.TEST_RELEASE_ROOT;
appendFileSync(join(root,'commands.jsonl'),JSON.stringify(args)+'\\n');
const ref=join(root,'ref.json'),release=join(root,'release'),assets=join(root,'assets');
const json=value=>console.log(JSON.stringify(value));
const error=code=>{console.error('gh: request failed (HTTP '+code+')');process.exit(1)};
if(args[0]==='api'){
 if(existsSync(join(root,'api-error')))error(readFileSync(join(root,'api-error'),'utf8'));
 if(args[1].includes('/git/ref/tags/')){
  if(!existsSync(ref))error(404);json(JSON.parse(readFileSync(ref,'utf8')));
 }else if(args[1].includes('/git/tags/')){
  const annotations=JSON.parse(readFileSync(join(root,'annotations.json'),'utf8'));
  json({object:annotations[args[1].split('/').at(-1)]});
 }else if(args[1].includes('/releases/tags/')){
  if(!existsSync(release))error(404);
  json({tag_name:readFileSync(release,'utf8'),assets:readdirSync(assets).map(name=>({name}))});
 }else process.exit(2);
}else if(args[1]==='create'){
 if(existsSync(release)||!args.includes('--target'))process.exit(1);
 const sha=existsSync(join(root,'race-sha'))?readFileSync(join(root,'race-sha'),'utf8'):args[args.indexOf('--target')+1];
 if(!existsSync(ref))writeFileSync(ref,JSON.stringify({ref:'refs/tags/'+args[2],object:{type:'commit',sha}}));
 writeFileSync(release,args[2]);
}else if(args[1]==='download'){
 const name=args[args.indexOf('--pattern')+1],directory=args[args.indexOf('--dir')+1];
 copyFileSync(join(assets,name),join(directory,name));
}else if(args[1]==='upload'){
 const destination=join(assets,basename(args[3]));if(existsSync(destination))process.exit(1);
 copyFileSync(args[3],destination);
}else process.exit(2);
`;

function fixture(t) {
  const scratch = resolve(import.meta.dirname, '../../.build');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'dist', 'publisher', 'remote/assets']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['publish-release.mjs', 'release-composition.mjs', 'onboarding.mjs', 'runtime-manifest.mjs'])
    copyFileSync(new URL('../' + file, import.meta.url), join(root, 'publisher', file));
  writeFileSync(join(root, 'bin/gh'), fakeGh); chmodSync(join(root, 'bin/gh'), 0o755);
  writeFileSync(join(root, 'bin/package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(join(root, '.gitignore'), 'bin/\ndist/\nremote/\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release@example.test', 'commit', '-qm', 'Fixture source'], { cwd: root });
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const component = (role, file, value) => {
    const bytes = Buffer.from(typeof value === 'object' ? JSON.stringify(value) : value);
    writeFileSync(join(root, 'dist', file), bytes);
    return { role, file, size: bytes.length, sha256: digest(bytes) };
  };
  const identity = { repository: 'werg/tendriller', source, sourceTree, dirty: false };
  const components = ['sdk', 'runtime', 'engine', 'tools', 'session', 'starter'].map(role =>
    component(role, role === 'tools' ? 'tool.mjs' : role + '.tgz', `immutable ${role} bytes\n`));
  const chronolog = { repository: 'werg/chronolog-db', source: 'a'.repeat(40), sourceTree: 'b'.repeat(40), dirty: false };
  const compositionBody = { format: 'tendriller-release-composition-v1', version: '1.2.3', contract: 3,
    core: identity, runtime: 'c'.repeat(64), chronolog: { session: chronolog, generation: chronolog }, components };
  const composition = { ...compositionBody, id: digest(JSON.stringify(compositionBody)) };
  const artifacts = [...components, component('composition', 'composition.json', composition),
    component('first-app', 'first-app.tgz', 'complete first-app bytes'),
    component('core-provenance', 'provenance.json', { ...identity, artifacts: components.filter(item => ['sdk', 'runtime', 'engine'].includes(item.role)) }),
    component('tools-provenance', 'tools-manifest.json', { version: '1.2.3', contract: 3, runtime: composition.runtime,
      source_commit: source, source_tree: sourceTree, dirty: false, artifacts: components.filter(item => item.role === 'tools') })];
  const manifest = { format: 'tendriller-core-release', version: '1.2.3', contract: 3, runtime: composition.runtime,
    source_commit: source, source_tree: sourceTree, composition: { id: composition.id, file: 'composition.json' },
    first_app: { file: 'first-app.tgz', profile: 'events', packages: ['sdk', 'tools', 'session'] }, artifacts };
  writeFileSync(join(root, 'dist/manifest.json'), JSON.stringify(manifest));
  const commands = () => existsSync(join(root, 'remote/commands.jsonl'))
    ? readFileSync(join(root, 'remote/commands.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return {
    root, source, manifest, commands, files: artifacts.map(item => item.file), composition,
    publish: (ref = 'refs/heads/release/v1.2.3', extraFiles = [], env = {}) => spawnSync(process.execPath, [join(root, 'publisher/publish-release.mjs'), ref, ...extraFiles], {
      encoding: 'utf8', env: { ...process.env, TMPDIR: root, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TEST_RELEASE_ROOT: join(root, 'remote'), GITHUB_SHA: source, ...env },
    }),
    setTag: (sha = source, type = 'commit') => writeFileSync(join(root, 'remote/ref.json'), JSON.stringify({ ref: 'refs/tags/v1.2.3', object: { type, sha } })),
    setRelease: () => writeFileSync(join(root, 'remote/release'), 'v1.2.3'),
    setManifest: changes => writeFileSync(join(root, 'dist/manifest.json'), JSON.stringify({ ...manifest, ...changes })),
    uploads: () => commands().filter(command => command[1] === 'upload').map(command => basename(command[3])),
  };
}

test('a release branch creates its absent tag at the exact checked-out source and publishes the manifest last', t => {
  const f = fixture(t), result = f.publish();
  assert.equal(result.status, 0, result.stderr);
  const create = f.commands().find(command => command[1] === 'create');
  assert.equal(create[create.indexOf('--target') + 1], f.source);
  assert.equal(create.includes('--verify-tag'), false);
  assert.deepEqual(f.uploads(), [...f.files, 'manifest.json']);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'remote/ref.json'), 'utf8')).object.sha, f.source);
});

test('an exact existing tag can create a release without changing the tag', t => {
  const f = fixture(t);
  f.setTag();
  const before = readFileSync(join(f.root, 'remote/ref.json'), 'utf8');
  const result = f.publish('refs/tags/v1.2.3');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.root, 'remote/ref.json'), 'utf8'), before);
});

test('annotated tags are resolved to their source commit', t => {
  const f = fixture(t), annotation = 'a'.repeat(40), nested = 'b'.repeat(40);
  f.setTag(annotation, 'tag');
  writeFileSync(join(f.root, 'remote/annotations.json'), JSON.stringify({
    [annotation]: { type: 'tag', sha: nested }, [nested]: { type: 'commit', sha: f.source },
  }));
  const result = f.publish('refs/tags/v1.2.3');
  assert.equal(result.status, 0, result.stderr);
});

test('release publication verifies existing assets and uploads only missing names', t => {
  const f = fixture(t);
  f.setTag(); f.setRelease();
  copyFileSync(join(f.root, 'dist/tool.mjs'), join(f.root, 'remote/assets/tool.mjs'));
  const result = f.publish();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.commands().filter(command => command[1] === 'download').length, 1);
  assert.deepEqual(f.uploads(), [...f.files.filter(file => file !== 'tool.mjs'), 'manifest.json']);
  writeFileSync(join(f.root, 'remote/commands.jsonl'), '');
  assert.equal(f.publish('refs/tags/v1.2.3').status, 0);
  assert.equal(f.commands().filter(command => command[1] === 'download').length, f.files.length + 1);
  assert.deepEqual(f.uploads(), []);
});

test('additional release metadata is verified and uploaded before discovery', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'dist/SHA256SUMS'), `${f.manifest.artifacts[0].sha256}  tool.mjs\n`);
  const result = f.publish('refs/heads/release/v1.2.3', ['SHA256SUMS']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.uploads(), [...f.files, 'SHA256SUMS', 'manifest.json']);
});

test('mismatched published bytes stop publication before any missing asset is uploaded', t => {
  const f = fixture(t);
  f.setTag(); f.setRelease();
  writeFileSync(join(f.root, 'remote/assets/manifest.json'), 'different bytes');
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Published release asset differs/);
  assert.deepEqual(f.uploads(), []);
});

test('corrupt local artifacts are rejected before invoking the release API', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'dist/tool.mjs'), 'corrupt local bytes');
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match manifest/);
  assert.deepEqual(f.commands(), []);
});

test('publication refuses a checkout changed after release preparation', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: '1.2.3', uncommitted: true }));
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release checkout must identify a clean/);
  assert.deepEqual(f.commands(), []);
});

test('publication refuses an incomplete composition before creating a release', t => {
  const f = fixture(t);
  for (const role of ['sdk', 'runtime', 'engine', 'tools', 'session', 'starter', 'composition', 'first-app', 'core-provenance', 'tools-provenance']) {
    f.setManifest({ artifacts: f.manifest.artifacts.filter(item => item.role !== role) });
    const result = f.publish();
    assert.notEqual(result.status, 0, role);
    assert.match(result.stderr, /must contain the complete/);
  }
  assert.deepEqual(f.commands(), []);
});

test('publication verifies composition identity even after outer checksums are replaced', t => {
  const f = fixture(t);
  const bytes = Buffer.from(JSON.stringify({ ...f.composition, runtime: 'd'.repeat(64) }));
  writeFileSync(join(f.root, 'dist/composition.json'), bytes);
  f.setManifest({ artifacts: f.manifest.artifacts.map(item => item.role !== 'composition' ? item :
    { ...item, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) });
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /composition identity does not match/);
  assert.deepEqual(f.commands(), []);
});

test('publication refuses a mismatched graph even with matching manifest and composition digests', t => {
  const f = fixture(t), { id: _id, ...body } = f.composition;
  body.components = body.components.map(item => item.role === 'session' ? { ...item, sha256: 'e'.repeat(64) } : item);
  const id = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const bytes = Buffer.from(JSON.stringify({ ...body, id }));
  writeFileSync(join(f.root, 'dist/composition.json'), bytes);
  f.setManifest({ composition: { file: 'composition.json', id }, artifacts: f.manifest.artifacts.map(item => item.role !== 'composition' ? item :
    { ...item, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) });
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /same complete component graph/);
  assert.deepEqual(f.commands(), []);
});

test('only exact package-version tags and release branches can publish', t => {
  const f = fixture(t);
  for (const ref of ['refs/heads/main', 'refs/heads/release/v1.2.4', 'refs/heads/release/v1.2.3/extra', 'refs/tags/v1.2.4', 'v1.2.3']) {
    const result = f.publish(ref);
    assert.notEqual(result.status, 0, ref);
    assert.match(result.stderr, /release ref must be/);
  }
  assert.deepEqual(f.commands(), []);
});

test('manifest and package versions must agree before the release API is invoked', t => {
  const f = fixture(t);
  f.setManifest({ version: '1.2.4' });
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest version must match package.json/);
  assert.deepEqual(f.commands(), []);
});

test('manifest and workflow source must both equal checked-out HEAD', t => {
  const f = fixture(t);
  f.setManifest({ source_commit: 'a'.repeat(40) });
  assert.notEqual(f.publish().status, 0);
  f.setManifest({});
  const result = f.publish('refs/heads/release/v1.2.3', [], { GITHUB_SHA: 'b'.repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact checked-out source commit/);
  assert.deepEqual(f.commands(), []);
});

test('an existing tag at a different commit is never moved or published', t => {
  const f = fixture(t);
  f.setTag('a'.repeat(40));
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing tags are never moved/);
  assert.equal(f.commands().some(command => command[0] === 'release'), false);
});

test('the tag target is checked again after release creation before uploading assets', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'remote/race-sha'), 'a'.repeat(40));
  const result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact tested source commit/);
  assert.deepEqual(f.uploads(), []);
});

test('API authorization and network failures never masquerade as missing releases', t => {
  const f = fixture(t);
  for (const code of ['403', '500']) {
    writeFileSync(join(f.root, 'remote/api-error'), code);
    const result = f.publish();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`HTTP ${code}`));
  }
  assert.equal(f.commands().some(command => command[0] === 'release'), false);
});
