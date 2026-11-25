import { it, expect } from 'vitest';
const assert = {
  equal: (actual: unknown, expected: unknown) => expect(actual).toBe(expected),
  deepEqual: (actual: unknown, expected: unknown) => expect(actual).toEqual(expected),
  throws: (work: () => unknown, expected: { code: string }) => expect(work).toThrowError(expect.objectContaining(expected)),
  rejects: (promise: Promise<unknown>, expected: { code: string }) => expect(promise).rejects.toMatchObject(expected),
};
import { resolveConsumer, registerConsumer, requireConsumerOperation, callerContext, consumerCurrent, type ConsumerRow } from '../src/assistant-bindings';
import { sha256Hex } from '../src/ids';
import type { Tendril } from '../src/tendril';
import type { Connection } from '../src/assistant-admission';
import type { Principal } from '../src/assistant-shared';

const id='12345678-1234-1234-1234-123456789abc',token='td_c_'+id+'.'+'a'.repeat(64);
const approved={applicationId:'b'.repeat(64),queries:[{name:'read',description:'Read',input:{type:'null'}}],commands:[{name:'write',description:'Write',input:{type:'null'}}],events:[{name:'changed',description:'Changed'}]} as Connection;
const principal={account:'owner',grant:'grant',client:'client',scopes:['applications:read','applications:write'],expires:Date.now()+60_000,bindingCredential:token} as Principal;
async function fixture() {
  let row:ConsumerRow|null={id,client_id:'client',label:'Independent agent',credential_hash:await sha256Hex(token),revision:3,status:'active',queries:'["read"]',commands:'["write","removed"]',events:'["changed"]',route:'on-demand',created_at:1};
  const t={db:{one:(sql:string)=>sql.startsWith('SELECT COUNT')?{n:row?1:0}:row,run(){throw Error('unexpected write');}},now:()=>10} as unknown as Tendril;
  return{t,row:()=>row,set:(next:ConsumerRow|null)=>{row=next;}};
}
it('private proof remains bound to its original OAuth client and never falls back to an unbound consumer',async()=>{
  const f=await fixture();
  await assert.rejects(resolveConsumer(f.t,approved,{...principal,client:'sibling-client'}),{code:'invalid_agent_binding'});
  for(const bindingCredential of ['malformed','td_c_'+id+'.'+'c'.repeat(64)])
    await assert.rejects(resolveConsumer(f.t,approved,{...principal,bindingCredential}),{code:'invalid_agent_binding'});
  f.set({...f.row()!,status:'revoked'});await assert.rejects(resolveConsumer(f.t,approved,principal),{code:'agent_binding_revoked'});
});
it('consumer rights are intersected with owner consent and pending or stale revisions confer no authority',async()=>{
  const f=await fixture(),consumer=await resolveConsumer(f.t,approved,principal);
  assert.deepEqual(consumer.commands,['write']);assert.equal(consumer.verification,'approved-binding');
  assert.throws(()=>requireConsumerOperation(consumer,'commands','removed'),{code:'agent_operation_not_approved'});
  f.set({...f.row()!,revision:4});assert.equal(consumerCurrent(f.t,consumer),false);
  f.set({...f.row()!,status:'pending'});await assert.rejects(resolveConsumer(f.t,approved,principal),{code:'agent_binding_approval_required'});
});
it('registration retries cannot widen capabilities or rotate a proof implicitly',async()=>{
  const f=await fixture();f.set({...f.row()!,commands:'["write"]'});
  assert.deepEqual(await registerConsumer(f.t,approved,principal,{label:'Independent agent',queries:['read'],commands:['write'],events:['changed']}),{agentBindingId:id,status:'active',revision:3});
  await assert.rejects(registerConsumer(f.t,approved,principal,{label:'Independent agent',commands:[],queries:['read'],events:['changed']}),{code:'agent_binding_conflict'});
  await assert.rejects(registerConsumer(f.t,approved,{...principal,bindingCredential:'td_c_'+id+'.'+'d'.repeat(64)},{label:'Independent agent',queries:['read'],commands:['write'],events:['changed']}),{code:'agent_binding_conflict'});
  await assert.rejects(registerConsumer(f.t,approved,principal,{label:'Independent agent',commands:['private-command']}),{code:'operation_not_approved'});
});
it('caller context cannot assert an actor, provider binding, authority or operation finality',()=>{
  for(const key of ['author','deviceId','providerBindingId','finalized','administrator','proposalId'])
    assert.throws(()=>callerContext({[key]:'forged'}),{code:'invalid_arguments'});
  assert.deepEqual(callerContext({runId:'run',documentPath:'board.html'}),{runId:'run',documentPath:'board.html'});
});
