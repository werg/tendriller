import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir, hostname} from 'node:os';
import {join} from 'node:path';
import {acquireAtomicLock} from '../../session/ipc.mjs';

test('expired heartbeat never replaces a live same-host owner with unreachable IPC', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ipc-live-lock-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const record = {version:1,lockId:'original',pid:process.pid,hostId:hostname(),startedAt:1,heartbeatAt:1,leaseTtlMs:1000};
  await writeFile(join(root,'owner.lock'),JSON.stringify(record),{mode:0o600});
  await assert.rejects(acquireAtomicLock(root,{probeReachable:async()=>false}),{code:'INSTANCE_UNRESPONSIVE'});
  assert.deepEqual(JSON.parse(await readFile(join(root,'owner.lock'),'utf8')),record);
});
