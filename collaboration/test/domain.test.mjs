import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describeApplication, PEER_GENERATION_CAPABILITIES } from '@chronolog/peer-session';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { createCollaborationDefinition } from '../domain.mjs';
import { captureCollaborationReader } from '../paging.mjs';
import { checkOwnerFrame } from '../browser-transport.mjs';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),G='1'.repeat(64),G2='2'.repeat(64),APP='7'.repeat(64),HISTORY='verified-domain-history';
function harness() {
  const db=new DatabaseSync(':memory:');let author=A,generation=G,attempt=Buffer.alloc(32,1),sequence=0;
  db.exec('PRAGMA recursive_triggers=ON');
  db.function('chronolog_actor',()=>Buffer.from(author,'hex'));
  db.function('chronolog_transaction_id',()=>attempt);
  db.function('chronolog_assert',(condition,code)=>{if(!condition)throw Error(code);return 1;});
  db.exec('CREATE TABLE chronolog_principals(id INTEGER PRIMARY KEY,key BLOB); CREATE TABLE chronolog_execution_context(singleton INTEGER PRIMARY KEY,transaction_id BLOB,application_id BLOB,generation BLOB)');
  db.exec('CREATE TABLE chronolog_transactions(tx_id BLOB PRIMARY KEY,author_id BLOB,operation_id TEXT,outcome TEXT); CREATE TABLE chronolog_attempt_generations(transaction_id BLOB PRIMARY KEY,generation BLOB); CREATE TABLE chronolog_peer_control(singleton INTEGER PRIMARY KEY,application_id BLOB)');
  db.prepare('INSERT INTO chronolog_peer_control VALUES(1,?)').run(Buffer.from(APP,'hex'));
  db.prepare('INSERT INTO chronolog_principals VALUES(1,?)').run(Buffer.from('d089b2593cdd5a4a10734f1f7253cea7b72501dffebfcadfed37be1d01557608','hex'));
  db.prepare('INSERT INTO chronolog_execution_context VALUES(1,?,?,?)').run(Buffer.alloc(32,1),Buffer.alloc(32),Buffer.from(generation,'hex'));
  const definition=createCollaborationDefinition({administrators:[A]});
  function steps(program) {for(const step of program.steps){if(step.op==='emit')continue;
    const values=step.bindings.map(binding=>binding.value.kind==='null'?null:binding.value.value);
    db.prepare(step.sql).run(...values);}}
  steps(definition.schema);db.exec('ALTER TABLE collab_journal ADD COLUMN chronolog_owner INTEGER');
  function executeProgram(run,as=author){author=as;attempt=Buffer.alloc(32);attempt.writeUInt32BE(++sequence,28);
    db.prepare('UPDATE chronolog_execution_context SET transaction_id=?,generation=?').run(attempt,Buffer.from(generation,'hex'));
    const reference={applicationId:APP,historyId:HISTORY,author,operationId:`operation-${sequence}`,attemptId:attempt.toString('hex'),generation};
    db.exec('BEGIN');try{run();db.prepare('INSERT INTO chronolog_transactions VALUES(?,?,?,?)').run(attempt,Buffer.from(author,'hex'),reference.operationId,'accepted');
      db.prepare('INSERT INTO chronolog_attempt_generations VALUES(?,?)').run(attempt,Buffer.from(generation,'hex'));db.exec('COMMIT');return reference;
    }catch(error){db.exec('ROLLBACK');throw error;}}
  function execute(name,input,as=author){return executeProgram(()=>steps(definition.commands[name].prepare(input)),as);}
  const view={get revision(){return{applicationId:APP,historyId:HISTORY,generation,point:{sequence,root:'9'.repeat(64)},controlRevision:0,materializationRevision:`materialization-${sequence}`};},get generation(){return generation;},query(sql,parameters=[]){const statement=db.prepare(sql);return{rows:statement.all(...parameters).map(row=>Object.values(row))};}};
  return {db,definition,execute,view,raw(sql,as){return executeProgram(()=>db.exec(sql),as);},setGeneration(value){generation=value;db.prepare('UPDATE chronolog_execution_context SET generation=?').run(Buffer.from(value,'hex'));},
    snapshot(taskId='task'){return definition.queries['collab.task'].read(view,{taskId});}};
}
function request(h,slots=[{slotId:'main',eligibleSigners:[B,C]}],responsePolicy='one'){
  return h.execute('collab.request',{interactionId:'task',kind:'review',title:'Review a shared proposal',input:'{"proposal":1}',
    target:'{"kind":"workerGroup","groupId":"reviewers","mode":"claimOne"}',source:'{}',context:'{}',slots,responsePolicy},A);
}
const claim=(claimId='claim-b',expectedEpoch=0)=>({taskId:'task',slotId:'main',claimId,runId:'run-b',endpointIncarnation:'view-b',expectedEpoch,taskVersion:1});
const result=(resultId='result-b',claimEpoch=1,generation=G)=>({taskId:'task',slotId:'main',resultId,claimEpoch,taskVersion:1,generation,
  runId:'run-b',endpointIncarnation:'view-b',outcome:'succeeded',content:'{"answer":42}'});
const rawRequest=()=>({kind:'review',title:'Raw request',input:'null',target:JSON.stringify({kind:'signer',deviceId:B}),
  source:'{}',context:'{}',slots:[{slotId:'main',eligibleSigners:[B]}],responsePolicy:'one'});
function rawRecord(h,type,body,{author=A,taskId='task',slotId='',id=crypto.randomUUID()}={}){
  const quoted=value=>`'${String(value).replaceAll("'","''")}'`;
  const encoded=typeof body==='string'?body:JSON.stringify(body);
  return h.raw(`INSERT INTO collab_journal(id,sequence,type,task_id,slot_id,author,generation,attempt_id,body,chronolog_owner)
    VALUES(${quoted(id)},(SELECT COALESCE(MAX(sequence),0)+1 FROM collab_journal),${quoted(type)},${quoted(taskId)},${quoted(slotId)},
      lower(hex(chronolog_actor())),'${G}',chronolog_transaction_id(),${quoted(encoded)},1)`,author);
}

test('raw JSON fields must retain the encoded-string contract and projection envelope types',async()=>{
  const h=harness();
  for(const key of ['input','target','source','context'])
    assert.throws(()=>rawRecord(h,'request',{...rawRequest(),[key]:{poison:true}}),/collab_json_fields/);
  assert.throws(()=>rawRecord(h,'request',{...rawRequest(),kind:{poison:true}}),/collab_envelope/);
  assert.throws(()=>rawRecord(h,'message',{messageId:'raw',text:'Safe text',source:{poison:true}}),/collab_json_fields/);
  assert.throws(()=>rawRecord(h,'message',{messageId:{poison:true},text:'Safe text',source:'{}'}),/collab_envelope/);
  request(h);h.execute('collab.claim',claim(),B);
  const {taskId,slotId,...content}=result('raw');
  assert.throws(()=>rawRecord(h,'result',{...content,disposition:'accepted',content:{poison:true}},{author:B,slotId}),/collab_json_fields/);
  h.execute('collab.result',result(),B);
  assert.throws(()=>rawRecord(h,'finalize',{expectedVersion:3,resultIds:['result-b'],allowPartial:false,content:{poison:true}}),/collab_json_fields/);
  const current=await h.snapshot();assert.equal(current.task.version,3);assert.equal(current.results.length,1);assert.deepEqual(current.results[0].content,{answer:42});h.db.close();
});

test('raw JSON structure rejects duplicate decoded keys, excessive ancestry or nodes and nonfinite atoms',async()=>{
  const h=harness(),nested=(levels,value=null)=>{while(levels--)value={'key.with[punctuation]':value};return value;};
  for(const input of [JSON.stringify(nested(25)), '{"x":1,"\\u0078":2}', '{"numeric":1e999}'])
    assert.throws(()=>rawRecord(h,'request',{...rawRequest(),input}),/collab_json_structure/);
  for(const extra of [nested(25),Array(4096).fill(0)])
    assert.throws(()=>rawRecord(h,'request',{...rawRequest(),extra}),/collab_json_structure/);
  const body=JSON.stringify(rawRequest());
  assert.throws(()=>rawRecord(h,'request',body.replace('"input":"null"','"input":"null","input":{"poison":true}')),/collab_json_structure/);
  const encodedNested=JSON.stringify(JSON.stringify(nested(16)));
  assert.throws(()=>rawRecord(h,'request',body.replace('"input":"null"',`"input":${encodedNested},"input":${encodedNested}`)),/collab_json_structure/);
  assert.throws(()=>rawRecord(h,'request',body.replace('"input":"null"','"input":"null","extra":1e999')),/collab_json_structure/);
  rawRecord(h,'request',{...rawRequest(),input:JSON.stringify(nested(24)),source:'{"literal.key[0]":true}'});
  const rawClaim=JSON.stringify({epoch:1,taskVersion:1,runId:'run-b',endpointIncarnation:'view-b'});
  assert.throws(()=>rawRecord(h,'claim',rawClaim.replace('"epoch":1','"epoch":1,"epoch":2'),{author:B,slotId:'main'}),/collab_json_structure/);
  h.execute('collab.claim',claim(),B);
  const {taskId,slotId,...content}=result('duplicate-disposition');
  const rawResult=JSON.stringify({...content,disposition:'accepted'}).replace('"disposition":"accepted"','"disposition":"accepted","disposition":"superseded"');
  assert.throws(()=>rawRecord(h,'result',rawResult,{author:B,slotId}),/collab_json_structure/);
  const current=await h.snapshot();assert.equal(current.task.version,2);assert.equal(current.claims[0].claimEpoch,1);
  checkOwnerFrame({id:1,value:{revision:h.view.revision,value:current},snapshot:{}});h.db.close();
});

test('one guarded claim wins and raw updates/deletes/inserts cannot bypass the schema',async()=>{
  const h=harness();request(h);h.execute('collab.claim',claim(),B);
  assert.throws(()=>h.execute('collab.claim',{...claim('claim-c'),runId:'run-c'},C));
  assert.throws(()=>h.db.exec("UPDATE collab_journal SET author='forged'"));
  assert.throws(()=>h.db.exec('DELETE FROM collab_journal'));
  assert.throws(()=>h.db.exec(`INSERT INTO collab_journal VALUES('forged',3,'claim','task','main','${C}','${G}',chronolog_transaction_id(),'{"epoch":2,"runId":"evil","endpointIncarnation":"evil","taskVersion":1}',1)`));
  assert.equal((await h.snapshot()).claims[0].claimant,B);h.db.close();
});
test('accepted result is idempotent but same identity with changed content conflicts',async()=>{
  const h=harness();request(h);h.execute('collab.claim',claim(),B);h.execute('collab.result',result(),B);
  h.execute('collab.result',result(),B);assert.throws(()=>h.execute('collab.result',{...result(),content:'{"answer":43}'},B));
  const snapshot=await h.snapshot();assert.equal(snapshot.results.length,1);assert.equal(snapshot.results[0].disposition,'accepted');
  h.execute('collab.finalize',{taskId:'task',actionId:'done',expectedVersion:snapshot.task.version,resultIds:['result-b'],content:'{"summary":"ok"}',allowPartial:false},A);
  assert.equal((await h.snapshot()).task.status,'completed');h.db.close();
});
test('durable source labels remain signer assertions even when a writer claims owner evidence',async()=>{
  const h=harness();
  h.execute('collab.request',{interactionId:'task',kind:'review',title:'Attributed request',input:'null',
    target:JSON.stringify({kind:'signer',deviceId:B}),source:JSON.stringify({deviceId:B,endpointId:'forged-endpoint',evidence:'owner-bound',contextEvidence:'owner-validated'}),
    context:'{}',slots:[{slotId:'main',eligibleSigners:[B]}],responsePolicy:'one'},A);
  const {task}=await h.snapshot();assert.equal(task.creator,A);assert.equal(task.source.deviceId,A);
  assert.equal(task.source.assertedDeviceId,B);assert.equal(task.source.evidence,'signer-asserted');
  assert.equal(task.source.contextEvidence,'caller-asserted');h.db.close();
});
test('record provenance is the verified attempt and original operation, including late results',async()=>{
  const h=harness(),requested=request(h),claimed=h.execute('collab.claim',claim(),B);
  let snapshot=await h.snapshot();assert.deepEqual(snapshot.task.operation,requested);assert.deepEqual(snapshot.claims[0].operation,claimed);
  h.setGeneration(G2);const produced=h.execute('collab.result',result(),B);snapshot=await h.snapshot();
  assert.equal(snapshot.results[0].generation,G);assert.equal(snapshot.results[0].disposition,'needsReview');
  assert.deepEqual(snapshot.results[0].operation,produced);assert.equal(snapshot.results[0].operation.generation,G2);
  assert.equal(snapshot.task.operation.attemptId,requested.attemptId);assert.ok(Object.isFrozen(snapshot.task.operation));h.db.close();
});
test('raw writers cannot substitute an attempt or override the verified read reference with JSON',async()=>{
  const h=harness();
  const body=JSON.stringify({text:'Attributed raw message',messageId:'raw',source:'{}',operation:{historyId:'forged-history',author:C,operationId:'forged',attemptId:'f'.repeat(64)}}).replaceAll("'","''");
  const insert=attempt=>`INSERT INTO collab_journal(id,sequence,type,task_id,slot_id,author,generation,attempt_id,body,chronolog_owner)
    VALUES('raw',1,'message','thread','',lower(hex(chronolog_actor())),'${G}',${attempt},'${body}',1)`;
  assert.throws(()=>h.raw(insert(`X'${'f'.repeat(64)}'`),A),/collab_attempt/);
  const verified=h.raw(insert('chronolog_transaction_id()'),A);
  const snapshot=await h.definition.queries['collab.snapshot'].read(h.view,null);
  assert.deepEqual(snapshot.messages[0].operation,verified);assert.equal(snapshot.messages[0].operation.author,A);
  assert.equal(snapshot.messages[0].operation.historyId,HISTORY);
  await assert.rejects(h.definition.queries['collab.snapshot'].read({...h.view,revision:{applicationId:'8'.repeat(64),historyId:HISTORY}},null),{code:'PROVENANCE_UNAVAILABLE'});
  await assert.rejects(h.definition.queries['collab.snapshot'].read({...h.view,revision:undefined},null),{code:'PROVENANCE_UNAVAILABLE'});
  h.db.exec('DELETE FROM chronolog_transactions');
  await assert.rejects(h.definition.queries['collab.snapshot'].read(h.view,null),error=>error.code==='PROVENANCE_UNAVAILABLE');h.db.close();
});
test('handoff fences old worker and retains late evidence',async()=>{
  const h=harness();request(h);h.execute('collab.claim',claim(),B);
  h.execute('collab.handoff',{taskId:'task',slotId:'main',actionId:'handoff',expectedEpoch:1,assignee:C,reason:'Reassigned explicitly'},A);
  h.execute('collab.claim',{...claim('claim-c',2),runId:'run-c',endpointIncarnation:'view-c'},C);
  h.execute('collab.result',result(),B);assert.equal((await h.snapshot()).results[0].disposition,'superseded');
  assert.equal((await h.snapshot()).claims[0].claimEpoch,3);h.db.close();
});
test('adopted old-generation claims need explicit rebind and old results remain review evidence',async()=>{
  const h=harness();request(h);h.execute('collab.claim',claim(),B);h.setGeneration(G2);
  assert.equal((await h.snapshot()).claims[0].status,'needsReview');h.execute('collab.result',result(),B);
  assert.equal((await h.snapshot()).results[0].disposition,'needsReview');
  h.execute('collab.rebind',claim('rebound',1),B);h.execute('collab.result',result('current-result',2,G2),B);
  assert.equal((await h.snapshot()).results[1].disposition,'accepted');h.db.close();
});
test('cancellation request, acknowledgement and late result are different facts',async()=>{
  const h=harness();request(h);h.execute('collab.claim',claim(),B);
  h.execute('collab.cancel',{taskId:'task',actionId:'cancel',expectedVersion:2,reason:'User stopped task'},A);
  assert.equal((await h.snapshot()).task.status,'cancelRequested');h.execute('collab.result',result(),B);
  assert.equal((await h.snapshot()).results[0].disposition,'cancelled');
  h.execute('collab.acknowledgeCancel',{taskId:'task',slotId:'main',actionId:'ack',claimEpoch:1,generation:G,runId:'run-b',endpointIncarnation:'view-b'},B);
  assert.equal((await h.snapshot()).task.status,'cancelled');h.db.close();
});
test('fan-in uses frozen slots, guarded parent version and explicit partial manual synthesis',async()=>{
  const h=harness();request(h,[{slotId:'main',eligibleSigners:[B]},{slotId:'other',eligibleSigners:[C]}],'allSlots');
  h.execute('collab.claim',claim(),B);h.execute('collab.result',result(),B);
  assert.throws(()=>h.execute('collab.finalize',{taskId:'task',actionId:'premature',expectedVersion:3,resultIds:['result-b'],content:'{}',allowPartial:true},A));
  h.execute('collab.claim',{...claim('other'),slotId:'other',runId:'run-c'},C);
  h.execute('collab.result',{...result('result-c'),slotId:'other',runId:'run-c'},C);
  assert.throws(()=>h.execute('collab.finalize',{taskId:'task',actionId:'stale',expectedVersion:3,resultIds:['result-b','result-c'],content:'{}',allowPartial:false},A));
  h.execute('collab.finalize',{taskId:'task',actionId:'complete',expectedVersion:5,resultIds:['result-b','result-c'],content:'{}',allowPartial:false},A);
  assert.equal((await h.snapshot()).task.aggregate.disposition,'complete');h.db.close();
});


test('current task inspection and bounded previews remain usable beyond ten thousand retained records',async()=>{
  const h=harness();request(h);h.execute('collab.claim',claim(),B);
  for(let index=0;index<40;index++){
    h.execute('collab.handoff',{taskId:'task',slotId:'main',actionId:`handoff-${index}`,expectedEpoch:1+index*2,assignee:B,reason:'Retained historical handoff'},A);
    h.execute('collab.claim',claim(`replacement-${index}`,2+index*2),B);
  }
  h.raw(`WITH RECURSIVE retained(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM retained WHERE n<10050)
    INSERT INTO collab_journal(id,sequence,type,task_id,slot_id,author,generation,attempt_id,body,chronolog_owner)
    SELECT 'retained-message-'||n,n+(SELECT MAX(sequence) FROM collab_journal),'message','task','',lower(hex(chronolog_actor())),
      '${G}',chronolog_transaction_id(),json_object('messageId','retained-message-'||n,'text','Retained conversation','source','{}'),1 FROM retained`,A);
  const batches=[],query=h.view.query.bind(h.view);
  h.view.query=(sql,parameters=[])=>{const value=query(sql,parameters);batches.push(value.rows.length);return value;};
  const snapshot=await h.snapshot();
  assert.equal(snapshot.task.version,10132);assert.equal(snapshot.claims.length,1);assert.equal(snapshot.claims[0].claimEpoch,81);
  assert.equal(snapshot.resultsPage.total,0);assert.equal(snapshot.resultsPage.hasMore,false);
  const preview=await h.definition.queries['collab.snapshot'].read(h.view,null);
  assert.equal(preview.tasks.length,1);assert.equal(preview.messages.length,20);assert.equal(preview.pages.messages.total,10050);
  assert.equal(preview.pages.messages.hasMore,true);assert.ok(preview.pages.messages.nextCursor);
  assert.ok(Math.max(...batches)<=8,'Even captured Worker SQL responses must use bounded inner batches');
  const second=await h.definition.queries['collab.messages'].read(h.view,{cursor:preview.pages.messages.nextCursor});
  assert.equal(second.messages[0].messageId,'retained-message-21');
  const cancellation=h.execute('collab.cancel',{taskId:'task',actionId:'after-large-history',expectedVersion:snapshot.task.version,reason:'Guard uses the complete count'},A);
  assert.equal((await h.snapshot()).task.cancellation.operation.attemptId,cancellation.attemptId);h.db.close();
});

test('result evidence pages obey a byte budget and expose all late evidence independently of current accepted slots',async()=>{
  const h=harness();request(h);h.execute('collab.claim',claim(),B);
  for(let index=0;index<40;index++)h.execute('collab.result',{...result(`large-result-${index}`),content:JSON.stringify({text:'e'.repeat(7600)})},B);
  const initial=await h.definition.queries['collab.results'].read(h.view,{taskId:'task',limit:64});
  assert.ok(initial.results.length<40);assert.equal(initial.page.total,40);assert.equal(initial.page.hasMore,true);
  assert.ok(Buffer.byteLength(JSON.stringify(initial))<140000);
  const seen=[...initial.results];let cursor=initial.page.nextCursor;
  while(cursor){const next=await h.definition.queries['collab.results'].read(h.view,{taskId:'task',limit:64,cursor});seen.push(...next.results);cursor=next.page.nextCursor;}
  assert.equal(seen.length,40);assert.equal(new Set(seen.map(value=>value.resultId)).size,40);
  assert.equal(seen.filter(value=>value.disposition==='superseded').length,39);
  const current=await h.snapshot();assert.equal(current.resultsPage.total,40);assert.equal(current.resultsPage.hasMore,true);
  assert.equal(current.acceptedResults.length,1);assert.equal(current.acceptedResults[0].resultId,'large-result-0');
  assert.equal('content' in current.acceptedResults[0],false);assert.equal(current.claims[0].status,'completed');
  assert.equal(current.task.version,42);assert.equal(current.acceptedResults[0].operation.historyId,HISTORY);h.db.close();
});

test('task discovery uses explicit eligibility and terminal filters and continuation binds its complete captured scope',async()=>{
  const h=harness();
  function make(taskId,eligible){h.execute('collab.request',{interactionId:taskId,kind:'review',title:taskId,input:'null',target:JSON.stringify({kind:'signer',deviceId:eligible}),
    source:'{}',context:'{}',slots:[{slotId:'main',eligibleSigners:[eligible]}],responsePolicy:'one'},A);}
  make('one',B);make('two',B);make('other',C);
  h.execute('collab.cancel',{taskId:'one',actionId:'closed',expectedVersion:1,reason:'Done'},A);
  const open=await h.definition.queries['collab.tasks'].read(h.view,{eligibleSigner:B,state:'open'});
  assert.deepEqual(open.tasks.map(value=>value.taskId),['two']);assert.equal(open.page.total,1);
  const first=await h.definition.queries['collab.tasks'].read(h.view,{eligibleSigner:B,limit:1});
  assert.equal(first.page.hasMore,true);assert.equal(first.page.total,2);
  const second=await h.definition.queries['collab.tasks'].read(h.view,{eligibleSigner:B,limit:1,cursor:first.page.nextCursor});
  assert.deepEqual(second.tasks.map(value=>value.taskId),['two']);assert.equal(second.page.hasMore,false);assert.equal(second.page.nextCursor,null);
  await assert.rejects(h.definition.queries['collab.tasks'].read(h.view,{eligibleSigner:C,cursor:first.page.nextCursor}),{code:'CURSOR_RESET_REQUIRED'});
  await assert.rejects(h.definition.queries['collab.tasks'].read({...h.view,revision:{...h.view.revision,historyId:'different-history'}},{eligibleSigner:B,cursor:first.page.nextCursor}),{code:'CURSOR_RESET_REQUIRED'});
  make('three',B);
  await assert.rejects(h.definition.queries['collab.tasks'].read(h.view,{eligibleSigner:B,cursor:first.page.nextCursor}),{code:'CURSOR_RESET_REQUIRED'});
  h.setGeneration(G2);
  await assert.rejects(h.definition.queries['collab.tasks'].read(h.view,{eligibleSigner:B,cursor:first.page.nextCursor}),{code:'CURSOR_RESET_REQUIRED'});h.db.close();
});

test('thread pages cannot cross threads or accept unscoped cursors and preserve original message lineage',async()=>{
  const h=harness();
  for(let index=0;index<7;index++)h.execute('collab.message',{threadId:index<5?'selected':'other',messageId:`message-${index}`,text:`Message ${index}`,source:'{}'},A);
  const first=await h.definition.queries['collab.thread'].read(h.view,{threadId:'selected',limit:2});
  assert.equal(first.page.total,5);assert.deepEqual(first.messages.map(value=>value.messageId),['message-0','message-1']);
  const second=await h.definition.queries['collab.thread'].read(h.view,{threadId:'selected',limit:2,cursor:first.page.nextCursor});
  assert.deepEqual(second.messages.map(value=>value.messageId),['message-2','message-3']);
  const last=await h.definition.queries['collab.thread'].read(h.view,{threadId:'selected',limit:2,cursor:second.page.nextCursor});
  assert.equal(last.page.hasMore,false);assert.equal(last.messages[0].messageId,'message-4');assert.equal(last.messages[0].operation.historyId,HISTORY);
  await assert.rejects(h.definition.queries['collab.thread'].read(h.view,{threadId:'other',cursor:first.page.nextCursor}),{code:'CURSOR_RESET_REQUIRED'});
  await assert.rejects(h.definition.queries['collab.messages'].read(h.view,{threadId:'selected',cursor:first.page.nextCursor}),{code:'CURSOR_RESET_REQUIRED'});
  await assert.rejects(h.definition.queries['collab.thread'].read(h.view,{threadId:'selected',cursor:'{"after":2}'}),{code:'CURSOR_RESET_REQUIRED'});h.db.close();
});

test('dense legal payloads page below real owner frame limits and retain complete continuations',async t=>{
  const h=harness(),payload=JSON.stringify(Array(4095).fill(0));
  for(let index=0;index<16;index++){
    const taskId=`dense-${index}`;
    h.execute('collab.request',{interactionId:taskId,...rawRequest(),input:payload},A);
    h.execute('collab.claim',{...claim(`dense-claim-${index}`),taskId},B);
    h.execute('collab.result',{...result(`dense-result-${index}`),taskId,content:payload},B);
  }
  for(let index=0;index<20;index++)h.execute('collab.message',{threadId:'dense-thread',messageId:`dense-message-${index}`,
    text:'A dense but valid signer assertion',source:JSON.stringify(Array(1023).fill(0))},A);
  const direct=await h.definition.queries['collab.tasks'].read(h.view,{limit:32});
  assert.ok(direct.tasks.length>0&&direct.tasks.length<16);assert.equal(direct.page.hasMore,true);
  assert.equal(direct.page.total,16);checkOwnerFrame({id:1,value:{revision:h.view.revision,value:direct},snapshot:{}});

  const lifetime=new AbortController(),description=describeApplication(h.definition),root=new MessageChannel();
  let released=0,client,reader;
  const session={applicationId:APP,historyId:HISTORY,storageId:'dense-paging',deviceId:A,signal:lifetime.signal,
    get revision(){return h.view.revision;},status:{phase:'ready',database:'ready',role:'coordinator',generation:G,coordinator:A,connectedPeers:0},
    signals:{delivery:'neighbors'},describe:()=>({...description,capabilities:{...PEER_GENERATION_CAPABILITIES,sql:true}}),
    onStatus(listener){listener(this.status);return()=>{};},onRecovery:()=>()=>{},
    async query(name,input){return{revision:h.view.revision,value:await h.definition.queries[name].read(h.view,input)};},
    async readView(){return{revision:structuredClone(h.view.revision),query:(...args)=>h.view.query(...args),release(){released++;}};},
    async close(){if(!lifetime.signal.aborted)lifetime.abort(Error('fixture closed'));},
  };
  const owner=createApplicationOwner(session);owner.attach(root.port1);
  t.after(async()=>{await reader?.close();await client?.detach();await owner.close();root.port1.close();root.port2.close();h.db.close();});
  client=await connectApplicationOwner(root.port2,{applicationId:APP,definitionId:description.id,definitionVersion:description.version,timeoutMs:2000});
  // This is the actual public server/client validator over MessagePorts, not a
  // copy of its limits. A too-large named-query reply rejects this call.
  const preview=await client.query('collab.snapshot',null);
  for(const subsection of ['tasks','results','messages'])assert.equal(preview.value.pages[subsection].hasMore,true);
  checkOwnerFrame({id:1,value:preview,snapshot:{}});
  const named=await client.query('collab.tasks',{limit:32});assert.equal(named.value.page.returned,direct.page.returned);
  reader=await captureCollaborationReader(client);
  for(const [method,key,total,options] of [['tasks','tasks',16,{limit:32}],['results','results',16,{limit:64}],['messages','messages',20,{limit:64}]]){
    const values=[];let cursor;
    do{
      const page=await reader[method]({...options,...(cursor?{cursor}:{})});
      assert.equal(page.value.page.total,total);assert.ok(page.value[key].length>0);
      checkOwnerFrame({id:1,value:page,snapshot:{}});values.push(...page.value[key]);cursor=page.value.page.nextCursor;
    }while(cursor);
    const identity=key==='tasks'?'taskId':key==='results'?'resultId':'messageId';
    assert.equal(values.length,total);assert.equal(new Set(values.map(value=>value[identity])).size,total);
  }
  await reader.close();assert.equal(released,1);assert.equal(lifetime.signal.aborted,false);
  assert.equal(owner.endpoints().length,1);
});
