import test from 'node:test';
import assert from 'node:assert/strict';
import {exerciseTutorialCLI} from './support/tutorial-cli-fixture.mjs';
for(const entry of ['session.mjs','assistant.mjs','sql/session.mjs','media/inference-peer.mjs']){
 test(`${entry} CLI closes its owner and exits despite a real half-open WebSocket`,{timeout:20000},async t=>{
  const result=await exerciseTutorialCLI(t,entry,{delayClose:true,largeOutput:true});
  assert.equal(result.aliveBeforeSignal,true,'the CLI must stay live until explicit stop');
  assert.equal(result.ownedClosed,true,result.stderr);assert.equal(result.exitWithoutHarnessKill,true,result.stderr);assert.equal(result.code,0,result.stderr);assert.equal(result.signal,null);assert.equal(result.stdoutFlushed,true);
 });
}
for(const entry of ['session.mjs','assistant.mjs','sql/session.mjs','media/inference-peer.mjs']){
 test(`${entry} cleanup failure after SIGTERM remains nonzero and explicitly uncertain`,{timeout:20000},async t=>{
  const result=await exerciseTutorialCLI(t,entry,{cleanupFailure:true});
  assert.equal(result.innerClosed,true,result.stderr);assert.equal(result.ownedClosed,false);assert.equal(result.exitWithoutHarnessKill,true,result.stderr);assert.equal(result.code,1);assert.match(result.stderr,/FIXTURE_OWNER_CLOSE_FAILED/);assert.match(result.stderr,/cleanup is unverified/);
 });
}
test('imported tutorial runners return without exiting an embedding process or its live HTTP listener',{timeout:20000},async t=>{
 const result=await exerciseTutorialCLI(t,'assistant.mjs',{embedded:true});
 assert.equal(result.ownedClosed,true,result.stderr);assert.equal(result.embeddingListenerAlive,true,result.stderr);assert.equal(result.exitWithoutHarnessKill,true,result.stderr);assert.equal(result.code,0,result.stderr);
});


test('a broken assistant stdout pipe cannot turn completed cleanup into a false successful CLI result',{timeout:20000},async t=>{
 const result=await exerciseTutorialCLI(t,'assistant.mjs',{brokenOutput:true});
 assert.equal(result.ownedClosed,true,result.stderr);assert.equal(result.exitWithoutHarnessKill,true,result.stderr);assert.equal(result.code,1,result.stderr);assert.match(result.stderr,/EPIPE|output/);
});
