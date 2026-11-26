import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollaborationClient } from '../client.mjs';
import { createEffectDispatcher } from '../local.mjs';

const signer = 'a'.repeat(64), app = 'c'.repeat(64), proposalId = '1'.repeat(64);
const inspection = (operationId='original',author=signer) => ({applicationId:app,author,operationId,proposalId,stored:true,pending:'materializer',materialized:null,retained:[],finalized:false,excluded:false});
test('a client cannot silently select a different run than its owner binding', () => {
  assert.throws(()=>createCollaborationClient({session:{command(){},query(){}},endpoint:{context:{runId:'bound-run'}},runId:'other-run'}),{code:'RUN_SCOPE_MISMATCH'});
});
test('uncertain submission retains the original signer reference before entering the owner', async () => {
  let retained;
  const session = { applicationId:app, identity:{publicKey:signer}, query(){}, async command() {
    assert.equal(retained.source.deviceId, signer); throw Object.assign(Error('response lost'), {code:'TIMEOUT'});
  } };
  const client = createCollaborationClient({session, store:{writeDraft(value){retained=value;},retainOperation(_reference,value){retained=value;}}});
  await assert.rejects(client.message({threadId:'thread',text:'hello'}, {operationId:'original'}), error =>
    error.code === 'TIMEOUT' && error.operationReference.author === signer && error.operationReference.operationId === 'original');
  assert.equal(retained.input.text,'hello');
  assert.equal(retained.source.deviceId,signer);
});

test('generated request identities and submitted input remain immutable across an uncertain boundary', async () => {
  let release,entered,submitted,retained;
  const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const session={applicationId:app,identity:{publicKey:signer},query(){},async command(name,input,options){
    submitted={name,input,options};assert.equal(retained.identities.interactionId,input.interactionId);
    assert.ok(Object.isFrozen(input.slots[0]));entered();await gate;
    return Object.freeze({stored:true,async inspect(){return inspection(options.operationId);},async materialized(){return {outcome:'accepted'};},async retained(){return[];},async finalized(){throw Error('FINALITY_UNSUPPORTED');}});
  }};
  const client=createCollaborationClient({session,store:{writeDraft(value){retained=value;},retainOperation(_reference,value){retained=value;}}});
  const input={kind:'review',title:'Review',input:{proposal:1},target:{kind:'signer',deviceId:signer},slots:[{slotId:'main',eligibleSigners:[signer]}]};
  const promise=client.request(input,{operationId:'original'});await waiting;
  input.slots[0].eligibleSigners.push('b'.repeat(64));input.input.proposal=2;release();
  const operation=await promise;
  assert.match(operation.identities.interactionId,/^[0-9a-f-]{36}$/u);
  assert.equal(operation.identities.taskId,operation.identities.interactionId);
  assert.equal(operation.identities.operationId,'original');assert.equal(operation.submission.command,'collab.request');
  assert.equal(operation.submission,retained);assert.equal(operation.submission.input,submitted.input);
  assert.deepEqual(submitted.input.slots[0].eligibleSigners,[signer]);assert.equal(submitted.input.input,'{"proposal":1}');
  assert.equal(operation.reference.proposalId,'1'.repeat(64));assert.ok(Object.isFrozen(operation));
  assert.throws(()=>{operation.identities.interactionId='replacement';},TypeError);
  assert.throws(()=>{operation.submission.input.slots[0].eligibleSigners.push('c'.repeat(64));},TypeError);
});

test('uncertain commands expose every generated identity even when a transport error is frozen', async () => {
  const cases=[
    ['request',{kind:'review',title:'Review',input:null,target:{kind:'signer',deviceId:signer},slots:[{slotId:'main',eligibleSigners:[signer]}]},'interactionId'],
    ['claim',{taskId:'task',slotId:'main'},'claimId'],
    ['handoff',{taskId:'task',slotId:'main',expectedEpoch:1,assignee:signer,reason:'Review'},'actionId'],
    ['result',{taskId:'task',slotId:'main',claimEpoch:1,claimProposalId:proposalId,content:{}},'resultId'],
    ['cancel',{taskId:'task',expectedVersion:1,reason:'Stopped'},'actionId'],
    ['acknowledgeCancel',{taskId:'task',slotId:'main',claimEpoch:1,claimProposalId:proposalId},'actionId'],
    ['finalize',{taskId:'task',expectedVersion:1,resultIds:['result'],content:{}},'actionId'],
    ['message',{threadId:'thread',text:'hello'},'messageId'],
  ];
  for(const [method,input,identity] of cases){
    let retained,submitted;const lost=Object.freeze(Object.assign(Error('response lost'),{code:'TIMEOUT'}));
    const client=createCollaborationClient({session:{applicationId:app,identity:{publicKey:signer},query(){},async command(name,value){
      submitted=value;assert.equal(retained.identities[identity],value[identity]);throw lost;
    }},store:{writeDraft(value){retained=value;},retainOperation(_reference,value){retained=value;}}});
    await assert.rejects(client[method](input),error=>{
      assert.equal(error.code,'TIMEOUT');assert.equal(error.cause,lost);
      assert.equal(error.operationReference.applicationId,app);
      assert.equal(error.operationIdentities.operationId,error.operationReference.operationId);
      assert.equal(error.operationIdentities[identity],submitted[identity]);
      assert.equal(error.operationSubmission,retained);assert.ok(Object.isFrozen(error.operationIdentities));
      assert.throws(()=>{error.operationIdentities={};},TypeError);
      assert.throws(()=>{error.operationSubmission.input[identity]='replacement';},TypeError);
      return true;
    });
  }
});

test('a local post-save failure retains the signed attempt and generated identity', async () => {
  let writes=0;
  const session={applicationId:app,identity:{publicKey:signer},query(){},async command(name,input,options){
    return{async inspect(){return inspection(options.operationId);}};
  }};
  const client=createCollaborationClient({session,store:{writeDraft(){writes++;},retainOperation(){if(++writes===2)throw Object.assign(Error('storage unavailable'),{code:'LOCAL_STORAGE_UNAVAILABLE'});}}});
  await assert.rejects(client.message({threadId:'thread',text:'hello'},{operationId:'original'}),error=>{
    assert.equal(error.code,'LOCAL_STORAGE_UNAVAILABLE');assert.equal(error.operationReference.proposalId,'1'.repeat(64));
    assert.equal(error.operationIdentities.messageId,error.operationSubmission.input.messageId);return true;
  });
});

test('a lost command response preserves its exact handle and retry uses only its original signed proposal', async () => {
  let retained,submitted,retried=0;
  const session={applicationId:app,identity:{publicKey:signer},query(){},
    async command(_name,_input,options){assert.equal(retained.identities.operationId,'original');submitted=options.operationId;throw Object.assign(Error('lost'),{code:'TIMEOUT'});},
    operations:{get:async id=>{assert.equal(id,'original');return{inspect:()=>inspection()};},async retry(id){assert.equal(id,'original');retried++;}}};
  const client=createCollaborationClient({session,store:{writeDraft(value){retained=value;}}});let reference;
  await assert.rejects(client.message({threadId:'thread',text:'hello'},{operationId:'original'}),error=>{reference=error.operationReference;return error.code==='TIMEOUT';});
  assert.equal(submitted,'original');assert.equal(reference.proposalId,undefined);await client.retry(reference);assert.equal(retried,1);
});

test('inspection verifies original authenticated proposal and actor rather than caller-supplied labels', async () => {
  const other='b'.repeat(64),calls=[],retried=[];let state=inspection('original',other);
  const session={applicationId:app,identity:{publicKey:signer},command(){},query(){},
    operations:{get:async id=>{calls.push(id);return state?{inspect:()=>state}:null;},async retry(id){retried.push(id);}}};
  const client=createCollaborationClient({session}),reference={applicationId:app,author:other,operationId:'original',proposalId};
  assert.equal((await client.inspectOperation(reference)).author,other);assert.deepEqual(calls,[proposalId]);
  await assert.rejects(client.retry(reference),{code:'ORIGINAL_SIGNER_REQUIRED'});
  const own={...reference,author:signer};state=inspection();await client.retry(own);assert.deepEqual(retried,[proposalId]);
  await assert.rejects(client.inspectOperation({...own,applicationId:'d'.repeat(64)}),{code:'OPERATION_SCOPE_MISMATCH'});
  for(const changed of [{...own,proposalId:'3'.repeat(64)},{...own,operationId:'changed'},{...own,author:other}])
    await assert.rejects(client.inspectOperation(changed),{code:'OPERATION_REFERENCE_CONFLICT'});
  state=null;assert.equal(await client.inspectOperation(own),null);await assert.rejects(client.retry(own),{code:'OPERATION_UNAVAILABLE'});
  state=inspection('original',other);await assert.rejects(client.retry(own),{code:'OPERATION_REFERENCE_CONFLICT'});assert.deepEqual(retried,[proposalId]);
});

test('outcome observation subscribes before querying and closes its waiter without cancelling work', async () => {
  let pending, subscribed=false, queries=0, cancellations=0, returned=false;
  const session={applicationId:app,identity:{publicKey:signer},command(){cancellations++;},
    async query(){assert.equal(subscribed,true);queries++;
      if(queries===1){pending({done:false,value:{}});return{value:{task:{status:'open'}}};}
      return{value:{task:{status:'completed'}},revision:{digest:'a'.repeat(64),view:'local',stateRoot:'b'.repeat(64),historyDigest:'c'.repeat(64),orderLength:1}};
    },
    changes({signal}){return{[Symbol.asyncIterator](){return this;},next(){subscribed=true;return new Promise((resolve,reject)=>{
      pending=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},async return(){returned=true;return{done:true};}};}
  };
  const result=await createCollaborationClient({session}).waitForOutcome('task');
  assert.equal(result.task.status,'completed');assert.equal(returned,true);assert.equal(cancellations,0);
});

test('page conveniences use approved named queries and capture stays an explicit raw-query capability',async()=>{
  const queries=[],denied=Object.assign(Error('named-query scope'),{code:'APPLICATION_ATTACHMENT_QUERY_FORBIDDEN'});
  let views=0,released=0;
  const session={applicationId:app,identity:{publicKey:signer},command(){},query(name,input){queries.push({name,input});return Promise.resolve({value:{},revision:{}});},
    async readView(){views++;return{query(){throw denied;},release(){released++;}};}};
  const client=createCollaborationClient({session});
  await client.tasks({limit:8,state:'open'});await client.results({taskId:'task',limit:16});
  await client.messages({cursor:'cursor'});await client.thread({threadId:'thread',limit:16});
  assert.deepEqual(queries.map(value=>value.name),['collab.tasks','collab.results','collab.messages','collab.thread']);
  assert.deepEqual(queries[0].input,{limit:8,state:'open'});assert.equal(views,0);
  await assert.rejects(client.capture(),value=>value===denied);assert.equal(views,1);assert.equal(released,1);
});

test('a completed provider receipt wins a concurrent dispatch failure and is never replaced', async () => {
  const records=new Map();let rejectDispatch,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const journal={idempotencyKey:id=>`provider-scope:${id}`,async transact(id,update){const {record,value}=update(records.get(id));records.set(id,record);return value;}};
  const dispatcher=createEffectDispatcher({journal,allowProvisionalEffects:true,authorize:async()=>{},
    dispatch:async({idempotencyKey})=>{assert.equal(idempotencyKey,'provider-scope:effect');started();return new Promise((_,reject)=>{rejectDispatch=reject;});},
    reconcile:async()=>({receiptId:'retained-provider-receipt'})});
  const input={effectId:'effect',fence:{epoch:1},input:{action:'send'}};
  const first=dispatcher.execute(input);await entered;
  const reconciled=await dispatcher.execute(input);rejectDispatch(Error('late transport failure'));
  const original=await first;assert.equal(original.status,'completed');assert.deepEqual(original.receipt,reconciled.receipt);
  assert.equal(records.get('effect').status,'completed');
});

test('local detach never closes the shared application owner', async () => {
  let detached=0,closed=0;
  const client=createCollaborationClient({session:{applicationId:app,identity:{publicKey:signer},command(){},query(){},detach(){detached++;},close(){closed++;}}});
  await client.detach();await client.detach();assert.equal(detached,1);assert.equal(closed,0);
  assert.throws(()=>client.snapshot(),{code:'ENDPOINT_STALE'});
});

test('ordinary storage never waits for a network or finalizer and the operation facade has no ambiguous acknowledgements',async()=>{
  const calls=[];const session={applicationId:app,identity:{publicKey:signer},query(){},async command(_name,_value,options){
    return{stored:true,inspect:()=>inspection(options.operationId),materialized:async()=>{calls.push('materialized');return{outcome:'accepted'};},
      retained:async()=>{calls.push('retained');return[];},finalized:async()=>{calls.push('finalized');throw Object.assign(Error('unsupported'),{code:'FINALITY_UNSUPPORTED'});}};}};
  const operation=await createCollaborationClient({session}).message({threadId:'thread',text:'Offline'},{operationId:'original'});
  assert.deepEqual(calls,[]);assert.equal(operation.stored,true);assert.equal(operation.proposalId,proposalId);
  assert.equal('applied' in operation,false);assert.equal('shared' in operation,false);
  await assert.rejects(operation.finalized(),{code:'FINALITY_UNSUPPORTED'});assert.deepEqual(calls,['finalized']);
});

test('an authorization callback is not a finality proof for irreversible provider work',async()=>{
  const records=new Map();let calls=0,state=inspection();
  const session={applicationId:app,operations:{async get(){return{inspect:()=>state};}}};
  const journal={async transact(id,update){const {record,value}=update(records.get(id));records.set(id,record);return value;}};
  const effects=createEffectDispatcher({journal,session,authorize:async()=>true,dispatch:async()=>{calls++;return{sent:true};}});
  const request={effectId:'effect',fence:{claimProposalId:proposalId},input:{send:'irreversible'}};
  await assert.rejects(effects.execute(request),{code:'EFFECT_FINALITY_PENDING'});assert.equal(calls,0);assert.equal(records.size,0);
  state={...state,finalized:true,materialized:{outcome:'accepted'}};assert.equal((await effects.execute(request)).status,'completed');assert.equal(calls,1);
});

test('an authenticated native attachment scopes its handle before persistence and signed-reference validation',async()=>{
  const canonical='native_'+'d'.repeat(64)+'_'+'e'.repeat(64);let draft,submitted;
  const session={applicationId:app,identity:{publicKey:signer},scopeOperationId(value){assert.ok(['local-handle',canonical].includes(value));return canonical;},query(){},
    async command(_name,_input,options){submitted=options.operationId;assert.equal(draft.identities.operationId,canonical);return{stored:true,inspect:()=>inspection(canonical),materialized:async()=>{},retained:async()=>[],finalized:async()=>{}};}};
  const client=createCollaborationClient({session,store:{writeDraft(value){draft=value;},retainOperation(reference){assert.equal(reference.operationId,canonical);}}});
  const operation=await client.message({threadId:'thread',text:'Scoped'},{operationId:'local-handle'});
  assert.equal(submitted,canonical);assert.equal(operation.reference.operationId,canonical);assert.equal(operation.identities.localOperationId,'local-handle');
});
