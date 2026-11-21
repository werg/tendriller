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

test('private metadata serialization failure removes its temporary file',async t=>{
  const {writePrivateJsonAtomic}=await import('../../session/ipc.mjs');
  const {readdir}=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'ipc-serialization-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await assert.rejects(writePrivateJsonAtomic(root,'state.json',{unsupported:1n}),TypeError);
  assert.deepEqual(await readdir(root),[]);
});

test('concurrent stale reclaimers cannot remove the winning live lock',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ipc-reclaim-race-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'owner.lock'),JSON.stringify({version:1,lockId:'dead',pid:999999999,hostId:hostname()}),{mode:0o600});
  // Both contenders finish the stale endpoint probe before either reclaims.
  let arrivals=0,release;const barrier=new Promise(resolve=>release=resolve);
  const probeReachable=async()=>{if(++arrivals===2)release();await barrier;return false;};
  const results=await Promise.allSettled([acquireAtomicLock(root,{probeReachable}),acquireAtomicLock(root,{probeReachable})]);
  const winners=results.filter(result=>result.status==='fulfilled');
  try {
    assert.equal(winners.length,1);
    const current=JSON.parse(await readFile(join(root,'owner.lock'),'utf8'));
    assert.equal(current.lockId,winners[0].value.lockId);assert.equal(current.pid,process.pid);
  } finally {await Promise.all(winners.map(result=>result.value.release()));}
});

test('incomplete and foreign-host locks are never guessed dead',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ipc-unverified-lock-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'owner.lock'),'',{mode:0o600});
  await assert.rejects(acquireAtomicLock(root,{probeReachable:async()=>false}),{code:'OWNER_BUSY'});
  const foreign=JSON.stringify({lockId:'foreign',pid:999999999,hostId:'different-host',heartbeatAt:1});
  await writeFile(join(root,'owner.lock'),foreign);
  await assert.rejects(acquireAtomicLock(root,{probeReachable:async()=>false}),{code:'INSTANCE_UNRESPONSIVE'});
  assert.equal(await readFile(join(root,'owner.lock'),'utf8'),foreign);
});
