import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName, ownerWorkerName, createBroadcastEndpoint, isOwnerAnnouncement } from './browser-transport.mjs';
import { CollaborationError } from './protocol.mjs';
import { createSharedRootEndpoint } from './browser-root.mjs';

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
async function retireCandidate(worker,profileId,timeoutMs=3000){
  if(!worker)return;
  const id=crypto.randomUUID();
  try{
    const retired=waitFor(worker,data=>data.type==='retired'&&data.id===id,{timeoutMs});
    worker.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'retire',id,profileId});
    await retired;
  }catch{ /* An unreachable candidate may still own sibling work; never steal its lock. */ }
}
function validate(options){
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(options.profileId))throw new CollaborationError('INVALID_PROFILE');
  if(!globalThis.navigator?.locks)throw new CollaborationError('OWNER_CAPABILITY_UNAVAILABLE','This browser needs Web Locks to retain one session owner. Choose a supported browser or a separately enrolled profile.');
  const url=new URL(options.workerUrl,globalThis.location?.href);
  if(url.origin!==location.origin)throw new CollaborationError('OWNER_ORIGIN_MISMATCH');
  return url;
}
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{signal?.throwIfAborted();const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal?.addEventListener('abort',abort,{once:true});});
/** Attach without opening a signing store in the page. Both routes use real exclusive fencing.
 * When this page's own Worker cannot take the profile because another owner holds it
 * (a sibling tab on another publication's Worker, a fallback owner, or a brief pairing
 * proof), the page attaches to that existing owner instead of failing with OWNER_BUSY. */
export async function openBrowserOwner(options){
  const url=validate(options),mode=options.mode??'auto';
  if(!['auto','shared','elected'].includes(mode))throw new CollaborationError('INVALID_OWNER_MODE');
  if(options.requiresDedicatedWorker!==undefined&&typeof options.requiresDedicatedWorker!=='boolean')throw new CollaborationError('INVALID_OWNER_MODE');
  if(mode==='shared'&&options.requiresDedicatedWorker)throw Object.assign(new CollaborationError('OWNER_STORAGE_UNSUPPORTED',
    'This storage engine requires a dedicated Worker. Use auto or elected mode with the retained profile.'),
  {nextAction:'Use mode: auto or elected with requiresDedicatedWorker: true; retain the existing profile.'});
  const shared=mode!=='elected'&&!options.requiresDedicatedWorker&&typeof SharedWorker==='function';
  if(mode==='shared'&&!shared)throw new CollaborationError('OWNER_CAPABILITY_UNAVAILABLE','SharedWorker is unavailable');
  const timeoutMs=options.timeoutMs??30000,deadline=Date.now()+timeoutMs;
  const handshake={applicationId:options.applicationId,definitionId:options.definitionId,
    definitionVersion:options.definitionVersion,context:options.context??{},signal:options.signal,timeoutMs:options.timeoutMs};
  if(!shared)return elected(url,options,handshake);
  for(let attempt=0;;attempt++){
    try{return await sharedRoute(url,options,handshake);}
    catch(error){
      if(error?.code!=='OWNER_BUSY')throw error;
      const remaining=deadline-Date.now();
      if(remaining<=0||typeof BroadcastChannel!=='function')throw Object.assign(new CollaborationError('OWNER_BUSY',
        'Another owner keeps this browser profile. Close other tabs of this page, then reopen it.'),{nextAction:'Close other tabs of this page and reload.'});
      const existing=await attachExisting(options,handshake,Math.min(remaining,1500));
      if(existing)return existing;
      await sleep(Math.min(2000,250*2**attempt,Math.max(0,deadline-Date.now())),options.signal);
    }
  }
}
function facade({session,transport,channel,worker,route,options}){
  let detached=false,releasing;
  function release(){
    if(releasing)return releasing;
    detached=true;session.signal.removeEventListener('abort',ended);globalThis.removeEventListener?.('pagehide',leaving);
    releasing=(async()=>{
      await transport?.close();channel?.close();
      if(route==='shared'){worker.port.close();return;}
      // Explicit detachment cannot terminate an elected owner serving siblings.
      // The worker retires immediately if queued, or after its last private route.
      if(worker)await retireCandidate(worker,options.profileId,Math.min(options.timeoutMs??30000,3000));
    })();return releasing;
  }
  const ended=()=>{void release().catch(()=>{});};
  const leaving=event=>{
    if(event.persisted)return;
    // Native page teardown cannot await crypto or facade RPCs. Each maintained
    // transport already holds the authority needed to relinquish only this route.
    transport?.relinquish();void release().catch(()=>{});
  };
  globalThis.addEventListener?.('pagehide',leaving);
  session.signal.addEventListener('abort',ended,{once:true});
  if(session.signal.aborted)ended();
  return Object.freeze({session,mode:route==='shared'?'shared':'elected',
    async suspend(){if(!detached){await session.suspend();await transport?.suspend();}},
    async resume(){if(detached)throw new CollaborationError('ENDPOINT_STALE');await transport?.resume();await session.resumeAttachment();return session;},
    async detach(){if(detached){await releasing;return;}detached=true;try{await session.detach();}finally{await release();}},
  });
}
async function sharedRoute(url,options,handshake){
  const id=crypto.randomUUID();let worker,transport;
  try{
    worker=new SharedWorker(url,{type:'module',name:ownerWorkerName(options.profileId)});worker.port.start();
    worker.addEventListener('error',event=>worker.port.dispatchEvent(new MessageEvent('message',{data:{
      protocol:BROWSER_OWNER_PROTOCOL,type:'failure',code:'OWNER_UNREACHABLE',message:event.message||'Shared owner module failed to load',id}})));
    const ready=waitFor(worker.port,data=>data.type==='ready'&&data.id===id,options);
    worker.port.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'boot',mode:'shared',id,profileId:options.profileId});
    const active=await ready;transport=createSharedRootEndpoint(worker.port,{profileId:options.profileId,rootId:id,
      ownerInstanceId:active.ownerInstanceId,onReplaced:options.onOwnerReplaced,livenessTimeoutMs:options.livenessTimeoutMs});
    const session=await connectApplicationOwner(transport,handshake);
    return facade({session,transport,worker,route:'shared',options});
  }catch(error){
    await transport?.close();
    try{worker?.port?.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'root.detach',profileId:options.profileId,rootId:id,id:crypto.randomUUID()});}catch{}
    worker?.port?.close();throw error;
  }
}
/** Attach to an owner that already announces this profile; never starts one. */
async function attachExisting(options,handshake,waitMs){
  const channel=new BroadcastChannel(ownerChannelName(options.profileId));let transport;
  try{
    const ready=waitFor(channel,data=>isOwnerAnnouncement(data,options.profileId),{...options,timeoutMs:waitMs});
    channel.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'discover'});
    let active;try{active=await ready;}catch(error){if(error?.code==='OWNER_UNREACHABLE'){channel.close();return null;}throw error;}
    transport=createBroadcastEndpoint(channel,active,{profileId:options.profileId,onReplaced:options.onOwnerReplaced,livenessTimeoutMs:options.livenessTimeoutMs});
    const session=await connectApplicationOwner(transport,handshake);
    return facade({session,transport,channel,route:'existing',options});
  }catch(error){await transport?.close();channel.close();throw error;}
}
async function elected(url,options,handshake){
  if(typeof BroadcastChannel!=='function'||typeof Worker!=='function')throw new CollaborationError('OWNER_CAPABILITY_UNAVAILABLE','The elected owner route needs Worker and BroadcastChannel');
  const id=crypto.randomUUID(),channel=new BroadcastChannel(ownerChannelName(options.profileId));let worker,transport,booted=false;
  try{
    worker=new Worker(url,{type:'module',name:`tendriller-owner-${id}`});
    const ready=waitFor(channel,data=>isOwnerAnnouncement(data,options.profileId),options);
    // The worker queues an exclusive Web Lock. Suspension never permits takeover.
    worker.addEventListener('message',({data})=>{if(data?.protocol===BROWSER_OWNER_PROTOCOL&&data.type==='failure')channel.dispatchEvent(new MessageEvent('message',{data}));});
    worker.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'boot',mode:'elected',id,profileId:options.profileId});booted=true;
    channel.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'discover'});
    const active=await ready;transport=createBroadcastEndpoint(channel,active,{profileId:options.profileId,
      onReplaced:options.onOwnerReplaced,livenessTimeoutMs:options.livenessTimeoutMs});
    const session=await connectApplicationOwner(transport,handshake);
    return facade({session,transport,channel,worker,route:'elected',options});
  }catch(error){await transport?.close();channel.close();
    if(booted)await retireCandidate(worker,options.profileId,Math.min(options.timeoutMs??30000,3000));else worker?.terminate();throw error;}
}
/** Enrollment is deliberate. A lock/storage failure never creates a replacement signer. */
export async function createBrowserIdentity(options){
  const url=validate(options),worker=new Worker(url,{type:'module'}),id=crypto.randomUUID();
  try{const ready=waitFor(worker,data=>data.type==='identity'&&data.id===id,options);
    worker.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'identity',profileId:options.profileId,id});return(await ready).publicKey;
  }finally{worker.terminate();}
}
