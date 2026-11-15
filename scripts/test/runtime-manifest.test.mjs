import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeManifest, verifyRuntimeManifest } from '../runtime-manifest.mjs';

test('release labels and on-demand dependencies cannot change at an immutable runtime URL', () => {
  const input = { version: '0.2.0-rc.1', contract: 2, assets: [{path:'tendril.js',sha256:'a'.repeat(64),type:'text/javascript',size:1}], resources: [] };
  const first = runtimeManifest(input);
  assert.deepEqual(verifyRuntimeManifest(first), first);
  assert.equal(runtimeManifest(input).id, first.id);
  for (const patch of [{version:'0.2.0-rc.2'}, {contract:3}, {resources:[{url:'_tendril/assets/'+ 'b'.repeat(64)+'/engine.wasm',sha256:'b'.repeat(64),type:'application/wasm'}]}]) {
    assert.notEqual(runtimeManifest({...input,...patch}).id, first.id);
    assert.throws(() => verifyRuntimeManifest({...first,...patch}), /identity/);
  }
});
