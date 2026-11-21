import {defineApplication,describeApplication,PEER_GENERATION_CAPABILITIES} from '@chronolog/peer-session';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBrowserRtcBroker, rtcEndpoint, BROWSER_RTC_PROTOCOL, checkRtcMessage, MAX_RTC_MESSAGE_BYTES } from '../browser-rtc.mjs';
const register = endpoint => endpoint.dispatchEvent(new MessageEvent('message',{data:{protocol:BROWSER_RTC_PROTOCOL,type:'register'}}));
const until = async predicate => { const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw Error('TEST_DEADLINE');await new Promise(setImmediate);} };

test('one bounded pending direct attempt waits for registration without polling or selecting relay',async()=>{
 const calls=[],broker=createBrowserRtcBroker({openConnection:async(endpoint,options)=>{calls.push({endpoint,options});return{close:async()=>{}};}});
 const pending=broker.openDirectConnection({timeoutMs:1000});assert.equal(calls.length,0);
 const endpoint=rtcEndpoint(()=>{});broker.addRoute(endpoint,{authorize:()=>true});register(endpoint);
 const connection=await pending;assert.equal(calls.length,1);assert.equal(calls[0].endpoint,endpoint);assert(calls[0].options.timeoutMs<=1000);await connection.close();broker.close();
});

test('unauthorized registration cannot satisfy a wait; close immediately fences pending work',async()=>{
 const broker=createBrowserRtcBroker({openConnection:async()=>{throw Error('MUST_NOT_OPEN');}}),endpoint=rtcEndpoint(()=>{});
 broker.addRoute(endpoint,{authorize:()=>false});register(endpoint);
 await assert.rejects(broker.openDirectConnection({timeoutMs:20}),{code:'RTC_PROVIDER_TIMEOUT'});
 const pending=broker.openDirectConnection({timeoutMs:1000});broker.close();await assert.rejects(pending,{code:'RTC_BROKER_CLOSED'});
});

test('provider loss aborts its connections; a subsequent controller attempt selects the surviving page',async()=>{
 const calls=[],broker=createBrowserRtcBroker({openConnection:async(endpoint,options)=>{calls.push({endpoint,options});return{kind:'direct',close:async()=>{}};}});
 const a=rtcEndpoint(()=>{}),b=rtcEndpoint(()=>{}),removeA=broker.addRoute(a,{authorize:()=>true});broker.addRoute(b,{authorize:()=>true});register(a);register(b);
 const first=await broker.openDirectConnection({timeoutMs:1000});assert.equal(calls[0].endpoint,a);removeA();assert(calls[0].options.signal.aborted);assert.equal(calls.length,1,'broker owns no retry loop');
 const second=await broker.openDirectConnection({timeoutMs:1000});assert.equal(calls[1].endpoint,b);await first.close();await second.close();broker.close();
});

test('opaque binary RTC messages have their own finite bound and reject transfers/cycles',()=>{
 checkRtcMessage({protocol:'opaque-kernel',packet:new Uint8Array(2*1024*1024)});
 checkRtcMessage({packet:new ArrayBuffer(1024)});
 assert.throws(()=>checkRtcMessage({packet:new Uint8Array(MAX_RTC_MESSAGE_BYTES+1)}),/RTC_MESSAGE_LIMIT/);
 const cycle={};cycle.self=cycle;assert.throws(()=>checkRtcMessage(cycle),/RTC_MESSAGE_INVALID/);
 const pair=new MessageChannel();try{assert.throws(()=>checkRtcMessage({port:pair.port1}),/RTC_MESSAGE_INVALID/);}finally{pair.port1.close();pair.port2.close();}
});

// Only substitute the public Chronolog RTC mechanics. The core default browser
// entry, private bootstrap roots and actual owner RPC attachment remain real.
const compiled=await build({stdin:{contents:"export {openBrowserOwner} from './collaboration/browser.mjs';export {serveBrowserOwner} from './collaboration/worker.mjs';",resolveDir:new URL('../..',import.meta.url).pathname,loader:'js'},bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'rtc-fixture',setup(build){build.onLoad({filter:/\/peer-session\/webrtc\.mjs$/},()=>({contents:`
 export function serveWorkerWebRtcConnections(endpoint,{signal}={}){
  const receive=({data})=>{if(data?.protocol==='test/rtc'&&data.type==='open')endpoint.postMessage({protocol:'test/rtc',type:'ready',id:data.id});};
  endpoint.addEventListener('message',receive);return{async close(){endpoint.removeEventListener('message',receive);}};
 }
 export function openWorkerWebRtcConnection(endpoint,options){return new Promise((resolve,reject)=>{
  const id=crypto.randomUUID(),abort=()=>{endpoint.removeEventListener('message',receive);reject(options.signal.reason);};
  const receive=({data})=>{if(data?.protocol!=='test/rtc'||data.id!==id)return;endpoint.removeEventListener('message',receive);options.signal.removeEventListener('abort',abort);resolve({kind:'direct',close:async()=>{}});};
  endpoint.addEventListener('message',receive);options.signal.addEventListener('abort',abort,{once:true});endpoint.postMessage({protocol:'test/rtc',type:'open',id});
 });}
`,loader:'js'}));}}]});

for(const mode of ['shared','elected'])test(`default ${mode} bootstrap makes the FIRST link direct even when openSession awaits that link before RPC readiness`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'core-rtc-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=join(directory,'core.mjs');await writeFile(file,compiled.outputFiles[0].text);const core=await import(pathToFileURL(file).href);
 const globals=new Map(['navigator','location','SharedWorker','Worker','RTCPeerConnection'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));t.after(()=>{for(const[key,value]of globals)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
 class Scope extends EventTarget{postMessage(){}close(){}connect(port){this.dispatchEvent(Object.assign(new Event('connect'),{ports:[port]}));}}
 const scope=new Scope(),stop=new AbortController(),links=[],description=describeApplication(defineApplication({id:'rtc-fixture',version:'1',commands:{},queries:{}}));let shared=0,dedicated=0,localWorker;
 const session={applicationId:'a'.repeat(64),historyId:'retained',storageId:'retained',deviceId:'b'.repeat(64),signal:stop.signal,revision:null,status:{phase:'ready',database:'idle',role:'coordinator',generation:'c'.repeat(64),coordinator:'b'.repeat(64),connectedPeers:0},signals:{delivery:'neighbors'},describe:()=>({...description,capabilities:{...PEER_GENERATION_CAPABILITIES,sql:false}}),onStatus(listener){listener(this.status);return()=>{};},onRecovery:()=>()=>{},async close(){stop.abort(Error('SESSION_CLOSED'));}};
 const setup={navigator:{locks:{request:async(_name,_options,run)=>run({})}},location:{origin:'https://app.test',href:'https://app.test/'},RTCPeerConnection:class{},SharedWorker:mode==='shared'?class extends EventTarget{constructor(){super();shared++;const wire=new MessageChannel();this.port=wire.port2;scope.connect(wire.port1);}}:undefined,Worker:class extends EventTarget{constructor(){super();dedicated++;localWorker=this;}postMessage(data){queueMicrotask(()=>scope.dispatchEvent(new MessageEvent('message',{data})));}terminate(){}}};for(const[key,value]of Object.entries(setup))Object.defineProperty(globalThis,key,{configurable:true,value});
 scope.postMessage=data=>queueMicrotask(()=>localWorker?.dispatchEvent(new MessageEvent('message',{data})));
 const service=core.serveBrowserOwner({scope,profileId:'retained',async openSession({signal,openDirectConnection}){try{links.push(await openDirectConnection({signal,role:'offerer',signaling:{},timeoutMs:500}));}catch{links.push({kind:'relay'});}return{session};}});
 t.after(()=>service.close());let attachment;
 try{attachment=await core.openBrowserOwner({workerUrl:'https://app.test/worker.mjs',profileId:'retained',applicationId:session.applicationId,definitionId:description.id,definitionVersion:'1',timeoutMs:2000,persistStorage:false,storageKeepAliveMs:0});assert.equal(attachment.mode,mode);assert.equal(shared,mode==='shared'?1:0);assert.equal(dedicated,mode==='elected'?1:0);assert.equal(links[0].kind,'direct','relay at startup must not become a permanent fallback');}finally{await attachment?.detach();await service.close();}
});

test('authenticated BC attach registers RTC before RPC, carries full opaque packets, and rejects public sideband forgery',async t=>{
 const {createBroadcastOwner,createBroadcastEndpoint,checkOwnerFrame,BROWSER_OWNER_PROTOCOL}=await import('../browser-transport.mjs');
 const name='rtc:'+crypto.randomUUID(),server=new BroadcastChannel(name),client=new BroadcastChannel(name),outsider=new BroadcastChannel(name),profileId='profile',order=[],received=[],rpc=[],ports=[];let ownerRtc;
 const owner={ownerInstanceId:crypto.randomUUID(),attach(endpoint){const receive=({data})=>{order.push('rpc');ports.push(data.port);data.port.onmessage=({data})=>rpc.push(data);data.port.start();data.port.postMessage({ready:true});};endpoint.addEventListener('message',receive);return()=>endpoint.removeEventListener('message',receive);}};
 const bridge=await createBroadcastOwner(server,owner,{profileId,idleTimeoutMs:5000,onRtcEndpoint(endpoint){ownerRtc=endpoint;endpoint.addEventListener('message',({data})=>{if(data.protocol===BROWSER_RTC_PROTOCOL){order.push('rtc');return;}received.push(data);endpoint.postMessage(data);});}});
 t.after(async()=>{await transport?.close();await bridge.close();for(const p of ports)p.close();server.close();client.close();outsider.close();});
 let transport;const announced=new Promise(resolve=>client.addEventListener('message',({data})=>{if(data.type==='ready')resolve(data);},{once:true}));bridge.announce();const announcement=await announced;
 transport=createBroadcastEndpoint(client,announcement,{profileId,livenessTimeoutMs:3000});
 transport.rtc.postMessage({protocol:BROWSER_RTC_PROTOCOL,type:'register'});
 const wire=new MessageChannel();ports.push(wire.port1,wire.port2);const frames=[];wire.port2.onmessage=({data})=>frames.push(data);wire.port2.start();
 transport.postMessage({protocol:'fixture/rpc',handshake:{},port:wire.port1});await until(()=>frames.length>0);assert.deepEqual(order.slice(0,2),['rtc','rpc']);
 const replies=[];transport.rtc.addEventListener('message',({data})=>replies.push(data));const packet=new Uint8Array(2*1024*1024);packet[0]=11;packet[packet.length-1]=23;
 assert.throws(()=>checkOwnerFrame({packet}),/OWNER_MESSAGE_LIMIT/);
 transport.rtc.postMessage({protocol:'opaque-kernel-test',packet});await until(()=>replies.length===1);assert.deepEqual(replies[0].packet,packet);assert.equal(received.length,1);assert.equal(rpc.length,0,'RTC payloads never enter the RPC port');
 for(let i=0;i<3;i++)transport.rtc.postMessage({protocol:'opaque-kernel-test',packet:new Uint8Array(1114112)});await until(()=>replies.length===4);assert.equal(received.length,4);
 outsider.postMessage({protocol:BROWSER_OWNER_PROTOCOL,type:'rtc',ownerInstanceId:owner.ownerInstanceId,payload:{protocol:'forged'}});
 outsider.postMessage({protocol:BROWSER_RTC_PROTOCOL,type:'register'});await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(received.length,4);assert.equal(order.filter(x=>x==='rtc').length,1);
 let closed=false;ownerRtc.addEventListener('close',()=>closed=true);await transport.close();await until(()=>closed);assert.equal(bridge.routes,0);
});
