export const BROWSER_OWNER_PROTOCOL = 'tendriller/browser-owner/v1';
export const ownerChannelName = profileId => `tendriller:owner:v1:${profileId}`;
export function checkOwnerFrame(value) {
  let nodes=0,bytes=0;const seen=new Set(),encoder=new TextEncoder();
  function visit(item,depth){if(++nodes>65536||depth>32)throw Error('OWNER_MESSAGE_LIMIT');
    if(typeof item==='string')bytes+=encoder.encode(item).length;
    else if(typeof item==='bigint')bytes+=item.toString().length;
    else if(item===null||item===undefined||typeof item==='boolean'||typeof item==='number')bytes+=8;
    else if(item instanceof Uint8Array)bytes+=item.byteLength;
    else if(typeof item==='object'){if(seen.has(item))throw Error('OWNER_MESSAGE_INVALID');seen.add(item);
      for(const [key,child]of Object.entries(item)){bytes+=encoder.encode(key).length;visit(child,depth+1);}seen.delete(item);
    }else throw Error('OWNER_MESSAGE_INVALID');
    if(bytes>1048576)throw Error('OWNER_MESSAGE_LIMIT');
  }visit(value,0);
}
export function ended(code='OWNER_UNREACHABLE'){return{ended:{name:'Error',message:code,code}};}

/** MessagePorts cannot cross BroadcastChannel. This bridge carries only bounded facade frames. */
export function createBroadcastEndpoint(channel,ownerInstanceId,{onReplaced}={}) {
  const routes=new Map();let closed=false;
  const receive=({data})=>{
    if(data?.protocol!==BROWSER_OWNER_PROTOCOL)return;
    if((data.type==='ready'&&data.ownerInstanceId!==ownerInstanceId)||(data.type==='retired'&&data.ownerInstanceId===ownerInstanceId)){
      for(const port of routes.values())port.postMessage(ended('ENDPOINT_STALE'));
      onReplaced?.({previous:ownerInstanceId,current:data.ownerInstanceId});return;
    }
    if(data.type!=='frame'||data.direction!=='client'||data.ownerInstanceId!==ownerInstanceId)return;
    const port=routes.get(data.route);if(!port)return;
    try{checkOwnerFrame(data.frame);port.postMessage(data.frame);}catch{port.postMessage(ended('OWNER_MESSAGE_LIMIT'));}
  };
  channel.addEventListener('message',receive);
  return {postMessage(frame){
    if(closed)throw Error('ENDPOINT_STALE');
    if(!frame?.port||typeof frame.port.postMessage!=='function'||routes.size>=1)throw Error('OWNER_HANDSHAKE_INVALID');
    const route=crypto.randomUUID(),port=frame.port;routes.set(route,port);
    port.addEventListener('message',({data})=>{try{checkOwnerFrame(data);channel.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'frame',direction:'owner',ownerInstanceId,route,frame:data});}
      catch{port.postMessage(ended('OWNER_MESSAGE_LIMIT'));}});port.start();
    channel.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'attach',ownerInstanceId,route,
      handshake:frame.handshake,facadeProtocol:frame.protocol});
  },addEventListener(){},removeEventListener(){},close(){if(closed)return;closed=true;
    channel.removeEventListener('message',receive);for(const [route,port]of routes){channel.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'detach',ownerInstanceId,route});port.close();}routes.clear();
  }};
}
