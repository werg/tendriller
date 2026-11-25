import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerDiscoveryWatcher, createPeersClient, PEER_DISCOVERY_PROTOCOL,
  validatePeerDiscoveryNotification } from '../peers.mjs';
import { createAgentClient } from '../client.mjs';
import { fakeHub, TOKEN, PAGE } from './support/fake-hub.mjs';
const peerId = 'ab'.repeat(32);
const flush = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventTarget {
  readyState = 1; sent = []; closes = [];
  send(value) { this.sent.push(value); }
  close(code, reason) { this.readyState = 3; this.closes.push({code,reason}); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', {data:JSON.stringify(value)})); }
  end(code = 1006) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), {code})); }
}
function fixture(options = {}, factory) {
  const sockets = [];
  const watch = createPeerDiscoveryWatcher(() => { const socket = factory?.() ?? new Socket(); sockets.push(socket); return socket; }, options);
  return {watch,sockets};
}

test('watch uses the agent hub or the page proxy cookie path; construction of the client is inert', async () => {
  const opened = [], original = globalThis.WebSocket, hub = fakeHub();
  globalThis.WebSocket = class extends Socket {constructor(url, protocols) {super(); opened.push({url,protocols,socket:this});}};
  try {
    const native = createAgentClient({service:'https://service.test',token:TOKEN}, {WebSocket:hub.WebSocket}).page(PAGE);
    assert.equal(hub.connections.length, 0);
    const watch = native.peers.watchDiscovery(peerId);
    hub.last.accept();
    assert.deepEqual(hub.last.frames('open'), [{t:'open',s:1,page:PAGE,path:`peers/discovery/watch?peerId=${peerId}`,protocols:[PEER_DISCOVERY_PROTOCOL]}]);
    hub.last.push({t:'opened',s:1,protocol:PEER_DISCOVERY_PROTOCOL});
    hub.last.push({t:'data',s:1,text:JSON.stringify({type:'ready'})}); await watch.ready; watch.close();
    const page = createPeersClient({base:'https://page.test/s/code/_tendril',request:()=>{throw Error('No polling');}});
    const pageWatch = page.watchDiscovery(peerId);
    assert.equal(opened[0].url, `wss://page.test/s/code/_tendril/peers/discovery/watch?peerId=${peerId}`);
    assert.deepEqual(opened[0].protocols,[PEER_DISCOVERY_PROTOCOL]); pageWatch.close();
    for (const base of ['http://remote.test/api','https://u:p@service.test/api','https://service.test/api?q=secret','https://service.test/api#fragment']) {
      const peers = createPeersClient({base,request:()=>{}});
      assert.throws(()=>peers.watchDiscovery(peerId),{code:'invalid_discovery_watch'});
    }
    assert.throws(()=>page.watchDiscovery('alias'),{code:'invalid_discovery_watch'});
    assert.throws(()=>page.watchDiscovery(peerId,{retryMs:0}),{code:'invalid_discovery_watch'});
    assert.equal(opened.length,1);
  } finally {globalThis.WebSocket = original;}
});

test('only the first server ready frame establishes readiness; healthy idle has no traffic or timers', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f = fixture(), reader = f.watch.notifications[Symbol.asyncIterator](); let ready = false;
  f.watch.ready.then(()=>{ready=true;});
  f.sockets[0].dispatchEvent(new Event('open')); await flush(); assert.equal(ready,false);
  f.sockets[0].receive({type:'ready'});
  assert.deepEqual(await reader.next(),{value:{type:'ready'},done:false}); await f.watch.ready;
  for(let i=0;i<100;i++) f.sockets[0].receive({type:'changed'});
  assert.deepEqual(await reader.next(),{value:{type:'changed'},done:false});
  const pending = reader.next(); t.mock.timers.tick(172800000); await flush();
  assert.equal(f.sockets.length,1); assert.deepEqual(f.sockets[0].sent,[]); assert.equal(f.sockets[0].closes.length,0);
  f.watch.close(); assert.deepEqual(await pending,{value:undefined,done:true}); await f.watch.closed;
});

test('reconnect emits ready once on its new connection and ignores stale changes and socket callbacks', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f = fixture({retryMs:10,maxRetryMs:20}), reader = f.watch.notifications[Symbol.asyncIterator]();
  f.sockets[0].receive({type:'ready'}); await reader.next();
  f.sockets[0].receive({type:'changed'}); f.sockets[0].end();
  t.mock.timers.tick(9); assert.equal(f.sockets.length,1);
  t.mock.timers.tick(1); assert.equal(f.sockets.length,2);
  let delivered = false; const next = reader.next().then(value=>{delivered=true;return value;});
  f.sockets[0].receive({type:'ready'}); await flush(); assert.equal(delivered,false);
  f.sockets[1].receive({type:'ready'}); assert.deepEqual(await next,{value:{type:'ready'},done:false});
  f.sockets[1].receive({type:'changed'}); assert.deepEqual(await reader.next(),{value:{type:'changed'},done:false});
  f.watch.close();
});

test('failed opens and open timeouts reconnect with capped failure backoff; cancellation clears pending retry', async t => {
  t.mock.timers.enable({apis:['setTimeout']}); let opens = 0;
  const f = fixture({retryMs:10,maxRetryMs:20,timeoutMs:30},()=>{opens++;if(opens<4)throw Error('offline');return new Socket();});
  assert.equal(opens,1); t.mock.timers.tick(10);assert.equal(opens,2);
  t.mock.timers.tick(19);assert.equal(opens,2);t.mock.timers.tick(1);assert.equal(opens,3);
  t.mock.timers.tick(20);assert.equal(opens,4);t.mock.timers.tick(30);assert.equal(f.sockets[0].closes.length,1);
  f.watch.close();t.mock.timers.tick(86400000);assert.equal(opens,4);await assert.rejects(f.watch.ready,{code:'discovery_closed'});
  const stop = new AbortController(), cancelled = fixture({signal:stop.signal,retryMs:10,maxRetryMs:20});
  const reading = cancelled.watch.notifications[Symbol.asyncIterator]().next();
  const rejected = assert.rejects(reading,/owner ended/);cancelled.sockets[0].end();stop.abort(Error('owner ended'));
  await rejected;await assert.rejects(cancelled.watch.ready,/owner ended/);t.mock.timers.tick(86400000);assert.equal(cancelled.sockets.length,1);
  const before = new AbortController();before.abort(Error('before open'));
  const closed = fixture({signal:before.signal});await assert.rejects(closed.watch.ready,/before open/);assert.equal(closed.sockets.length,0);
});

for(const code of [1008,4003]) test(`terminal subscription refusal ${code} cannot reconnect`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.sockets[0].end(code);
  await assert.rejects(f.watch.ready,{code:'discovery_access_revoked'});assert.equal((await f.watch.closed).code,code);
  t.mock.timers.tick(86400000);assert.equal(f.sockets.length,1);
  await assert.rejects(f.watch.notifications[Symbol.asyncIterator]().next(),{code:'discovery_access_revoked'});
});

test('exact notification validation rejects payload data, duplicate readiness, pre-ready changes and oversized or binary frames',async()=>{
  for(const value of [null,[],{}, {type:'ready',version:1},{type:'changed',peers:[]},{type:'unknown'}])
    assert.throws(()=>validatePeerDiscoveryNotification(value),{code:'invalid_discovery_notification'});
  for(const data of ['{"type":"changed"}', 'not json', JSON.stringify({type:'ready',secret:'no'}),' '.repeat(129),new ArrayBuffer(1)]) {
    const f=fixture();f.sockets[0].dispatchEvent(new MessageEvent('message',{data}));
    await assert.rejects(f.watch.ready,{code:'invalid_discovery_notification'});assert.equal((await f.watch.closed).code,1008);
    assert.equal(f.sockets[0].closes[0].code,1008);
  }
  const f=fixture();f.sockets[0].receive({type:'ready'});await f.watch.ready;
  f.sockets[0].receive({type:'ready'});assert.equal((await f.watch.closed).code,1008);
});

test('a watch has one notification consumer and explicit close drains its owned lifetime',async()=>{
  const f=fixture(), first=f.watch.notifications[Symbol.asyncIterator](), second=f.watch.notifications[Symbol.asyncIterator]();
  const pending=first.next();await assert.rejects(second.next(),{code:'reader_exists'});
  f.watch.close();assert.deepEqual(await pending,{value:undefined,done:true});
  assert.deepEqual(await f.watch.closed,{code:1000,reason:'Discovery watch closed'});
});


test('a newer controller fences the old watcher with 4000 without a reconnect contest', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let retained, firstOpens=0, secondOpens=0;
  const connect = () => {const previous=retained; const socket=retained=new Socket(); previous?.end(4000); return socket;};
  const first=createPeerDiscoveryWatcher(()=>{firstOpens++;return connect();});
  retained.receive({type:'ready'}); await first.ready;
  const reader=first.notifications[Symbol.asyncIterator]();await reader.next();
  const pending=assert.rejects(reader.next(),{code:'participant_replaced'});
  const second=createPeerDiscoveryWatcher(()=>{secondOpens++;return connect();});
  retained.receive({type:'ready'});await second.ready;await pending;
  assert.deepEqual(await first.closed,{code:4000,reason:'Discovery participant replaced'});
  t.mock.timers.tick(86400000);await flush();
  assert.equal(firstOpens,1);assert.equal(secondOpens,1);
  second.close();
  const unopened=fixture();unopened.sockets[0].end(4000);
  await assert.rejects(unopened.watch.ready,{code:'participant_replaced'});
});


for(const status of [401,403,409]) test(`hidden upgrade refusal is terminal after authenticated self returns ${status}`, async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let opens=0, probes=0;
  const peers=createPeersClient({base:'https://service.test/api/t/aaaaaaaaaaaa', socket:()=>{opens++;throw Error('hidden HTTP upgrade error');},
    request:async(path,options)=>{probes++;assert.equal(path,'self');assert(options.signal instanceof AbortSignal);throw Object.assign(Error('refused'),{status});}});
  const watch=peers.watchDiscovery(peerId);
  await assert.rejects(watch.ready,{code:'discovery_access_revoked'});assert.equal((await watch.closed).code,4003);
  t.mock.timers.tick(86400000);await flush();assert.equal(opens,1);assert.equal(probes,1);
});

test('failure-only access diagnosis uses the agent credential and fetcher',async()=>{
  let probes=0; const hub=fakeHub();
  const client=createAgentClient({service:'https://service.test',token:TOKEN}, {WebSocket:hub.WebSocket,fetch:async(url,options)=>{
    probes++;assert.equal(url,`https://service.test/api/agent/pages/${PAGE}/self`);
    assert.equal(options.headers.Authorization,'Bearer '+TOKEN);
    return new Response('not JSON',{status:403});
  }});
  try{
    const watch=client.page(PAGE).peers.watchDiscovery(peerId);
    hub.last.accept(); hub.last.push({t:'closed',s:1,code:1006,reason:'upgrade refused'});
    await assert.rejects(watch.ready,{code:'discovery_access_revoked'});
    assert.equal(probes,1);
  }finally{client.close();}
});

test('healthy watches never probe; inconclusive failures back off and aborted probes cannot redial',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let probes=0, probeSignal;
  const stop=new AbortController(), f=fixture({signal:stop.signal,retryMs:10,maxRetryMs:20,
    probeAccess:async({signal})=>{probes++;probeSignal=signal;if(probes===1)throw Object.assign(Error('self route unavailable'),{status:404});return new Promise(()=>{});}});
  f.sockets[0].receive({type:'ready'});await f.watch.ready;t.mock.timers.tick(86400000);await flush();assert.equal(probes,0);
  f.sockets[0].end();await flush();assert.equal(probes,1);assert.equal(f.sockets.length,1);
  t.mock.timers.tick(10);assert.equal(f.sockets.length,2);f.sockets[1].end();await flush();assert.equal(probes,2);
  stop.abort();await f.watch.closed;assert(probeSignal.aborted);await flush();
  t.mock.timers.tick(86400000);assert.equal(f.sockets.length,2);
});

test('an uncooperative access probe has a bounded deadline and its late denial cannot close the reconnected watch',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const gate=Promise.withResolvers();let signal;
  const f=fixture({retryMs:10,maxRetryMs:20,probeAccess:options=>{signal=options.signal;return gate.promise;}});
  f.sockets[0].end();await flush();t.mock.timers.tick(5000);await flush();assert(signal.aborted);
  t.mock.timers.tick(10);assert.equal(f.sockets.length,2);f.sockets[1].receive({type:'ready'});await f.watch.ready;
  gate.reject(Object.assign(Error('late denial'),{status:401}));await flush();
  assert.equal(f.sockets[1].closes.length,0);f.watch.close();
});

test('terminal watcher errors expose a provider-neutral retryable false contract; caller abort reasons remain intact',async()=>{
  const {PeerDiscoveryWatchError,validatePeerDiscoveryWatchOptions,validatePeerAdvertisementPresence}=await import('../peers.mjs');
  assert.equal(new PeerDiscoveryWatchError('participant_replaced','fenced').retryable,false);
  for(const action of [()=>validatePeerDiscoveryWatchOptions({retryMs:0}),()=>validatePeerDiscoveryNotification({type:'wrong'}),
    ()=>validatePeerAdvertisementPresence({}),
    ()=>createPeersClient({base:'not a URL',request:async()=>{}}).watchDiscovery(peerId),
    ()=>createPeersClient({base:'https://host.test',request:async()=>{}}).watchDiscovery('wrong')])
    assert.throws(action,error=>error.retryable===false&&typeof error.code==='string');
  for(const code of [1008,4000,4003]){
    const f=fixture();f.sockets[0].end(code);await assert.rejects(f.watch.ready,error=>error.retryable===false);
    await assert.rejects(f.watch.notifications[Symbol.asyncIterator]().next(),error=>error.retryable===false);
  }
  const invalid=fixture();invalid.sockets[0].receive({type:'wrong'});
  await assert.rejects(invalid.watch.ready,error=>error.retryable===false);
  const reason=Error('caller cancelled'), stop=new AbortController(), cancelled=fixture({signal:stop.signal});stop.abort(reason);
  await assert.rejects(cancelled.watch.ready,error=>error===reason);
  assert.equal(reason.retryable,undefined);
});

test('public declarations type discovery failures as terminal and readonly',async t=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const directory=await mkdtemp(join(tmpdir(),'discovery-error-types-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'consumer.mts');
  await writeFile(file,`
import {PeerDiscoveryWatchError,PeerDiscoveryError} from ${JSON.stringify(fileURLToPath(new URL('../peers.mjs',import.meta.url)))};
const watched = new PeerDiscoveryWatchError('participant_replaced','fenced');
const directory = new PeerDiscoveryError('invalid_advertisement','invalid');
const fatal: false = watched.retryable;
const alsoFatal: false = directory.retryable;
const neutral: {readonly retryable: false; readonly code: string} = watched;
// @ts-expect-error terminal does not mean transient
const transient: true = watched.retryable;
// @ts-expect-error consumers cannot change the retry decision
watched.retryable = true;
void [fatal,alsoFatal,neutral,transient];
`);
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../node_modules/typescript/bin/tsc',import.meta.url)),
    '--strict','--noEmit','--skipLibCheck','--target','ES2022','--module','NodeNext',file],{cwd:directory});
});
