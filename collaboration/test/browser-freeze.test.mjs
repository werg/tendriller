import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {BROWSER_OWNER_PROTOCOL} from '../browser-transport.mjs';
import {BROWSER_RTC_PROTOCOL} from '../browser-rtc.mjs';
import {defineApplication,defineQuery,describeApplication,PEER_GENERATION_CAPABILITIES} from '@chronolog/peer-session';

// Real public owner composition and Chronolog attachment RPC. Only RTC mechanics
// are stubbed: this fixture verifies lifecycle/provider ownership, not P2P data.
const rtc={name:'freeze-rtc',setup(build){build.onLoad({filter:/\/peer-session\/webrtc\.mjs$/},()=>({loader:'js',contents:`
 export function serveWorkerWebRtcConnections(endpoint){
  const probe=globalThis.__freezeProbe,id=++probe.started;probe.active.add(id);let closed=false;
  const receive=({data})=>{if(!closed&&data?.protocol==='fixture/opaque-rtc')endpoint.postMessage({...data,providerId:id});};endpoint.addEventListener('message',receive);
  return{async close(){if(closed)return;closed=true;endpoint.removeEventListener('message',receive);probe.closed++;probe.active.delete(id);}};
 }
 export async function openWorkerWebRtcConnection(endpoint,{signal}){return{signal,async close(){},roundTrip(packet){return new Promise((resolve,reject)=>{
  const id=crypto.randomUUID(),done=(error,value)=>{endpoint.removeEventListener('message',receive);signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const receive=({data})=>{if(data?.protocol==='fixture/opaque-rtc'&&data.id===id)done(null,data);},abort=()=>done(signal.reason);
  signal.throwIfAborted();endpoint.addEventListener('message',receive);signal.addEventListener('abort',abort,{once:true});endpoint.postMessage({protocol:'fixture/opaque-rtc',id,packet});
 });}};}

 `}));}};
const root=new URL('../..',import.meta.url).pathname;
// Freeze only the page clock. The Worker remains alive on its independent real
// clock, as it does when a browser document stops scheduling callbacks.
const pageBundle=await build({stdin:{contents:"export{openBrowserOwner}from'./collaboration/browser.mjs';",resolveDir:root},bundle:true,write:false,format:'esm',platform:'node',plugins:[rtc],banner:{js:`const __clock=globalThis.__freezeClock;const performance={now:()=>__clock.now};const setTimeout=__clock.setTimeout.bind(__clock);const clearTimeout=__clock.clearTimeout.bind(__clock);`}});
const workerBundle=await build({stdin:{contents:"export{serveBrowserOwner}from'./collaboration/worker.mjs';",resolveDir:root},bundle:true,write:false,format:'esm',platform:'node',plugins:[rtc],banner:{js:'const BroadcastChannel=globalThis.__freezeWorkerChannel;'}});

class PageClock{
 now=0;tasks=new Map();errors=[];
 setTimeout(fn,ms=0,...args){const key={unref(){return this;}};this.tasks.set(key,{fn,args,at:this.now+ms});return key;}
 clearTimeout(key){this.tasks.delete(key);}
 get heartbeats(){return[...this.tasks].filter(([,task])=>task.fn.name==='pulse').map(([key])=>key);}
 elapse(ms){this.now+=ms;}
 runDue(){for(let count=0;count<10000;count++){const next=[...this.tasks].find(([,task])=>task.at<=this.now);if(!next)return;const[key,task]=next;this.tasks.delete(key);try{void Promise.resolve(task.fn(...task.args)).catch(error=>this.errors.push(error));}catch(error){this.errors.push(error);}}throw Error('FIXTURE_TIMER_LOOP');}
 advance(ms){this.elapse(ms);this.runDue();}
}
async function until(predicate,label){const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw Error('FIXTURE_WAIT: '+label);await delay(2);}}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('FIXTURE_WAIT: '+label)),3000);})]);}finally{clearTimeout(timer);}}

async function fixture(t,mode){
 const directory=await mkdtemp(join(tmpdir(),'browser-freeze-')),clock=new PageClock(),doc=new EventTarget(),events=new EventTarget();
 doc.visibilityState='visible';doc.hidden=false;
 const keys=['navigator','location','document','window','SharedWorker','Worker','RTCPeerConnection','addEventListener','removeEventListener','dispatchEvent','__freezeClock','__freezeProbe','__freezeWorkerChannel'];
 const globals=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const rootRequests=new Map(),dedicatedAvailability=[],sharedRoots=[],ports=[],channels=[],replaced=[],gate={silent:false,hold:false,queued:[],holdSuspendAck:false,suspendAcks:[]},probe={started:0,closed:0,active:new Set()};let held=0,opened=0,service,attachment,pageWorker,openDirectConnection;const siblingAttachments=[];
 const deliver=send=>{if(gate.silent)return;if(gate.hold)gate.queued.push(send);else send();};
 const NativeChannel=globalThis.BroadcastChannel;
 class WorkerChannel extends NativeChannel{constructor(...args){super(...args);channels.push(this);}postMessage(value){deliver(()=>super.postMessage(value));}}
 const stop=new AbortController(),signalListeners=new Set();
 const signals={delivery:'neighbors',async send(topic,payload){for(const receive of signalListeners)receive({topic,payload});return null;},async *subscribe({signal}){
  const queue=[];let wake;const receive=value=>{queue.push(value);wake?.();},ended=()=>wake?.();signalListeners.add(receive);signal.addEventListener('abort',ended,{once:true});
  try{while(!signal.aborted){if(!queue.length)await new Promise(resolve=>{wake=resolve;});if(!signal.aborted&&queue.length)yield queue.shift();}}finally{signalListeners.delete(receive);signal.removeEventListener('abort',ended);}
 }};
 const definition=defineApplication({id:'freeze-fixture',version:'1',commands:{},queries:{state:defineQuery({description:'Read retained fixture identity',input:{type:'null'},read:()=>[]})}}),description=describeApplication(definition);
 const revision={applicationId:'a'.repeat(64),historyId:'retained',generation:'c'.repeat(64),point:{generation:'c'.repeat(64),sequence:0,root:'d'.repeat(64)},controlRevision:0,materializationRevision:'0'};
 const session={applicationId:'a'.repeat(64),historyId:'retained',storageId:'retained',deviceId:'b'.repeat(64),signal:stop.signal,revision:null,
  status:{phase:'ready',database:'idle',role:'coordinator',generation:'c'.repeat(64),coordinator:'b'.repeat(64),connectedPeers:0},signals,
  describe:()=>({...description,capabilities:{...PEER_GENERATION_CAPABILITIES,sql:false}}),onStatus(fn){fn(this.status);return()=>{};},onRecovery:()=>()=>{},
  async query(){return{revision,value:['retained identity']};},async close(){stop.abort(Error('FIXTURE_OWNER_CLOSED'));}};
 class Scope extends EventTarget{postMessage(value){deliver(()=>queueMicrotask(()=>pageWorker?.dispatchEvent(new MessageEvent('message',{data:value}))));}close(){}connect(port){this.dispatchEvent(Object.assign(new Event('connect'),{ports:[port]}));}}
 const scope=new Scope();
 function outgoing(port){const post=port.postMessage.bind(port);port.postMessage=(...args)=>{const frame=args[0];if(gate.holdSuspendAck&&frame?.type==='root.result'&&rootRequests.get(frame.id)==='root.suspend'){gate.suspendAcks.push(()=>post(...args));return;}deliver(()=>post(...args));};}
 const values={__freezeClock:clock,__freezeProbe:probe,__freezeWorkerChannel:WorkerChannel,
  navigator:{locks:{async request(_name,options,run){if(held&&options.ifAvailable)return run(null);held++;try{return await run({});}finally{held--;}}}},
  location:new URL('https://fixture.test/'),document:doc,window:globalThis,RTCPeerConnection:class{},
  addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),
  SharedWorker:mode==='shared'?class extends EventTarget{constructor(){super();const wire=new MessageChannel();ports.push(wire.port1,wire.port2);this.port=wire.port2;
    // Gate both root replies and the transferred RPC endpoint before the owner
    // consumes its handshake; otherwise a "silent" root could still answer RPC.
    const root={port:wire.port2};sharedRoots.push(root);wire.port1.addEventListener('message',({data})=>{if(data?.protocol===BROWSER_OWNER_PROTOCOL)rootRequests.set(data.id,data.type);if(data?.type==='boot')root.id=data.id;if(data?.port)outgoing(data.port);});outgoing(wire.port1);scope.connect(wire.port1);}}:undefined,
  Worker:class extends EventTarget{constructor(){super();pageWorker=this;}postMessage(data){queueMicrotask(()=>scope.dispatchEvent(new MessageEvent('message',{data})));}terminate(){}},
 };
 for(const[key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{configurable:true,value});
 t.after(async()=>{
  gate.silent=false;gate.hold=false;gate.holdSuspendAck=false;for(const send of [...gate.queued.splice(0),...gate.suspendAcks.splice(0)])send();
  try{
   let done=false;const closing=Promise.allSettled([service?.close(),attachment?.detach(),...siblingAttachments.map(value=>value.detach())]).then(()=>done=true);
   for(let i=0;!done&&i<100;i++){await delay(2);clock.advance(1000);}await bounded(closing,'cleanup');
  }finally{for(const port of ports)port.close();for(const channel of channels)channel.close();for(const[key,value]of globals)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];await rm(directory,{recursive:true,force:true});}
 });
 await writeFile(join(directory,'page.mjs'),pageBundle.outputFiles[0].text);await writeFile(join(directory,'worker.mjs'),workerBundle.outputFiles[0].text);
 const page=await import(pathToFileURL(join(directory,'page.mjs')).href),worker=await import(pathToFileURL(join(directory,'worker.mjs')).href);
 service=worker.serveBrowserOwner({scope,profileId:'retained',async openSession(options){openDirectConnection=options.openDirectConnection;opened++;return{session};}});
 // This listener is installed after the real Worker ingress handler. Its
 // synchronous RTC dispatch has applied the hint before this observer runs.
 scope.addEventListener('message',({data})=>{if(data?.protocol===BROWSER_RTC_PROTOCOL&&data.payload?.type==='availability')dedicatedAvailability.push(data.payload.available);});
 attachment=await bounded(page.openBrowserOwner({workerUrl:'https://fixture.test/worker.mjs',profileId:'retained',applicationId:session.applicationId,definitionId:definition.id,definitionVersion:definition.version,persistStorage:false,storageKeepAliveMs:0,onOwnerReplaced:value=>replaced.push(value)}),'initial attach');
 await until(()=>clock.heartbeats.length>0,'initial heartbeat armed');
 async function workerBarrier(available){
  if(mode==='shared'){
   // Both provider data and private root controls use this same FIFO port.
   // A matching root result proves the preceding availability/park was applied.
   const root=sharedRoots[0],id=crypto.randomUUID();
   await bounded(new Promise((resolve,reject)=>{
    const receive=({data})=>{if(data?.id!==id)return;root.port.removeEventListener('message',receive);data.type==='root.result'?resolve():reject(Error('FIXTURE_ROOT_BARRIER_FAILED'));};
    root.port.addEventListener('message',receive);root.port.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'root.ping',profileId:'retained',rootId:root.id,ownerInstanceId:attachment.session.endpoint.ownerInstanceId,id});
   }),'Worker root control barrier');
  }else{
   // An actual facade reply is ordered after RTC messages on the authenticated
   // BC queue. The separate bootstrap Worker port needs its own observed hint.
   await bounded(attachment.session.query('state',null),'authenticated BC queue barrier');
   if(available!==undefined)await until(()=>dedicatedAvailability.at(-1)===available,'bootstrap availability applied');
  }
 }
 async function sibling(){
  const previous=globalThis.document,next=new EventTarget();next.hidden=false;next.visibilityState='visible';Object.defineProperty(globalThis,'document',{configurable:true,value:next});
  try{const value=await bounded(page.openBrowserOwner({workerUrl:'https://fixture.test/worker.mjs',profileId:'retained',applicationId:session.applicationId,definitionId:definition.id,definitionVersion:definition.version,persistStorage:false,storageKeepAliveMs:0}),'sibling attach');siblingAttachments.push(value);return value;}finally{Object.defineProperty(globalThis,'document',{configurable:true,value:previous});}
 }
 return{attachment,clock,doc,events,probe,gate,replaced,session,sibling,workerBarrier,rootRequests,registerOriginal(){const root=sharedRoots[0];root.port.postMessage({protocol:BROWSER_RTC_PROTOCOL,profileId:'retained',rootId:root.id,payload:{protocol:BROWSER_RTC_PROTOCOL,type:'register',available:true}});},get signalObservers(){return signalListeners.size;},openDirect:options=>openDirectConnection({timeoutMs:1000,...options}),get opened(){return opened;},get held(){return held;}};
}

for(const mode of['shared','elected'])for(const event of['freeze','visibilitychange'])for(const manual of[false,true])test(`${mode} automatic ${event} pauses synchronously and authenticated resume preserves the owner${manual?' with coalesced BFCache calls':''}`,async t=>{
 const f=await fixture(t,mode),session=f.attachment.session,identity={deviceId:session.deviceId,historyId:session.historyId,storageId:session.storageId,ownerInstanceId:session.endpoint.ownerInstanceId};
 const previousHeartbeats=f.clock.heartbeats,initialProviders=f.probe.active.size;
 f.doc.hidden=true;f.doc.visibilityState='hidden';f.doc.dispatchEvent(new Event(event));
 assert(previousHeartbeats.every(key=>!f.clock.tasks.has(key)),'freeze must cancel the existing local pulse synchronously, before a Promise or microtask');
 assert.equal(f.probe.active.size,initialProviders,'soft freeze must preserve the page RTC providers');
 if(manual)await bounded(Promise.all([f.attachment.suspend(),f.attachment.suspend()]),'coalesced suspension');
 await until(()=>f.clock.tasks.size===0,'suspend RPC acknowledged before freezing the page clock');
 f.clock.elapse(30_001);assert.equal(f.replaced.length,0);assert.equal(session.signal.aborted,false);assert.equal(f.session.signal.aborted,false);
 f.doc.hidden=false;f.doc.visibilityState='visible';f.doc.dispatchEvent(new Event('resume'));
 if(manual)await bounded(Promise.all([f.attachment.resume(),f.attachment.resume()]),'coalesced resume');
 await until(()=>f.clock.heartbeats.length>0,'authenticated resume arms a fresh heartbeat');f.clock.runDue();
 assert.deepEqual((await bounded(session.query('state',null),'query after resume')).value,['retained identity']);
 assert.equal(f.replaced.length,0);assert.equal(session.signal.aborted,false);assert.equal(f.opened,1);assert.equal(f.held,1);assert.equal(f.attachment.session,session);
 assert.deepEqual({deviceId:session.deviceId,historyId:session.historyId,storageId:session.storageId,ownerInstanceId:session.endpoint.ownerInstanceId},identity);
 const providers=f.probe.active.size,started=f.probe.started;assert(providers>0);
 f.doc.hidden=false;f.doc.visibilityState='visible';f.doc.dispatchEvent(new Event('resume'));await bounded(Promise.all([f.attachment.resume(),f.attachment.resume()]),'repeated active resume');
 assert.equal(f.probe.active.size,providers);assert.equal(f.probe.started,started,'duplicate resume must not create another RTC provider');assert.deepEqual(f.clock.errors,[]);
});
for(const mode of['shared','elected'])test(`${mode} resume cannot manufacture freshness when the owner is silent`,async t=>{
 const f=await fixture(t,mode);f.doc.dispatchEvent(new Event('freeze'));await until(()=>f.clock.tasks.size===0,'suspend RPC acknowledged');f.clock.elapse(30_001);f.gate.silent=true;f.doc.hidden=false;f.doc.visibilityState='visible';f.doc.dispatchEvent(new Event('resume'));
 await until(()=>[...f.clock.tasks.values()].some(task=>task.at===f.clock.now+15_000),'bounded resume probe armed');
 assert.equal(f.clock.heartbeats.length,0);f.clock.advance(14_999);await delay(2);assert.equal(f.replaced.length,0);assert.equal(f.attachment.session.signal.aborted,false);
 f.clock.advance(1);await until(()=>f.attachment.session.signal.aborted,'silent owner fails closed');assert.equal(f.replaced.length,1);assert.equal(f.opened,1);assert.equal(f.session.signal.aborted,false,'an attachment fence cannot stop the retained owner');
});

for(const mode of['shared','elected'])test(`${mode} a delayed resume proof cannot unpark a newly frozen page`,async t=>{
 const f=await fixture(t,mode),session=f.attachment.session;
 f.doc.dispatchEvent(new Event('freeze'));
 await until(()=>f.clock.tasks.size===0,'suspension acknowledged');
 f.clock.elapse(30_001);f.gate.hold=true;
 f.doc.dispatchEvent(new Event('resume'));
 await until(()=>f.gate.queued.length>0,'owner resume proof held in transit');
 f.doc.dispatchEvent(new Event('freeze'));
 assert.equal(f.clock.heartbeats.length,0,'second freeze parks synchronously');
 f.gate.hold=false;for(const send of f.gate.queued.splice(0))send();
 await until(()=>f.clock.tasks.size===0,'old proof settles while frozen');
 assert.equal(f.clock.heartbeats.length,0,'stale resume proof must not restart observation');
 assert.equal(session.signal.aborted,false);assert.equal(f.replaced.length,0);
 f.doc.dispatchEvent(new Event('resume'));
 await until(()=>f.clock.heartbeats.length>0,'new visible resume receives fresh proof');
 assert.deepEqual((await bounded(session.query('state',null),'query after second resume')).value,['retained identity']);
 assert.equal(f.opened,1);assert.equal(f.probe.active.size,mode==='shared'?1:2);assert.deepEqual(f.clock.errors,[]);
});

for(const mode of['shared','elected'])test(`${mode} rapid visible-hidden-visible obtains a new proof after a stale resume`,async t=>{
 const f=await fixture(t,mode);
 f.doc.dispatchEvent(new Event('freeze'));await until(()=>f.clock.tasks.size===0,'suspension acknowledged');
 f.clock.elapse(30_001);f.gate.hold=true;f.doc.dispatchEvent(new Event('resume'));
 await until(()=>f.gate.queued.length>0,'first resume proof held');
 f.doc.dispatchEvent(new Event('freeze'));f.doc.dispatchEvent(new Event('resume'));
 f.gate.hold=false;for(const send of f.gate.queued.splice(0))send();
 await until(()=>f.clock.heartbeats.length>0,'final visible state obtains a new proof and rearms heartbeat');
 assert.equal(f.replaced.length,0);assert.equal(f.attachment.session.signal.aborted,false);
 assert.equal(f.opened,1);assert.deepEqual(f.clock.errors,[]);
});
for(const mode of['shared'])test(`${mode} an obsolete resume timeout cannot fence a reparked page`,async t=>{
 const f=await fixture(t,mode);
 f.doc.dispatchEvent(new Event('freeze'));await until(()=>f.clock.tasks.size===0,'suspension acknowledged');
 f.clock.elapse(30_001);f.gate.hold=true;f.doc.dispatchEvent(new Event('resume'));
 await until(()=>f.gate.queued.length>0,'resume proof withheld');
 f.gate.hold=false;f.gate.queued.splice(0);f.doc.dispatchEvent(new Event('freeze'));
 // New suspension RPCs reach the owner; only the obsolete proof was lost.
 await delay(10);f.clock.advance(15_000);await delay(10);
 assert.equal(f.replaced.length,0,'a superseded proof deadline is not evidence that the owner died');
 assert.equal(f.attachment.session.signal.aborted,false);assert.equal(f.clock.heartbeats.length,0);
 f.doc.dispatchEvent(new Event('resume'));
 await until(()=>f.clock.heartbeats.length>0,'fresh visible resume after obsolete timeout');
 assert.equal(f.opened,1);assert.deepEqual(f.clock.errors,[]);
});

for(const mode of ['shared','elected'])test(`${mode} observational parking forwards active opaque RTC frames and preserves ordinary queries`,async t=>{
 const f=await fixture(t,mode),connection=await f.openDirect();t.after(()=>connection.close());
 const streamStop=new AbortController();t.after(()=>streamStop.abort());const stream=f.attachment.session.signals.subscribe({topics:['position'],signal:streamStop.signal})[Symbol.asyncIterator](),nextSignal=stream.next();
 await until(()=>f.signalObservers===1,'signal subscription established before hiding');
 const packet=new Uint8Array([1,9,7,4]),before=await bounded(connection.roundTrip(packet),'active RTC packet');
 f.doc.hidden=true;f.doc.visibilityState='hidden';f.doc.dispatchEvent(new Event('visibilitychange'));
 await f.workerBarrier();
 const after=await bounded(connection.roundTrip(packet),'hidden provider forwards RTC packet');
 assert.deepEqual(after.packet,packet);assert.equal(after.providerId,before.providerId);assert.equal(connection.signal.aborted,false);
 assert.deepEqual((await bounded(f.attachment.session.query('state',null),'background query')).value,['retained identity']);
 await f.attachment.session.signals.send('position',{x:7});assert.deepEqual((await bounded(nextSignal,'background signal stream')).value,{topic:'position',payload:{x:7}});assert.equal(f.signalObservers,1,'observation parking must not cancel active signal streams');
 assert.equal(f.replaced.length,0);assert.equal(f.opened,1);
 // Merely hidden providers remain eligible. Only a frozen provider is skipped
 // for new opens; selection must not abort its retained connection.
 const hidden=await f.openDirect();await hidden.close();f.doc.dispatchEvent(new Event('freeze'));
 await f.workerBarrier(false);
 let opened=false;const pending=f.openDirect().then(value=>{opened=true;return value;});
 await delay(10);assert.equal(opened,false);assert.equal(connection.signal.aborted,false);
 f.doc.dispatchEvent(new Event('resume'));await f.workerBarrier(true);
 const fresh=await bounded(pending,'resume wakes pending selection');await fresh.close();
 assert.equal(connection.signal.aborted,false);assert.equal(f.clock.heartbeats.length,0,'resume while hidden keeps observation parked');
});
test('shared selection uses a visible sibling without aborting the frozen first provider',async t=>{
 const f=await fixture(t,'shared'),first=await f.openDirect();t.after(()=>first.close());
 const original=await bounded(first.roundTrip(new Uint8Array([3])),'first provider');await f.sibling();
 f.doc.hidden=true;f.doc.visibilityState='hidden';f.doc.dispatchEvent(new Event('freeze'));
 await f.workerBarrier(false);
 const second=await f.openDirect();t.after(()=>second.close());
 const reply=await bounded(second.roundTrip(new Uint8Array([5])),'visible provider packet');assert.notEqual(reply.providerId,original.providerId);
 assert.equal(first.signal.aborted,false);f.doc.dispatchEvent(new Event('resume'));
 await f.workerBarrier(true);
 const third=await f.openDirect();const thirdReply=await bounded(third.roundTrip(new Uint8Array([8])),'hidden resumed selection');assert.equal(thirdReply.providerId,original.providerId);await third.close();
 assert.deepEqual((await bounded(first.roundTrip(new Uint8Array([6])),'retained hidden provider packet')).packet,new Uint8Array([6]));
 assert.equal(f.opened,1);
});

for(const mode of ['shared','elected'])test(`${mode} explicit suspension closes its providers and forbids new work until resume`,async t=>{
 const f=await fixture(t,mode),first=await f.openDirect();t.after(()=>first.close());
 await f.attachment.suspend();await until(()=>first.signal.aborted,'explicit provider shutdown');assert.equal(f.probe.active.size,0);
 let opened=false;const pending=f.openDirect().then(value=>{opened=true;return value;});await delay(10);assert.equal(opened,false);
 await f.attachment.resume();const next=await bounded(pending,'explicit resume permits a new open');await next.close();assert.equal(f.opened,1);
});

test('a delayed old SharedWorker ping cannot create a second heartbeat after park/resume',async t=>{
 const f=await fixture(t,'shared');f.gate.hold=true;f.clock.advance(5000);
 await until(()=>f.gate.queued.length>0,'old ping reply held');
 const oldReplies=f.gate.queued.splice(0);f.gate.hold=false;f.doc.dispatchEvent(new Event('freeze'));f.doc.dispatchEvent(new Event('resume'));
 await until(()=>f.clock.heartbeats.length===1,'fresh resumed heartbeat');
 for(const send of oldReplies)send();
 await until(()=>f.clock.tasks.size===f.clock.heartbeats.length,'old ping settled');
 assert.equal(f.clock.heartbeats.length,1,'an obsolete pulse must not schedule another loop');assert.equal(f.replaced.length,0);
});

test('observational park cannot clear an explicitly suspended SharedWorker RTC route',async t=>{
 const f=await fixture(t,'shared');await f.attachment.suspend();
 f.doc.hidden=true;f.doc.visibilityState='hidden';f.doc.dispatchEvent(new Event('freeze'));f.doc.dispatchEvent(new Event('resume'));
 await until(()=>f.clock.tasks.size===0,'park hint updated while explicitly suspended');
 // Simulate a late provider registration on the same private root. Only an
 // explicit authenticated root.resume may restore its authority.
 f.registerOriginal();let opened=false;const pending=f.openDirect().then(value=>{opened=true;return value;});await delay(10);assert.equal(opened,false);
 await f.attachment.resume();const connection=await bounded(pending,'explicit resume restores route authority');await connection.close();
});

for(const mode of ['shared','elected'])for(const visibleAgain of [false,true])test(`${mode} hide during explicit resume parks synchronously${visibleAgain?' and a rapid visible return requires new proof':''}`,async t=>{
 const f=await fixture(t,mode);await f.attachment.suspend();const starts=f.probe.started;
 let release,entered=false,calls=0;const held=new Promise(resolve=>{release=resolve;}),resumeAttachment=f.attachment.session.resumeAttachment.bind(f.attachment.session);
 // Run the actual endpoint RPC, then delay its continuation. This isolates the
 // facade's await boundary after transport proof without changing owner policy.
 f.attachment.session.resumeAttachment=async()=>{calls++;const value=await resumeAttachment();if(calls===1){entered=true;await held;}return value;};
 const resuming=f.attachment.resume();await until(()=>entered,'explicit resume awaiting endpoint continuation');assert(f.clock.heartbeats.length>0);
 f.doc.hidden=true;f.doc.visibilityState='hidden';f.doc.dispatchEvent(new Event('visibilitychange'));
 assert.equal(f.clock.heartbeats.length,0,'hide must synchronously park an explicit resume');
 if(visibleAgain){f.doc.hidden=false;f.doc.visibilityState='visible';f.doc.dispatchEvent(new Event('visibilitychange'));}
 f.clock.elapse(30_001);release();await bounded(resuming,'explicit resume settles after hide');
 assert.equal(f.probe.started,starts+1,'one explicit resume recreates its provider only once');
 if(visibleAgain){assert.equal(calls,2,'the old continuation cannot replace fresh visible proof');await until(()=>f.clock.heartbeats.length===1,'one fresh heartbeat');}
 else{assert.equal(f.clock.heartbeats.length,0);f.doc.hidden=false;f.doc.visibilityState='visible';f.doc.dispatchEvent(new Event('visibilitychange'));await until(()=>f.clock.heartbeats.length===1,'later visible proof');}
 f.clock.runDue();assert.equal(f.replaced.length,0);assert.equal(f.attachment.session.signal.aborted,false);assert.equal(f.opened,1);
 assert.deepEqual((await bounded(f.attachment.session.query('state',null),'query after explicit resume race')).value,['retained identity']);
});

for(const mode of ['shared','elected'])for(const silent of [false,true])test(`${mode} hidden explicit resume requires fresh binding from a ${silent?'silent':'healthy'} owner`,async t=>{
 const f=await fixture(t,mode);await f.attachment.suspend();await until(()=>f.clock.tasks.size===0,'explicit suspension acknowledged');
 const starts=f.probe.started;let calls=0,replies=0,outcome;
 const resumeAttachment=f.attachment.session.resumeAttachment.bind(f.attachment.session);
 f.attachment.session.resumeAttachment=async()=>{calls++;const result=await resumeAttachment();replies++;return result;};
 f.gate.hold=true;const resuming=f.attachment.resume();void resuming.then(()=>{outcome='completed';},()=>{outcome='failed';});
 await until(()=>f.gate.queued.length>0,'transport resume proof held');
 f.doc.hidden=true;f.doc.visibilityState='hidden';f.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(f.clock.heartbeats.length,0);
 if(silent){
  f.gate.silent=true;f.gate.hold=false;f.gate.queued.splice(0);await delay(10);
  assert.notEqual(outcome,'completed');assert.equal(f.probe.active.size,0);
  // The shared transport's superseded request retains its existing 15s bound;
  // cancellation of the BC probe may settle sooner. Neither is owner evidence.
  f.clock.advance(15000);await until(()=>calls>0||outcome!==undefined,'fresh endpoint request after transport cancellation');
  assert.equal(calls,1,'a cancelled transport proof must still require a new binding RPC');assert.equal(replies,0);assert.notEqual(outcome,'completed');assert.equal(f.probe.started,starts);
  f.clock.advance(30000);await until(()=>outcome!==undefined,'silent owner fails within the existing RPC deadline');assert.equal(outcome,'failed');assert.equal(f.probe.started,starts);
 }else{
  await delay(10);assert.notEqual(outcome,'completed','withheld owner replies cannot complete manual resume');
  f.gate.hold=false;for(const send of f.gate.queued.splice(0))send();await bounded(resuming,'healthy hidden owner proves binding');
  assert.equal(calls,1);assert.equal(replies,1);assert.equal(f.probe.started,starts+1);assert.equal(f.clock.heartbeats.length,0,'fresh binding while hidden must leave health parked');
  assert.deepEqual((await bounded(f.attachment.session.query('state',null),'healthy hidden query')).value,['retained identity']);
 }
});

for(const mode of ['shared','elected'])test(`${mode} explicit resume begun hidden obtains new transport proof if it becomes visible during binding`,async t=>{
 const f=await fixture(t,mode);await f.attachment.suspend();const starts=f.probe.started;
 f.doc.hidden=true;f.doc.visibilityState='hidden';f.doc.dispatchEvent(new Event('visibilitychange'));
 let release,entered=false,calls=0;const held=new Promise(resolve=>{release=resolve;}),resumeAttachment=f.attachment.session.resumeAttachment.bind(f.attachment.session);
 f.attachment.session.resumeAttachment=async()=>{calls++;const result=await resumeAttachment();if(calls===1){entered=true;await held;}return result;};
 const resuming=f.attachment.resume();await until(()=>entered,'hidden fresh binding continuation');assert.equal(f.clock.heartbeats.length,0);
 f.doc.hidden=false;f.doc.visibilityState='visible';f.doc.dispatchEvent(new Event('visibilitychange'));release();await bounded(resuming,'visible completion after hidden binding');
 assert.equal(calls,2);await until(()=>f.clock.heartbeats.length===1,'visible completion rearms observation');assert.equal(f.probe.started,starts+1);assert.equal(f.replaced.length,0);
});

test('a newer explicit suspend waits for renewed SharedWorker suspension after cancelling a sent resume',async t=>{
 const f=await fixture(t,'shared');await f.attachment.suspend();const starts=f.probe.started;
 const before=[...f.rootRequests.values()].filter(type=>type==='root.suspend').length;
 f.gate.hold=true;const resuming=f.attachment.resume();await until(()=>f.gate.queued.length>0,'sent resume result held');
 const oldReplies=f.gate.queued.splice(0);f.gate.hold=false;f.gate.holdSuspendAck=true;
 let suspended=false;const suspending=f.attachment.suspend().then(()=>{suspended=true;});for(const send of oldReplies)send();
 await bounded(resuming,'superseded resume settles');
 await until(()=>f.gate.suspendAcks.length>0||suspended,'new suspension reasserted on the Worker wire');
 assert.equal(suspended,false,'the final suspend cannot succeed before root.suspend acknowledgement');
 assert.equal([...f.rootRequests.values()].filter(type=>type==='root.suspend').length,before+1);assert.equal(f.probe.started,starts);
 f.gate.holdSuspendAck=false;for(const send of f.gate.suspendAcks.splice(0))send();await bounded(suspending,'last suspend intent acknowledged');
 f.registerOriginal();await f.workerBarrier();let opened=false;const pending=f.openDirect().then(value=>{opened=true;return value;});await f.workerBarrier();assert.equal(opened,false,'late registration cannot reactivate the explicitly suspended root');
 await f.attachment.resume();const connection=await bounded(pending,'later deliberate resume');await connection.close();
});
test('an explicit resume superseded before its turn never sends a SharedWorker resume request',async t=>{
 const f=await fixture(t,'shared');await f.attachment.suspend();const before=[...f.rootRequests.values()].filter(type=>type==='root.resume').length,starts=f.probe.started;
 await bounded(Promise.all([f.attachment.resume(),f.attachment.suspend()]),'immediately superseded resume');await f.workerBarrier();
 assert.equal([...f.rootRequests.values()].filter(type=>type==='root.resume').length,before);assert.equal(f.probe.started,starts);
});
