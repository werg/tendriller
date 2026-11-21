import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {defineApplication,defineQuery,describeApplication,PEER_GENERATION_CAPABILITIES} from '@chronolog/peer-session';

// Real public owner composition and Chronolog attachment RPC. Only RTC mechanics
// are stubbed: this fixture verifies lifecycle/provider ownership, not P2P data.
const rtc={name:'freeze-rtc',setup(build){build.onLoad({filter:/\/peer-session\/webrtc\.mjs$/},()=>({loader:'js',contents:`
 export function serveWorkerWebRtcConnections(){
  const probe=globalThis.__freezeProbe,id=++probe.started;probe.active.add(id);let closed=false;
  return{async close(){if(closed)return;closed=true;probe.closed++;probe.active.delete(id);}};
 }
 export async function openWorkerWebRtcConnection(){throw Error('NO_NETWORK_IN_FREEZE_FIXTURE');}
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
 const ports=[],channels=[],replaced=[],gate={silent:false,hold:false,queued:[]},probe={started:0,closed:0,active:new Set()};let held=0,opened=0,service,attachment,pageWorker;
 const deliver=send=>{if(gate.silent)return;if(gate.hold)gate.queued.push(send);else send();};
 const NativeChannel=globalThis.BroadcastChannel;
 class WorkerChannel extends NativeChannel{constructor(...args){super(...args);channels.push(this);}postMessage(value){deliver(()=>super.postMessage(value));}}
 const stop=new AbortController();
 const definition=defineApplication({id:'freeze-fixture',version:'1',commands:{},queries:{state:defineQuery({description:'Read retained fixture identity',input:{type:'null'},read:()=>[]})}}),description=describeApplication(definition);
 const revision={applicationId:'a'.repeat(64),historyId:'retained',generation:'c'.repeat(64),point:{generation:'c'.repeat(64),sequence:0,root:'d'.repeat(64)},controlRevision:0,materializationRevision:'0'};
 const session={applicationId:'a'.repeat(64),historyId:'retained',storageId:'retained',deviceId:'b'.repeat(64),signal:stop.signal,revision:null,
  status:{phase:'ready',database:'idle',role:'coordinator',generation:'c'.repeat(64),coordinator:'b'.repeat(64),connectedPeers:0},signals:{delivery:'neighbors'},
  describe:()=>({...description,capabilities:{...PEER_GENERATION_CAPABILITIES,sql:false}}),onStatus(fn){fn(this.status);return()=>{};},onRecovery:()=>()=>{},
  async query(){return{revision,value:['retained identity']};},async close(){stop.abort(Error('FIXTURE_OWNER_CLOSED'));}};
 class Scope extends EventTarget{postMessage(value){deliver(()=>queueMicrotask(()=>pageWorker?.dispatchEvent(new MessageEvent('message',{data:value}))));}close(){}connect(port){this.dispatchEvent(Object.assign(new Event('connect'),{ports:[port]}));}}
 const scope=new Scope();
 function outgoing(port){const post=port.postMessage.bind(port);port.postMessage=(...args)=>{deliver(()=>post(...args));};}
 const values={__freezeClock:clock,__freezeProbe:probe,__freezeWorkerChannel:WorkerChannel,
  navigator:{locks:{async request(_name,options,run){if(held&&options.ifAvailable)return run(null);held++;try{return await run({});}finally{held--;}}}},
  location:new URL('https://fixture.test/'),document:doc,window:globalThis,RTCPeerConnection:class{},
  addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),
  SharedWorker:mode==='shared'?class extends EventTarget{constructor(){super();const wire=new MessageChannel();ports.push(wire.port1,wire.port2);this.port=wire.port2;
    // Gate both root replies and the transferred RPC endpoint before the owner
    // consumes its handshake; otherwise a "silent" root could still answer RPC.
    wire.port1.addEventListener('message',({data})=>{if(data?.port)outgoing(data.port);});outgoing(wire.port1);scope.connect(wire.port1);}}:undefined,
  Worker:class extends EventTarget{constructor(){super();pageWorker=this;}postMessage(data){queueMicrotask(()=>scope.dispatchEvent(new MessageEvent('message',{data})));}terminate(){}},
 };
 for(const[key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{configurable:true,value});
 t.after(async()=>{
  gate.silent=false;gate.hold=false;for(const send of gate.queued.splice(0))send();
  try{
   let done=false;const closing=Promise.allSettled([service?.close(),attachment?.detach()]).then(()=>done=true);
   for(let i=0;!done&&i<100;i++){await delay(2);clock.advance(1000);}await bounded(closing,'cleanup');
  }finally{for(const port of ports)port.close();for(const channel of channels)channel.close();for(const[key,value]of globals)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];await rm(directory,{recursive:true,force:true});}
 });
 await writeFile(join(directory,'page.mjs'),pageBundle.outputFiles[0].text);await writeFile(join(directory,'worker.mjs'),workerBundle.outputFiles[0].text);
 const page=await import(pathToFileURL(join(directory,'page.mjs')).href),worker=await import(pathToFileURL(join(directory,'worker.mjs')).href);
 service=worker.serveBrowserOwner({scope,profileId:'retained',async openSession(){opened++;return{session};}});
 attachment=await bounded(page.openBrowserOwner({workerUrl:'https://fixture.test/worker.mjs',profileId:'retained',applicationId:session.applicationId,definitionId:definition.id,definitionVersion:definition.version,persistStorage:false,storageKeepAliveMs:0,onOwnerReplaced:value=>replaced.push(value)}),'initial attach');
 await until(()=>clock.heartbeats.length>0,'initial heartbeat armed');
 return{attachment,clock,doc,events,probe,gate,replaced,session,get opened(){return opened;},get held(){return held;}};
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
