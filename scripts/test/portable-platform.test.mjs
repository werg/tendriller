// Builtins-only portability checks: these do not qualify SQL, WebRTC, or deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {listenLocalIpc,connectLocalIpc,acquireAtomicLock} from '../../session/ipc.mjs';
import {createPersistentOutbox} from '../../session/outbox.mjs';
import {probeCapabilities} from '../../contract/transport-probe.mjs';
import {packTarGz,unpackTarGz} from '../../contract/archive.mjs';
import {extractVerifiedTarGz} from '../../contract/release-verify.mjs';
import {createHash} from 'node:crypto';

for(const preferredTransport of ['auto','loopback-tcp'])test(`real ${preferredTransport} IPC connects, authenticates fallback and closes`,async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'portable-ipc-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const listener=await listenLocalIpc(directory,socket=>{socket.on('error',()=>{});socket.end('ready');},{preferredTransport});
  const {socket,descriptor}=await connectLocalIpc(directory);
  try {
    const chunks=[];socket.on('data',chunk=>chunks.push(chunk));
    await once(socket,'close');assert.equal(Buffer.concat(chunks).toString(),'ready');
    if(preferredTransport==='loopback-tcp'){
      assert.equal(descriptor.transport,'loopback-tcp');
      assert.equal(listener.verifyLoopbackToken(descriptor.token),true);
      assert.equal(listener.verifyLoopbackToken('0'.repeat(64)),false);
    }else assert.equal(descriptor.transport,process.platform==='win32'?'windows-named-pipe':'unix-socket');
    if(process.platform!=='win32')assert.equal((await stat(join(directory,'endpoint.json'))).mode&0o777,0o600);
  } finally {socket.destroy();await listener.close();}
});

test('outbox reopens the original attempt; extraction and locks need no shell tools',async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'portable-state-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const lock=await acquireAtomicLock(directory,{probeReachable:async()=>false});
  try{await assert.rejects(acquireAtomicLock(directory,{probeReachable:async()=>false}),{code:'INSTANCE_UNRESPONSIVE'});}finally{await lock.release();}
  const input={operationId:'original',appId:'app',deviceId:'device',command:'add',input:{text:'retained'}};
  await (await createPersistentOutbox(directory)).record(input);
  const reopened=await createPersistentOutbox(directory);assert.equal((await reopened.record(input)).operationId,'original');
  const archive=packTarGz([{path:'nested/file.txt',bytes:'portable'}]);
  assert.equal(new TextDecoder().decode(unpackTarGz(archive).get('nested/file.txt')),'portable');
  const result=extractVerifiedTarGz(archive,join(directory,'extract'),{expectedSha256:createHash('sha256').update(archive).digest('hex')});
  assert.deepEqual(result.written,['nested/file.txt']);
});

test('capability probe never infers a working SQL engine from WebAssembly presence',async t=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'portable-probe-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const report=await probeCapabilities({projectPath:directory,checkNetwork:false});
  assert.equal(report.runtime.sqlEngineValidated,false);
  assert.equal(report.runtime.sqlDefaultEngine,typeof WebAssembly==='object'?'unknown':'unavailable');
  assert.equal(report.networking.wssRelay443,'unknown');assert.equal(report.networking.https443,'unknown');
});
