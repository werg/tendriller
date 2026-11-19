import test from 'node:test';
import assert from 'node:assert/strict';
import { participantModel, receiptModel } from '../presentation.mjs';

test('participant counts use stable identities and distinct endpoint incarnations',()=>{
  const signer='a'.repeat(64),endpoint={deviceId:signer,endpointId:'view',endpointIncarnation:'one'};
  const entry={kind:'person',deviceId:signer,principalId:'human',authorized:true,endpoint,presence:{expiresAt:200,phase:'reachable'}};
  const model=participantModel([entry,{...entry,label:'Updated label'},{...entry,endpoint:{...endpoint,endpointIncarnation:'two'}},
    {kind:'agent',deviceId:'b'.repeat(64),agentBindingId:'reviewer',authorized:true},
    {kind:'agent',deviceId:'c'.repeat(64),agentBindingId:'reviewer',authorized:true}],{selfEndpoint:endpoint,now:100});
  assert.deepEqual(model.counts,{people:1,agents:1,devices:3,endpoints:2});assert.equal(model.participants.length,4);
  assert.equal(model.participants[0].label,'Updated label');assert.equal(model.participants[0].thisView,true);
  assert.equal(model.participants[1].thisView,false);
});
test('fresh presence cannot restore revoked or missing application authority',()=>{
  const base={kind:'agent',deviceId:'a'.repeat(64),presence:{expiresAt:200,phase:'reachable'}};
  assert.equal(participantModel([{...base,authorized:false}],{now:100}).participants[0].canRequest,false);
  assert.equal(participantModel([{...base,authorized:true,revoked:true}],{now:100}).participants[0].availability,'revoked');
  assert.equal(participantModel([{...base,authorized:true}],{now:300}).participants[0].availability,'unknown');
  assert.equal(participantModel([{...base,authorized:true}],{now:100}).participants[0].availability,'on-demand');
});
test('delivery and uncertain effects are described without claiming an accepted answer',()=>{
  assert.match(receiptModel({status:'delivered'}).detail,/does not establish a model turn/);
  assert.match(receiptModel({status:'outcomeUnknown'}).detail,/original operation/);
  assert.equal(receiptModel({status:'applied',outcome:'rejected'}).label,'Rejected in selected history');
});
