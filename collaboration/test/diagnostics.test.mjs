import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseApplicationSession, diagnosticFinding } from '../../session/diagnostics.mjs';

const session = status => ({ applicationId:'a'.repeat(64),identity:{publicKey:'b'.repeat(64)},
  status:{canAuthor:true,phase:'ready',database:'idle',connectedPeers:0,pendingOperations:0,materializationError:null,...status},
  describe:()=>({id:'definition',version:'1',commands:[{name:'submit',input:{privateExample:'never-report'}}],queries:[{name:'state'}]}),
  query(){throw Error('Diagnostics must not activate data');},
  get authority(){throw Error('Diagnostics must not open another authority reader');},
  get operations(){throw Error('Diagnostics must not read application operations');},
});
test('doctor stays protocol-only and redacts unknown endpoint, state and definition payloads',async()=>{
  const value=session({secret:'never-report'});
  value.endpoint={ownerInstanceId:'owner',endpointId:'endpoint',endpointIncarnation:'incarnation',token:'never-report',
    identity:{agentBindingId:'reviewer',credential:'never-report'},context:{runId:'run',viewId:'view',input:'never-report'},capabilities:['queries','diagnostics']};
  value.endpoints=async()=>[value.endpoint];
  const report=await diagnoseApplicationSession(value,{mode:'attach'});
  assert.equal(report.assessment,'ready');assert.equal(report.scope.agentBindingId,'reviewer');assert.equal(report.scope.runId,'run');
  assert.deepEqual(report.definition.commands,['submit']);assert.deepEqual(report.definition.queries,['state']);
  assert.equal(report.findings.find(item=>item.code==='DATA_IDLE').severity,'info');
  assert.doesNotMatch(JSON.stringify(report),/never-report|privateExample|credential|token/);
  assert.notEqual(report.endpoints[0],value.endpoint);
});
test('missing keys, failed local materialization and owner loss have distinct actions without inventing a coordinator',async()=>{
  for(const [state,code] of [[{phase:'awaiting-keys',canAuthor:false},'KEYS_UNAVAILABLE'],[{database:'failed'},'DATA_UNAVAILABLE'],[{phase:'closed',canAuthor:false},'OWNER_UNREACHABLE']]){
    const report=await diagnoseApplicationSession(session(state)),finding=report.findings.find(item=>item.code===code);
    assert.ok(finding);assert.equal(finding.scope.applicationId,'a'.repeat(64));assert.equal(finding.scope.publicKey,'b'.repeat(64));
    assert.equal(finding.retrySafe,false);assert.ok(finding.nextAction.length>40);
    assert.equal(report.assessment,state.phase==='closed'?'unavailable':'attention-required');
    assert.equal(report.status.canAuthor,state.canAuthor??true,'a failed read does not revoke local authoring');
  }
  const value=session({database:'ready'});value.diagnostics=async()=>[];
  const report=await diagnoseApplicationSession(value);
  assert.equal(report.assessment,'ready');assert.equal(report.status.canAuthor,true);
  assert.equal(report.participation.phase,'disconnected');assert.equal(report.transport.authenticatedPeers,0);
  assert.doesNotMatch(JSON.stringify(report),/coordinator|generation|recovery/);
});
test('restricted endpoint diagnostics retain the original denial without erasing session observations',async()=>{
  const value=session();value.endpoints=async()=>{throw Object.assign(Error('secret credential'),{code:'ENDPOINT_CAPABILITY_FORBIDDEN'});};
  const report=await diagnoseApplicationSession(value),finding=report.findings.find(item=>item.code==='ENDPOINT_CAPABILITY_FORBIDDEN');
  assert.equal(report.identity.publicKey,'b'.repeat(64));assert.equal(finding.severity,'warning');assert.equal(finding.retrySafe,false);
  assert.match(finding.nextAction,/approved attachment capabilities/);assert.doesNotMatch(JSON.stringify(report),/secret credential/);
});
test('diagnostic error mapping preserves exact codes without exposing arbitrary messages or unsafe retry claims',()=>{
  const result=diagnosticFinding(Object.assign(Error('token=secret'),{code:'SUPERVISOR_BINDING_REVOKED'}),{
    scope:{applicationId:'app',agentBindingId:'binding',token:'secret',operationId:'original'},state:{phase:'closed',message:'secret'}});
  assert.equal(result.code,'SUPERVISOR_BINDING_REVOKED');assert.match(result.nextAction,/new explicitly approved binding/);
  assert.equal(result.retrySafe,false);assert.doesNotMatch(JSON.stringify(result),/secret/);
  assert.equal(diagnosticFinding({code:'OPERATION_UNCERTAIN'}).retrySafe,false);
  assert.match(diagnosticFinding({code:'OPERATION_UNCERTAIN'}).nextAction,/original signer-scoped operation/);
});
test('cancelled diagnostics do not observe a session or convert cancellation into a healthy report',async()=>{
  const signal=AbortSignal.abort(Error('cancelled'));
  await assert.rejects(diagnoseApplicationSession(new Proxy({}, {get(){throw Error('must not observe');}}),{signal}),/cancelled/);
  const controller=new AbortController(),value=session();
  value.endpoints=async()=>{controller.abort(Error('cancelled while observing'));return[];};
  await assert.rejects(diagnoseApplicationSession(value,{signal:controller.signal}),/cancelled while observing/);
});


test('incompatible owner metadata preserves its exact code and directs a composition upgrade without resetting retained state',()=>{
  for(const error of[Error('APPLICATION_WORKER_METADATA_INVALID'),{code:'APPLICATION_WORKER_METADATA_INVALID',message:'token=private'}]){
    const finding=diagnosticFinding(error);
    assert.equal(finding.code,'APPLICATION_WORKER_METADATA_INVALID');assert.equal(finding.retrySafe,false);
    assert.match(finding.nextAction,/mixed package\/owner composition/);assert.match(finding.nextAction,/Preserve the existing device identity, storage and original signed operation references/);
    assert.match(finding.nextAction,/Close old app tabs/);assert.match(finding.nextAction,/update native participants and the signed UI to the same qualified public package composition/);
    assert.match(finding.nextAction,/reopen the retained profile/);assert.match(finding.nextAction,/Do not reset or clear app data/);assert.doesNotMatch(JSON.stringify(finding),/token=private/);
  }
});
