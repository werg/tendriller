import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerlessHostAdapter} from '../../contract/serverless.mjs';
import {handleFor} from './serverless-fixtures.mjs';
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
    async command(_name,input,{operationId}){assert.equal(input,null);seen=operationId;return handleFor(id,operationId);},
    operations:{get:async operationId=>{assert.equal(operationId,seen);return handleFor(id,operationId);}},
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

test('a command result without an inspectable operation handle is an invalid session, never success',async()=>{
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{
    command:async()=>({materialized:async()=>({outcome:'accepted'})}),
    operations:{get:async()=>({outcome:'rejected'})},
  }})});
  const response=await adapter.handleRequest(request('commands',{command:'add',operationId:'original',input:null}));
  assert.equal(response.status,202);const body=await response.json();assert.equal(body.submission,'uncertain');assert.equal(body.error.code,'SERVERLESS_SESSION_INVALID');
  const inspected=await adapter.handleRequest(request('operations/original'));
  assert.equal(inspected.status,500);assert.equal((await inspected.json()).error.code,'SERVERLESS_SESSION_INVALID');
});

test('retainer is required, registered before owner work, and holds physical cleanup after the response deadline',async()=>{
  assert.throws(()=>createServerlessHostAdapter({...base,retainTask:undefined}),{code:'SERVERLESS_TASK_RETENTION_REQUIRED'});
  let finish,retained,retainedDone=false,closed=false;
  const applied=new Promise(resolve=>finish=resolve);
  const adapter=createServerlessHostAdapter({...base,timeoutMs:20,retainTask:task=>{retained=task;task.then(()=>retainedDone=true);},openSession:async()=>{
    assert.ok(retained);return{session:{command:async(_name,_input,{operationId})=>handleFor(id,operationId,{materialized:()=>applied})},close:async()=>{closed=true;}};
  }});
  const response=await adapter.handleRequest(request('commands',{command:'add',operationId:'original',input:null,wait:'materialized'}));
  assert.equal(response.status,202);assert.equal(retainedDone,false);assert.equal(closed,false);
  finish({outcome:'accepted'});await retained;
  assert.equal(closed,true);assert.equal(retainedDone,true);
});

test('retention registration failure prevents owner work',async()=>{
  let opens=0;
  const adapter=createServerlessHostAdapter({...base,retainTask:()=>{throw Error('context ended');},openSession:async()=>{opens++;}});
  const response=await adapter.handleRequest(request('commands',{command:'add',operationId:'original',input:null}));
  assert.equal(response.status,500);assert.equal((await response.json()).error.code,'SERVERLESS_TASK_RETENTION_FAILED');assert.equal(opens,0);
});

test('authorized end-to-end workflow: command stores durably, inspect reports facts, query is canonical',async()=>{
  const ops=new Map(),kv=new Map();
  const session={
    async query(){return{applicationId:id,revision:{digest:'d'.repeat(64),view:'local',executionManifestDigest:'e'.repeat(64),policyDigest:'f'.repeat(64)},value:{count:ops.size}};},
    async command(_name,_input,{operationId}){const handle=handleFor(id,operationId);ops.set(operationId,handle);return handle;},
    operations:{get:async operationId=>ops.get(operationId)??null},
  };
  const adapter=createServerlessHostAdapter({...base,storage:{get:async key=>kv.get(key)??null,put:async(key,value)=>{kv.set(key,value);},list:async()=>[...kv.keys()]},
    authorize:req=>req.headers.get('Authorization')==='Bearer ok',openSession:async()=>({session})});
  const call=(path,init={})=>adapter.handleRequest(new Request(`https://worker.test/v1/apps/${id}/${path}`,{...init,headers:{Authorization:'Bearer ok'}}));
  assert.equal((await adapter.handleRequest(new Request(`https://worker.test/v1/apps/${id}/health`))).status,401);
  const stored=await call('commands',{method:'POST',body:JSON.stringify({command:'add',input:{a:3},operationId:'srv-1'})});
  assert.equal(stored.status,200);const body=await stored.json();assert.equal(body.submission,'stored');assert.equal(body.operation.stored,true);assert.equal(body.operation.operationId,'srv-1');
  const inspected=await (await call('operations/srv-1?wait=materialized')).json();assert.equal(inspected.operation.materialized.outcome,'accepted');
  const queried=await (await call('query',{method:'POST',body:JSON.stringify({query:'count'})})).json();assert.deepEqual(Object.keys(queried),['applicationId','revision','value']);assert.equal(queried.value.count,1);
});
