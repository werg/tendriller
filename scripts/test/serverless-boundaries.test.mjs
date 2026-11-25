import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerlessHostAdapter,createTransactionalBytesStore} from '../../contract/serverless.mjs';
import {accepted,handleFor,inspection} from './serverless-fixtures.mjs';
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

test('partial batch retains stored evidence, a primary wait failure and the unsubmitted tail despite cleanup failures',async()=>{
  let calls=0,closes=0;
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{async command(_name,_input,{operationId}){
    calls++;return handleFor(id,operationId,{materialized:async()=>{if(operationId==='two')throw Object.assign(Error('primary'),{code:'PRIMARY'});return accepted;}});
  }},flush:async()=>{throw Object.assign(Error('flush'),{code:'FLUSH'});},close:async()=>{closes++;throw Object.assign(Error('close'),{code:'CLOSE'});}})});
  const response=await adapter.handleRequest(request('commands/batch',{commands:['one','two','three'].map(operationId=>({...command(operationId),wait:'materialized'}))}));
  assert.equal(response.status,500);const body=await response.json();
  assert.deepEqual(body.results.map(row=>[row.operationId,row.submission]),[['one','stored'],['two','stored'],['three','not_submitted']]);
  assert.equal(body.results[0].wait,'materialized');assert.equal(body.results[0].operation.stored,true);
  assert.equal(body.complete,false);assert.equal(body.error.code,'PRIMARY');assert.deepEqual(body.cleanupErrors.map(error=>error.code),['FLUSH','CLOSE']);assert.equal(calls,2);assert.equal(closes,1);
});

test('a command whose storage reply is never observed is uncertain (202) and keeps its original ID',async()=>{
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{async command(_name,_input,{operationId}){
    if(operationId==='two')throw Object.assign(Error('reply lost'),{code:'STORE_REPLY'});return handleFor(id,operationId);
  }}})});
  const response=await adapter.handleRequest(request('commands/batch',{commands:['one','two','three'].map(command)}));
  assert.equal(response.status,202);const body=await response.json();
  assert.deepEqual(body.results.map(row=>[row.operationId,row.submission]),[['one','stored'],['two','uncertain'],['three','not_submitted']]);
});

test('request deadline returns stored work while noncooperative materialization and cleanup retain the shared owner lock',async()=>{
  const waiting=deferred(),flushing=deferred(),flushEntered=deferred();let opens=0,closes=0;
  const options={...base,withLock:mutex(),timeoutMs:40,openSession:async()=>{
    const first=++opens===1;return{session:{command:async(_name,_input,{operationId})=>handleFor(id,operationId,{materialized:()=>first?waiting.promise:accepted})},
      flush:async()=>{if(first){flushEntered.resolve();await flushing.promise;}},close:async()=>{closes++;}};
  }};
  const firstAdapter=createServerlessHostAdapter(options),otherAdapter=createServerlessHostAdapter(options);
  const response=await firstAdapter.handleRequest(request('commands',{...command('original'),wait:'materialized'}));
  assert.equal(response.status,202);const body=await response.json();assert.equal(body.submission,'stored');assert.equal(body.error.code,'serverless_deadline');assert.equal(opens,1);
  const second=otherAdapter.handleRequest(request('commands',command('next')));
  waiting.resolve(accepted);await flushEntered.promise;
  assert.equal(opens,1);assert.equal(closes,0);
  flushing.resolve();assert.equal((await second).status,200);assert.equal(opens,2);assert.equal(closes,2);
});

test('stored is the default: no materialization, retention or finality wait happens',async()=>{
  const waits=[];
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{command:async(_name,_input,{operationId})=>handleFor(id,operationId,{
    materialized:async()=>{waits.push('materialized');},retained:async()=>{waits.push('retained');},finalized:async()=>{waits.push('finalized');}})}})});
  const response=await adapter.handleRequest(request('commands',command('original')));
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.wait,'stored');assert.equal(body.submission,'stored');assert.equal(body.operation.stored,true);assert.equal(body.operation.materialized,null);assert.deepEqual(waits,[]);
});

test('each wait selector observes only its own independent fact',async()=>{
  for(const fact of ['materialized','retained','finalized']){
    const waits=[];
    const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{command:async(_name,_input,{operationId})=>handleFor(id,operationId,{
      materialized:async()=>{waits.push('materialized');},retained:async()=>{waits.push('retained');},finalized:async()=>{waits.push('finalized');}})}})});
    const response=await adapter.handleRequest(request('commands',{...command('original'),wait:fact}));
    assert.equal(response.status,200);assert.equal((await response.json()).wait,fact);assert.deepEqual(waits,[fact]);
  }
});

test('old wait values, basedOn and other undeclared fields are rejected before opening; no aliases',async()=>{
  let opens=0;const adapter=createServerlessHostAdapter({...base,openSession:async()=>{opens++;}});
  for(const extra of [{wait:'recorded'},{wait:'applied'},{wait:'saved'},{wait:'shared'},{basedOn:{digest:'x'}},{lifecycle:'applied'}])
    assert.equal((await adapter.handleRequest(request('commands',{...command('original'),...extra}))).status,400,JSON.stringify(extra));
  for(const wait of ['recorded','applied','shared','bad'])assert.equal((await adapter.handleRequest(request(`operations/original?wait=${wait}`))).status,400);
  assert.equal(opens,0);
});

test('finalized waits are explicitly unsupported under no finality and never submit the command',async()=>{
  let commands=0;
  const session={authority:{descriptor:{finalityPolicy:{kind:'none'}}},command:async()=>{commands++;return handleFor(id,'x');},operations:{get:async()=>handleFor(id,'original')}};
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session})});
  const response=await adapter.handleRequest(request('commands',{...command('original'),wait:'finalized'}));
  assert.equal(response.status,409);const body=await response.json();assert.equal(body.error.code,'finality_unsupported');assert.equal(body.submission,'not_submitted');assert.equal(commands,0);
  assert.equal((await adapter.handleRequest(request('operations/original?wait=finalized'))).status,409);
  assert.equal((await adapter.handleRequest(request('operations/original'))).status,200);
});

test('inspection reports independent facts as plain data and never serializes handles, sessions or signatures',async()=>{
  const secret=Symbol('private');
  const handle=handleFor(id,'original',{
    inspect:()=>inspection(id,'original',{materialized:accepted,retained:[{payload:{peer:'p1',storageId:'s1',proposalId:'c'.repeat(64)},signer:'p1',signature:'SIGNATURE-BYTES'}],finalized:false,excluded:false}),
    owner:{secret:'PRIVATE-OWNER'},privateKey:'PRIVATE-KEY',[secret]:true,
  });
  handle.session={handle};
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{operations:{get:async operationId=>operationId==='original'?handle:null}}})});
  const response=await adapter.handleRequest(request('operations/original'));const text=await response.text();
  assert.equal(response.status,200);assert.ok(!/PRIVATE|SIGNATURE|owner/u.test(text));
  const {operation}=JSON.parse(text);
  assert.equal(operation.stored,true);assert.equal(operation.materialized.outcome,'accepted');assert.equal(operation.finalized,false);assert.deepEqual(operation.retained,[{peer:'p1',storageId:'s1'}]);
  const missing=await adapter.handleRequest(request('operations/unknown'));assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,'operation_not_found');
});

test('a finality-excluded operation stays distinct: its intent is stored and no recovery or reapplication state exists',async()=>{
  const excluded=inspection(id,'original',{excluded:true});
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{
    operations:{get:async()=>handleFor(id,'original',{inspect:()=>excluded})},
    command:async()=>handleFor(id,'original',{inspect:()=>excluded,materialized:async()=>{throw Object.assign(Error('OPERATION_EXCLUDED'),{code:'OPERATION_EXCLUDED',inspection:excluded});}}),
  }})});
  const inspected=await (await adapter.handleRequest(request('operations/original'))).json();
  assert.equal(inspected.operation.excluded,true);assert.equal(inspected.operation.stored,true);assert.ok(!('lifecycle' in inspected));
  const response=await adapter.handleRequest(request('commands',{...command('original'),wait:'materialized'}));
  assert.equal(response.status,409);const body=await response.json();
  assert.equal(body.submission,'stored');assert.equal(body.excludedOperation.excluded,true);assert.ok(!('lifecycle' in body));
});

test('query returns the canonical {applicationId, revision, value} and rejects other shapes',async()=>{
  const revision={digest:'d'.repeat(64),view:'local',executionManifestDigest:'e'.repeat(64),policyDigest:'f'.repeat(64)};
  const make=result=>createServerlessHostAdapter({...base,openSession:async()=>({session:{query:async()=>result}})});
  const good=await make({applicationId:id,revision,value:[1],extra:'dropped'}).handleRequest(request('query',{query:'list'}));
  assert.equal(good.status,200);assert.deepEqual(await good.json(),{applicationId:id,revision,value:[1]});
  for(const bad of [[1],{value:[1]},{applicationId:'0'.repeat(64),revision,value:1}]){
    const response=await make(bad).handleRequest(request('query',{query:'list'}));
    assert.equal(response.status,500);assert.equal((await response.json()).error.code,'SERVERLESS_SESSION_INVALID');
  }
});

test('query primary failure survives flush/close errors and cleanup never reports a successful result',async()=>{
  const adapter=createServerlessHostAdapter({...base,openSession:async()=>({session:{query:async()=>{throw Object.assign(Error('read'),{code:'READ'});}},
    flush:async()=>{throw Error('flush');},close:async()=>{throw Error('close');}})});
  const response=await adapter.handleRequest(request('query',{query:'list'}));assert.equal(response.status,500);
  const body=await response.json();assert.equal(body.error.code,'READ');assert.equal(body.cleanupErrors.length,2);
});
