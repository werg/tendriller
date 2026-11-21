import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompositionV2 } from '../release-composition.mjs';

test('profile metadata cannot promise SQL while omitting its required engine capability', () => {
  for (const spec of [null, { sql: true, nativeRtc: false }, { sql: true, nativeRtc: false, wasmSql: true, nativeSql: true }]) {
    assert.throws(() => buildCompositionV2({ profiles: { 'sql-portable-relay-only': spec } }), /capabilities/);
  }
});
test('profile components bind immutable file names, sizes and digests', () => {
  const profile = { sql: false, nativeRtc: false };
  for (const component of [{ file: '../escape.tgz', sha256: 'a'.repeat(64), size: 1 }, { file: 'kit.tgz', size: 1 }, { file: 'kit.tgz', sha256: 'a'.repeat(64), size: 0 }]) {
    assert.throws(() => buildCompositionV2({ profiles: { 'events-relay-only': { ...profile, components: [component] } } }), /exact component/);
  }
});
