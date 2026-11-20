import test from 'node:test';
import assert from 'node:assert/strict';
import { runNativeBootstrap, bootstrapOptions, disposeStoppedBootstrap } from '../idle-soak/native-bootstrap.mjs';
import { newState, report } from '../idle-soak/state.mjs';
import { nativeCoverage, nativeAssistantStatus, nativeAssistantBusy, nativeStopped } from '../idle-soak/run.mjs';
import { quietBoundary } from '../idle-soak/warmup.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const readiness=f=>f.messages.filter(x=>x.idleSoakReady===1||x.idleSoakCoverage===1);
function fixture({assistant=true,events=false,queryFailure=false,missingPairings=false,changesNeedOwnerClose=false}={}) {
 const stop=new AbortController(),sessionStop=new AbortController(),query=Promise.withResolvers(),reconciliation=Promise.withResolvers();
 const calls=[],messages=[],wakeups=[];let status,notify,observed,reconcile,assistantReport,opens=0,closes=0,assistantCalls=0,supervisorCloses=0;
 const session={signal:sessionStop.signal,participation:{onStatus(fn){status=fn;return()=>calls.push('unsubscribe');}},
  query(name,input){calls.push(['query',name,input]);return query.promise;},
  changes({signal}){if(changesNeedOwnerClose)signal=sessionStop.signal;return{async *[Symbol.asyncIterator](){
    while(!signal.aborted){const change=await new Promise(resolve=>{const abort=()=>resolve(null);signal.addEventListener('abort',abort,{once:true});notify=value=>{signal.removeEventListener('abort',abort);resolve(value);};if(signal.aborted)abort();});if(change===null)break;yield change;}
  }};}};
 const owned={session,watchSetup(){calls.push('watch');},processPairings:missingPairings?undefined:async options=>{calls.push(['reconcile',options]);return reconciliation.promise;},
  close:async()=>{closes++;sessionStop.abort();calls.push('close');}};
 const deps={openSession:async()=>{opens++;return owned;},
  superviseParticipant(options){assert.equal(assistant,false);observed=options.owned;reconcile=observed.processPairings;return{close:async()=>{supervisorCloses++;}};},
  async runAssistant(options,hooks){assistantCalls++;calls.push(['assistant',options.events]);observed=await hooks.open();assert.equal(observed.session,session);reconcile=observed.processPairings;assistantReport=hooks.report;
    try{await new Promise(resolve=>{options.signal.addEventListener('abort',resolve,{once:true});if(options.signal.aborted)resolve();});}finally{await observed.close();}
  },
  // These are operator-only work, never bootstrap hooks.
  prepareAssistant(){throw Error('MUST_NOT_PREPARE_HERE');},setup(){throw Error('MUST_NOT_SETUP');}};
 const task=runNativeBootstrap({assistant,events,signal:stop.signal,record:kind=>wakeups.push(kind),send:value=>messages.push(value)},deps);
 task.catch(()=>{});
 if(queryFailure)query.reject(Error('query failed'));
 return{task,stop,query,reconciliation,calls,messages,wakeups,session,owned,
  status:value=>status(value),change:value=>notify(value),reconcile:(...args)=>reconcile(...args),assistantReport:value=>assistantReport(value),
  stats:()=>({opens,closes,assistantCalls,supervisorCloses}),get observed(){return observed;}};
}
const readyStatus={phase:'following',error:null,recovery:null};
test('flags preserve native-only default and require assistant for events',()=>{
 assert.deepEqual({...bootstrapOptions([])},{assistant:false,events:false});
 assert.deepEqual({...bootstrapOptions(['--assistant','--events'])},{assistant:true,events:true});
 assert.throws(()=>bootstrapOptions(['--events']),/EVENTS_REQUIRE_ASSISTANT/);
 assert.throws(()=>bootstrapOptions(['--setup']));
});
test('assistant readiness requires actual adapter online, native participation, successful reconciliation and query',async()=>{
 const f=fixture({events:true});await flush();assert.deepEqual(f.stats(),{opens:1,closes:0,assistantCalls:1,supervisorCloses:0});
 assert.deepEqual(f.calls.filter(x=>Array.isArray(x)&&x[0]==='assistant'),[['assistant',true]]);
 f.assistantReport({state:'participant_running',private:'MUST_NOT_LEAK'});f.assistantReport({assistant:{state:'connected'}});
 f.status({phase:'connected'});const pass=f.reconcile({signal:f.stop.signal});f.reconciliation.resolve([]);await pass;
 f.query.resolve({revision:{},value:[]});await flush();assert.equal(readiness(f).length,0);
 f.assistantReport({state:'adapter_online'});await flush();assert.equal(readiness(f).length,0);
 f.status({...readyStatus,recovery:{id:'review'}});assert.equal(readiness(f).length,0);
 f.status(readyStatus);assert.deepEqual(readiness(f),[{idleSoakCoverage:1,bootstrapScope:'native-with-mcp-adapter',wakeups:true,modelTurns:false,eventsForwarding:true},{idleSoakReady:1}]);
 f.status(readyStatus);f.assistantReport({state:'adapter_online'});assert.equal(readiness(f).length,2);
 assert(!JSON.stringify(f.messages).includes('MUST_NOT_LEAK'));
 f.stop.abort();await f.task;assert.equal(f.stats().closes,1);assert(f.calls.includes('unsubscribe'));
});
test('an earlier online callback is invalidated by adapter loss before the remaining readiness conditions',async()=>{
 const f=fixture();await flush();f.assistantReport({state:'adapter_online'});f.assistantReport({assistant:{state:'disconnected'}});
 f.status(readyStatus);const pass=f.reconcile({signal:f.stop.signal});f.reconciliation.resolve([]);await pass;f.query.resolve({});await flush();assert.equal(readiness(f).length,0);
 f.assistantReport({state:'adapter_online'});assert.equal(f.messages.at(-1).idleSoakReady,1);f.stop.abort();await f.task;
});
test('native-only mode still counts real reconciliation, participation and change callbacks and closes once',async()=>{
 const f=fixture({assistant:false});await flush();f.status(readyStatus);const pass=f.reconcile({signal:f.stop.signal});f.reconciliation.resolve([]);await pass;f.query.resolve({});await flush();
 assert.equal(f.messages[0].bootstrapScope,'native-only-without-mcp-adapter');assert.equal(f.messages[0].eventsForwarding,false);assert.equal(f.stats().assistantCalls,0);
 const before=f.wakeups.length;f.change({kind:'applied'});await flush();assert.equal(f.wakeups.length,before+1);
 await f.reconcile({signal:f.stop.signal});assert.equal(f.wakeups.length,before+2);assert(f.wakeups.every(x=>x==='wakeups'));
 f.stop.abort();await f.task;assert.equal(f.stats().closes,1);assert.equal(f.stats().supervisorCloses,1);
});
test('failed activation or an outdated starter cannot emit readiness or leak a second owner',async()=>{
 const failed=fixture({queryFailure:true});await assert.rejects(failed.task,/query failed/);assert.equal(readiness(failed).length,0);assert.equal(failed.stats().opens,1);assert.equal(failed.stats().closes,1);
 const old=fixture({missingPairings:true});await assert.rejects(old.task,/CURRENT_EVENT_DRIVEN_STARTER_REQUIRED/);assert.equal(readiness(old).length,0);assert.equal(old.stats().assistantCalls,0);assert.equal(old.stats().closes,1);
});
test('abort cancels blocked activation, closes the canonical open hook and never emits late readiness',async()=>{
 const f=fixture();await flush();f.status(readyStatus);const pass=f.reconcile({signal:f.stop.signal});f.reconciliation.resolve([]);await pass;f.assistantReport({state:'adapter_online'});
 f.stop.abort();await f.task;f.query.resolve({});await flush();assert.equal(readiness(f).length,0);assert.equal(f.stats().closes,1);assert.equal(f.stats().opens,1);
 let opened=false;await assert.rejects(runNativeBootstrap({assistant:true,signal:AbortSignal.abort(Error('stopped')),record(){},send(){}},{openSession(){opened=true;}}),/stopped/);assert.equal(opened,false);
});
test('coverage IPC uses a fixed native scope whitelist and MCP does not imply observed model turns',()=>{
 const c={hours:48},s=newState(c);
 assert.equal(nativeCoverage(s,{idleSoakCoverage:1,bootstrapScope:'UNTRUSTED',wakeups:true,modelTurns:true}),false);
 assert.equal(s.coverage.bootstrapScope,'operator-command-unverified');
 for(const bootstrapScope of ['native-only-without-mcp-adapter','native-with-mcp-adapter']){
  assert.equal(nativeCoverage(s,{idleSoakCoverage:1,bootstrapScope,wakeups:true,modelTurns:false,eventsForwarding:true}),true);
  assert.equal(report(s).coverage.eventsForwarding,bootstrapScope==='native-with-mcp-adapter');
  assert.equal(report(s).counts.modelTurns,null);assert.equal(report(s).coverage.bootstrapScope,bootstrapScope);
 }
});


test('latest assistant state gates a full quiet interval; a brief disconnect records state without killing native',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 const state=newState({hours:48});nativeCoverage(state,{idleSoakCoverage:1,bootstrapScope:'native-with-mcp-adapter',wakeups:true,modelTurns:false,eventsForwarding:true});
 assert.equal(nativeAssistantBusy(state),true);
 assert(nativeAssistantStatus(state,{idleSoakAssistantStatus:1,eventsForwardingBlocked:false,online:true,eventsForwarding:true}));assert.equal(nativeAssistantBusy(state),false);
 let done=false;const boundary=quietBoundary({busy:()=>nativeAssistantBusy(state),timeoutMs:10000});const wait=boundary.wait().then(()=>{done=true;});
 t.mock.timers.tick(1000);nativeAssistantStatus(state,{idleSoakAssistantStatus:1,eventsForwardingBlocked:false,online:false,eventsForwarding:true});boundary.activity();
 t.mock.timers.tick(3000);await flush();assert.equal(done,false);assert.equal(state.coverage.mcpOnline,false);assert.equal(state.coverage.mcpStatusAt,2000);assert.equal(state.coverage.eventsForwarding,true);
 nativeAssistantStatus(state,{idleSoakAssistantStatus:1,eventsForwardingBlocked:false,online:true,eventsForwarding:true});boundary.activity();
 t.mock.timers.tick(1999);await flush();assert.equal(done,false);t.mock.timers.tick(1);await wait;
 assert.equal(done,true);assert.equal(report(state).counts.modelTurns,null);
 const before=JSON.stringify(state.coverage);assert.equal(nativeAssistantStatus(state,{idleSoakAssistantStatus:1,eventsForwardingBlocked:false,online:'yes',eventsForwarding:true,private:'secret'}),false);assert.equal(JSON.stringify(state.coverage),before);
});

test('assistant status IPC changes only on actual boolean transitions and cleanup fences late online callbacks',async()=>{
 const f=fixture({events:true});await flush();
 f.assistantReport({state:'adapter_online'});f.assistantReport({state:'adapter_online'});f.assistantReport({assistant:{state:'disconnected'}});f.assistantReport({state:'adapter_online'});
 assert.deepEqual(f.messages.filter(x=>x.idleSoakAssistantStatus===1).map(x=>[x.online,x.eventsForwarding]),[[false,true],[true,true],[false,true],[true,true]]);
 f.stop.abort();await f.task;
 const before=f.messages.length;f.assistantReport({state:'adapter_online'});await flush();assert.equal(f.messages.length,before);
 assert.equal(f.messages.at(-1).online,false);assert.equal(f.stats().closes,1);assert.equal(readiness(f).length,0);
});

test('online provider, participation and query cannot bypass an unfinished or failed initial reconciliation',async()=>{
 const f=fixture();await flush();f.status(readyStatus);f.query.resolve({});f.assistantReport({state:'adapter_online'});await flush();
 assert.equal(readiness(f).length,0);
 const pass=f.reconcile({signal:f.stop.signal});const rejected=assert.rejects(pass,/reconcile failed/);f.reconciliation.reject(Error('reconcile failed'));await rejected;await flush();
 assert.equal(readiness(f).length,0);assert.equal(f.stats().closes,0);
 f.stop.abort();await f.task;assert.equal(f.stats().closes,1);
});


test('event activity failure blocks readiness and quiet without disconnecting the provider',async()=>{
 const f=fixture({events:true});await flush();f.status(readyStatus);f.query.resolve({});
 const pass=f.reconcile();f.reconciliation.resolve([]);await pass;
 f.assistantReport({state:'adapter_activity_failed'});f.assistantReport({state:'adapter_online'});await flush();
 assert.equal(readiness(f).length,0);assert.equal(f.stats().closes,0);
 const s=newState({hours:48});nativeCoverage(s,{idleSoakCoverage:1,bootstrapScope:'native-with-mcp-adapter',eventsForwarding:true});
 for(const message of f.messages.filter(x=>x.idleSoakAssistantStatus))nativeAssistantStatus(s,message);
 assert.equal(s.coverage.mcpOnline,true);assert.equal(s.coverage.eventsForwardingBlocked,true);assert.equal(nativeAssistantBusy(s),true);
 f.assistantReport({state:'adapter_offline'});f.assistantReport({state:'adapter_online'});
 assert.equal(f.messages.at(-1).eventsForwardingBlocked,true);assert.equal(readiness(f).length,0);
 f.stop.abort();await f.task;const count=f.messages.length;f.assistantReport({state:'adapter_activity_failed'});assert.equal(f.messages.length,count);
});

test('activity failure after one-shot ready updates the quiet gate without restarting the native lifetime',async()=>{
 const f=fixture({events:true});await flush();f.status(readyStatus);f.query.resolve({});
 const pass=f.reconcile();f.reconciliation.resolve([]);await pass;f.assistantReport({state:'adapter_online'});await flush();
 assert.equal(readiness(f).length,2);
 const s=newState({hours:48});for(const m of f.messages){nativeCoverage(s,m);nativeAssistantStatus(s,m);}
 assert.equal(nativeAssistantBusy(s),false);
 f.assistantReport({state:'adapter_activity_failed',private:'SECRET'});
 assert(nativeAssistantStatus(s,f.messages.at(-1)));assert.equal(nativeAssistantBusy(s),true);assert.equal(s.coverage.mcpOnline,true);
 assert.equal(readiness(f).length,2);assert.equal(f.stats().closes,0);assert(!JSON.stringify(f.messages).includes('SECRET'));
 f.stop.abort();await f.task;assert.equal(f.stats().closes,1);
});


test('abort closes the shared owner before awaiting readers blocked on owner transport', {timeout:1000}, async()=>{
 const f=fixture({assistant:false,changesNeedOwnerClose:true});await flush();f.status(readyStatus);f.query.resolve({});
 const pass=f.reconcile();f.reconciliation.resolve([]);await pass;await flush();
 f.stop.abort();await f.task;assert.equal(f.stats().closes,1);assert.equal(f.stats().supervisorCloses,1);
});


test('dedicated process disposal requires completed owned shutdown and flushes its receipt before exit',async()=>{
 const f=fixture({assistant:false}),gate=Promise.withResolvers(),close=f.owned.close;let returned=false;
 f.owned.close=async()=>{await gate.promise;await close();};await flush();f.stop.abort();const result=f.task.then(x=>{returned=true;return x;});await flush();assert.equal(returned,false);
 gate.resolve();const receipt=await result;assert.deepEqual(receipt,{ownerClosed:true,observersSettled:true,assistantSettled:true});
 const sent=Promise.withResolvers(),calls=[];const disposal=disposeStoppedBootstrap(receipt,{send:async m=>{calls.push(m);await sent.promise;},disconnect:()=>calls.push('disconnect'),exit:code=>calls.push(code)});
 await flush();assert.equal(calls.length,1);sent.resolve();await disposal;assert.deepEqual(calls.slice(1),['disconnect',0]);
 const s=newState({hours:48});assert(nativeStopped(s,calls[0],123));assert.equal(s.events.at(-1).processDisposal,true);assert.equal(report(s).counts.modelTurns,null);
 let exited=false;await assert.rejects(disposeStoppedBootstrap({...receipt,ownerClosed:false},{exit:()=>exited=true}),/SHUTDOWN_REQUIRED/);assert.equal(exited,false);
 await assert.rejects(disposeStoppedBootstrap(receipt,{send:async()=>{throw Error('IPC failed');},exit:()=>exited=true}),/IPC failed/);assert.equal(exited,false);
});
