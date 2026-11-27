import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tendriller-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  for (const name of ['scripts', 'server/src', 'runtime/src', 'contract', 'dist/sdk']) mkdirSync(join(root, name), { recursive: true });
  copyFileSync(resolve(import.meta.dirname, '../check-boundaries.mjs'), join(root, 'scripts/check-boundaries.mjs'));
  write('server/src/authority.ts', "import {verifyFinalityV2} from '@chronolog/authority';\n");
  write('dist/engine/inputs.json', ['server/src/index.ts', 'node_modules/@chronolog/authority/index.mjs']);
  write('dist/engine/worker.mjs', 'export default {};\n');
  write('dist/sdk/client.mjs', 'export const client = true;\n');
  write('dist/runtime/inputs.json', ['runtime/src/kernel.ts']);
  write('dist/tools-inputs.json', ['tools/cli/lib/session.mjs', 'node_modules/@chronolog/authority/index.mjs', 'node_modules/@chronolog/peer-session/browser.mjs']);
  return { write, run: () => spawnSync(process.execPath, [join(root, 'scripts/check-boundaries.mjs')], { encoding: 'utf8' }),
    succeed: () => execFileSync(process.execPath, [join(root, 'scripts/check-boundaries.mjs')], { encoding: 'utf8' }) };
}

test('portable authority is allowed in declared host controls and tools consume public companions', t => {
  assert.match(fixture(t).succeed(), /boundaries passed/);
});

for (const [name, file, source] of [
  ['host cannot import an application session', 'server/src/authority.ts', "import {createApplicationSession} from '@chronolog/peer-session';"],
  ['unrelated host files cannot import authority', 'server/src/unrelated.ts', "import {verifyFinalityV2} from '@chronolog/authority';"],
  ['browser runtime cannot import authority', 'runtime/src/kernel.ts', "import {verifyFinalityV2} from '@chronolog/authority';"],
  ['retired ordering packages are not authority', 'server/src/authority.ts', "import {select} from '@chronolog/peer-generation/control';"],
  ['host cannot import tools', 'server/src/authority.ts', "import {pack} from '../../tools/pack.mjs';"],
]) test(name, t => {
  const f = fixture(t); f.write(file, source);
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /imports application\/tool implementation/);
});

for (const [name, path] of [
  ['host cannot bundle native engine', 'node_modules/@chronolog/peer-session/native.mjs'],
  ['host cannot bundle a source checkout', '../chronolog/packages/peer-session/src/session.ts'],
  ['host cannot bundle retired controls', 'node_modules/@chronolog/peer-generation/control.mjs'],
]) test(name, t => {
  const f = fixture(t); f.write('dist/engine/inputs.json', ['node_modules/@chronolog/authority/index.mjs', path]);
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Worker includes application\/tool dependency/);
});

test('native imports cannot hide in the compiled host Worker', t => {
  const f = fixture(t); f.write('dist/engine/worker.mjs', "import fs from 'node:fs';\n");
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Unexpected native Worker dependency/);
});

for (const path of ['contract/application.mjs', 'server/src/authority.ts', '../chronolog/packages/peer-session/src/session.ts', 'node_modules/@chronolog/materializer/index.mjs'])
  test(`tools reject private application implementation: ${path}`, t => {
    const f = fixture(t); f.write('dist/tools-inputs.json', [path]);
    const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Tools must consume public artifacts/);
  });

test('browser kernel does not inherit optional application libraries', t => {
  const f = fixture(t); f.write('dist/runtime/inputs.json', ['runtime/src/kernel.ts', 'node_modules/@chronolog/peer-session/browser.mjs']);
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Browser kernel includes application\/tool dependency/);
});

test('SDK cannot accidentally publish private source trees', t => {
  const f = fixture(t); f.write('dist/sdk/server/private.mjs', 'export const privateCode = true;\n');
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SDK contains private implementation/);
});
