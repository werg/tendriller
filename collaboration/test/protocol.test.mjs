import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewStore, createEffectDispatcher } from '../local.mjs';
import { canonicalJson, prepareCollaborationCommand, resolveRecipient, consumerCursor, validateConsumerCursor, operationReference } from '../protocol.mjs';

function storage(){const data=new Map();return{get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};}
const signer='a'.repeat(64),app='b'.repeat(64),proposalId='c'.repeat(64);
const reference={applicationId:app,author:signer,operationId:'operation',proposalId};
test('local drafts and exact proposal references remain independent in two views',()=>{
  const shared=storage(),scope={storage:shared,applicationId:app,profileId:'profile'};
  const a=createViewStore({...scope,viewId:'view-a'}),b=createViewStore({...scope,viewId:'view-b'});
  a.writeDraft({text:'a'});b.writeDraft({text:'b'});assert.equal(a.readDraft().text,'a');
  a.retainOperation(reference,{input:'original'});b.retainOperation(reference,{input:'original'});a.removeOperation(reference);
  assert.equal(a.pending().length,0);assert.equal(b.pending().length,1);
  assert.throws(()=>b.retainOperation(reference,{input:'edited'}),{code:'OPERATION_REFERENCE_CONFLICT'});
  assert.equal(b.inspectOperation(reference).context.input,'original');
  assert.throws(()=>b.retainOperation({...reference,operationId:'changed'},{input:'original'}),{code:'OPERATION_REFERENCE_CONFLICT'});
});
test('local storage encodes every identity segment and cannot delete a sibling view or application',()=>{
  const shared=storage(),scope={storage:shared,applicationId:app,profileId:'profile'};
  const left=createViewStore({...scope,viewId:'c'}),right=createViewStore({...scope,viewId:'b:view:c'});
  left.retainOperation(reference,{input:'left'});right.retainOperation(reference,{input:'right'});
  assert.equal(left.pending().length,1);assert.equal(right.pending().length,1);assert.equal(left.pending({allViews:true}).length,2);
  left.removeOperation(reference);assert.equal(right.inspectOperation(reference).context.input,'right');
  const a=createViewStore({...scope,viewId:'a'}),b=createViewStore({...scope,viewId:'a:draft:b'});
  a.writeDraft({text:'left'},'b:draft:c');b.writeDraft({text:'right'},'c');a.removeDraft('b:draft:c');assert.equal(b.readDraft('c').text,'right');
  const other=createViewStore({storage:shared,applicationId:'d'.repeat(64),profileId:'profile',viewId:'c'});
  other.writeDraft({text:'other-app'});left.removeDraft();assert.equal(other.readDraft().text,'other-app');assert.deepEqual(other.pending(),[]);
});
test('only the authenticated inspection can complete a proposal reference and its application/actor/handle must agree',()=>{
  const session={applicationId:app,identity:{publicKey:signer}},pending=operationReference(session,'operation');
  assert.equal(pending.proposalId,undefined);assert.equal(pending.author,signer);assert.ok(Object.isFrozen(pending));
  assert.deepEqual(operationReference(session,'operation',reference),reference);
  for(const changed of [{...reference,applicationId:'d'.repeat(64)},{...reference,author:'e'.repeat(64)},{...reference,operationId:'changed'}])
    assert.throws(()=>operationReference(session,'operation',changed),{code:'OPERATION_REFERENCE_CONFLICT'});
  const store=createViewStore({storage:storage(),applicationId:app,profileId:'profile',viewId:'view'});
  assert.throws(()=>store.retainOperation(pending),{code:'OPERATION_SCOPE_MISMATCH'});
  assert.throws(()=>store.retainOperation({...reference,proposalId:'invalid'}),{code:'OPERATION_SCOPE_MISMATCH'});
});
test('owner attribution replaces caller source and endpoint incarnation fences its route',()=>{
  const endpoint={ownerInstanceId:'owner',endpointId:'endpoint',endpointIncarnation:'incarnation',context:{runId:'real-run',documentPath:'board.html'}};
  const prepared=prepareCollaborationCommand(endpoint,'collab.request',{source:'{"deviceId":"forged"}'},signer);
  const source=JSON.parse(prepared.source);assert.equal(source.deviceId,signer);assert.equal(source.documentPath,'board.html');assert.equal(source.contextEvidence,'same-origin-assertion');
  assert.equal(prepareCollaborationCommand(endpoint,'collab.claim',{runId:'forged',endpointIncarnation:'forged'},signer).runId,'real-run');
});
test('recipient selection rejects ambiguity and presence cannot confer authority',()=>{
  const target={kind:'agent',agentBindingId:'reviewer'};
  assert.throws(()=>resolveRecipient(target,[{agentBindingId:'reviewer',deviceId:signer,available:true}]),{code:'RECIPIENT_UNAVAILABLE'});
  assert.throws(()=>resolveRecipient(target,[{agentBindingId:'reviewer',deviceId:signer,authorized:true},{agentBindingId:'reviewer',deviceId:'b'.repeat(64),authorized:true}]),{code:'RECIPIENT_AMBIGUOUS'});
});
test('consumer cursors bind consumer, filter and exact projection digest, not application ordering',()=>{
  const scope={applicationId:app,consumerId:'worker-a',filterVersion:'filter-v1',revisionDigest:'1'.repeat(64)},cursor=consumerCursor(scope,12);
  assert.equal(validateConsumerCursor(cursor,scope).sequence,12);
  for(const changed of [{...scope,consumerId:'worker-b'},{...scope,revisionDigest:'2'.repeat(64)},{...scope,filterVersion:'filter-v2'}])
    assert.throws(()=>validateConsumerCursor(cursor,changed),{code:'CURSOR_RESET_REQUIRED'});
  assert.throws(()=>validateConsumerCursor(cursor,scope,{retainedFrom:13}),{code:'CURSOR_RESET_REQUIRED'});
});
test('provider receipt uncertainty is durable and never causes automatic redispatch',async()=>{
  const records=new Map();let sends=0;
  const journal={async transact(id,fn){const {record,value}=fn(records.get(id));records.set(id,record);return value;}};
  const effects=createEffectDispatcher({journal,allowProvisionalEffects:true,authorize:async()=>{},dispatch:async()=>{sends++;throw Error('receipt lost');}});
  const request={effectId:'effect-one',fence:{claimProposalId:proposalId,epoch:1},input:{action:'send'}};
  await assert.rejects(effects.execute(request),{code:'EFFECT_OUTCOME_UNKNOWN'});assert.equal((await effects.execute(request)).status,'outcomeUnknown');assert.equal(sends,1);
  await assert.rejects(effects.execute({...request,input:{action:'changed'}}),{code:'EFFECT_ID_CONFLICT'});
});
test('canonical payload validation rejects accessors, nonfinite numbers and unbounded structure',()=>{
  assert.equal(canonicalJson({b:1,a:2}),'{"a":2,"b":1}');
  assert.throws(()=>canonicalJson({get secret(){throw Error('must not execute');}}),{code:'INVALID_PAYLOAD'});
  assert.throws(()=>canonicalJson({x:NaN}));assert.throws(()=>canonicalJson('abc',2));
});
