import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewStore, createEffectDispatcher } from '../local.mjs';
import { canonicalJson, prepareCollaborationCommand, resolveRecipient, consumerCursor, validateConsumerCursor } from '../protocol.mjs';

function storage(){const data=new Map();return{get length(){return data.size;},key:i=>[...data.keys()][i]??null,
  getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};}
const signer='a'.repeat(64);
test('local drafts and references are independent even when two views inspect the same original operation',()=>{
  const shared=storage(),scope={storage:shared,applicationId:'app',profileId:'profile'};
  const a=createViewStore({...scope,viewId:'view-a'}),b=createViewStore({...scope,viewId:'view-b'});
  a.writeDraft({text:'a'});b.writeDraft({text:'b'});assert.equal(a.readDraft().text,'a');
  const ref={applicationId:'app',author:signer,operationId:'operation'};
  a.retainOperation(ref,{input:'original'});b.retainOperation(ref,{input:'original'});a.removeOperation(ref);
  assert.equal(a.pending().length,0);assert.equal(b.pending().length,1);
  assert.throws(()=>b.retainOperation(ref,{input:'edited'}),{code:'OPERATION_REFERENCE_CONFLICT'});
  assert.equal(b.inspectOperation(ref).context.input,'original');
  b.retainOperation({...ref,attemptId:'first-attempt',generation:'first-generation'},{input:'original'});
  assert.equal(b.inspectOperation(ref).reference.attemptId,'first-attempt');
  assert.throws(()=>b.retainOperation({...ref,attemptId:'replacement'},{input:'original'}),{code:'OPERATION_REFERENCE_CONFLICT'});
});
test('owner attribution replaces caller source and full incarnation fences endpoint identity',()=>{
  const endpoint={ownerInstanceId:'owner',endpointId:'endpoint',endpointIncarnation:'incarnation',context:{runId:'real-run',documentPath:'board.html'}};
  const prepared=prepareCollaborationCommand(endpoint,'collab.request',{source:'{"deviceId":"forged"}'},signer);
  const source=JSON.parse(prepared.source);assert.equal(source.deviceId,signer);assert.equal(source.documentPath,'board.html');
  assert.equal(source.contextEvidence,'same-origin-assertion');
  assert.equal(prepareCollaborationCommand(endpoint,'collab.claim',{runId:'forged',endpointIncarnation:'forged'},signer).runId,'real-run');
});
test('recipient discovery rejects ambiguity and presence cannot confer authority',()=>{
  const target={kind:'agent',agentBindingId:'reviewer'};
  assert.throws(()=>resolveRecipient(target,[{agentBindingId:'reviewer',deviceId:signer,available:true}]),{code:'RECIPIENT_UNAVAILABLE'});
  assert.throws(()=>resolveRecipient(target,[{agentBindingId:'reviewer',deviceId:signer,authorized:true},{agentBindingId:'reviewer',deviceId:'b'.repeat(64),authorized:true}]),{code:'RECIPIENT_AMBIGUOUS'});
});
test('cursor identity includes consumer, filter, generation and retention boundary',()=>{
  const scope={applicationId:'app',consumerId:'worker-a',filterVersion:'filter-v1',generation:'gen-1'},cursor=consumerCursor(scope,12);
  assert.equal(validateConsumerCursor(cursor,scope).sequence,12);
  for(const changed of [{...scope,consumerId:'worker-b'},{...scope,generation:'gen-2'},{...scope,filterVersion:'filter-v2'}])
    assert.throws(()=>validateConsumerCursor(cursor,changed),{code:'CURSOR_RESET_REQUIRED'});
  assert.throws(()=>validateConsumerCursor(cursor,scope,{retainedFrom:13}),{code:'CURSOR_RESET_REQUIRED'});
});
test('effect uncertainty is retained outside app history and never causes automatic redispatch',async()=>{
  const records=new Map();let sends=0;
  const journal={async transact(id,fn){const {record,value}=fn(records.get(id));records.set(id,record);return value;}};
  const effects=createEffectDispatcher({journal,authorize:async()=>{},dispatch:async()=>{sends++;throw Error('receipt lost');}});
  const request={effectId:'effect-one',fence:{generation:'gen-1',epoch:1},input:{action:'send'}};
  await assert.rejects(effects.execute(request),{code:'EFFECT_OUTCOME_UNKNOWN'});
  assert.equal((await effects.execute(request)).status,'outcomeUnknown');assert.equal(sends,1);
  await assert.rejects(effects.execute({...request,input:{action:'changed'}}),{code:'EFFECT_ID_CONFLICT'});
});
test('canonical payload rejects accessors, nonfinite numbers and unbounded structure',()=>{
  assert.equal(canonicalJson({b:1,a:2}),'{"a":2,"b":1}');
  assert.throws(()=>canonicalJson({get secret(){throw Error('must not execute');}}),{code:'INVALID_PAYLOAD'});
  assert.throws(()=>canonicalJson({x:NaN}));assert.throws(()=>canonicalJson('abc',2));
});
