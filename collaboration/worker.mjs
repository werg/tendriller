import { acquireApplicationOwnerLock, createApplicationOwner } from '@chronolog/peer-session/worker';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName, createBroadcastOwner } from './browser-transport.mjs';
import { prepareCollaborationCommand } from './protocol.mjs';

/** One public owner composition for SharedWorker and the Web-Lock-elected fallback. */
export function serveBrowserOwner({profileId,openSession,createIdentity,scope=globalThis,ownerOptions={}}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(profileId)||typeof openSession!=='function')throw Error('OWNER_CONFIGURATION_INVALID');
  const lifetime=new AbortController(),attached=new Set();
  let owner,owned,lease,opening,channel,election,broadcast,closed=false;
  const failure=(endpoint,id,error)=>endpoint.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'failure',id,
    code:error.code??error.message??'OWNER_UNREACHABLE',message:error.message??String(error)});
  async function open(wait){
    if(opening)return opening;
    opening=(async()=>{
      lease=await acquireApplicationOwnerLock(profileId,{wait,signal:lifetime.signal});
      try{owned=await openSession({signal:lifetime.signal});lifetime.signal.throwIfAborted();
        if(!owned?.session)throw Error('OWNER_SESSION_REQUIRED');
        owner=createApplicationOwner(owned.session,{...ownerOptions,host:owned.control,
          prepareCommand:(endpoint,name,input)=>prepareCollaborationCommand(endpoint,name,input,owned.session.deviceId)});
        return owner;
      }catch(error){try{await owned?.session?.close();await owned?.close?.();}finally{await lease.close();lease=undefined;}throw error;}
    })().catch(error=>{opening=undefined;owned=undefined;owner=undefined;throw error;});return opening;
  }
  async function startElection(){
    if(election)return election;
    channel=new BroadcastChannel(ownerChannelName(profileId));
    election=open(true).then(async()=>{
      broadcast=await createBroadcastOwner(channel,owner,{profileId,maxRoutes:ownerOptions.maxAttachments??32});
      if(closed){await broadcast.close();return;}broadcast.announce();
    });
    return election;
  }
  function attachBootstrap(endpoint){
    const message=({data})=>{
      if(data?.protocol!==BROWSER_OWNER_PROTOCOL||closed)return;
      void(async()=>{
        if(data.profileId!==profileId)throw Error('OWNER_PROFILE_MISMATCH');
        if(data.type==='identity'){
          if(typeof createIdentity!=='function')throw Error('IDENTITY_CREATION_UNAVAILABLE');
          const identityLock=await acquireApplicationOwnerLock(profileId,{signal:lifetime.signal});
          try{const publicKey=await createIdentity({signal:lifetime.signal});endpoint.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'identity',id:data.id,publicKey});}
          finally{await identityLock.close();}return;
        }
        if(data.type!=='boot')return;
        if(data.mode==='elected'){void startElection().catch(error=>failure(endpoint,data.id,error));return;}
        if(data.mode!=='shared')throw Error('OWNER_MODE_INVALID');
        await open(false);if(!attached.has(endpoint)){owner.attach(endpoint);attached.add(endpoint);}
        endpoint.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'ready',id:data.id,ownerInstanceId:owner.ownerInstanceId});
      })().catch(error=>failure(endpoint,data.id,error));
    };endpoint.addEventListener('message',message);endpoint.start?.();
  }
  scope.addEventListener('connect',event=>{for(const port of event.ports)attachBootstrap(port);});
  attachBootstrap(scope);
  return Object.freeze({get owner(){return owner;},async close(){if(closed)return;closed=true;lifetime.abort(Error('OWNER_UNREACHABLE'));
    try{await broadcast?.close();await owner?.close();await owned?.close?.();}finally{await lease?.close();channel?.close();}
  }});
}
