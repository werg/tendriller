import { openBrowserDevice, createApplicationSession, createApplicationOwner } from '@chronolog/peer-session/worker';
import { definition } from '../../docs/tutorial/shared/observation/domain.mjs';
import { createTestConnection } from './connection.mjs';
const pending=new Map();let sequence=0,owner,ownerReady;
const ready=new Promise(resolve=>ownerReady=resolve);
const bridge=createTestConnection((lane,bytes)=>new Promise((resolve,reject)=>{
  if(pending.size>=128) {reject(Error('Fixture send capacity exceeded.'));return;}
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Fixture send timed out.'));},10000);
  pending.set(id,{resolve(){clearTimeout(timer);resolve();},reject(error){clearTimeout(timer);reject(error);}});
  postMessage({type:'bridge-out',id,lane,bytes:[...bytes]});
}));
const device=await openBrowserDevice({name:'observation-qualification',create:true});
// Only the test driver evaluates this in the Worker. No private signer or
// epoch key is passed through the page or embedded in authored assets.
self.initializeWorker=async ({authority,key,nativePublicKey})=>{
  for(const membership of authority.memberships) membership.payload.authorTimeAfterMs=BigInt(membership.payload.authorTimeAfterMs);
  const session=await createApplicationSession({device,definition,authority,epochKeys:new Map([[0,new Uint8Array(key)]])});
  owner=createApplicationOwner(session);ownerReady();
  await session.connectPeer({connection:bridge.connection,peerIdentity:nativePublicKey});
};
addEventListener('message',({data})=>{void(async()=>{
  if(data?.type==='bridge-in') bridge.accept(data.lane,new Uint8Array(data.bytes));
  if(data?.type==='bridge-ack') {const task=pending.get(data.id);pending.delete(data.id);if(data.error)task?.reject(Error(data.error));else task?.resolve();}
  if(data?.type==='attach') {await ready;owner.attach(data.port,{capabilities:['commands','queries','events','content','signals','operations','diagnostics'],commands:['retainObservation'],queries:['observations'],rawSubmit:false,rawSql:false});}
  if(data?.type==='close') {await owner?.close();await bridge.close();for(const task of pending.values())task.reject(Error('Fixture closed.'));pending.clear();await device.close();postMessage({type:'closed'});}
})().catch(error=>postMessage({type:'failure',message:error.stack??String(error)}));});
postMessage({type:'identity',publicKey:device.identity.publicKey});
