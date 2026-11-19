import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('public collaboration declarations accept both session facades and expose typed verified records',()=>{
  const compiler=fileURLToPath(new URL('../../node_modules/.bin/tsc',import.meta.url));
  const result=spawnSync(compiler,['--noEmit','--strict','--module','nodenext',
    '--target','es2022','--lib','es2022,dom',fileURLToPath(new URL('./types.fixture.mts',import.meta.url))],
  {encoding:'utf8',cwd:fileURLToPath(new URL('../../',import.meta.url))});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
