import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerlessHostAdapter} from '../../contract/serverless.mjs';
const id='c'.repeat(64),storage={get:async()=>null,put:async()=>{}};
const base={applicationId:id,storage,withLock:(_id,work)=>work(),authorize:()=>true,retainTask:()=>{},openSession:async()=>({session:{}})};
const request=(path,body)=>new Request(`https://host.test/v1/apps/${id}/${path}`,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});

test('missing input is rejected for the entire batch before any owner opens',async()=>{
  let opens=0;
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>{opens++;throw Error('must not open');}});
  assert.equal((await adapter.handleRequest(request('commands',{command:'add',operationId:'one'}))).status,400);
  assert.equal((await adapter.handleRequest(request('commands/batch',{commands:[{command:'add',operationId:'one',input:null},{command:'add',operationId:'two'}]}))).status,400);
  assert.equal(opens,0);
});

test('canonical 512-code-unit Unicode and scoped operation IDs pass unchanged through command and inspect',async()=>{
  let seen;
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{
    async command(_name,input,{operationId}){assert.equal(input,null);seen=operationId;return{applied:async()=>({status:'applied',outcome:'accepted'})};},
    operations:{get:async operationId=>{assert.equal(operationId,seen);return{status:'saved'};}},
  }})});
  for(const operationId of ['界'.repeat(512),'native_'+'a'.repeat(64)+'_'+'界'.repeat(440)]){
    assert.equal(operationId.length,512);
    const response=await adapter.handleRequest(request('commands',{command:'add',operationId,input:null}));
    assert.equal(response.status,200);assert.equal((await response.json()).operationId,operationId);assert.equal(seen,operationId);
    const inspect=await adapter.handleRequest(request('operations/'+encodeURIComponent(operationId)));
    assert.equal(inspect.status,200);assert.equal((await inspect.json()).operationId,operationId);
  }
  for(const operationId of ['a'.repeat(513),'bad\nidentity'])
    assert.equal((await adapter.handleRequest(request('commands',{command:'add',operationId,input:null}))).status,400);
});

test('an outcome alone never establishes applied state',async()=>{
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{
    command:async()=>({applied:async()=>({outcome:'accepted'})}),
    operations:{get:async()=>({outcome:'rejected'})},
  }})});
  const response=await adapter.handleRequest(request('commands',{command:'add',operationId:'original',input:null}));
  assert.equal(response.status,202);assert.equal((await response.json()).lifecycle,'unknown');
  assert.equal((await (await adapter.handleRequest(request('operations/original'))).json()).lifecycle,'unknown');
});

test('retainer is required, registered before owner work, and holds physical cleanup after the response deadline',async()=>{
  assert.throws(()=>createServerlessHostAdapter({...base,retainTask:undefined}),{code:'SERVERLESS_TASK_RETENTION_REQUIRED'});
  let finish,retained,retainedDone=false,closed=false;
  const applied=new Promise(resolve=>finish=resolve);
  const adapter=createServerlessHostAdapter({...base,timeoutMs:20,retainTask:task=>{retained=task;task.then(()=>retainedDone=true);},openSession:async()=>{
    assert.ok(retained);return{session:{command:async()=>({applied:()=>applied})},close:async()=>{closed=true;}};
  }});
  const response=await adapter.handleRequest(request('commands',{command:'add',operationId:'original',input:null}));
  assert.equal(response.status,202);assert.equal(retainedDone,false);assert.equal(closed,false);
  finish({status:'applied',outcome:'accepted'});await retained;
  assert.equal(closed,true);assert.equal(retainedDone,true);
});

test('retention registration failure prevents owner work',async()=>{
  let opens=0;
  const adapter=createServerlessHostAdapter({...base,retainTask:()=>{throw Error('context ended');},openSession:async()=>{opens++;}});
  const response=await adapter.handleRequest(request('commands',{command:'add',operationId:'original',input:null}));
  assert.equal(response.status,500);assert.equal((await response.json()).error.code,'SERVERLESS_TASK_RETENTION_FAILED');assert.equal(opens,0);
});
