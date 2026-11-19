import { acquireApplicationOwnerLock, createApplicationOwner } from '@chronolog/peer-session/worker';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName, checkOwnerFrame, ended } from './browser-transport.mjs';
import { prepareCollaborationCommand } from './protocol.mjs';

/** One public owner composition for SharedWorker and the Web-Lock-elected fallback. */
export function serveBrowserOwner({profileId,openSession,createIdentity,scope=globalThis,ownerOptions={}}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(profileId)||typeof openSession!=='function')throw Error('OWNER_CONFIGURATION_INVALID');
  const lifetime=new AbortController(),routes=new Map(),attached=new Set();
  let owner,owned,lease,opening,channel,election,closed=false;
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
    })();return opening;
  }
  const announce=()=>{if(owner)channel?.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'ready',ownerInstanceId:owner.ownerInstanceId,profileId});};
  function retireRoute(route){const record=routes.get(route);if(!record)return;record.detach();record.port.close();routes.delete(route);}
  async function startElection(){
    if(election)return election;
    channel=new BroadcastChannel(ownerChannelName(profileId));
    channel.addEventListener('message',({data})=>{
      if(data?.protocol!==BROWSER_OWNER_PROTOCOL||!owner)return;
      if(data.type==='discover'){announce();return;}
      if(data.ownerInstanceId!==owner.ownerInstanceId)return;
      if(typeof data.route!=='string'||data.route.length>128)return;
      if(data.type==='detach'){retireRoute(data.route);return;}
      if(data.type==='attach'){
        if(routes.has(data.route))return;
        if(routes.size>=32){channel.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'frame',direction:'client',ownerInstanceId:owner.ownerInstanceId,route:data.route,frame:ended('OWNER_BUSY')});return;}
        try{checkOwnerFrame(data.handshake);const ports=new MessageChannel(),endpoint=new EventTarget();endpoint.postMessage=()=>{};
          const detach=owner.attach(endpoint);routes.set(data.route,{port:ports.port2,detach});
          ports.port2.addEventListener('message',({data:frame})=>{try{checkOwnerFrame(frame);channel.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'frame',direction:'client',ownerInstanceId:owner.ownerInstanceId,route:data.route,frame});}
            catch{retireRoute(data.route);}});ports.port2.start();
          endpoint.dispatchEvent(new MessageEvent('message',{data:{protocol:data.facadeProtocol,handshake:data.handshake,port:ports.port1}}));
        }catch{retireRoute(data.route);}return;
      }
      if(data.type==='frame'&&data.direction==='owner'){
        const record=routes.get(data.route);if(!record)return;
        try{checkOwnerFrame(data.frame);record.port.postMessage(data.frame);}catch{record.port.postMessage({id:0,method:'invalid',args:[]});retireRoute(data.route);}
      }
    });
    election=open(true).then(announce);
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
    if(owner)channel?.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'retired',ownerInstanceId:owner.ownerInstanceId});
    for(const route of routes.keys())retireRoute(route);
    try{await owner?.close();await owned?.close?.();}finally{await lease?.close();channel?.close();}
  }});
}
