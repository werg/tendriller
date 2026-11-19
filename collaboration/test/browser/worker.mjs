import { defineApplication, defineCommand, defineQuery, emit, program, openPeerApplication,
  MemoryBytesStore, createPeerIdentity, bytesDigest, participantGrant, signApplicationDescriptor,
  signControlRevision, createGenerationRegistry, signTransitionRequest, applicationDefinitionDigest,
  eventExecutionManifest, executionManifestArtifacts, bytesToHex } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { serveBrowserOwner } from '../../worker.mjs';
const profileId = new URL(import.meta.url).searchParams.get('profile') || 'browser-owner-test';
const applicationId = '91'.repeat(32), encoder = new TextEncoder(), decoder = new TextDecoder();
const definition = defineApplication({id:'owner-fixture',version:'1',commands:{say:defineCommand({description:'Retain test message',input:{type:'string',minLength:1,maxLength:128},prepare:text=>program(emit('message',{text}))})},
  queries:{messages:defineQuery({description:'Coherent test messages',input:{type:'null'},read:view=>view.readEvents()})}});
serveBrowserOwner({async load(){
  // Exercise first-message delivery while configuration performs real async work.
  await new Promise(resolve=>setTimeout(resolve,30));
  return{profileId,async createIdentity(){const device=await openBrowserDevice({name:profileId,create:true});try{return device.identity.publicKey;}finally{await device.close();}},
  async openSession(){
  const device=await openBrowserDevice({name:profileId,create:true});let session;
  try{
    let raw=await device.store.get('test/authority'),key=await device.store.get('test/epoch');
    if(!raw){const host=await createPeerIdentity();key=crypto.getRandomValues(new Uint8Array(32));
      const execution=await executionManifestArtifacts(await eventExecutionManifest());
      const descriptor=await signApplicationDescriptor({applicationId,historyId:profileId,profile:'peer-generation-v1',policy:'eligible-members-v1',
        controlPublicKey:host.publicKey,schemaAdministrator:device.identity.publicKey,executionManifestDigest:bytesToHex(execution.executionManifestDigest),
        definitionDigest:await applicationDefinitionDigest(definition),schemaDigest:null},host);
      const control=await signControlRevision({applicationId,profile:'peer-generation-v1',policy:'eligible-members-v1',revision:0,previous:null,epoch:0,
        keyDigest:await bytesDigest(key),recoveryFloor:null,grants:[participantGrant(device.identity.publicKey,{administrator:true})]},host);
      const registry=await createGenerationRegistry({store:new MemoryBytesStore(),descriptor,controls:[control],signer:host});
      await registry.select(await signTransitionRequest({applicationId,profile:'peer-generation-v1',policy:'eligible-members-v1',transitionId:'initial',expectedGeneration:null,
        requester:device.identity.publicKey,coordinator:device.identity.publicKey,controlRevision:0,reason:'create',base:null},device.identity));
      raw=encoder.encode(JSON.stringify(await registry.read()));await device.store.put('test/authority',raw);await device.store.put('test/epoch',key);
    }
    session=await openPeerApplication({device,definition,authority:JSON.parse(decoder.decode(raw)),epochKeys:new Map([[0,key]]),signals:{localEcho:true,delivery:'neighbors'}});
    return{session};
  }catch(error){if(session)await session.close();else await device.close();throw error;}
}};
}});
