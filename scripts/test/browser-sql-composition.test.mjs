import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyBrowserSqlSession } from '../release-composition.mjs';
import { readBrowserSqlPin } from '../session-pin.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('supplemental browser SQL pin requires explicit in-checkout bytes and rejects inferred or changed archives', t => {
  const root = mkdtempSync(join(tmpdir(), 'browser-sql-pin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'artifacts'));
  const bytes = Buffer.from('exact supplemental archive'), archive = 'artifacts/session-browser.tgz';
  writeFileSync(join(root, archive), bytes);
  const config = value => writeFileSync(join(root, 'scripts/sql-browser-session.json'), JSON.stringify(value));
  assert.throws(() => readBrowserSqlPin(root), /ENOENT/);
  config({ archive, sha256: hash(bytes) });
  assert.deepEqual(readBrowserSqlPin(root), { archive: join(root, archive), sha256: hash(bytes) });
  config({ archive: '../outside.tgz', sha256: hash(bytes) });
  assert.throws(() => readBrowserSqlPin(root), /IN_CHECKOUT/);
  config({ archive }); assert.throws(() => readBrowserSqlPin(root), /HASH_REQUIRED/);
  config({ archive, sha256: hash(bytes) }); writeFileSync(join(root, archive), 'changed');
  assert.throws(() => readBrowserSqlPin(root), /HASH_MISMATCH/);
});

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const identity = { repository: 'werg/chronolog', source: 'a'.repeat(40), sourceTree: 'b'.repeat(40), dirty: false };
  const files = new Map(Object.entries({ 'index.mjs': 'export {};' }).map(([name, text]) => [name, Buffer.from(text)]));
  const proof = { ...identity, format: 'chronolog-peer-session-package/v2', profile: 'chronolog-crdt-v2', zeroNativeBuild: true };
  const pkg = { name: '@chronolog/peer-session', exports: Object.fromEntries(['.', './browser', './worker', './kernel', './websocket'].map(key => [key, './index.mjs'])) };
  const archive = {
    package: pkg,
    has: name => files.has(name),
    read: name => { assert(files.has(name), `missing ${name}`); return files.get(name); },
    json: name => name === 'provenance.json' ? proof : JSON.parse(files.get(name).toString()),
  };
  return { identity, files, proof, pkg, verify: () => verifyBrowserSqlSession(archive, identity) };
}
test('portable browser SQL graph binds exact clean Chronolog v2 source without native engine', () => {
  const f = fixture(); assert.deepEqual(f.verify(), f.identity);
});
for (const [name, mutate] of [
  ['dirty source', f => { f.proof.dirty = true; }],
  ['source mismatch', f => { f.proof.source = 'c'.repeat(40); }],
  ['source tree mismatch', f => { f.proof.sourceTree = 'c'.repeat(40); }],
  ['native build', f => { f.proof.zeroNativeBuild = false; }],
  ['platform restriction', f => { f.pkg.os = ['linux']; }],
  ['better-sqlite3 dep', f => { f.pkg.dependencies = { 'better-sqlite3': '11.0.0' }; }],
  ['missing kernel export', f => { delete f.pkg.exports['./kernel']; }],
  ['legacy doltlite binary', f => { f.files.set('engine/build/Release/doltlite.node', Buffer.from('bin')); }],
]) test(`portable browser SQL rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(f.verify); });
