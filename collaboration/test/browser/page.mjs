import {openBrowserOwner,createBrowserIdentity} from '../../browser.mjs';
import {createViewStore} from '../../local.mjs';
import {ownerWorkerName} from '../../browser-transport.mjs';
import {verifyParticipantPanel} from './presentation.mjs';
window.verifyParticipantPanel=verifyParticipantPanel;
const query=new URL(location.href).searchParams,profileId=query.get('profile')||'browser-owner-test';
window.ownerStage='identity';
window.ready=(async()=>{
  const workerUrl=new URL(`./worker.mjs?profile=${profileId}`,import.meta.url);
  if(query.get('identity')==='create'){await createBrowserIdentity({workerUrl,profileId});const retained=new URL(location.href);retained.searchParams.delete('identity');history.replaceState(null,'',retained);}
  window.ownerStage='attachment';
  const ownerOptions={workerUrl,profileId,
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
      instances.add(current.session.endpoint.ownerInstanceId);await current.session.authority();await current.detach();
    }
    return [...instances];
  };
  window.closeUnderlyingSession=()=>{
    const control=new SharedWorker(workerUrl,{type:'module',name:ownerWorkerName(profileId)});
    control.port.postMessage({protocol:'fixture-owner-test',type:'close-session'});
    // Leave this root connected until the session's own close closes the worker.
    window.fixtureControl=control;
  };
  window.ownerProfile=profileId;window.ownerStage='ready';
  return{endpoint:attachment.session.endpoint,deviceId:attachment.session.deviceId,status:attachment.session.status};
})().catch(error=>{window.ownerStage=`failed:${window.ownerStage}`;window.ownerFailure={name:error.name,code:error.code,message:error.message};throw error;});
