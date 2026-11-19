import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollaborationClient } from '../client.mjs';
import { createEffectDispatcher } from '../local.mjs';

const signer = 'a'.repeat(64);
test('a client cannot silently select a different run than its owner binding', () => {
  assert.throws(()=>createCollaborationClient({session:{command(){},query(){}},endpoint:{context:{runId:'bound-run'}},runId:'other-run'}),{code:'RUN_SCOPE_MISMATCH'});
});
test('uncertain submission retains the original signer reference before entering the owner', async () => {
  let retained;
  const session = { applicationId:'app', deviceId:signer, query(){}, async command() {
    assert.equal(retained.reference.author, signer); throw Object.assign(Error('response lost'), {code:'TIMEOUT'});
  } };
  const client = createCollaborationClient({session, store:{retainOperation(reference,context){retained={reference,context};}}});
  await assert.rejects(client.message({threadId:'thread',text:'hello'}, {operationId:'original'}), error =>
    error.code === 'TIMEOUT' && error.operationReference.author === signer && error.operationReference.operationId === 'original');
  assert.equal(retained.context.input.text,'hello');
});

test('outcome observation subscribes before querying and closes its waiter without cancelling work', async () => {
  let pending, subscribed=false, queries=0, cancellations=0, returned=false;
  const session={applicationId:'app',deviceId:signer,command(){cancellations++;},
    async query(){assert.equal(subscribed,true);queries++;
      if(queries===1){pending({done:false,value:{}});return{value:{task:{status:'open'}}};}
      return{value:{task:{status:'completed'}},revision:{generation:'g'}};
    },
    changes({signal}){return{[Symbol.asyncIterator](){return this;},next(){subscribed=true;return new Promise((resolve,reject)=>{
      pending=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},async return(){returned=true;return{done:true};}};}
  };
  const result=await createCollaborationClient({session}).waitForOutcome('task');
  assert.equal(result.task.status,'completed');assert.equal(returned,true);assert.equal(cancellations,0);
});

test('a completed provider receipt wins a concurrent dispatch failure and is never replaced', async () => {
  const records=new Map();let rejectDispatch,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const journal={idempotencyKey:id=>`provider-scope:${id}`,async transact(id,update){const {record,value}=update(records.get(id));records.set(id,record);return value;}};
  const dispatcher=createEffectDispatcher({journal,authorize:async()=>{},
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
  const client=createCollaborationClient({session:{applicationId:'app',deviceId:signer,command(){},query(){},detach(){detached++;},close(){closed++;}}});
  await client.detach();await client.detach();assert.equal(detached,1);assert.equal(closed,0);
  assert.throws(()=>client.snapshot(),{code:'ENDPOINT_STALE'});
});
