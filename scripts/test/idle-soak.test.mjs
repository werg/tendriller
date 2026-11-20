import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { HOUR, validateConfig, newState, beginSegment, endSegment, record, boundedActive, report, save, privateJSON } from '../idle-soak/state.mjs';
import { planQueries, measure, graphql } from '../idle-soak/cloudflare.mjs';
import { startBrowser } from '../idle-soak/browser.mjs';
import { waitUntil } from '../idle-soak/run.mjs';
import { watchApplicationSetup } from '../../contract/setup-watch.mjs';

const config = { hours:48, isolated:true, account:'a'.repeat(32), worker:'isolated-soak', namespaces:['b'.repeat(32)], pageUrl:'https://isolated.example/t/test', provenance:{sourceCommit:'c'.repeat(40),compositionId:'d'.repeat(64)},native:{argv:['/node','/private/start.mjs'],cwd:'/private'},browserProfile:'/private/profile',adapter:'/private/adapter.mjs',wrangler:'/node_modules/wrangler/bin/wrangler.js' };
const flush = () => new Promise(resolve => setImmediate(resolve));
test('24/48h scope validation rejects shared namespaces, invented hours and credential URLs', () => {
  assert.equal(validateConfig(config),config);
  assert.equal(validateConfig({...config,hours:24}).hours,24);
  for(const change of [{hours:1},{isolated:false},{namespaces:[]},{pageUrl:'https://secret@example.test/'},{pageUrl:'https://example.test/?token=secret'},{native:{}}]) assert.throws(()=>validateConfig({...config,...change}));
});
test('48h virtual time proves timers only, never real duration or provider billing', async t => {
  t.mock.timers.enable({ apis:['Date','setTimeout'],now:1000 });
  const s=newState(config);beginSegment(s,'closed');const initial={...s.counts};
  const waiting=waitUntil(s.segments[0].deadline);t.mock.timers.tick(16*HOUR);await waiting;endSegment(s);
  assert.deepEqual(s.counts,initial);assert.equal(s.segments[0].observedMs,16*HOUR);
  assert.equal(report(s).realWallClockComplete,false);assert.equal(report(s).status,'incomplete-or-over-budget');assert.equal(report(s).metricsComplete,false);
});
test('quiet healthy setup watch uses no requests or heartbeat for 48 virtual hours',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  let opens=0,requests=0,changes=0,sends=0; const ws=new EventTarget();
  ws.send=()=>sends++;ws.close=()=>ws.dispatchEvent(Object.assign(new Event('close'),{code:1000}));
  const watcher=watchApplicationSetup({api:'https://isolated.example/api/t/aaaaaaaaaaaa',token:'tk_'+'a'.repeat(32),onChange:()=>changes++,fetcher:()=>{requests++;throw Error();},openSocket:()=>{opens++;return ws;}});
  ws.dispatchEvent(new Event('open'));t.mock.timers.tick(48*HOUR);await flush();
  assert.deepEqual({opens,requests,changes,sends},{opens:1,requests:0,changes:0,sends:0});await watcher.close();
});
test('revoked watch expires active recovery after one read without idle retries',async()=>{
  let requests=0,opens=0;const watcher=watchApplicationSetup({api:'https://isolated.example/api/t/aaaaaaaaaaaa',token:'tk_'+'a'.repeat(32),onChange(){},openSocket(){opens++;throw Error();},fetcher:async()=>{requests++;return new Response(null,{status:403});}});
  await watcher.closed;assert.equal(opens,1);assert.equal(requests,1);
});
test('active retry has attempt and wall deadline bounds',async()=>{
  let now=0,calls=0;await assert.rejects(boundedActive(async()=>{calls++;throw Error('private');},{attempts:3,expiresAt:5000,now:()=>now,wait:async ms=>{now+=ms;}}),/ACTIVE_RETRY_EXPIRED/);assert.equal(calls,3);
  calls=0;now=0;await assert.rejects(boundedActive(async()=>{calls++;throw Error();},{attempts:10,expiresAt:500,now:()=>now,wait:async ms=>{now+=ms;}}));assert.equal(calls,1);
});
test('active cancellation aborts a hung operation and no retry remains',async()=>{
  const stop=new AbortController();let calls=0;
  const result=boundedActive(()=>{calls++;return new Promise(()=>{});},{signal:stop.signal});await flush();stop.abort();await assert.rejects(result);assert.equal(calls,1);
});
test('unobserved model/wakeup counts are null and arbitrary credential events rejected',()=>{
  const s=newState(config);assert.equal(record(s,{source:'native',kind:'token',count:1}),false);
  assert.equal(record(s,{source:'native',kind:'requests',count:-1}),false);
  record(s,{source:'native',kind:'requests',count:1,token:'SUPERSECRET'});
  const r=report(s);assert.equal(r.counts.modelTurns,null);assert.equal(r.counts.wakeups,null);assert(!JSON.stringify(r).includes('SUPERSECRET'));
});
test('every unsolicited idle request/frame/model dispatch is an explicit zero-budget overrun',()=>{
  const s=newState(config);beginSegment(s,'foreground',1000);record(s,{source:'native',kind:'framesSent'});record(s,{source:'adapter',kind:'modelTurns'});endSegment(s,1000+16*HOUR);
  assert.deepEqual(s.segments[0].overruns.map(x=>x.counter),['framesSent','modelTurns']);assert.equal(report(s).status,'incomplete-or-over-budget');
});
test('private checkpoint roundtrips atomically and rejects world-readable credentials',()=>{
  const dir=mkdtempSync(join(tmpdir(),'soak-unit-'));try{const file=join(dir,'state.json');save(file,{count:1});save(file,{count:2});assert.equal(statSync(file).mode&0o777,0o600);assert.equal(privateJSON(file).count,2);const unsafe=join(dir,'unsafe');writeFileSync(unsafe,'{}',{mode:0o644});assert.throws(()=>privateJSON(unsafe));}finally{rmSync(dir,{recursive:true,force:true});}
});
function schema() {
  const input={name:'Filters',inputFields:['scriptName','namespaceId','datetime_geq','datetime_lt'].map(name=>({name}))};
  const types=[input, {name:'AccountSettings',fields:['workersInvocationsAdaptive','durableObjectsInvocationsAdaptiveGroups','durableObjectsPeriodicGroups','durableObjectsStorageGroups'].map(name=>({name,type:{name:'Settings'},args:[]}))}];
  for(const name of ['workersInvocationsAdaptive','durableObjectsInvocationsAdaptiveGroups','durableObjectsPeriodicGroups','durableObjectsStorageGroups']) {
    types.push({name:name+'Root',fields:[{name,type:{name:name+'Group'},args:[{name:'filter',type:{name:'Filters'}}]}]},
      {name:name+'Group',fields:[{name:'sum',type:{name:'Sums'}},{name:'max',type:{name:'Max'}}]});
  }
  types.push({name:'Sums',fields:['requests','errors','cpuTimeUs','duration','wallTime','activeTime','cpuTime','inboundWebsocketMsgCount','outboundWebsocketMsgCount','rowsRead','rowsWritten','storageReadUnits','storageWriteUnits','storageDeletes'].map(name=>({name,description:name==='duration'?'GB*s':'provider unit'}))},{name:'Max',fields:[{name:'storedBytes',description:'bytes'}]});return {status:'available',types,schemaHash:'schema'};
}
test('queries scope every dataset and use exclusive UTC end; no account-wide fallback',()=>{
  const plans=planQueries(schema().types,config,0,HOUR);assert.equal(plans.length,4);
  for(const p of plans){assert(p.query.includes('datetime_lt:'));assert(p.query.includes(config.account));assert(p.query.includes(p.scope==='worker'?config.worker:config.namespaces[0]));assert(!p.query.includes('mutation'));}
  const unsupported=planQueries([],config,0,HOUR);assert(unsupported.every(p=>p.reason==='SCHEMA_UNSUPPORTED'&&!p.query));
});
test('storage list filter follows actual schema namespaceIds_has',()=>{
  const s=schema();s.types.find(x=>x.name==='Filters').inputFields=s.types.find(x=>x.name==='Filters').inputFields.map(x=>x.name==='namespaceId'?{name:'namespaceIds_has'}:x);
  assert(planQueries(s.types,config,0,HOUR).filter(p=>p.scope!=='worker').every(p=>p.query.includes('namespaceIds_has:')));
});
test('API denial retains status/code but never echoed auth or raw messages',async()=>{
  const r=await graphql({Authorization:'Bearer SECRET'},'PRIVATE QUERY',async()=>new Response(JSON.stringify({errors:[{message:'SECRET PRIVATE QUERY',extensions:{code:10000}}]}),{status:403}));
  assert.equal(r.status,'unavailable');assert.equal(r.httpStatus,403);assert.deepEqual(r.codes,[10000]);assert(!JSON.stringify(r).includes('SECRET'));
});
test('missing rows and denied metrics are unavailable, never zero',async()=>{
  const r=await measure(config,0,HOUR,{headers:{},schema:schema(),fetcher:async()=>new Response(JSON.stringify({data:{viewer:{accounts:[{}]}}}))});
  assert.equal(r.length,4);assert(r.every(x=>x.status==='unavailable'&&x.reason==='NO_DATA_OR_INGESTION_DELAY'&&!x.values));
});
test('real provider numbers retain units, expose overrun and chunk windows hourly',async()=>{
  let reads=0;const r=await measure(config,0,2*HOUR,{headers:{},schema:schema(),fetcher:async(_url,init)=>{
    reads++;const query=JSON.parse(init.body).query;const dataset=['workersInvocationsAdaptive','durableObjectsInvocationsAdaptiveGroups','durableObjectsPeriodicGroups','durableObjectsStorageGroups'].find(x=>query.includes(x+'('));
    return new Response(JSON.stringify({data:{viewer:{accounts:[{[dataset]:[{sum:Object.fromEntries(schema().types.find(x=>x.name==='Sums').fields.map(x=>[x.name,x.name==='duration'?2:0])),max:{storedBytes:42}}]}]}}}));
  }});
  assert.equal(reads,8);assert.equal(r[0].values['sum.duration'],2);assert.equal(r[0].fields.find(x=>x.name==='duration').description,'GB*s');assert(r[0].overruns.some(x=>x.counter==='sum.duration'));assert.equal(r[3].values['max.storedBytes'],42);
});
test('residency changes are observed; reconnect requires adapter proof and records elapsed wall time',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'soak-browser-'));let visibility='visible',offline=[],proofs=0;const created=[];
  class Page extends EventEmitter{async close(){} async goto(){} async bringToFront(){visibility=this.cover?'hidden':'visible';}async waitForFunction(_fn,value){assert.equal(visibility,value);}async evaluate(){return visibility;}}
  const ctx=new EventEmitter();ctx.pages=()=>[];ctx.newPage=async()=>{const p=new Page();p.cover=created.length===0;created.push(p);ctx.emit('page',p);return p;};ctx.setOffline=async value=>offline.push(value);ctx.close=async()=>{};
  const adapter=join(dir,'adapter.mjs');writeFileSync(adapter,`export const settled=[]; export async function ready(){}; export async function settle({page}){const state=await page.evaluate(()=>document.visibilityState);settled.push(state);if(state!=='visible')throw Error('hidden interaction');} export async function reconnect(){return true;}`);
  try{const browser=await startBrowser({...config,adapter},()=>{}, {chromium:{},launchContext:async()=>({context:ctx,close:async()=>{}})});assert.deepEqual(await browser.phase('closed'),{observed:'closed'});assert.deepEqual(await browser.phase('background'),{observed:'hidden'});await browser.settle();assert.deepEqual(browser.adapter.settled,['visible']);assert.deepEqual(await browser.phase('foreground'),{observed:'visible'});await browser.settle();assert.deepEqual(browser.adapter.settled,['visible','visible']);const reconnect=await browser.reconnect();assert.equal(reconnect.verified,true);assert(reconnect.elapsedMs>=0);assert.deepEqual(offline,[true,false]);await browser.close();}finally{rmSync(dir,{recursive:true,force:true});}
});

test('native observer bounds fetch, emits numeric counters only and does not extend participant lifetime', async () => {
  const observer = new URL('../idle-soak/native-observer.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    globalThis.fetch=async (_input,init)=>{assert(init.signal);return new Response('PRIVATE_APP_DATA');};
    globalThis.WebSocket=class extends EventTarget{send(){} close(){this.dispatchEvent(new Event('close'));}};
    await import(${JSON.stringify(observer)});
    await fetch('https://invalid.example/api/t/PRIVATE_HANDLE/peers/participant?token=PRIVATE_TOKEN',{headers:{Authorization:'Bearer PRIVATE_TOKEN'}});
    const ws=new WebSocket('wss://invalid.example/api/t/PRIVATE_HANDLE/peers/discovery/watch?peerId=PRIVATE_ID', ['PRIVATE_TOKEN']);
    ws.dispatchEvent(new Event('open'));ws.send('PRIVATE_APP_DATA');
    ws.dispatchEvent(Object.assign(new Event('message'),{data:'PRIVATE_APP_DATA'}));ws.close();
    globalThis[Symbol.for('tendriller.idle-soak.record')]('wakeups',1,'PRIVATE_LABEL');
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe','ipc']});
  const messages=[];let diagnostics='';child.on('message',v=>messages.push(v));child.stderr.on('data',v=>diagnostics+=v);
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('OBSERVER_KEPT_CHILD_ALIVE'));},5000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
  assert.equal(result,0,diagnostics);assert(messages.some(x=>x.kind==='requests'));assert(messages.some(x=>x.kind==='framesReceived'));assert(messages.some(x=>x.kind==='wakeups'));
  assert(!JSON.stringify(messages).includes('PRIVATE_'));assert(messages.every(x=>Object.keys(x).sort().join(',')===(x.idleSoakActivity===1?'idleSoakActivity,pending,source':'category,count,idleSoak,kind,source')));
  assert.equal(messages.find(x=>x.kind==='requests').category,'control');
  for(const kind of ['socketsOpened','socketsClosed','framesSent','framesReceived','bytesSent','bytesReceived'])
    assert.equal(messages.find(x=>x.kind===kind).category,'discovery-watch');
  assert.equal(messages.find(x=>x.kind==='wakeups').category,'other');
  assert.deepEqual(messages.filter(x=>x.idleSoakActivity===1).map(x=>x.pending),[1,0]);
});

test('worker completion keeps all request counts and clears only the exact proven script before hiding',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'soak-worker-correlation-')),events=[],order=[],created=[];let complete,visibility='visible';
 class Page extends EventEmitter {async goto(){} async close(){} async bringToFront(){visibility=this.cover?'hidden':'visible';order.push(visibility);}async waitForFunction(_f,wanted){assert.equal(visibility,wanted);}async evaluate(){return visibility;}}
 const ctx=new EventEmitter();ctx.pages=()=>[];ctx.newPage=async()=>{const p=new Page();p.cover=!created.length;created.push(p);ctx.emit('page',p);return p;};
 const script={url:()=> 'https://fixture.invalid/worker.mjs',resourceType:()=> 'script'},other={url:()=> 'https://fixture.invalid/data',resourceType:()=> 'fetch'};
 ctx.load=()=>{ctx.emit('request',script);ctx.emit('request',other);ctx.emit('requestfinished',script);complete(script.url());assert.equal(events.at(-1).pending,1);ctx.emit('requestfinished',other);};
 const adapter=join(dir,'adapter.mjs');writeFileSync(adapter,'export async function ready({context}){context.load();} export async function reconnect(){return true;}');
 try{
 const browser=await startBrowser({...config,adapter},e=>events.push(e),{chromium:{},launchContext:async()=>({context:ctx,endpoint:'ws://fixture',close:async()=>{}}),observeBootstraps:async(_endpoint,done)=>{complete=done;return{finish:async()=>order.push('worker-proof'),close:async()=>order.push('detached')};}});
 assert.deepEqual(await browser.phase('background'),{observed:'hidden'});assert.equal(events.filter(e=>e.kind==='requests').length,2);assert.equal(events.filter(e=>e.kind==='activity').at(-1).pending,0);
 assert(order.indexOf('worker-proof')<order.lastIndexOf('hidden'));assert(order.indexOf('detached')<order.lastIndexOf('hidden'));assert.equal(browser.workerBootstrapEvidence().completedLoads,1);
 const later={url:script.url,resourceType:script.resourceType};ctx.emit('request',later);assert.equal(events.at(-2).pending,1);assert.equal(events.filter(e=>e.kind==='requests').length,3);ctx.emit('requestfinished',later);await browser.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
