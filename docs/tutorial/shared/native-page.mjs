// One optional page inside the workspace's single agent program. The shared
// signer and wrap key stay in the Node context; every page has its own admitted
// membership and wrapped keys.
import {createApplicationSession,describeApplication} from '@chronolog/peer-session';
import {signPublicationManifest} from '@chronolog/authority';
import {createAdmission,openPageAuthority} from '@tendriller/core/admission';
import {createApplicationOwner} from '@chronolog/peer-session/worker';
import {participateNativeApplication} from '@tendriller/core/native-rtc';
import {watchApplicationSetup} from '@tendriller/core/setup';
import {createHash} from 'node:crypto';
import {superviseParticipant} from './participant-lifecycle.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
export function publicationControl(context,definition) {
 return Object.freeze({
  definition:async()=>({definition:describeApplication(definition)}),publication:()=>context.host.peers.publication(),
  async publicationOperation(id){const publication=await context.readPrivate(`pub-signed-${digest(id)}.json`,true);return publication?{publication,receipt:await context.host.peers.publication(publication.id)}:null;},
  async preparePublication({operationId,entry='index.html',files}){
   const name=`pub-signed-${digest(operationId)}.json`,saved=await context.readPrivate(name,true);
   if(saved){if(saved.payload.entry!==entry||JSON.stringify(saved.payload.files)!==JSON.stringify(files))throw Error('Publication operation ID already binds another graph');return saved;}
   const [metadata,previous]=await Promise.all([context.host.peers.application(),context.host.peers.publication()]),scope=metadata.publicationAuthority;
   if(scope?.applicationId!==context.page.applicationId||!scope.publisherKeys.includes(context.signer.publicKey))throw Error('Independent publisher grant required');
   const publication=await signPublicationManifest({applicationId:context.page.applicationId,membershipId:scope.grantId,author:context.signer.publicKey,operationId,revision:previous===null?0:previous.publication.payload.revision+1,previous:previous?.publication.id??null,executionManifestDigest:scope.executionManifestDigest,entry,files},context.signer);
   await context.savePrivate(name,publication);return publication;
  },publish:(publication,assets)=>context.host.peers.publish(publication,assets),
 });
}
export async function openNativePage(context,{definition,createMaterializer,assistant,onEpochRotated}={}) {
 context.signal?.throwIfAborted();
 const initialized=await context.readPrivate('initialized.json',true);
 if(initialized?.applicationId!==context.page.applicationId||initialized.publicKey!==context.signer.publicKey)throw Object.assign(Error(`Run npm run init -- ${context.page.slug} first; browser reads and Save never require the agent`),{code:'native_page_init_required'});
 const device=await context.openDevice({create:true});let session,participation,lifecycle,admission;
 try{
  // Agent-first pages open their own cached keys; a browser-first page is pinned from the host
  // and waits, without failing, until an online member admits this agent from its signed grant.
  const {authority}=await openPageAuthority({store:device.store,identity:device.identity,wrapKey:context.wrapKey,peers:context.host.peers,applicationId:context.page.applicationId,executionManifestDigest:initialized.executionManifestDigest,create:false,signal:context.signal});
  session=await createApplicationSession({device,definition,authority,...(createMaterializer?{createMaterializer}: {})});
  admission=createAdmission(session,{peers:context.host.peers,wrapKey:context.wrapKey,store:device.store,subject:'agent',
   ...(onEpochRotated?{onEpochRotated}:{}),
   onEvent:notice=>context.report({admission:notice.kind,publicKey:notice.publicKey,label:notice.label??null,...(notice.reason?{reason:notice.reason}:{})})});
  let phase;admission.subscribe(state=>{if(state.phase!==phase){phase=state.phase;context.report({admission:'phase',phase});}});
  participation=participateNativeApplication(session,{peers:context.host.peers,onNotification:()=>void admission.refresh()});
  let optional={};
  try{if(assistant)optional=await assistant({context,session});}
  catch(error){context.report({state:'optional_assistant_unavailable',code:/^[A-Za-z0-9_]{1,96}$/.test(error?.code??'')?error.code:'assistant_configuration_unavailable',participantRunning:true});}
  const owned={session,participation};
  lifecycle=superviseParticipant({owned,signal:context.signal,report:context.report,watch:callbacks=>watchApplicationSetup({page:context.host,...callbacks}),...optional});
  const owner=createApplicationOwner(session,{extensions:admission.extensions}),close=owner.close.bind(owner);let closing;
  return Object.assign(owner,{control:publicationControl(context,definition),participation,admission,close:()=>closing??=(async()=>{const errors=[];for(const finish of [()=>admission.close(),()=>lifecycle.close(),()=>participation.close(),close]){try{await finish();}catch(error){errors.push(error);}}if(errors.length)throw new AggregateError(errors,'Native page cleanup failed',{cause:errors[0]});})()});
 }catch(error){const errors=[error];for(const finish of [()=>admission?.close(),()=>lifecycle?.close(),()=>participation?.close(),()=>session?session.close():device.close()]){try{await finish();}catch(cleanup){errors.push(cleanup);}}if(errors.length>1)throw new AggregateError(errors,'Native page opening and cleanup failed',{cause:error});throw error;}
}
