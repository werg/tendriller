import {openBrowserOwner,createBrowserIdentity} from '../../browser.mjs';
import {createViewStore} from '../../local.mjs';
import {verifyParticipantPanel} from './presentation.mjs';
window.verifyParticipantPanel=verifyParticipantPanel;
const query=new URL(location.href).searchParams,profileId=query.get('profile')||'browser-owner-test';
window.ready=(async()=>{
  const workerUrl=new URL(`./worker.mjs?profile=${profileId}`,import.meta.url);
  if(query.get('identity')==='create') await createBrowserIdentity({workerUrl,profileId});
  const attachment=await openBrowserOwner({workerUrl,profileId,
    applicationId:'91'.repeat(32),definitionId:'owner-fixture',definitionVersion:'1',mode:query.get('mode')||'shared',
    context:{viewId:query.get('view')||crypto.randomUUID(),documentPath:location.pathname,publicationId:'fixture-publication'}});
  window.attachment=attachment;window.session=attachment.session;
  window.viewStore=createViewStore({storage:localStorage,applicationId:'91'.repeat(32),profileId,viewId:attachment.session.endpoint.context.viewId});
  return{endpoint:attachment.session.endpoint,deviceId:attachment.session.deviceId,status:attachment.session.status};
})();
