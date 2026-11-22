import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewStore, createEffectDispatcher } from '../local.mjs';
import { canonicalJson, prepareCollaborationCommand, resolveRecipient, consumerCursor, validateConsumerCursor, operationReference } from '../protocol.mjs';

function storage(){const data=new Map();return{get length(){return data.size;},key:i=>[...data.keys()][i]??null,
  getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};}
const signer='a'.repeat(64);
test('local drafts and references are independent even when two views inspect the same original operation',()=>{
  const shared=storage(),scope={storage:shared,applicationId:'app',profileId:'profile'};
  const a=createViewStore({...scope,viewId:'view-a'}),b=createViewStore({...scope,viewId:'view-b'});
  a.writeDraft({text:'a'});b.writeDraft({text:'b'});assert.equal(a.readDraft().text,'a');
  const ref={applicationId:'app',historyId:'history',author:signer,operationId:'operation'};
  a.retainOperation(ref,{input:'original'});b.retainOperation(ref,{input:'original'});a.removeOperation(ref);
  assert.equal(a.pending().length,0);assert.equal(b.pending().length,1);
  assert.throws(()=>b.retainOperation(ref,{input:'edited'}),{code:'OPERATION_REFERENCE_CONFLICT'});
  assert.equal(b.inspectOperation(ref).context.input,'original');
  const attempt='b'.repeat(64),generation='c'.repeat(64);
  b.retainOperation({...ref,attemptId:attempt,generation},{input:'original'});
  assert.equal(b.inspectOperation(ref).reference.attemptId,attempt);
  assert.throws(()=>b.retainOperation({...ref,attemptId:'d'.repeat(64)},{input:'original'}),{code:'OPERATION_REFERENCE_CONFLICT'});
  assert.throws(()=>b.retainOperation({...ref,attemptId:'invalid-digest'},{input:'original'}),{code:'OPERATION_REFERENCE_INVALID'});
  assert.equal(b.inspectOperation(ref).reference.attemptId,attempt);
});
test('local storage encodes every identity segment without allowing sibling removals',()=>{
  const shared=storage(),scope={storage:shared,applicationId:'app',profileId:'profile'};
  const left=createViewStore({...scope,viewId:'c'}),right=createViewStore({...scope,viewId:'b:view:c'});
  const ref={applicationId:'app',historyId:'history',author:signer,operationId:'a:view:b'},other={...ref,operationId:'a'};
  left.retainOperation(ref,{input:'left'});right.retainOperation(other,{input:'right'});
  assert.equal(left.pending().length,1);assert.equal(right.pending().length,1);
  assert.equal(left.pending({allViews:true}).length,2);
  left.removeOperation(ref);assert.equal(right.inspectOperation(other).context.input,'right');

  const draftLeft=createViewStore({...scope,viewId:'a'}),draftRight=createViewStore({...scope,viewId:'a:draft:b'});
  draftLeft.writeDraft({text:'left'},'b:draft:c');draftRight.writeDraft({text:'right'},'c');
  draftLeft.removeDraft('b:draft:c');assert.equal(draftRight.readDraft('c').text,'right');

  const appLeft=createViewStore({storage:shared,applicationId:'a:b',profileId:'c',viewId:'view'});
  const appRight=createViewStore({storage:shared,applicationId:'a',profileId:'b:c',viewId:'view'});
  appLeft.writeDraft({text:'left'});appRight.writeDraft({text:'right'});appLeft.removeDraft();
  assert.equal(appRight.readDraft().text,'right');
  appLeft.retainOperation({...ref,applicationId:'a:b'},{input:'left'});
  assert.equal(appRight.pending({allViews:true}).length,0);
});
test('ambiguous candidate storage is preserved without assigning it to a new view',()=>{
  const shared=storage(),legacy='tendriller:collaboration:v1:app:profile:operation:'+signer+':a:view:b:view:c';
  shared.setItem(legacy,JSON.stringify({reference:{applicationId:'app',author:signer,operationId:'a'},viewId:'b:view:c',context:{}}));
  const view=createViewStore({storage:shared,applicationId:'app',profileId:'profile',viewId:'c'});
  assert.deepEqual(view.pending({allViews:true}),[]);
  view.removeOperation({applicationId:'app',historyId:'history',author:signer,operationId:'a:view:b'});
  assert.notEqual(shared.getItem(legacy),null);
});
test('references bind verified session history and local stores separate histories',()=>{
  const session={applicationId:'app',historyId:'history: one/二',deviceId:signer};
  const ref=operationReference(session,'operation',{historyId:'caller-label'});
  assert.equal(ref.historyId,session.historyId);assert.ok(Object.isFrozen(ref));
  assert.throws(()=>operationReference({...session,historyId:undefined},'operation'),{code:'OPERATION_SCOPE_MISMATCH'});
  assert.throws(()=>operationReference(session,'operation',{operationId:'different'}),{code:'OPERATION_REFERENCE_CONFLICT'});
  const scoped={...session,scopeOperationId(){throw Error('Must not scope an inspected foreign signer');}};
  assert.equal(operationReference(scoped,'foreign-operation',{author:'b'.repeat(64),operationId:'foreign-operation'}).operationId,'foreign-operation');
  const shared=storage(),scope={storage:shared,applicationId:'app',profileId:'profile',viewId:'view'};
  const beforeAttachment=createViewStore(scope),bound=createViewStore({...scope,historyId:session.historyId});
  const other=createViewStore({...scope,historyId:'history: two/二'}),foreign={...ref,historyId:other.historyId};
  beforeAttachment.retainOperation(ref,{input:'first'});beforeAttachment.retainOperation(foreign,{input:'second'});
  beforeAttachment.removeOperation(ref);assert.equal(beforeAttachment.inspectOperation(foreign).context.input,'second');
  bound.writeDraft({text:'first'});other.writeDraft({text:'second'});bound.removeDraft();
  assert.equal(other.readDraft().text,'second');assert.equal(beforeAttachment.readDraft(),null);
  bound.retainOperation(ref);assert.throws(()=>bound.retainOperation(foreign),{code:'OPERATION_SCOPE_MISMATCH'});
  assert.equal(other.pending({allViews:true}).length,0);
  assert.throws(()=>beforeAttachment.retainOperation({...ref,historyId:undefined}),{code:'OPERATION_SCOPE_MISMATCH'});
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
