import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerlessHostAdapter} from '../../contract/serverless.mjs';
import {handleFor} from './serverless-fixtures.mjs';
const id='a'.repeat(64);
const request=body=>new Request(`https://test/v1/apps/${id}/commands`,{method:'POST',body:JSON.stringify(body)});
const storage={get:async()=>null,put:async()=>{}};
function ownerLock(){let tail=Promise.resolve();return(_id,work)=>{const next=tail.then(work,work);tail=next.catch(()=>{});return next;};}

test('failed/aborted materialization wait flushes the original stored intent before closing',async()=>{
  const order=[];let saved=false;
  const adapter=createServerlessHostAdapter({applicationId:id,storage,retainTask:()=>{},withLock:ownerLock(),authorize:()=>true,openSession:async()=>({
    session:{async command(_name,_input,{operationId}){assert.equal(operationId,'original');saved=true;
      return handleFor(id,operationId,{materialized:async()=>{throw Object.assign(Error('wait lost'),{code:'OPERATION_WAIT_TIMEOUT'});}});}},
    flush:async()=>{assert.equal(saved,true);order.push('flush');},close:async()=>order.push('close'),
  })});
  const response=await adapter.handleRequest(request({command:'add',input:null,operationId:'original',wait:'materialized'}));
  assert.equal(response.status,202);assert.deepEqual(order,['flush','close']);
  const body=await response.json();assert.equal(body.submission,'stored');assert.equal(body.operation.stored,true);
});

test('commands and the entire batch require retained IDs before opening a session',async()=>{
  let opens=0;
  const adapter=createServerlessHostAdapter({applicationId:id,storage,retainTask:()=>{},withLock:ownerLock(),authorize:()=>true,openSession:async()=>{opens++;throw Error('must not open');}});
  assert.equal((await adapter.handleRequest(request({command:'add'}))).status,400);
  const response=await adapter.handleRequest(new Request(`https://test/v1/apps/${id}/commands/batch`,{method:'POST',body:JSON.stringify({commands:[{command:'add',input:null,operationId:'original'},{command:'add',input:null}]})}));
  assert.equal(response.status,400);assert.equal(opens,0);
});

test('queued cancellation never opens a session; flush failure still closes and cannot report success',async()=>{
  let release,entered;
  const firstStarted=new Promise(resolve=>entered=resolve), held=new Promise(resolve=>release=resolve);let opens=0,closes=0;
  const adapter=createServerlessHostAdapter({applicationId:id,storage,retainTask:()=>{},withLock:ownerLock(),authorize:()=>true,openSession:async()=>{opens++;return{session:{},flush:async()=>{throw Error('flush failed');},close:async()=>{closes++;}};}});
  const first=adapter.withActiveSession(undefined,async()=>{entered();await held;});
  await firstStarted;
  const controller=new AbortController(),second=adapter.withActiveSession(controller.signal,async()=>{});
  const cancelled=assert.rejects(second,{name:'AbortError'});
  controller.abort();release();
  await assert.rejects(first,{code:'serverless_cleanup_failed'});await cancelled;
  assert.equal(opens,1);assert.equal(closes,1);
});
