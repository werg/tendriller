import { registerBrowserRtcProvider } from './browser-rtc.mjs';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName, ownerWorkerName, createBroadcastEndpoint, isOwnerAnnouncement } from './browser-transport.mjs';
import { CollaborationError } from './protocol.mjs';
import { createSharedRootEndpoint, createRootRtcEndpoint } from './browser-root.mjs';

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
/** Ask the browser to keep this origin's storage (device key, journal, unsent work)
 * out of best-effort eviction under storage pressure. Never throws; null = unsupported. */
export function requestPersistentStorage(){
  const storage=globalThis.navigator?.storage;
  if(typeof storage?.persist!=='function')return Promise.resolve(null);
  return (async()=>{try{return await storage.persisted?.()||await storage.persist();}catch{return false;}})();
}
/** Chromium's in-memory OPFS (private/incognito windows, automation contexts) drops
 * the files of a record directory nothing has touched for about ten minutes, even while
 * the owner holds it open (reproduced without any application code; a persistent
 * profile keeps them). The next open then fails closed with
 * APPLICATION_DATA_STORAGE_MISSING. Opening the directory's handle resets that clock.
 *
 * Lean by design: nothing runs when the browser has granted persistent storage; ticks
 * run only while this page is visible (a hidden or frozen tab is never woken for it);
 * hiding and showing the page each touch once, so a backgrounded tab starts with a
 * full window. In-memory storage cannot be detected directly (quota, persisted() and
 * persist() read the same as on a normal profile), so it runs wherever storage is not
 * known to be persistent. intervalMs 0 disables. Returns a stop function. */
export function keepStorageInUse({intervalMs=240_000,storagePersisted=requestPersistentStorage(),now=()=>Date.now(),onTick}={}){
  const storage=globalThis.navigator?.storage,doc=globalThis.document;
  if(!intervalMs||typeof storage?.getDirectory!=='function'||!doc)return ()=>{};
  let stopped=false,timer;
  const touch=async()=>{
    if(stopped)return;
    // Opening each record directory's handle is enough to keep its files (reproduced:
    // 11 idle minutes kept; opening only the root was not); its records are not listed.
    const started=now();let directories=0;
    const root=await storage.getDirectory();
    for await(const [name,handle] of root.entries()){
      if(handle.kind!=='directory'||!name.startsWith('chronolog-'))continue;
      await root.getDirectoryHandle(name);directories++;
    }
    onTick?.({ms:now()-started,directories});
  };
  const tick=()=>{void touch().catch(()=>{});};
  const schedule=()=>{clearInterval(timer);timer=undefined;if(!stopped&&doc.visibilityState==='visible')timer=setInterval(tick,intervalMs);};
  const visibility=()=>{tick();schedule();};
  const pagehide=()=>{tick();clearInterval(timer);timer=undefined;};
  void Promise.resolve(storagePersisted).then(persisted=>{
    if(persisted===true||stopped)return;
    doc.addEventListener('visibilitychange',visibility);doc.addEventListener('freeze',pagehide);doc.addEventListener('resume',visibility);
    globalThis.addEventListener?.('pagehide',pagehide);globalThis.addEventListener?.('pageshow',visibility);
    if(doc.visibilityState==='visible')tick();
    schedule();
  }).catch(()=>{});
  return ()=>{stopped=true;clearInterval(timer);doc.removeEventListener('visibilitychange',visibility);
    doc.removeEventListener('freeze',pagehide);doc.removeEventListener('resume',visibility);
    globalThis.removeEventListener?.('pagehide',pagehide);globalThis.removeEventListener?.('pageshow',visibility);};
}
function facade({session,transport,channel,worker,route,options,provider:initialProvider,bootstrapRtc}){
  initialProvider?.adopt(session);
  transport.bindRequestSource(session);
  let detached=false,releasing,suspended=false,residency=Promise.resolve(), explicitSuspended=false, explicitResuming=false;
  const document=globalThis.document;
  let frozen=false, observationPaused=false, observationResume, observationEpoch=0;
  const away=()=>frozen||document?.visibilityState==='hidden';
  function pauseObservation(force=false){
    if(detached||observationPaused&&!force&&!observationResume&&!explicitResuming)return;
    observationPaused=true;observationEpoch++;
    // Pause the local fence synchronously, before promises or RTC cleanup. A
    // hidden page retains its RTC provider and can still process allowed inputs.
    try{if(transport.park)transport.park({frozen});else transport.suspend();}catch{}
    try{void Promise.resolve(session.suspend()).catch(()=>{});}catch{}
  }
  function resumeObservation(){
    if(detached||!observationPaused||suspended||explicitSuspended||away())return Promise.resolve(session);
    if(observationResume)return observationResume;
    observationResume=(async()=>{
      // A second freeze invalidates the pending proof even if the document is
      // visible again by the time it arrives. Retry only while still visible;
      // each attempt remains bounded by the transport's existing deadline.
      while(!detached&&observationPaused&&!away()&&!suspended&&!explicitSuspended){
        const epoch=observationEpoch;
        await transport.resume();
        if(epoch!==observationEpoch)continue;
        if(away()||suspended||explicitSuspended){pauseObservation(true);break;}
        await session.resumeAttachment();
        if(detached)throw new CollaborationError('ENDPOINT_STALE');
        if(epoch!==observationEpoch)continue;
        if(away()||suspended||explicitSuspended)pauseObservation(true);
        else observationPaused=false;
      }
      return session;
    })().finally(()=>{observationResume=undefined;});
    return observationResume;
  }
  const visibility=()=>{if(away())pauseObservation();else void resumeObservation().catch(()=>{});};
  const freeze=()=>{frozen=true;pauseObservation(true);};
  const resume=()=>{frozen=false;if(away())pauseObservation(true);else visibility();};
  document?.addEventListener?.('visibilitychange',visibility);
  document?.addEventListener?.('freeze',freeze);
  document?.addEventListener?.('resume',resume);
  if(away())pauseObservation();
  const startRtc=()=>registerBrowserRtcProvider(transport.rtc,session);
  let provider=initialProvider ?? startRtc();
  // An attached session holds a retained signing key and signed work: keep it durable.
  const storagePersisted=options.persistStorage===false?Promise.resolve(null):requestPersistentStorage();
  const stopKeepAlive=keepStorageInUse({intervalMs:options.storageKeepAliveMs??240_000,storagePersisted});
  function release(){
    if(releasing)return releasing;
    detached=true;stopKeepAlive();
    document?.removeEventListener?.('visibilitychange',visibility);
    document?.removeEventListener?.('freeze',freeze);
    document?.removeEventListener?.('resume',resume);
    session.signal.removeEventListener('abort',ended);globalThis.removeEventListener?.('pagehide',leaving);
    releasing=(async()=>{
      const failures=[];
      try{await provider.close();}catch(error){failures.push(error);}
      bootstrapRtc?.dispose();
      try{await transport?.close();}catch(error){failures.push(error);}finally{channel?.close();}
      try{
        if(route==='shared')worker.port.close();
        // A detached elected candidate stops competing, but cannot terminate
        // an owner still serving authenticated siblings.
        else if(worker)await retireCandidate(worker,options.profileId,Math.min(options.timeoutMs??30000,3000));
      }catch(error){failures.push(error);}
      if(failures.length)throw new AggregateError(failures,'OWNER_DETACH_FAILED');
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
  function changeResidency(nextSuspended){
    explicitSuspended=nextSuspended;
    if(nextSuspended)pauseObservation();
    const changing=residency.then(async()=>{
      if(detached){if(nextSuspended)return;throw new CollaborationError('ENDPOINT_STALE');}
      if(suspended===nextSuspended)return nextSuspended?undefined:session;
      if(nextSuspended){
        suspended=true;
        await provider.close();await session.suspend();await transport?.suspend();
      }else{
        explicitResuming=true;
        try{
          // A hide invalidates explicit resume just as it invalidates automatic
          // observation. Re-prove a rapid visible return before installing once.
          while(!detached){
            const epoch=observationEpoch;
            await transport?.resume();
            if(epoch!==observationEpoch){if(away()||explicitSuspended)break;continue;}
            if(away()||explicitSuspended){pauseObservation(true);break;}
            await session.resumeAttachment();
            if(epoch!==observationEpoch){if(away()||explicitSuspended)break;continue;}
            break;
          }
          if(detached)throw new CollaborationError('ENDPOINT_STALE');
          if(explicitSuspended){pauseObservation(true);return session;}
          provider=startRtc();suspended=false;
          if(away())pauseObservation(true);else observationPaused=false;
          return session;
        }finally{explicitResuming=false;}
      }
    });
    residency=changing.catch(()=>{});return changing;
  }
  return Object.freeze({session,mode:route==='shared'?'shared':'elected',storagePersisted,
    suspend(){return changeResidency(true);},
    resume(){return changeResidency(false);},
    async detach(){if(detached){await releasing;return;}detached=true;try{await session.detach();}finally{await release();}},
  });
}
async function sharedRoute(url,options,handshake){
  const id=crypto.randomUUID();let worker,transport,provider,rtc;
  try{
    worker=new SharedWorker(url,{type:'module',name:ownerWorkerName(options.profileId)});worker.port.start();
    worker.addEventListener('error',event=>worker.port.dispatchEvent(new MessageEvent('message',{data:{
      protocol:BROWSER_OWNER_PROTOCOL,type:'failure',code:'OWNER_UNREACHABLE',message:event.message||'Shared owner module failed to load',id}})));
    const ready=waitFor(worker.port,data=>data.type==='ready'&&data.id===id,options);
    worker.port.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'boot',mode:'shared',id,profileId:options.profileId});
    rtc=createRootRtcEndpoint(worker.port,{profileId:options.profileId,rootId:id});provider=registerBrowserRtcProvider(rtc,{signal:options.signal??new AbortController().signal});
    const active=await ready;transport=createSharedRootEndpoint(worker.port,{profileId:options.profileId,rootId:id,
      ownerInstanceId:active.ownerInstanceId,onReplaced:options.onOwnerReplaced,livenessTimeoutMs:options.livenessTimeoutMs,requestTimeoutMs:options.timeoutMs??30000,rtc});
    const session=await connectApplicationOwner(transport,handshake);
    return facade({session,transport,provider,worker,route:'shared',options});
  }catch(error){
    await provider?.close();rtc?.dispose();await transport?.close();
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
    transport=createBroadcastEndpoint(channel,active,{profileId:options.profileId,onReplaced:options.onOwnerReplaced,livenessTimeoutMs:options.livenessTimeoutMs,requestTimeoutMs:options.timeoutMs??30000});
    const provider=registerBrowserRtcProvider(transport.rtc,{signal:options.signal??new AbortController().signal});
    let session;try{session=await connectApplicationOwner(transport,handshake);}catch(error){await provider.close();throw error;}
    return facade({session,transport,provider,channel,route:'existing',options});
  }catch(error){await transport?.close();channel.close();throw error;}
}
async function elected(url,options,handshake){
  if(typeof BroadcastChannel!=='function'||typeof Worker!=='function')throw new CollaborationError('OWNER_CAPABILITY_UNAVAILABLE','The elected owner route needs Worker and BroadcastChannel');
  const id=crypto.randomUUID(),channel=new BroadcastChannel(ownerChannelName(options.profileId));let worker,transport,booted=false,bootstrapRtc,bootstrapProvider,provider;
  try{
    worker=new Worker(url,{type:'module',name:`tendriller-owner-${id}`});
    const ready=waitFor(channel,data=>isOwnerAnnouncement(data,options.profileId),options);
    // The worker queues an exclusive Web Lock. Suspension never permits takeover.
    worker.addEventListener('message',({data})=>{if(data?.protocol===BROWSER_OWNER_PROTOCOL&&data.type==='failure')channel.dispatchEvent(new MessageEvent('message',{data}));});
    worker.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'boot',mode:'elected',id,profileId:options.profileId});booted=true;
    bootstrapRtc=createRootRtcEndpoint(worker,{profileId:options.profileId,rootId:id});bootstrapProvider=registerBrowserRtcProvider(bootstrapRtc,{signal:options.signal??new AbortController().signal});
    channel.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'discover'});
    const active=await ready;transport=createBroadcastEndpoint(channel,active,{profileId:options.profileId,
      onReplaced:options.onOwnerReplaced,livenessTimeoutMs:options.livenessTimeoutMs,requestTimeoutMs:options.timeoutMs??30000});
    provider=registerBrowserRtcProvider(transport.rtc,{signal:options.signal??new AbortController().signal});
    const session=await connectApplicationOwner(transport,handshake);
    const providers={adopt(session){provider.adopt(session);bootstrapProvider.adopt(session);},async close(){await Promise.all([provider.close(),bootstrapProvider.close()]);}};
    return facade({session,transport,provider:providers,bootstrapRtc,channel,worker,route:'elected',options});
  }catch(error){await provider?.close();await bootstrapProvider?.close();bootstrapRtc?.dispose();await transport?.close();channel.close();
    if(booted)await retireCandidate(worker,options.profileId,Math.min(options.timeoutMs??30000,3000));else worker?.terminate();throw error;}
}
/** Enrollment is deliberate. A lock/storage failure never creates a replacement signer. */
export async function createBrowserIdentity(options){
  const url=validate(options),worker=new Worker(url,{type:'module'}),id=crypto.randomUUID();
  try{const ready=waitFor(worker,data=>data.type==='identity'&&data.id===id,options);
    worker.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'identity',profileId:options.profileId,id});
    const publicKey=(await ready).publicKey;
    // A new retained key is the device's only signer: keep it out of best-effort eviction.
    if(options.persistStorage!==false)void requestPersistentStorage();
    return publicKey;
  }finally{worker.terminate();}
}
