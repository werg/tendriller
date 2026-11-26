import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createTransportDiagnostics,TRANSPORT_DIAGNOSTIC_LIMIT} from '../../session/transport-diagnostics.mjs';
const id='a'.repeat(64),other='b'.repeat(64);
const row=(overrides={})=>({peerId:id,kind:'direct',sentReliableBytes:10,receivedReliableBytes:8,sentLiveBytes:2,receivedLiveBytes:1,...overrides});
function fixture(read=async()=>[row()]){
 const listeners=new Set();let calls=0;
 const source={status:{phase:'connected',connectedPeers:[id],connectionRevision:0},async diagnostics(){calls++;return read();},onStatus(fn){listeners.add(fn);fn(this.status);return()=>listeners.delete(fn);},reconsiderConnections(){throw Error('MUST_NOT_RECONSIDER');}};
 return{source,get calls(){return calls;},get listeners(){return listeners.size;},change(value){source.status={...source.status,...value};for(const fn of listeners)fn(source.status);}};
}
test('transport observation never reads or probes until explicit refresh, and status invalidation does not poll',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),view=createTransportDiagnostics(f.source);t.after(()=>view.close());
 assert.equal(view.status().authenticatedPeers,1);assert.equal(f.calls,0);t.mock.timers.tick(48*3600_000);assert.equal(f.calls,0);
 const sample=await view.refresh();assert.equal(f.calls,1);assert.equal(sample.sampled,true);assert.equal(sample.connections[0].kind,'direct');assert.equal(sample.connections[0].sentLiveBytes,2);
 f.change({phase:'connecting',connectedPeers:[id]});assert.equal(view.status().sampled,false);assert.equal(f.calls,1);
 t.mock.timers.tick(48*3600_000);assert.equal(f.calls,1);
});
test('only authenticated rows are exposed, with bounded metadata and no identity, addresses or arbitrary errors',async()=>{
 const f=fixture(async()=>[row({kind:'relay',reason:'direct_timeout',token:'SECRET',sdp:'SECRET',address:'SECRET',payload:{secret:'SECRET'}}),row({peerId:other})]);
 const view=createTransportDiagnostics(f.source);const report=await view.refresh();
 assert.equal(report.connections.length,1);assert.equal(report.connections[0].reason,'direct_timeout');assert.equal(report.limited,true);
 const serialized=JSON.stringify(report);for(const privateValue of[id,other,'SECRET','token','sdp','address','payload'])assert.equal(serialized.includes(privateValue),false);
 assert(Object.isFrozen(report));assert(Object.isFrozen(report.connections));assert(Object.isFrozen(report.connections[0]));view.close();assert.equal(f.listeners,0);
});
test('missing or invalid counters remain unavailable rather than becoming invented zeros',async()=>{
 const f=fixture(async()=>[row({kind:'secret-kind',reason:'secret-reason',sentReliableBytes:-1,receivedLiveBytes:Infinity,sentRequests:0})]);
 const view=createTransportDiagnostics(f.source),report=await view.refresh(),link=report.connections[0];
 assert.equal(link.kind,'unknown');assert.equal(link.reason,null);for(const key of['sentBytes','receivedBytes','sentReliableBytes','receivedLiveBytes'])assert.equal(link[key],null);
 assert.equal(link.receivedReliableBytes,8);assert.equal('sentRequests' in link,false);assert.equal('receivedRequests' in link,false);view.close();
});
test('link totals add measured reliable and live framing; a link without a live route counts reliable framing only',async()=>{
 const f=fixture(async()=>[row(),row({connectionId:'no-live',sentLiveBytes:undefined,receivedLiveBytes:undefined,sentBytes:999,receivedBytes:999}),row({connectionId:'huge',sentReliableBytes:Number.MAX_SAFE_INTEGER})]);
 const view=createTransportDiagnostics(f.source),[live,reliable,huge]=(await view.refresh()).connections;
 assert.deepEqual([live.sentBytes,live.receivedBytes],[12,9]);assert.deepEqual([reliable.sentBytes,reliable.receivedBytes,reliable.sentLiveBytes],[10,8,null]);
 assert.equal(huge.sentBytes,Number.MAX_SAFE_INTEGER);view.close();
});
test('agent handles name links only through the supplied local lookup and never expose the key',async()=>{
 const f=fixture(),seen=[];const view=createTransportDiagnostics(f.source,{agentHandle:peerId=>{seen.push(peerId);return'notekeeper';}});
 const report=await view.refresh();assert.equal(report.connections[0].agent,'notekeeper');assert.equal(seen.at(-1),id);assert.equal(JSON.stringify(report).includes(id),false);view.close();
 const plain=createTransportDiagnostics(fixture().source);assert.equal((await plain.refresh()).connections[0].agent,null);plain.close();
 assert.throws(()=>createTransportDiagnostics(f.source,{agentHandle:'notekeeper'}),/agentHandle/);
});
test('a diagnostic sample is capped before iterating an oversized sparse result',async()=>{
 const values=new Array(1_000_000);values[0]=row();const f=fixture(async()=>values),view=createTransportDiagnostics(f.source);
 const report=await view.refresh();assert.equal(report.connections.length,1);assert.equal(report.limited,true);assert(report.connections.length<=TRANSPORT_DIAGNOSTIC_LIMIT);view.close();
});
test('concurrent refreshes coalesce; late replies cannot restore disconnected links',async()=>{
 let resolve;const f=fixture(()=>new Promise(done=>resolve=done)),view=createTransportDiagnostics(f.source);
 const a=view.refresh(),b=view.refresh();assert.equal(a,b);await tick();assert.equal(f.calls,1);
 f.change({phase:'connecting',connectedPeers:[]});resolve([row()]);const report=await a;
 assert.equal(report.sampled,false);assert.equal(report.connections.length,0);assert.equal(report.authenticatedPeers,0);view.close();
});
test('a timed-out physical read stays charged and cannot multiply through repeated refresh clicks',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let resolve,first=true;const f=fixture(()=>first?(first=false,new Promise(done=>resolve=done)):Promise.resolve([row()]));
 const view=createTransportDiagnostics(f.source,{timeoutMs:100}),pending=view.refresh();await tick();t.mock.timers.tick(100);
 assert.equal((await pending).error,'timed_out');await view.refresh();assert.equal(f.calls,1);
 resolve([row()]);await tick();assert.equal(view.status().error,'timed_out');assert.equal(view.status().connections.length,0);
 assert.equal((await view.refresh()).sampled,true);assert.equal(f.calls,2);view.close();
});
test('abort and source closure detach observers, finish pending reads, and fence their late samples',async()=>{
 for(const action of['abort','closed']){
  const stop=new AbortController();let resolve;const f=fixture(()=>new Promise(done=>resolve=done)),view=createTransportDiagnostics(f.source,{signal:stop.signal});
  const pending=view.refresh();await tick();if(action==='abort')stop.abort();else f.change({phase:'closed',connectedPeers:[]});
  assert.equal((await pending).state,'closed');assert.equal(f.listeners,0);resolve([row()]);await tick();assert.equal(view.status().connections.length,0);
 }
});
test('unsupported and failed diagnostics never expose exception text or fake transport evidence',async()=>{
 const unsupported=createTransportDiagnostics({status:{phase:'connected',connectedPeers:[id],connectionRevision:0}});assert.equal((await unsupported.refresh()).state,'unavailable');unsupported.close();
 for(const failure of[Error('SECRET'),null,undefined,0]){const f=fixture(async()=>{throw failure;}),view=createTransportDiagnostics(f.source);const report=await view.refresh();assert.equal(report.error,'read_failed');assert.equal(report.sampled,false);assert.equal(JSON.stringify(report).includes('SECRET'),false);view.close();}
});

test('a connectionRevision change samples a same-peer replacement once and reports the reset current-link counters',async()=>{
 let direct=false;const f=fixture(async()=>[row({kind:direct?'direct':'relay',reason:direct?undefined:'direct_failed',sentReliableBytes:direct?0:1000,sentLiveBytes:0})]);
 f.source.status.connectionRevision=0;const view=createTransportDiagnostics(f.source);await view.refresh();assert.equal(f.calls,1);
 direct=true;f.change({phase:'connected',connectedPeers:[id],connectionRevision:1});await tick();
 assert.equal(f.calls,2);assert.equal(view.status().connectionRevision,1);assert.equal(view.status().connections[0].kind,'direct');assert.equal(view.status().connections[0].sentBytes,0);
 f.change({phase:'connected',connectedPeers:[id],connectionRevision:1});await tick();assert.equal(f.calls,2);view.close();
});
test('revision bursts during an outstanding sample coalesce to one fresh follow-up',async()=>{
 const resolves=[];const f=fixture(()=>new Promise(resolve=>resolves.push(resolve)));f.source.status.connectionRevision=0;
 const view=createTransportDiagnostics(f.source),first=view.refresh();await tick();
 f.change({phase:'connected',connectedPeers:[id],connectionRevision:1});f.change({phase:'connected',connectedPeers:[id],connectionRevision:2});
 assert.equal(f.calls,1);resolves[0]([row({kind:'relay'})]);await first;await tick();assert.equal(f.calls,2);
 resolves[1]([row({kind:'direct'})]);await tick();assert.equal(view.status().connections[0].kind,'direct');assert.equal(view.status().connectionRevision,2);view.close();
});
test('asynchronous diagnostic observers cannot reject or delay local sampling',async()=>{
 const f=fixture(),view=createTransportDiagnostics(f.source);view.onChange(async()=>{throw Error('OBSERVER_FAILURE');});
 assert.equal((await view.refresh()).sampled,true);await tick();view.close();
});

for(const kind of ['capped','filtered'])test(`${kind} sample limitation survives duplicate status until a complete replacement sample`,async()=>{
 let values=kind==='capped'?new Array(TRANSPORT_DIAGNOSTIC_LIMIT+1).fill(row()):[row(),row({peerId:other})];
 const f=fixture(async()=>values),view=createTransportDiagnostics(f.source),reports=[];view.onChange(value=>reports.push(value));
 const sample=await view.refresh();assert.equal(sample.limited,true);assert.equal(sample.sampled,true);const notices=reports.length;
 f.change({...f.source.status});assert.deepEqual(view.status(),sample);assert.equal(reports.length,notices);assert.equal(f.calls,1);
 values=[row()];const complete=await view.refresh();assert.equal(complete.limited,false);assert.equal(complete.sampled,true);assert.equal(f.calls,2);view.close();
});

test('refresh after a public timeout returns current status while the unresolved physical read stays charged',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let resolve;
 const f=fixture(()=>new Promise(done=>resolve=done)),view=createTransportDiagnostics(f.source,{timeoutMs:100});
 const pending=view.refresh();assert.equal(view.refresh(),pending);await tick();t.mock.timers.tick(100);
 const timedOut=await pending;assert.equal(timedOut.phase,'connected');assert.equal(timedOut.authenticatedPeers,1);
 f.change({phase:'connecting',connectedPeers:[]});const again=view.refresh();assert.notEqual(again,pending);
 assert.deepEqual(await again,view.status());assert.equal((await again).phase,'connecting');assert.equal((await again).authenticatedPeers,0);assert.equal(f.calls,1);
 resolve([row()]);await tick();assert.equal(view.status().connections.length,0);view.close();
});
test('connection revisions after timeout retain one follow-up without overlapping the charged physical read',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const resolves=[];
 const f=fixture(()=>new Promise(done=>resolves.push(done))),view=createTransportDiagnostics(f.source,{timeoutMs:100});
 const first=view.refresh();await tick();t.mock.timers.tick(100);await first;
 f.change({connectionRevision:1});f.change({connectionRevision:2});await view.refresh();assert.equal(f.calls,1);
 resolves[0]([row({kind:'relay'})]);await tick();assert.equal(f.calls,2);
 resolves[1]([row({kind:'direct'})]);await tick();assert.equal(view.status().connections[0].kind,'direct');assert.equal(view.status().connectionRevision,2);view.close();
});
test('status and sample limitations remain independent',async()=>{
 const f=fixture(async()=>[row()]);f.source.status.connectedPeers=[id,...Array.from({length:64},(_,i)=>(i+1).toString(16).padStart(64,'0'))];
 const view=createTransportDiagnostics(f.source);assert.equal((await view.refresh()).limited,true);
 f.change({connectedPeers:f.source.status.connectedPeers.slice(0,64)});assert.equal(view.status().limited,false);assert.equal(f.calls,1);view.close();
});

test('the current session DTO preserves physical links to one signer and labels only measured reliable protocol bytes',async()=>{
 const source={status:{phase:'ready',connectedPeers:2,connectionRevision:2},async diagnostics(){return[
  {connectionId:'physical-a',peerId:id,kind:'unknown',sentReliableBytes:4,receivedReliableBytes:9},
  {connectionId:'physical-b',peerId:id,kind:'unknown',sentReliableBytes:7,receivedReliableBytes:2},
 ];}};
 const inspector=createTransportDiagnostics(source);
 try{const report=await inspector.refresh();assert.equal(report.phase,'connected');assert.equal(report.authenticatedPeers,1);assert.equal(report.connections.length,2);assert.equal(report.limited,false);
  assert.deepEqual(report.connections.map(row=>row.sentReliableBytes),[4,7]);
  assert.deepEqual(report.connections.map(row=>row.sentBytes),[4,7]);
  for(const row of report.connections){assert.equal(row.kind,'unknown');assert.equal(row.sentLiveBytes,null);assert.equal(row.receivedLiveBytes,null);}
  assert.doesNotMatch(JSON.stringify(report),/physical-a|physical-b/);
 }finally{inspector.close();}
});

test('signal rejection diagnostics retain only fixed bounded counters and distinguish old sources', async () => {
 const secret = 'SECRET_REJECTED_FRAME';
 const f = fixture(async () => [row({ signalRejections: { total: 7, clockSkew: 2, expired: 1,
  unauthorized: 1, duplicate: 1, capacity: 2, payload: secret, peer: id, reasons: { [secret]: 3 } } })]);
 const view = createTransportDiagnostics(f.source), sample = await view.refresh();
 assert.deepEqual(sample.connections[0].signalRejections, { total: 7, clockSkew: 2, expired: 1, unauthorized: 1, duplicate: 1, capacity: 2 });
 assert(Object.isFrozen(sample.connections[0].signalRejections));
 assert.equal(JSON.stringify(sample).includes(secret), false);
 assert.equal(JSON.stringify(sample).includes(id), false);
 view.close();
 const old = createTransportDiagnostics(fixture().source);
 assert.equal((await old.refresh()).connections[0].signalRejections, null);
 old.close();
 const invalid = createTransportDiagnostics(fixture(async () => [row({signalRejections: {
  total: Number.MAX_SAFE_INTEGER, clockSkew: -1, expired: NaN, unauthorized: Infinity, duplicate: 0, capacity: Number.MAX_SAFE_INTEGER + 1,
 }})]).source);
 assert.deepEqual((await invalid.refresh()).connections[0].signalRejections,
  {total:Number.MAX_SAFE_INTEGER, clockSkew:null, expired:null, unauthorized:null, duplicate:0, capacity:null});
 invalid.close();
});
