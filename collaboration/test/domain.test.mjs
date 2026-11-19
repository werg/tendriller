import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCollaborationDefinition } from '../domain.mjs';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),G='1'.repeat(64),G2='2'.repeat(64);
function harness() {
  const db=new DatabaseSync(':memory:');let author=A,generation=G;
  db.exec('PRAGMA recursive_triggers=ON');
  db.function('chronolog_actor',()=>Buffer.from(author,'hex'));
  db.function('chronolog_transaction_id',()=>Buffer.alloc(32,1));
  db.function('chronolog_assert',(condition,code)=>{if(!condition)throw Error(code);return 1;});
  db.exec('CREATE TABLE chronolog_principals(id INTEGER PRIMARY KEY,key BLOB); CREATE TABLE chronolog_execution_context(singleton INTEGER PRIMARY KEY,transaction_id BLOB,application_id BLOB,generation BLOB)');
  db.prepare('INSERT INTO chronolog_principals VALUES(1,?)').run(Buffer.from('d089b2593cdd5a4a10734f1f7253cea7b72501dffebfcadfed37be1d01557608','hex'));
  db.prepare('INSERT INTO chronolog_execution_context VALUES(1,?,?,?)').run(Buffer.alloc(32,1),Buffer.alloc(32),Buffer.from(generation,'hex'));
  const definition=createCollaborationDefinition({administrators:[A]});
  function steps(program) {for(const step of program.steps){if(step.op==='emit')continue;
    const values=step.bindings.map(binding=>binding.value.kind==='null'?null:binding.value.value);
    db.prepare(step.sql).run(...values);}}
  steps(definition.schema);db.exec('ALTER TABLE collab_journal ADD COLUMN chronolog_owner INTEGER');
  function execute(name,input,as=author){author=as;db.exec('BEGIN');try{steps(definition.commands[name].prepare(input));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}
  const view={get generation(){return generation;},query(sql,parameters=[]){const statement=db.prepare(sql);return{rows:statement.all(...parameters).map(row=>Object.values(row))};}};
  return {db,definition,execute,view,setGeneration(value){generation=value;db.prepare('UPDATE chronolog_execution_context SET generation=?').run(Buffer.from(value,'hex'));},
    snapshot(taskId='task'){return definition.queries['collab.task'].read(view,{taskId});}};
}
function request(h,slots=[{slotId:'main',eligibleSigners:[B,C]}],responsePolicy='one'){
  h.execute('collab.request',{interactionId:'task',kind:'review',title:'Review a shared proposal',input:'{"proposal":1}',
    target:'{"kind":"workerGroup","groupId":"reviewers","mode":"claimOne"}',source:'{}',context:'{}',slots,responsePolicy},A);
}
const claim=(claimId='claim-b',expectedEpoch=0)=>({taskId:'task',slotId:'main',claimId,runId:'run-b',endpointIncarnation:'view-b',expectedEpoch,taskVersion:1});
const result=(resultId='result-b',claimEpoch=1,generation=G)=>({taskId:'task',slotId:'main',resultId,claimEpoch,taskVersion:1,generation,
  runId:'run-b',endpointIncarnation:'view-b',outcome:'succeeded',content:'{"answer":42}'});

test('one guarded claim wins and raw updates/deletes/inserts cannot bypass the schema',async()=>{
  const h=harness();request(h);h.execute('collab.claim',claim(),B);
  assert.throws(()=>h.execute('collab.claim',{...claim('claim-c'),runId:'run-c'},C));
  assert.throws(()=>h.db.exec("UPDATE collab_journal SET author='forged'"));
  assert.throws(()=>h.db.exec('DELETE FROM collab_journal'));
  assert.throws(()=>h.db.exec(`INSERT INTO collab_journal VALUES('forged',3,'claim','task','main','${C}','${G}','{"epoch":2,"runId":"evil","endpointIncarnation":"evil","taskVersion":1}',1)`));
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
