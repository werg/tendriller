import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVITY_LIMIT, HOUR, newState, record, beginSegment, endSegment, markStopRequested, report } from '../idle-soak/state.mjs';
import { requestStop } from '../idle-soak/run.mjs';
import { classifyTransport, transportCategories } from '../idle-soak/classification.mjs';
import { startBrowser } from '../idle-soak/browser.mjs';
const config = { hours: 48 };

test('classification uses only path and returns a fixed category without retaining private URL components', () => {
  const routes = { 'setup/watch':'setup-watch', 'peers/discovery/watch':'discovery-watch',
    'peers/invitations':'invitations', 'peers/rendezvous':'rendezvous', 'peers/relay':'relay',
    'assistant/adapter':'assistant-provider', 'publication-ready':'publication-watch', 'peers/participant':'control' };
  for (const [route, expected] of Object.entries(routes)) for (const prefix of ['/api/t/SECRET_ID/', '/_tendril/', '/s/SECRET_KEY/_tendril/']) {
    assert.equal(classifyTransport(`wss://SECRET_USER:SECRET_PASS@secret.example${prefix}${route}?token=SECRET_TOKEN#SECRET`), expected);
    assert.equal(classifyTransport(new URL(`https://another.example${prefix}${route}`)), expected);
  }
  assert.equal(classifyTransport(new Request('https://example.test/api/t/SECRET/setup/watch')), 'setup-watch');
  for (const value of ['SECRET', 'https://example.test/?path=/api/t/SECRET/setup/watch', 'https://example.test/other/peers/relay', null, {}])
    assert.equal(classifyTransport(value), 'other');
  assert.equal(classifyTransport('https://example.test/_tendril/__proto__'), 'control');
});

test('receipt timeline validates vocabulary, discards labels/secrets and bounds retention without dropping totals', () => {
  const s = newState(config, 1000);
  for (let i = 0; i < ACTIVITY_LIMIT + 17; i++) assert(record(s, { source:'native', kind:'requests', count:2,
    category: i % 2 ? 'discovery-watch' : 'SECRET_LABEL', at:'SECRET_TIMESTAMP', url:'SECRET_URL', body:'SECRET_BODY', id:'SECRET_ID' }, 1000+i));
  assert.equal(s.activityTimeline.length, ACTIVITY_LIMIT); assert.equal(s.activityTimelineDropped,17);
  assert.equal(s.counts.requests, (ACTIVITY_LIMIT+17)*2); assert.equal(s.activityTimeline[0].at,1017);
  for (const entry of s.activityTimeline) {
    assert.deepEqual(Object.keys(entry).sort(),['at','category','count','counter','phase','source','stopping']);
    assert(transportCategories.includes(entry.category)); assert(Number.isSafeInteger(entry.at));
  }
  for (const event of [{source:'SECRET',kind:'requests'}, {source:'native',kind:'SECRET'},
    {source:'native',kind:'requests',count:-1}, {source:'native',kind:'requests',count:0.5}]) assert.equal(record(s,event),false);
  assert.equal(record(s,{source:'native',kind:'requests'},NaN),false);
  const result=report(s); assert(!JSON.stringify(result).includes('SECRET'));
  assert.equal(result.activityTimelineDropped,17); assert.equal(result.coverage.eventsForwarding,false);
  assert.equal(s.coverage.byteScope,'websocket-frames');
  delete s.coverage.byteScope;
  assert.equal(report(s).coverage.byteScope,'websocket-frames');
  assert.match(result.wakeupScope,/setup\/pairing/); assert.match(result.wakeupScope,/excludes kernel-internal.*AI/);
});

test('stop is persisted before abort, with UTC receipt time and phase attribution; shutdown counts remain overruns', () => {
  const s=newState(config,0); beginSegment(s,'closed',1000);
  record(s,{source:'native',kind:'requests',category:'discovery-watch'},1001);
  const abort=new AbortController(), order=[];
  abort.signal.addEventListener('abort',()=>{order.push('abort'); record(s,{source:'native',kind:'socketsClosed',category:'discovery-watch'},1002);});
  requestStop(s,abort,()=>{order.push('persist');assert.equal(abort.signal.aborted,false);assert.equal(s.activityTimeline.at(-1).counter,'stopRequested');},1002);
  requestStop(s,abort,()=>assert.fail('stop marker must be idempotent'),1003);
  assert.deepEqual(order,['persist','abort']); assert.equal(s.stopRequestedAt,1002);
  endSegment(s,1004);
  record(s,{source:'browser',kind:'requests'},1005);
  assert.deepEqual(s.activityTimeline.map(x=>[x.at,x.phase,x.stopping]),[
    [1001,'closed',false],[1002,'closed',true],[1002,'closed',true],[1005,'boundary',true]]);
  assert.equal(s.segments[0].incomplete,true); assert.equal(s.segments[0].delta.requests,1);
  assert.equal(s.segments[0].delta.socketsClosed,1); assert.equal(s.segments[0].overruns.length,2);
  assert.equal(report(s).status,'incomplete-or-over-budget');
});

test('assistant status timeline accepts only fixed booleans and does not invent traffic or model/wakeup counts', () => {
  const s=newState(config,0), before={...s.counts}; beginSegment(s,'background',10);
  assert.equal(s.coverage.mcpOnline,null); assert.equal(s.coverage.mcpStatusAt,null); assert.equal(s.coverage.eventsForwardingBlocked,null);
  assert(record(s,{source:'native',kind:'assistant-status',eventsForwardingBlocked:false,online:true,eventsForwarding:false,url:'SECRET',status:'SECRET'},11));
  assert.equal(record(s,{source:'native',kind:'assistant-status',eventsForwardingBlocked:false,online:'SECRET',eventsForwarding:true},12),false);
  assert.equal(record(s,{source:'browser',kind:'assistant-status',eventsForwardingBlocked:false,online:true,eventsForwarding:true},12),false);
  assert.equal(record(s,{source:'native',kind:'assistant-status',eventsForwardingBlocked:false,online:true,eventsForwarding:1},12),false);
  assert.equal(record(s,{source:'native',kind:'assistant-status',eventsForwardingBlocked:false,online:true,eventsForwarding:true,count:2},12),false);
  markStopRequested(s,12);
  assert(record(s,{source:'native',kind:'assistant-status',eventsForwardingBlocked:false,online:false,eventsForwarding:false},13));
  assert.deepEqual(s.counts,before); assert.equal(s.activityTimeline[0].category,'assistant-provider');
  assert.equal(s.activityTimeline[0].phase,'background'); assert.equal(s.activityTimeline.at(-1).stopping,true);
  assert(!JSON.stringify(report(s)).includes('SECRET'));
  assert.equal(record(s,{source:'native',kind:'assistant-status',online:true,eventsForwarding:true,eventsForwardingBlocked:'SECRET'},14),false);
  assert(record(s,{source:'native',kind:'assistant-status',online:true,eventsForwarding:true,eventsForwardingBlocked:true},15));
  assert.equal(s.activityTimeline.at(-1).eventsForwardingBlocked,true);
  assert.deepEqual(s.counts,before);
  assert.equal(report(s).coverage.eventsForwardingBlocked,null);
});

test('persistence failure still aborts after recording the stop boundary', () => {
  const s=newState(config,0),abort=new AbortController();
  assert.throws(()=>requestStop(s,abort,()=>{throw Error('DISK_FAILED');},1),/DISK_FAILED/);
  assert.equal(s.stopRequestedAt,1); assert.equal(abort.signal.aborted,true);
});

test('interrupted diagnostic counts are retained exactly and older checkpoints acquire no invented timeline', () => {
  const s=newState(config,0); delete s.activityTimeline; delete s.activityTimelineDropped;
  beginSegment(s,'closed',0);
  for (const [kind,count] of Object.entries({requests:4,socketsOpened:1,socketsClosed:1,framesReceived:1,bytesReceived:16})) record(s,{source:'native',kind,count},HOUR);
  endSegment(s,Math.round(69.48*60000)); s.status='interrupted';
  assert.deepEqual(s.segments[0].delta,{requests:4,socketsOpened:1,socketsClosed:1,framesSent:0,framesReceived:1,bytesSent:0,bytesReceived:16,modelTurns:0,wakeups:0});
  assert.equal(report(s).realWallClockComplete,false); assert.equal(report(s).counts.wakeups,null);
  delete s.activityTimeline; delete s.activityTimelineDropped;
  assert.deepEqual(report(s).activityTimeline,[]); assert.equal(report(s).activityTimelineDropped,0);
});

test('browser emits fixed path categories for requests and every socket/frame counter, never URLs or payloads', async () => {
  const dir=mkdtempSync(join(tmpdir(),'idle-activity-browser-')), context=new EventEmitter(), events=[];
  context.pages=()=>[]; context.newPage=async()=>{const page=new EventEmitter();page.goto=async()=>{};context.emit('page',page);return page;};
  const adapter=join(dir,'adapter.mjs'); writeFileSync(adapter,'export async function ready(){};export async function reconnect(){};');
  let browser;
  try {
    browser=await startBrowser({adapter},event=>events.push(event),{chromium:{},launchContext:async()=>({context,close:async()=>{}})});
    const request={url:()=> 'https://example.test/_tendril/info?token=SECRET_TOKEN'};
    context.emit('request',request); context.emit('requestfinished',request);
    const page=await context.newPage(), socket=new EventEmitter();socket.url=()=> 'wss://example.test/_tendril/publication-ready?key=SECRET_KEY';
    page.emit('websocket',socket);socket.emit('framesent',{payload:'SECRET_PAYLOAD'});socket.emit('framereceived',{payload:Buffer.from('SECRET_PAYLOAD')});socket.emit('close');
    assert.equal(events.find(x=>x.kind==='requests').category,'control');
    const traffic=events.filter(x=>x.kind!=='activity'&&x.kind!=='requests'); assert.equal(traffic.length,6);
    assert(traffic.every(x=>x.category==='publication-watch')); assert.equal(traffic.find(x=>x.kind==='bytesReceived').count,14);
    assert(!JSON.stringify(events).includes('SECRET'));
  } finally { await browser?.close(); rmSync(dir,{recursive:true,force:true}); }
});
