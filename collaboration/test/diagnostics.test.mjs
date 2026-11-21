import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseApplicationSession, diagnosticFinding } from '../../session/diagnostics.mjs';

const session = status => ({ applicationId:'application',historyId:'history',deviceId:'signer',
  status:{phase:'ready',database:'idle',role:'coordinator',generation:'selected',coordinator:'signer',connectedPeers:0,...status},
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
test('unavailable coordinator, keys and recovery produce distinct scoped next actions',async()=>{
  for(const [phase,code]of[['waiting','COORDINATOR_UNAVAILABLE'],['awaiting-keys','KEYS_UNAVAILABLE'],['recovering','RECOVERY_REVIEW_REQUIRED'],['closed','OWNER_UNREACHABLE']]){
    const report=await diagnoseApplicationSession(session({phase,database:'ready'}));
    const finding=report.findings.find(item=>item.code===code);
    assert.ok(finding);assert.equal(finding.scope.historyId,'history');assert.equal(finding.state.generation,'selected');
    assert.equal(finding.retrySafe,false);assert.ok(finding.nextAction.length>40);
    assert.equal(report.assessment,phase==='closed'?'unavailable':'attention-required');
  }
  const value=session({database:'failed'});value.participation={status:{phase:'approval-required',connectedPeers:[],error:'private payload'}};
  const report=await diagnoseApplicationSession(value);
  assert.ok(report.findings.some(item=>item.code==='RECOVERY_REVIEW_REQUIRED'));
  assert.ok(report.findings.some(item=>item.code==='DATA_UNAVAILABLE'));
  assert.doesNotMatch(JSON.stringify(report),/private payload/);
});
test('restricted endpoint diagnostics retain the original denial without erasing session observations',async()=>{
  const value=session();value.endpoints=async()=>{throw Object.assign(Error('secret credential'),{code:'APPLICATION_ATTACHMENT_FORBIDDEN'});};
  const report=await diagnoseApplicationSession(value),finding=report.findings.find(item=>item.code==='APPLICATION_ATTACHMENT_FORBIDDEN');
  assert.equal(report.identity.deviceId,'signer');assert.equal(finding.severity,'warning');assert.equal(finding.retrySafe,false);
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
