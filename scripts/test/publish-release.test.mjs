import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
  const root = mkdtempSync(join(tmpdir(), 'release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'dist', 'publisher', 'remote/assets']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(new URL('../publish-release.mjs', import.meta.url), join(root, 'publisher/publish-release.mjs'));
  writeFileSync(join(root, 'bin/gh'), fakeGh); chmodSync(join(root, 'bin/gh'), 0o755);
  writeFileSync(join(root, 'bin/package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release@example.test', 'commit', '-qm', 'Fixture source', '--allow-empty'], { cwd: root });
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const bytes = Buffer.from('immutable release bytes\n');
  const manifest = { version: '1.2.3', source_commit: source, artifacts: [{ file: 'tool.mjs', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  writeFileSync(join(root, 'dist/tool.mjs'), bytes);
  writeFileSync(join(root, 'dist/manifest.json'), JSON.stringify(manifest));
  const commands = () => existsSync(join(root, 'remote/commands.jsonl'))
    ? readFileSync(join(root, 'remote/commands.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return {
    root, source, manifest, commands,
    publish: (ref = 'refs/heads/release/v1.2.3', extraFiles = [], env = {}) => spawnSync(process.execPath, [join(root, 'publisher/publish-release.mjs'), ref, ...extraFiles], {
      encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TEST_RELEASE_ROOT: join(root, 'remote'), GITHUB_SHA: source, ...env },
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
  assert.deepEqual(f.uploads(), ['tool.mjs', 'manifest.json']);
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
  assert.deepEqual(f.uploads(), ['manifest.json']);
  writeFileSync(join(f.root, 'remote/commands.jsonl'), '');
  assert.equal(f.publish('refs/tags/v1.2.3').status, 0);
  assert.equal(f.commands().filter(command => command[1] === 'download').length, 2);
  assert.deepEqual(f.uploads(), []);
});

test('additional release metadata is verified and uploaded before discovery', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'dist/SHA256SUMS'), `${f.manifest.artifacts[0].sha256}  tool.mjs\n`);
  const result = f.publish('refs/heads/release/v1.2.3', ['SHA256SUMS']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.uploads(), ['tool.mjs', 'SHA256SUMS', 'manifest.json']);
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
