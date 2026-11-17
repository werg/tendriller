import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs, intFlag } from '../lib/args.mjs';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile), cli = fileURLToPath(new URL('../bin/tendril.mjs', import.meta.url));
test('CLI accepts explicit stable operation flags and refuses missing values', () => {
  assert.deepEqual(parseArgs(['command', 'claim', '{}', '--operation', 'claim-1', '--saved']), {
    cmd: 'command', args: ['claim', '{}'], flags: { operation: 'claim-1', saved: true },
  });
  assert.throws(() => parseArgs(['command', 'claim', '{}', '--operation']), /needs a value/);
  assert.throws(() => intFlag('1.5', 'timeout', 30), /safe integer/);
});
test('public CLI advertises one session and rejects removed host data commands before opening a session', async () => {
  const result = await run(process.execPath, [cli, '--help']);
  assert.match(result.stdout, /--session/); assert.match(result.stdout, /publish <directory>/);
  assert.doesNotMatch(result.stdout, /state get|events socket|scopes register|collector spool/);
  for (const command of ['state', 'stream', 'workflow', 'ack', 'rollback']) {
    await assert.rejects(run(process.execPath, [cli, command]), error => error.code === 64 && /Unknown command/.test(error.stderr));
  }
});
test('reapplication cannot be issued without a reviewed revision', async () => {
  await assert.rejects(run(process.execPath, [cli, 'reapply', 'old', 'claim', '{}', '--operation', 'new']),
    error => error.code === 64 && /--based-on/.test(error.stderr));
});
