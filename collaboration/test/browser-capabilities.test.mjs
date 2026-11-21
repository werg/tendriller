import test from 'node:test';
import {FixtureLocks} from './fixtures/locks.mjs';
import assert from 'node:assert/strict';
import { openBrowserOwner } from '../../session/browser.mjs';
import { BROWSER_OWNER_PROTOCOL } from '../../session/browser-transport.mjs';

test('SQL storage selects the maintained dedicated route before a Worker or store can open', async t => {
  const saved=new Map(['navigator','location','SharedWorker','Worker','BroadcastChannel'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,value]of saved)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
  let shared=0,dedicated=0,closed=0,channel;
  class Channel extends EventTarget {constructor(){super();channel=this;}postMessage(){}close(){closed++;}}
  class Dedicated extends EventTarget {
    constructor(){super();dedicated++;}
    postMessage(data){queueMicrotask(()=>data.type==='retire'?this.dispatchEvent(new MessageEvent('message',{data:{protocol:BROWSER_OWNER_PROTOCOL,type:'retired',id:data.id}})):channel.dispatchEvent(new MessageEvent('message',{data:{protocol:BROWSER_OWNER_PROTOCOL,type:'failure',code:'FIXTURE_ELECTED_ROUTE'}})));}
    terminate(){}
  }
  const globals={navigator:{locks:new FixtureLocks()},location:{origin:'https://app.example',href:'https://app.example/'},
    SharedWorker:class {constructor(){shared++;throw Error('FIXTURE_SHARED_ROUTE');}},Worker:Dedicated,BroadcastChannel:Channel};
  for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,value});
  const options={workerUrl:'https://app.example/worker.mjs',profileId:'retained',applicationId:'a'.repeat(64),definitionId:'schema',definitionVersion:'1',timeoutMs:1000};
  await assert.rejects(openBrowserOwner({...options,requiresDedicatedWorker:true,mode:'shared'}),error=>{
    assert.equal(error.code,'OWNER_STORAGE_UNSUPPORTED');assert.match(error.nextAction,/auto or elected/);return true;
  });assert.equal(shared,0);assert.equal(dedicated,0);
  await assert.rejects(openBrowserOwner({...options,requiresDedicatedWorker:true}),error=>error.code==='FIXTURE_ELECTED_ROUTE');
  assert.equal(shared,0);assert.equal(dedicated,1);assert.equal(closed,1);
  await assert.rejects(openBrowserOwner(options),/FIXTURE_SHARED_ROUTE/);assert.equal(shared,1);assert.deepEqual(await navigator.locks.query(),{held:[],pending:[]},'constructor failure releases the acquired witness');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request(){assert.fail('missing query must fail before requesting a witness');}}}});
  await assert.rejects(openBrowserOwner(options),/OWNER_CAPABILITY_UNAVAILABLE/);assert.equal(shared,1,'missing query prevents construction');
});
