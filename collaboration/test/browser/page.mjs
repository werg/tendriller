import {openBrowserOwner,createBrowserIdentity} from '../../browser.mjs';
import {rootLifetimeLockName} from '../../root-lifetime.mjs';
import {createViewStore} from '../../local.mjs';
import {ownerWorkerName,BROWSER_OWNER_PROTOCOL} from '../../browser-transport.mjs';
import {verifyParticipantPanel} from './presentation.mjs';
window.verifyParticipantPanel=verifyParticipantPanel;
const query=new URL(location.href).searchParams,profileId=query.get('profile')||'browser-owner-test';
// Test-only loss of the best-effort detach frame. A frozen document's close
// can still run pagehide in Chromium; block the wire notification so only the
// document witness can reclaim its Worker root. Product behavior is unchanged.
if(query.has('lost-teardown')){
  const post=MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage=function(message,...args){
    if(message?.protocol===BROWSER_OWNER_PROTOCOL&&message.type==='root.detach'){
      void window.__orphanWire?.('root.detach.dropped');return;
    }
    return post.call(this,message,...args);
  };
  const broadcast=BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage=function(message,...args){
    if(message?.protocol===BROWSER_OWNER_PROTOCOL&&message.type==='hello')window.fixtureBroadcastWitness=rootLifetimeLockName(profileId,message.route);
    if(message?.protocol===BROWSER_OWNER_PROTOCOL&&message.type==='release'){void window.__orphanWire?.('bc.release.dropped');return;}
    return broadcast.call(this,message,...args);
  };
}
if(globalThis.SharedWorker){
  const Native=globalThis.SharedWorker;
  globalThis.SharedWorker=class extends Native{constructor(...args){super(...args);this.port.addEventListener('message',({data})=>{
    if(data?.protocol==='fixture-owner-test'&&data.type==='native-root-events-blocked')window.fixtureRootEvents=data;
  });}};
}
window.ownerStage='identity';
window.ready=(async()=>{
  const workerUrl=new URL(`./worker.mjs?profile=${profileId}${query.get('variant')?`&variant=${query.get('variant')}`:''}`,import.meta.url);
  if(query.get('identity')==='create'){await createBrowserIdentity({workerUrl,profileId});const retained=new URL(location.href);retained.searchParams.delete('identity');history.replaceState(null,'',retained);}
  window.ownerStage='attachment';
  const ownerOptions={workerUrl,profileId,...(query.has('lost-teardown')?{timeoutMs:5000}:{}),
    applicationId:'91'.repeat(32),definitionId:'owner-fixture',definitionVersion:'1',mode:query.get('mode')||'shared',
    context:{viewId:sessionStorage.getItem('fixture-view')||query.get('view')||crypto.randomUUID(),documentPath:location.pathname,publicationId:'fixture-publication'}};
  const attachment=await openBrowserOwner(ownerOptions);
  sessionStorage.setItem('fixture-view',attachment.session.endpoint.context.viewId);
  window.attachment=attachment;window.session=attachment.session;
  window.viewStore=createViewStore({storage:localStorage,applicationId:'91'.repeat(32),profileId,viewId:attachment.session.endpoint.context.viewId});
  window.cycleRoots=async count=>{
    const instances=new Set();
    for(let index=0;index<count;index++){
      const current=await openBrowserOwner({...ownerOptions,context:{documentPath:location.pathname}});
      if(ownerOptions.mode==='shared'&&current.mode!=='shared'){await current.detach();throw Error('FIXTURE_SHARED_OWNER_REQUIRED');}
      instances.add(current.session.endpoint.ownerInstanceId);await current.session.authority();await current.detach();
    }
    return [...instances];
  };
  window.reattach=async()=>{
    await window.attachment.detach();
    const next=await openBrowserOwner(ownerOptions);window.attachment=next;window.session=next.session;
    return next.session.endpoint;
  };
  window.closeUnderlyingSession=()=>{
    const control=new SharedWorker(workerUrl,{type:'module',name:ownerWorkerName(profileId)});
    control.port.postMessage({protocol:'fixture-owner-test',type:'close-session'});
    // Leave this root connected until the session's own close closes the worker.
    window.fixtureControl=control;
  };
  window.ownerProfile=profileId;window.ownerStage='ready';
  return{broadcastWitnessName:window.fixtureBroadcastWitness??null,mode:attachment.mode,portEventFault:window.fixtureRootEvents??null,endpoint:attachment.session.endpoint,deviceId:attachment.session.deviceId,status:attachment.session.status};
})().catch(error=>{window.ownerStage=`failed:${window.ownerStage}`;window.ownerFailure={name:error.name,code:error.code,message:error.message};throw error;});
