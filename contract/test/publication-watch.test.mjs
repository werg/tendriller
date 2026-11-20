import test from 'node:test';
import assert from 'node:assert/strict';
import { watchPublicationUpdates } from '../publication-watch.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { fail = false, response = new Response(null, { status: 202, headers: { 'Tendril-Publication-Version': '0' } }) } = {}) {
  const window = new EventTarget(), sockets = [], notices = [], statuses = []; let reads = 0, sends = 0;
  const globals = { window, navigator: { onLine: true }, location: new URL('https://page.example/s/key/_publications/1/'),
    WebSocket: class {
      constructor(url, protocols) { if (fail) { fail = false; throw Error('offline'); } this.url=url; assert.deepEqual(protocols,['tendriller.publication.v1']); sockets.push(this); }
      send() { sends++; }
      close(code=1000) { this.onclose?.({code}); }
      receive(current) { this.onmessage?.({data:JSON.stringify({type:'publication',version:1,current})}); }
    }, fetch: async (_url, options) => { reads++; assert.equal(options.method,'HEAD'); return response; } };
  const restorers=[];
  for (const [key,value] of Object.entries(globals)) { const descriptor=Object.getOwnPropertyDescriptor(globalThis,key); Object.defineProperty(globalThis,key,{value,configurable:true,writable:true}); restorers.push(()=>descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key]); }
  const watch=watchPublicationUpdates({base:'https://page.example/s/key/',onCurrent:value=>notices.push(value.current),onStatus:value=>statuses.push(value)});
  t.after(()=>{watch.close();for(const restore of restorers)restore();});
  return {watch,window,sockets,notices,statuses,counts:()=>({reads,sends,sockets:sockets.length})};
}
test('healthy publication watch has zero heartbeat, HTTP reads or timers across 48 hours and accepts rollback to zero',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);f.sockets[0].receive(1);
  t.mock.timers.tick(48*3600000);await flush();assert.deepEqual(f.counts(),{reads:0,sends:0,sockets:1});
  f.sockets[0].receive(2);f.sockets[0].receive(1);f.sockets[0].receive(0);assert.deepEqual(f.notices,[1,2,1,0]);
});
test('only transport failure makes one bounded HEAD observation and reconnect backoff',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{fail:true});await flush();
  assert.equal(f.counts().reads,1);t.mock.timers.tick(1000);assert.equal(f.sockets.length,1);f.sockets[0].receive(2);
  t.mock.timers.tick(48*3600000);await flush();assert.deepEqual(f.counts(),{reads:1,sends:0,sockets:1});
});
test('revoked and malformed watches are terminal and cannot restart after disposal or online events',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);f.sockets[0].receive(1);f.sockets[0].onclose({code:4003});
  f.window.dispatchEvent(new Event('online'));f.window.dispatchEvent(new Event('pageshow'));t.mock.timers.tick(48*3600000);await flush();
  assert.deepEqual(f.counts(),{reads:0,sends:0,sockets:1});assert(f.statuses.some(x=>x.state==='access_ended'));
});
test('pagehide fences late responses and BFCache reconnect reconciles the selected publication',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);f.sockets[0].receive(1);
  f.window.dispatchEvent(new Event('pagehide'));f.sockets[0].receive(2);assert.deepEqual(f.notices,[1]);
  f.window.dispatchEvent(new Event('pageshow'));assert.equal(f.sockets.length,2);f.sockets[1].receive(0);assert.deepEqual(f.notices,[1,0]);
  f.watch.close();f.window.dispatchEvent(new Event('online'));t.mock.timers.tick(48*3600000);assert.equal(f.sockets.length,2);
});
test('publication notices cannot inject arbitrary fields or navigation destinations',t=>{
  const f=fixture(t);f.sockets[0].onmessage({data:JSON.stringify({type:'publication',version:1,current:2,url:'https://untrusted.example'})});
  assert.deepEqual(f.notices,[]);assert(f.statuses.some(x=>x.state==='protocol_error'));
});

test('a delayed close from an already failed stream cannot duplicate recovery requests',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);const stream=f.sockets[0];stream.receive(1);
 stream.onerror();await flush();assert.equal(f.counts().reads,1);stream.onclose({code:1006});await flush();
 assert.equal(f.counts().reads,1);t.mock.timers.tick(1000);assert.equal(f.sockets.length,2);f.sockets[1].receive(2);
 t.mock.timers.tick(48*3600000);assert.equal(f.counts().reads,1);
});
