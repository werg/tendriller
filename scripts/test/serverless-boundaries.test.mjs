import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerlessHostAdapter,createTransactionalBytesStore} from '../../contract/serverless.mjs';
const id='b'.repeat(64),storage={get:async()=>null,put:async()=>{}};
const base={applicationId:id,storage,retainTask:()=>{},authorize:()=>true,withLock:(_id,work)=>work(),openSession:async()=>({session:{}})};
const request=(path,body)=>new Request(`https://host.test/v1/apps/${id}/${path}`,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});
const command=operationId=>({command:'add',input:null,operationId});
function mutex(){let tail=Promise.resolve();return(_id,work)=>{const next=tail.then(work,work);tail=next.catch(()=>{});return next;};}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};

test('storage-owner lock and explicit authorization are mandatory, including health',async()=>{
  assert.throws(()=>createServerlessHostAdapter({...base,withLock:undefined}),{code:'SERVERLESS_OWNER_LOCK_REQUIRED'});
  assert.throws(()=>createServerlessHostAdapter({...base,authorize:undefined}),{code:'SERVERLESS_AUTHORIZATION_REQUIRED'});
  let opens=0;
  for(const authorization of [false,undefined]){
    const adapter=createServerlessHostAdapter({...base,authorize:()=>authorization,openSession:async()=>{opens++;}});
    assert.equal((await adapter.handleRequest(request('commands',command('original')))).status,401);
    assert.equal((await adapter.handleRequest(request('health'))).status,401);
  }
  assert.equal(opens,0);
});

test('DO Map enumeration uses snapshot values; keys enumeration holds the same owner lock across reads',async()=>{
  let reads=0;
  const map=new Map([['b',new Uint8Array([2])],['a',new Uint8Array([1]).buffer]]);
  const raw=createTransactionalBytesStore({...storage,list:async()=>map,get:async()=>{reads++;throw Error('snapshot must not reread');}});
  const entries=await raw.entries();assert.deepEqual(entries.map(row=>[row.key,[...row.value]]),[['a',[1]],['b',[2]]]);assert.equal(reads,0);
  new Uint8Array(map.get('a'))[0]=9;assert.equal(entries[0].value[0],1);
  let locked=false,locks=0;
  const adapter=createServerlessHostAdapter({...base,withLock:async(_id,work)=>{assert.equal(locked,false);locked=true;locks++;try{return await work();}finally{locked=false;}},storage:{
    put:async()=>{},list:async()=>{assert.equal(locked,true);return['b','a'];},get:async()=>{assert.equal(locked,true);return new Uint8Array([3]);},
  }});
  assert.equal((await adapter.store.entries()).length,2);assert.equal(locks,1);
});

test('bounded JSON rejects declared/chunked oversized, invalid and invalid-batch bodies before opening',async()=>{
  let opens=0;const adapter=createServerlessHostAdapter({...base,maxBodyBytes:256,openSession:async()=>{opens++;}});
  const large=request('commands',{...command('one'),input:'x'.repeat(300)});
  assert.equal((await adapter.handleRequest(large)).status,413);
  const declared=new Request(`https://host.test/v1/apps/${id}/commands`,{method:'POST',headers:{'content-length':'9999'},body:'{}'});
  assert.equal((await adapter.handleRequest(declared)).status,413);
  const invalid=new Request(`https://host.test/v1/apps/${id}/commands`,{method:'POST',body:'{"broken"'});
  assert.equal((await adapter.handleRequest(invalid)).status,400);
  assert.equal((await adapter.handleRequest(request('commands/batch',{commands:[command('one'),{command:'add'}]}))).status,400);
  assert.equal((await adapter.handleRequest(request('commands/batch',{commands:[command('one'),command('one')]}))).status,400);
  assert.equal(opens,0);
});

test('fixed deadline cancels a stuck body without opening storage',async()=>{
  let cancelled=false,opens=0;
  const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
  const adapter=createServerlessHostAdapter({...base,timeoutMs:20,openSession:async()=>{opens++;}});
  const response=await adapter.handleRequest(new Request(`https://host.test/v1/apps/${id}/commands`,{method:'POST',body:stream,duplex:'half'}));
  assert.equal(response.status,504);assert.equal((await response.json()).error.code,'serverless_deadline');assert.equal(opens,0);assert.equal(cancelled,true);
});

test('partial batch retains applied evidence, original uncertain ID and unsubmitted tail despite cleanup failures',async()=>{
  let calls=0,closes=0;
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{async command(_name,_input,{operationId}){
    calls++;return{applied:async()=>{if(operationId==='two')throw Object.assign(Error('primary'),{code:'PRIMARY'});return{status:'applied',outcome:'accepted'};}};
  }},flush:async()=>{throw Object.assign(Error('flush'),{code:'FLUSH'});},close:async()=>{closes++;throw Object.assign(Error('close'),{code:'CLOSE'});}})});
  const response=await adapter.handleRequest(request('commands/batch',{commands:['one','two','three'].map(command)}));
  assert.equal(response.status,202);const body=await response.json();
  assert.deepEqual(body.results.map(row=>[row.operationId,row.lifecycle]),[['one','applied'],['two','unknown'],['three','not_submitted']]);
  assert.equal(body.complete,false);assert.equal(body.error.code,'PRIMARY');assert.deepEqual(body.cleanupErrors.map(error=>error.code),['FLUSH','CLOSE']);assert.equal(calls,2);assert.equal(closes,1);
});

test('request deadline returns unknown while noncooperative work and cleanup retain the shared owner lock',async()=>{
  const applied=deferred(),flushing=deferred(),flushEntered=deferred();let opens=0,closes=0;
  const options={...base,withLock:mutex(),timeoutMs:40,openSession:async()=>{
    const first=++opens===1;return{session:{command:async()=>({applied:async()=>first?applied.promise:{status:'applied',outcome:'accepted'}})},
      flush:async()=>{if(first){flushEntered.resolve();await flushing.promise;}},close:async()=>{closes++;}};
  }};
  const firstAdapter=createServerlessHostAdapter(options),otherAdapter=createServerlessHostAdapter(options);
  const response=await firstAdapter.handleRequest(request('commands',command('original')));
  assert.equal(response.status,202);assert.equal((await response.json()).lifecycle,'unknown');assert.equal(opens,1);
  const second=otherAdapter.handleRequest(request('commands',command('next')));
  applied.resolve({status:'applied',outcome:'accepted'});await flushEntered.promise;
  assert.equal(opens,1);assert.equal(closes,0);
  flushing.resolve();assert.equal((await second).status,200);assert.equal(opens,2);assert.equal(closes,2);
});

test('abandoned and needsReapply stay distinct in inspect, recorded waits and failed applied waits',async()=>{
  for(const status of ['abandoned','needsReapply']){
    const state={status,operationId:'original'};
    const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{operations:{get:async()=>state},command:async()=>({get:async()=>state,applied:async()=>{throw Object.assign(Error('recovery'),{operation:state});}})}})});
    const inspected=await adapter.handleRequest(request('operations/original'));assert.equal((await inspected.json()).lifecycle,status);
    for(const wait of ['recorded','applied']){
      const response=await adapter.handleRequest(request('commands',{...command('original'),wait}));
      assert.equal(response.status,409);assert.equal((await response.json()).lifecycle,status);
    }
  }
});

test('query primary failure survives flush/close errors and cleanup never reports a successful result',async()=>{
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{query:async()=>{throw Object.assign(Error('read'),{code:'READ'});}},
    flush:async()=>{throw Error('flush');},close:async()=>{throw Error('close');}})});
  const response=await adapter.handleRequest(request('query',{query:'list'}));assert.equal(response.status,500);
  const body=await response.json();assert.equal(body.error.code,'READ');assert.equal(body.cleanupErrors.length,2);
});
