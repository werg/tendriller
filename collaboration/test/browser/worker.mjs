import { defineApplication, defineCommand, defineQuery, emit, program, createApplicationSession,
  createSigningIdentity, signAppDescriptor, signMembership, epochKeyCommitment, encodeRecord, decodeRecord,
  eventExecutionManifest, executionManifestArtifacts, bytesToHex } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { serveBrowserOwner } from '../../../session/worker.mjs';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName } from '../../../session/browser-transport.mjs';
import { rootLifetimeLockName } from '../../../session/root-lifetime.mjs';
const profileId = new URL(import.meta.url).searchParams.get('profile') || 'browser-owner-test';
// Test-only fault injection: neither port death nor an unloaded document's
// best-effort teardown may stand in for the document witness in this fixture.
const roots=new Set(), missingWitnesses=new Set();let suppressedPortListeners=0,queryCount=0;
globalThis.addEventListener('connect',event=>{for(const port of event.ports){
  const listen=port.addEventListener.bind(port);
  port.addEventListener=(type,...args)=>{if(['close','messageerror'].includes(type)){suppressedPortListeners++;return;}return listen(type,...args);};
  listen('message',({data})=>{if(data?.protocol===BROWSER_OWNER_PROTOCOL&&data.type==='boot'&&data.mode==='shared')roots.add(data.id);});
}});
const NativeChannel=globalThis.BroadcastChannel;
globalThis.BroadcastChannel=class extends NativeChannel{constructor(name){super(name);
  if(name===ownerChannelName(profileId))this.addEventListener('message',({data})=>{
    if(data?.protocol===BROWSER_OWNER_PROTOCOL&&data.type==='hello')roots.add(data.route);
  });
}};
const nativeQuery=navigator.locks.query.bind(navigator.locks);
navigator.locks.query=async()=>{queryCount++;const snapshot=await nativeQuery();
  for(const root of roots)if(!snapshot.held.some(lock=>lock.name===rootLifetimeLockName(profileId,root)))missingWitnesses.add(root);
  return snapshot;
};
const applicationId = '91'.repeat(32);
const definition = defineApplication({id:'owner-fixture',version:'1',commands:{say:defineCommand({description:'Retain test message',input:{type:'string',minLength:1,maxLength:128},prepare:text=>program(emit('message',{text}))})},
  queries:{messages:defineQuery({description:'Coherent test messages',input:{type:'null'},read:view=>view.readEvents()})}});
const service=serveBrowserOwner({async load(){
  // Exercise first-message delivery while configuration performs real async work.
  await new Promise(resolve=>setTimeout(resolve,30));
  return{profileId,rootLimits:{maxPorts:4},ownerOptions:{maxAttachments:4},async createIdentity(){const device=await openBrowserDevice({name:profileId,create:true});try{return device.identity.publicKey;}finally{await device.close();}},
  async openSession(){
  const device=await openBrowserDevice({name:profileId,create:true});let session;
  try{
    let raw=await device.store.get('test/authority'),key=await device.store.get('test/epoch');
    if(!raw){
      const host=await createSigningIdentity();
      if(!key){key=crypto.getRandomValues(new Uint8Array(32));await device.store.put('test/epoch',key);}
      const execution=await executionManifestArtifacts(await eventExecutionManifest());
      const descriptor=await signAppDescriptor({applicationId,rootPrincipal:device.identity.publicKey,authorityPublicKey:host.publicKey,
        executionManifestDigest:bytesToHex(execution.executionManifestDigest),finalityPolicy:{kind:'none'}},host);
      const membership=await signMembership({applicationId,revision:0,previous:null,authorTimeAfterMs:-1n,epoch:0,
        epochKeyDigest:await epochKeyCommitment(applicationId,0,key),members:[{publicKey:device.identity.publicKey,wrapKey:null,reader:true,writer:true,administrator:true,publisher:false,finalizer:false}],
        admission:{mode:'strict',hostKey:host.publicKey,accounts:[],grant:{reader:true,writer:true}},admitted:[],invites:[]},host);
      raw=encodeRecord({descriptor,memberships:[membership]});await device.store.put('test/authority',raw);
    }
    if(!(key instanceof Uint8Array)||key.length!==32)throw Error('RETAINED_FIXTURE_EPOCH_KEY_MISSING');
    session=await createApplicationSession({device,definition,authority:decodeRecord(raw),epochKeys:new Map([[0,key]])});
    return{session};
  }catch(error){if(session)await session.close();else await device.close();throw error;}
}};
}});

// Test-only control: exercise a true underlying session close, not service.close().
// Production worker composition has no such public control action.
function control(data,post){
  if(data?.protocol!=='fixture-owner-test')return;
  if(data.type==='close-session')void service.owner?.session.close();
  if(data.type==='witness-proof'&&Array.isArray(data.roots)&&data.roots.length<=16)
    post({protocol:'fixture-owner-test',type:'witness-proof',id:data.id,
      observedMissing:data.roots.map(root=>missingWitnesses.has(root)),tracked:data.roots.map(root=>roots.has(root)),queryCount,suppressedPortListeners,
      ownerInstanceId:service.owner?.ownerInstanceId??null});
}
globalThis.addEventListener('connect',event=>{for(const port of event.ports)port.addEventListener('message',({data})=>control(data,value=>port.postMessage(value)));});
globalThis.addEventListener('message',({data})=>control(data,value=>globalThis.postMessage(value)));
