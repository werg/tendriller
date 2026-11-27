import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCollaborationReader } from '../paging.mjs';

const revision={digest:'a'.repeat(64),view:'local',stateRoot:'b'.repeat(64),historyDigest:'c'.repeat(64),orderLength:0};
function fixture(query) {
  let opened=0,released=0,closed=0,detached=0;
  const lifetime=new AbortController(),calls=[];
  const view={revision:structuredClone(revision),async query(topic,input){
    const sql=typeof input==='object'&&input!==null?input.sql:topic;
    const params=typeof input==='object'&&input!==null?input.params:[];
    calls.push(sql);
    if(query)return query(sql,params);
    return{rows:sql==='SELECT 1'?[[1]]:sql.startsWith('SELECT COUNT(*)')?[[0]]:[]};
  },release(){released++;}};
  return {view,calls,lifetime,session:{applicationId:'d'.repeat(64),signal:lifetime.signal,async readView(){opened++;return view;},close(){closed++;},detach(){detached++;}},
    counts:()=>({opened,released,closed,detached})};
}
function gate(){let release,enter;return{wait:new Promise(resolve=>{release=resolve;}),entered:new Promise(resolve=>{enter=resolve;}),release:()=>release(),enter:()=>enter()};}

test('captured paging owns one immutable view and closes only its read resource',async()=>{
  const f=fixture(),reader=await captureCollaborationReader(f.session);
  assert.deepEqual(f.calls,['SELECT 1']);assert.ok(Object.isFrozen(reader.revision));assert.equal(reader.revision.view,'local');
  f.view.revision.digest='e'.repeat(64);
  const [tasks,results,messages,thread,task,snapshot]=await Promise.all([
    reader.tasks(),reader.results(),reader.messages(),reader.thread({threadId:'thread'}),reader.inspect('task'),reader.snapshot(),
  ]);
  assert.equal(tasks.value.page.revision.digest,revision.digest);assert.equal(results.value.page.returned,0);
  assert.deepEqual(messages.value.messages,[]);assert.deepEqual(thread.value.messages,[]);
  assert.equal(task.value.task,null);assert.equal(snapshot.value.pages.tasks.total,0);
  assert.equal(tasks.revision,reader.revision);assert.equal(reader.closed,false);
  await reader.close();await reader.close();assert.equal(reader.closed,true);
  assert.deepEqual(f.counts(),{opened:1,released:1,closed:0,detached:0});
  await assert.rejects(reader.messages(),{code:'COLLABORATION_READER_CLOSED'});
});

test('raw-query capability denial releases the captured view and preserves the original denial',async()=>{
  for(const code of ['APPLICATION_ATTACHMENT_QUERY_FORBIDDEN','APPLICATION_ATTACHMENT_FORBIDDEN']){
    const error=Object.assign(Error(code),{code}),f=fixture(async()=>{throw error;});
    await assert.rejects(captureCollaborationReader(f.session),value=>value===error);
    assert.deepEqual(f.calls,['SELECT 1']);assert.equal(f.counts().released,1);
  }
});

test('cancellation racing view creation releases the eventual view without touching its session',async()=>{
  const opening=gate(),f=fixture(),controller=new AbortController(),reason=Error('observer stopped');
  f.session.readView=async()=>{opening.enter();await opening.wait;return f.view;};
  const capturing=captureCollaborationReader(f.session,{signal:controller.signal});await opening.entered;
  controller.abort(reason);opening.release();await assert.rejects(capturing,value=>value===reason);
  assert.equal(f.counts().released,1);assert.equal(f.calls.length,0);
  assert.equal(f.counts().closed,0);assert.equal(f.counts().detached,0);
});

test('owner cancellation fences pending SQL reads and bounded reader admission preserves sibling work',async()=>{
  const reading=gate(),f=fixture(async sql=>{
    if(sql==='SELECT 1')return{rows:[[1]]};
    reading.enter();await reading.wait;return{rows:[[0]]};
  });
  const reader=await captureCollaborationReader(f.session),pending=Array.from({length:8},()=>reader.messages());
  pending.forEach(value=>void value.catch(()=>{}));await reading.entered;
  await assert.rejects(reader.messages(),{code:'COLLABORATION_READER_BUSY'});
  const reason=Error('owner stopped');f.lifetime.abort(reason);reading.release();
  for(const result of await Promise.allSettled(pending)){assert.equal(result.status,'rejected');assert.equal(result.reason,reason);}
  await reader.close();assert.equal(f.counts().released,1);assert.equal(f.calls.length,9);
  assert.equal(f.counts().closed,0);assert.equal(f.counts().detached,0);
});

test('a rejected in-flight query preserves current cancellation while live-reader errors remain unchanged',async()=>{
  for(const cancelled of [false,true]){
    const reading=gate(),controller=new AbortController(),underlying=Object.assign(Error('APPLICATION_VIEW_RELEASED'),{code:'APPLICATION_VIEW_RELEASED'});
    const f=fixture(async sql=>{if(sql==='SELECT 1')return{rows:[[1]]};reading.enter();await reading.wait;throw underlying;});
    const reader=await captureCollaborationReader(f.session,{signal:controller.signal}),pending=reader.messages();
    await reading.entered;
    const reason=Error('reviewer observation stopped');if(cancelled)controller.abort(reason);
    reading.release();await assert.rejects(pending,error=>error===(cancelled?reason:underlying));
    await reader.close();assert.equal(f.counts().released,1);assert.equal(f.counts().closed,0);
  }
});
