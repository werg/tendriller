import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFilePath } from '../paths.mjs';
test('publication paths preserve canonical Unicode and reject aliases and reserved routes', () => {
  for (const path of ['inputs/über.csv', 'a/b', '測定/🌒.txt']) assert.equal(assertFilePath(path), path);
  for (const path of ['', '/absolute', '../a', 'a/../b', 'a/./b', 'a//b', 'a/', './a', '_tendril/settings',
    '_publications/2/a', 'a\\b', 'x\u0000y', 'a\u007fy', 'u\u0308ber.csv', 'high\ud800.txt', 'low\udfff.txt'])
    assert.throws(() => assertFilePath(path), TypeError, path);
});
