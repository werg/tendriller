import {openBrowserOwner,createBrowserIdentity} from '../../browser.mjs';
import {createViewStore} from '../../local.mjs';
import {ownerWorkerName,BROWSER_OWNER_PROTOCOL} from '../../browser-transport.mjs';
import {verifyParticipantPanel} from './presentation.mjs';
window.verifyParticipantPanel=verifyParticipantPanel;
const query=new URL(location.href).searchParams,profileId=query.get('profile')||'browser-owner-test';
// Test-only route capture and loss of best-effort teardown. The Worker fixture
// independently disables port-death cleanup, leaving witness reclamation.
const post=MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage=function(message,...args){
  if(message?.protocol===BROWSER_OWNER_PROTOCOL&&message.type==='boot'&&message.mode==='shared'){
    window.fixtureDocumentRoot=message.id;window.fixtureRootPort=this;
  }
  if(query.has('lost-teardown')&&message?.protocol===BROWSER_OWNER_PROTOCOL&&message.type==='root.detach'){
    void window.__orphanWire?.('root.detach.dropped');return;
  }
  if(query.has('lost-teardown')&&message?.method==='close'){
    void window.__orphanWire?.('rpc.close.dropped');return;
  }
  return post.call(this,message,...args);
};
const channelPost=BroadcastChannel.prototype.postMessage;
BroadcastChannel.prototype.postMessage=function(message,...args){
  if(message?.protocol===BROWSER_OWNER_PROTOCOL&&message.type==='hello')window.fixtureDocumentRoot=message.route;
  if(query.has('lost-teardown')&&message?.protocol===BROWSER_OWNER_PROTOCOL&&message.type==='release'){
    void window.__orphanWire?.('route.release.dropped');return;
  }
  return channelPost.call(this,message,...args);
};
const NativeWorker=globalThis.Worker;
window.fixtureWorkers=[];
globalThis.Worker=class extends NativeWorker{constructor(...args){super(...args);window.fixtureWorkers.push(this);}};
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
  window.fixtureOwnerProof=roots=>new Promise((resolve,reject)=>{
    const endpoints=ownerOptions.mode==='elected'?window.fixtureWorkers:[window.fixtureRootPort],id=crypto.randomUUID();
    const finish=(error,value)=>{clearTimeout(timer);for(const endpoint of endpoints)endpoint.removeEventListener('message',receive);error?reject(error):resolve(value);};
    const receive=({data})=>{if(data?.protocol==='fixture-owner-test'&&data.type==='witness-proof'&&data.id===id&&data.ownerInstanceId===window.session.endpoint.ownerInstanceId)finish(null,data);};
    const timer=setTimeout(()=>finish(Error('FIXTURE_WITNESS_PROOF_TIMEOUT')),5000);
    for(const endpoint of endpoints){endpoint.addEventListener('message',receive);try{endpoint.postMessage({protocol:'fixture-owner-test',type:'witness-proof',id,roots});}catch{}}
  });
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
  return{mode:attachment.mode,endpoint:attachment.session.endpoint,deviceId:attachment.session.deviceId,status:attachment.session.status,rootId:window.fixtureDocumentRoot};
})().catch(error=>{window.ownerStage=`failed:${window.ownerStage}`;window.ownerFailure={name:error.name,code:error.code,message:error.message};throw error;});
