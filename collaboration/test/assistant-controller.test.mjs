import test from 'node:test';
import assert from 'node:assert/strict';
import { createSigningIdentity, signAppDescriptor, signMembership, epochKeyCommitment,
  createApplicationSession, openApplicationDevice, defineApplication, defineCommand, defineQuery, emit, program,
  createScopedApplicationTools, eventExecutionManifest, executionManifestArtifacts, bytesToHex } from '@chronolog/peer-session';
import { connectApplicationAssistant } from '../../contract/assistant.mjs';

class EphemeralBytes {
  records=new Map();
  async get(key){return this.records.get(key)?.slice()??null;}
  async put(key,value){this.records.set(key,value.slice());}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('actual scoped controller namespaces once, preserves signed provenance and denies sibling journal access',async t=>{
  const device=await openApplicationDevice({store:new EphemeralBytes(),create:true}),signer=await createSigningIdentity();
  const applicationId='a'.repeat(64),key=crypto.getRandomValues(new Uint8Array(32));
  const manifest=await executionManifestArtifacts(await eventExecutionManifest());
  const descriptor=await signAppDescriptor({applicationId,rootPrincipal:device.identity.publicKey,authorityPublicKey:signer.publicKey,
    executionManifestDigest:bytesToHex(manifest.executionManifestDigest),finalityPolicy:{kind:'none'}},signer);
  const membership=await signMembership({applicationId,revision:0,previous:null,authorTimeAfterMs:-1n,epoch:0,
    epochKeyDigest:await epochKeyCommitment(applicationId,0,key),members:[{publicKey:device.identity.publicKey,reader:true,writer:true,administrator:true,publisher:false,finalizer:false}]},signer);
  const definition=defineApplication({id:'assistant-controller',version:'1',commands:{append:defineCommand({description:'Append',input:{type:'string'},prepare:text=>program(emit('note',{text}))})},
    queries:{notes:defineQuery({description:'Notes',input:{type:'null'},read:view=>view.readEvents({topics:['note']})})}});
  const session=await createApplicationSession({device,definition,authority:{descriptor,memberships:[membership]},epochKeys:new Map([[0,key]])});
  const tools=createScopedApplicationTools(session,{commands:['append'],queries:['notes']});let socket;const frames=[];
  class Socket extends EventTarget {readyState=0;send(data){frames.push(JSON.parse(data));}close(code=1000){this.readyState=3;this.dispatchEvent(Object.assign(new Event('close'),{code}));}}
  const assistant=connectApplicationAssistant({api:'https://service.example/api/t/aaaaaaaaaaaa',key:'td_a_'+'b'.repeat(64),session,tools,
    openSocket(){socket=new Socket();queueMicrotask(()=>{socket.readyState=1;socket.dispatchEvent(new Event('open'));});return socket;}});
  t.after(async()=>{await assistant.close();await session.close();});await assistant.waitUntilOnline();
  async function call(kind,id,{binding='approved',...extra}={}){
    socket.dispatchEvent(Object.assign(new Event('message'),{data:JSON.stringify({type:'call',applicationId,id,kind,name:'append',operationId:'gateway-handle',
      caller:{account:'owner',agentBindingId:binding,bindingRevision:1,verification:'approved-binding',context:{}},...extra})}));
    for(let i=0;i<1000;i++){const frame=frames.find(value=>value.id===id);if(frame)return frame;await flush();}
    throw Error('Scoped controller did not settle within the bounded fixture turns');
  }
  const created=await call('command','create',{input:'Original intent'});assert.equal(created.error,undefined);
  const actualId=await tools.operationId('gateway-handle',{caller:'approved'});
  assert.equal(created.value.requestOperationId,'gateway-handle');assert.equal(created.value.state.operationId,actualId);
  assert.equal(created.value.state.author,device.identity.publicKey);assert.equal(created.value.state.stored,true);
  assert.equal(created.value.operationReference.deviceId,device.identity.publicKey);
  const proposalId=created.value.state.proposalId;assert.match(proposalId,/^[a-f0-9]{64}$/u);
  for(const kind of ['inspect','retry']){const reply=await call(kind,kind);assert.equal(reply.value.state.proposalId,proposalId);assert.equal(reply.value.state.operationId,actualId);}
  const denied=await call('inspect','sibling',{binding:'unapproved-sibling'});assert.equal(denied.error,'APPLICATION_TOOL_OPERATION_FORBIDDEN');
  const unknown=await call('command','unknown',{name:'private',input:'Not granted'});assert.equal(unknown.error,'APPLICATION_TOOL_COMMAND_FORBIDDEN');
  const finality=await call('wait','finality',{fact:'finalized'});assert.equal(finality.error,'FINALITY_UNSUPPORTED');
  assert.equal((await session.operations.get(actualId)).inspect().proposalId,proposalId);
});
