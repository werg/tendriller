import test from 'node:test';
import assert from 'node:assert/strict';
import { runNativeBootstrap, bootstrapOptions, disposeStoppedBootstrap, readSoakWorkspace } from '../idle-soak/native-bootstrap.mjs';
import { newState, report } from '../idle-soak/state.mjs';
import { nativeCoverage, nativeAssistantStatus, nativeAssistantBusy, nativeStopped } from '../idle-soak/run.mjs';
import { quietBoundary } from '../idle-soak/warmup.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const readiness=f=>f.messages.filter(x=>x.idleSoakReady===1||x.idleSoakCoverage===1);
const PAGE='abcdefghijkl';
// A fake agent program: the bootstrap only reads its JSON reports and stops it with SIGTERM.
function fixture({assistant=false,events=false,cleanExit=true}={}) {
 const stop=new AbortController(),messages=[],wakeups=[],exit=Promise.withResolvers();let onReport,onMessage,spawns=0,stops=0;
 const task=runNativeBootstrap({assistant,events,workspace:{page:{slug:'soak',id:PAGE}},signal:stop.signal,record:kind=>wakeups.push(kind),send:value=>messages.push(value)},
  {spawnAgent(callbacks){spawns++;({onReport,onMessage}=callbacks);return{exited:exit.promise,stop(){stops++;if(cleanExit){onReport({running:false});exit.resolve({code:0,signal:null});}else exit.resolve({code:null,signal:'SIGKILL'});}};}});
 task.catch(()=>{});
 return{task,stop,messages,wakeups,exit,report:value=>onReport(value),relay:value=>onMessage(value),stats:()=>({spawns,stops})};
}
const readyPage=f=>{f.report({hub:'connected'});f.report({page:PAGE,state:'running'});f.report({page:PAGE,canAuthor:true,database:'ready'});f.report({page:PAGE,setup:{state:'connected'}});f.report({page:PAGE,connection:'connected'});};
test('flags preserve native-only default and require assistant for events',()=>{
 assert.deepEqual({...bootstrapOptions([])},{assistant:false,events:false});
 assert.deepEqual({...bootstrapOptions(['--assistant','--events'])},{assistant:true,events:true});
 assert.throws(()=>bootstrapOptions(['--events']),/EVENTS_REQUIRE_ASSISTANT/);
 assert.throws(()=>bootstrapOptions(['--setup']));
});
test('the soak workspace has one initialized page, the agent credential and a matching assistant preparation',async()=>{
 const files={'/w/tendriller.json':JSON.stringify({service:'https://s.example',agent:{id:'ag_x'},pages:{soak:{id:PAGE}}})};
 const present=new Set(['/w/.tendriller/agent/credential.json',`/w/.tendriller/pages/${PAGE}/page.json`,`/w/.tendriller/pages/${PAGE}/initialized.json`,'/w/pages/soak/agent.mjs','/w/node_modules/@tendriller/tools/bin/tendril.mjs']);
 const io={read:async path=>{if(!(path in files))throw Error('ENOENT');return files[path];},exists:path=>present.has(path)||path in files};
 assert.deepEqual(await readSoakWorkspace('/w',{},io),{root:'/w',agent:'ag_x',page:{slug:'soak',id:PAGE}});
 await assert.rejects(readSoakWorkspace('/w',{assistant:true},io),/ASSISTANT_PREPARATION_MISMATCH/);
 files[`/w/.tendriller/pages/${PAGE}/assistant.json`]=JSON.stringify({proposalId:'p1'});
 files[`/w/.tendriller/pages/${PAGE}/assistant-proposal-p1.json`]=JSON.stringify({forwardEvents:true});
 await assert.rejects(readSoakWorkspace('/w',{},io),/ASSISTANT_PREPARATION_MISMATCH/,'A prepared adapter starts anyway; native-only scope would misreport coverage.');
 await assert.rejects(readSoakWorkspace('/w',{assistant:true},io),/ASSISTANT_PREPARATION_MISMATCH/);
 assert.equal((await readSoakWorkspace('/w',{assistant:true,events:true},io)).page.id,PAGE);
 present.delete(`/w/.tendriller/pages/${PAGE}/initialized.json`);
 await assert.rejects(readSoakWorkspace('/w',{assistant:true,events:true},io),/PAGE_INITIALIZATION_REQUIRED/);
 files['/w/tendriller.json']=JSON.stringify({agent:{id:'ag_x'},pages:{soak:{id:PAGE},other:{id:'mnopqrstuvwx'}}});
 await assert.rejects(readSoakWorkspace('/w',{},io),/DEDICATED_SOAK_WORKSPACE_REQUIRED/);
 present.delete('/w/.tendriller/agent/credential.json');
 await assert.rejects(readSoakWorkspace('/w',{},io),/WORKSPACE_AGENT_CREDENTIAL_REQUIRED/);
 await assert.rejects(readSoakWorkspace('/empty',{},io),/AGENT_WORKSPACE_REQUIRED/);
});
test('native-only readiness needs the hub, the running page, local authoring ability, setup and a connected route; every callback counts',async()=>{
 const f=fixture();await flush();assert.equal(f.stats().spawns,1);
 f.report({hub:'connected'});f.report({page:PAGE,state:'running'});f.report({page:PAGE,setup:{state:'connected'}});
 assert.equal(readiness(f).length,0);
 f.report({page:PAGE,connection:'connected',error:'PEER_X'});assert.equal(readiness(f).length,0);
 f.report({page:'mnopqrstuvwx',connection:'connected',canAuthor:true});assert.equal(readiness(f).length,0,'Another page never satisfies readiness.');
 f.report({page:PAGE,connection:'connected'});assert.equal(readiness(f).length,0,'A connected route without local keys and grant is not coverage.');
 f.report({page:PAGE,canAuthor:false,database:'ready'});assert.equal(readiness(f).length,0);
 f.report({page:PAGE,canAuthor:true,database:'ready'});
 assert.deepEqual(readiness(f),[{idleSoakCoverage:1,bootstrapScope:'native-only-without-mcp-adapter',wakeups:true,modelTurns:false,eventsForwarding:false},{idleSoakReady:1}]);
 const before=f.wakeups.length;f.report({page:PAGE,revision:{},change:'materialized'});f.report({page:PAGE,provisioning:{verified:true}});
 assert.equal(f.wakeups.length,before+2);assert(f.wakeups.every(x=>x==='wakeups'));
 f.relay({idleSoak:1,source:'native',kind:'requests',count:1,category:'agent-hub'});
 assert.deepEqual(f.messages.at(-1),{idleSoak:1,source:'native',kind:'requests',count:1,category:'agent-hub'},'Observer counters from the agent program reach the runner.');
 f.stop.abort();assert.deepEqual(await f.task,{ownerClosed:true,observersSettled:true,assistantSettled:true});assert.equal(f.stats().stops,1);
});
test('local authoring ability is independent of the network: it is required for coverage, then losing the route never restarts the agent',async()=>{
 const f=fixture();await flush();readyPage(f);assert.equal(readiness(f).length,2);
 f.report({page:PAGE,connection:'unavailable'});f.report({page:PAGE,canAuthor:false});assert.equal(readiness(f).length,2);assert.equal(f.stats().stops,0);
 f.stop.abort();await f.task;
});
test('a reported reconciliation failure or session loss withholds readiness until it recovers',async()=>{
 const f=fixture();await flush();f.report({hub:'connected'});f.report({page:PAGE,state:'running'});f.report({page:PAGE,canAuthor:true});
 f.report({page:PAGE,setup:{state:'connected'}});f.report({page:PAGE,state:'setup_retry',code:'x'});f.report({page:PAGE,connection:'connected'});
 assert.equal(readiness(f).length,0);
 f.report({page:PAGE,state:'page_retry'});f.report({page:PAGE,provisioning:{verified:true}});assert.equal(readiness(f).length,0,'A retried page must report its running state, local ability and route again.');
 f.report({page:PAGE,state:'running'});f.report({page:PAGE,connection:'connected'});assert.equal(readiness(f).length,0);
 f.report({page:PAGE,canAuthor:true});assert.equal(readiness(f).length,2);
 f.stop.abort();await f.task;
});
test('assistant readiness requires actual adapter online and fixed boolean status IPC',async()=>{
 const f=fixture({assistant:true,events:true});await flush();readyPage(f);assert.equal(readiness(f).length,0);
 f.report({page:PAGE,state:'adapter_online',private:'MUST_NOT_LEAK'});
 assert.deepEqual(readiness(f)[0],{idleSoakCoverage:1,bootstrapScope:'native-with-mcp-adapter',wakeups:true,modelTurns:false,eventsForwarding:true});
 f.report({page:PAGE,assistant:{state:'disconnected'}});f.report({page:PAGE,state:'adapter_online'});
 assert.deepEqual(f.messages.filter(x=>x.idleSoakAssistantStatus===1).map(x=>x.online),[false,true,false,true]);
 assert(!JSON.stringify(f.messages).includes('MUST_NOT_LEAK'));
 f.stop.abort();await f.task;
 const count=f.messages.length;assert.equal(f.messages.at(-1).online,false);f.report({page:PAGE,state:'adapter_online'});assert.equal(f.messages.length,count,'Cleanup fences late callbacks.');
});
test('event activity failure blocks readiness without restarting the agent program',async()=>{
 const f=fixture({assistant:true,events:true});await flush();readyPage(f);
 f.report({page:PAGE,state:'adapter_activity_failed'});f.report({page:PAGE,state:'adapter_online'});
 assert.equal(readiness(f).length,0);assert.equal(f.messages.at(-1).eventsForwardingBlocked,true);assert.equal(f.stats().stops,0);
 const s=newState({hours:48});nativeCoverage(s,{idleSoakCoverage:1,bootstrapScope:'native-with-mcp-adapter',eventsForwarding:true});
 for(const message of f.messages.filter(x=>x.idleSoakAssistantStatus))nativeAssistantStatus(s,message);
 assert.equal(s.coverage.mcpOnline,true);assert.equal(s.coverage.eventsForwardingBlocked,true);assert.equal(nativeAssistantBusy(s),true);
 f.stop.abort();await f.task;
});
test('an unexpected agent exit, agent revocation or unclean shutdown cannot earn the owned shutdown receipt',async()=>{
 const exited=fixture();await flush();readyPage(exited);exited.exit.resolve({code:1,signal:null});
 await assert.rejects(exited.task,/AGENT_PROGRAM_EXITED/);
 const revoked=fixture();await flush();revoked.report({hub:'revoked'});await assert.rejects(revoked.task,/AGENT_REVOKED/);assert.equal(revoked.stats().stops,1);
 const killed=fixture({cleanExit:false});await flush();killed.stop.abort();
 const receipt=await killed.task;assert.equal(receipt.ownerClosed,false);
 await assert.rejects(disposeStoppedBootstrap(receipt,{send:async()=>{},disconnect(){},exit(){assert.fail('must not exit');}}),/SHUTDOWN_REQUIRED/);
 let spawned=false;await assert.rejects(runNativeBootstrap({workspace:{page:{id:PAGE}},signal:AbortSignal.abort(Error('stopped')),record(){},send(){}},{spawnAgent(){spawned=true;}}),/stopped/);assert.equal(spawned,false);
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

test('dedicated process disposal requires completed owned shutdown and flushes its receipt before exit',async()=>{
 const f=fixture();await flush();f.stop.abort();const receipt=await f.task;assert.deepEqual(receipt,{ownerClosed:true,observersSettled:true,assistantSettled:true});
 const sent=Promise.withResolvers(),calls=[];const disposal=disposeStoppedBootstrap(receipt,{send:async m=>{calls.push(m);await sent.promise;},disconnect:()=>calls.push('disconnect'),exit:code=>calls.push(code)});
 await flush();assert.equal(calls.length,1);sent.resolve();await disposal;assert.deepEqual(calls.slice(1),['disconnect',0]);
 const s=newState({hours:48});assert(nativeStopped(s,calls[0],123));assert.equal(s.events.at(-1).processDisposal,true);assert.equal(report(s).counts.modelTurns,null);
 let exited=false;await assert.rejects(disposeStoppedBootstrap({...receipt,ownerClosed:false},{exit:()=>exited=true}),/SHUTDOWN_REQUIRED/);assert.equal(exited,false);
 await assert.rejects(disposeStoppedBootstrap(receipt,{send:async()=>{throw Error('IPC failed');},exit:()=>exited=true}),/IPC failed/);assert.equal(exited,false);
});
