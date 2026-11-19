import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName, createBroadcastEndpoint, isOwnerAnnouncement } from './browser-transport.mjs';
import { CollaborationError } from './protocol.mjs';

function waitFor(endpoint,predicate,{signal,timeoutMs=30000}={}){
  signal?.throwIfAborted();return new Promise((resolve,reject)=>{
    const finish=(error,value)=>{clearTimeout(timer);endpoint.removeEventListener('message',message);endpoint.removeEventListener('error',failed);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const message=({data})=>{if(data?.protocol!==BROWSER_OWNER_PROTOCOL)return;
      if(data.type==='failure')finish(new CollaborationError(data.code??'OWNER_UNREACHABLE',data.message));else if(predicate(data))finish(null,data);};
    const failed=event=>finish(new CollaborationError('OWNER_UNREACHABLE',event.message??'Owner worker failed to load'));
    const abort=()=>finish(signal.reason);const timer=setTimeout(()=>finish(new CollaborationError('OWNER_UNREACHABLE','The owner did not answer; preserve the original operation reference')),timeoutMs);
    endpoint.addEventListener('message',message);endpoint.addEventListener('error',failed);signal?.addEventListener('abort',abort,{once:true});
  });
}
function validate(options){
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(options.profileId))throw new CollaborationError('INVALID_PROFILE');
  if(!globalThis.navigator?.locks)throw new CollaborationError('OWNER_CAPABILITY_UNAVAILABLE','This browser needs Web Locks to retain one session owner. Choose a supported browser or a separately enrolled profile.');
  const url=new URL(options.workerUrl,globalThis.location?.href);
  if(url.origin!==location.origin)throw new CollaborationError('OWNER_ORIGIN_MISMATCH');
  return url;
}
/** Attach without opening a signing store in the page. Both routes use real exclusive fencing. */
export async function openBrowserOwner(options){
  const url=validate(options),mode=options.mode??'auto';
  if(!['auto','shared','elected'].includes(mode))throw new CollaborationError('INVALID_OWNER_MODE');
  const shared=mode!=='elected'&&typeof SharedWorker==='function';
  if(mode==='shared'&&!shared)throw new CollaborationError('OWNER_CAPABILITY_UNAVAILABLE','SharedWorker is unavailable');
  const id=crypto.randomUUID(),handshake={applicationId:options.applicationId,definitionId:options.definitionId,
    definitionVersion:options.definitionVersion,context:options.context??{},signal:options.signal,timeoutMs:options.timeoutMs};
  let worker,channel,transport,session;
  try{
    if(shared){
      worker=new SharedWorker(url,{type:'module',name:`tendriller:${options.profileId}:v2`});worker.port.start();
      worker.addEventListener('error',event=>worker.port.dispatchEvent(new MessageEvent('message',{data:{
        protocol:BROWSER_OWNER_PROTOCOL,type:'failure',code:'OWNER_UNREACHABLE',message:event.message||'Shared owner module failed to load',id}})));
      const ready=waitFor(worker.port,data=>data.type==='ready'&&data.id===id,options);
      worker.port.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'boot',mode:'shared',id,profileId:options.profileId});
      await ready;session=await connectApplicationOwner(worker.port,handshake);
    }else{
      if(typeof BroadcastChannel!=='function'||typeof Worker!=='function')throw new CollaborationError('OWNER_CAPABILITY_UNAVAILABLE','The elected owner route needs Worker and BroadcastChannel');
      channel=new BroadcastChannel(ownerChannelName(options.profileId));
      const ready=waitFor(channel,data=>isOwnerAnnouncement(data,options.profileId),options);
      worker=new Worker(url,{type:'module',name:`tendriller-owner-${id}`});
      // The worker queues an exclusive Web Lock. Suspension never permits takeover.
      worker.addEventListener('message',({data})=>{if(data?.protocol===BROWSER_OWNER_PROTOCOL&&data.type==='failure')channel?.dispatchEvent(new MessageEvent('message',{data}));});
      worker.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'boot',mode:'elected',id,profileId:options.profileId});
      channel.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'discover'});
      const active=await ready;transport=createBroadcastEndpoint(channel,active,{profileId:options.profileId,
        onReplaced:options.onOwnerReplaced,livenessTimeoutMs:options.livenessTimeoutMs});
      session=await connectApplicationOwner(transport,handshake);
    }
  }catch(error){await transport?.close();channel?.close();if(shared)worker?.port?.close();else worker?.terminate();throw error;}
  let detached=false;
  return Object.freeze({session,mode:shared?'shared':'elected',
    async suspend(){if(!detached){await session.suspend();transport?.suspend();}},
    async resume(){if(detached)throw new CollaborationError('ENDPOINT_STALE');transport?.resume();await session.resumeAttachment();return session;},
    async detach(){if(detached)return;detached=true;try{await session.detach();}finally{await transport?.close();channel?.close();if(shared)worker.port.close();else worker.terminate();}},
  });
}
/** Enrollment is deliberate. A lock/storage failure never creates a replacement signer. */
export async function createBrowserIdentity(options){
  const url=validate(options),worker=new Worker(url,{type:'module'}),id=crypto.randomUUID();
  try{const ready=waitFor(worker,data=>data.type==='identity'&&data.id===id,options);
    worker.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'identity',profileId:options.profileId,id});return(await ready).publicKey;
  }finally{worker.terminate();}
}
