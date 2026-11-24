import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['docs/tutorial/connection.mjs'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'public-storage', setup(b) {
  b.onResolve({filter: /^@tendriller\/core\/browser-owner$/}, () => ({path:'storage',namespace:'fixture'}));
  b.onLoad({filter: /.*/,namespace:'fixture'}, () => ({contents:'export const requestPersistentStorage=async()=>false;'}));
}}] });
const {createOwnerConnection} = await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const tick = () => new Promise(resolve=>setTimeout(resolve,0));
const wait = async predicate => { for(let i=0;i<100;i++){if(predicate())return;await tick();}assert.fail('state was not observed'); };
function fixture(t, overrides={}) {
  const doc = new EventTarget(); doc.visibilityState='visible'; const events = new EventTarget();
  const previous = new Map();
  for (const [key,value] of Object.entries({ document:doc, location:{origin:'https://page.example',href:'https://page.example/',reload(){}}, addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)})) {
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true});
  }
  t.after(()=>{controller.close();for(const [key,desc]of previous)desc?Object.defineProperty(globalThis,key,desc):delete globalThis[key];});
  const navigations=[],states=[],values=new Map();
  const controller=createOwnerConnection({configuration:{applicationId:'app',page_url:'https://page.example/'},storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},navigate:url=>navigations.push(url),onState:s=>states.push(s),connect:async()=>{throw Object.assign(Error('new'),{code:'DEVICE_NOT_ENROLLED'});},...overrides});
  return {controller,navigations,states,events};
}
test('a prepared request never sends the browser to an approval page',async t=>{
  const f=fixture(t,{pairing:{read:()=>({pairingId:'id'}),refresh:async()=>({state:'pending',pairingId:'id',preparedDigest:'digest',reviewUrl:'https://service.example/pairings/page/id'})}});
  const run=f.controller.start();await wait(()=>f.states.some(s=>s.phase==='enrolling'));f.controller.close();await run;
  assert.equal(f.navigations.length,0);assert.equal(f.states.some(s=>s.phase==='approve'),false);
});
test('closing during the initial read prevents retries and connected UI',async t=>{
  let reject,attempts=0;const f=fixture(t,{connect:()=>{attempts++;return new Promise((_,r)=>{reject=r;});}});
  const run=f.controller.start();await tick();f.controller.close();reject(Error('view closed'));await run;
  await f.controller.retry();assert.equal(attempts,1);assert.equal(f.states.some(s=>s.phase==='connected'),false);
});
test('Ask again inspects a retained uncertain renewal and recovers without replacing it',async t=>{
  let state='denied',renews=0,inspections=0;
  const pairing={read:()=>({pairingId:'id'}),refresh:async()=>{inspections++;return {state,pairingId:'id',preparedDigest:'digest',reviewUrl:'https://service.example/pairings/page/id'};},request:async()=>{renews++;state='pending';throw new TypeError('lost response');}};
  const f=fixture(t,{pairing});await f.controller.start();const run=f.controller.state.action.run();
  await wait(()=>renews===1);f.events.dispatchEvent(new Event('focus'));
  await wait(()=>inspections>=3);f.controller.close();await run;
  assert.equal(renews,1);assert.ok(inspections>=3);assert.equal(f.navigations.length,0);
});
test('retained inspection receives a finite abort scope and close cancels it',async t=>{
  let scope;const f=fixture(t,{pairing:{read:()=>({pairingId:'id'}),refresh:({signal})=>{scope=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}});
  const run=f.controller.start();await wait(()=>scope);f.controller.close();await run;assert.equal(scope.aborted,true);
});
test('an unattended offline participant cannot consume the retained review budget',async t=>{
  let renewals=0;
  const f=fixture(t,{pairing:{read:()=>({pairingId:'id'}),refresh:async()=>({state:'expired'}),request:async()=>{renewals++;return {state:'pending'};}}});
  const run=f.controller.start();await wait(()=>renewals===1);await tick();f.events.dispatchEvent(new Event('focus'));await run;
  assert.equal(renewals,1);assert.equal(f.controller.state.phase,'failed');assert.equal(f.controller.state.action.label,'Request another review');
});
