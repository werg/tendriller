import test from 'node:test';
import assert from 'node:assert/strict';
import {exerciseTutorialCLI,provisionNativeMember} from './support/tutorial-cli-fixture.mjs';

const memoryStore=()=>{const values=new Map();return{async get(key){return values.get(key)?.slice()??null;},async put(key,value){values.set(key,value.slice());}};};

test('the CLI fixture provisions a retained member through the public session API without any native root or key creation',{timeout:20000},async()=>{
 const peer=await import('@chronolog/peer-session'),authority=await import('@chronolog/authority');
 const {definition}=await import('../../docs/tutorial/domain.mjs');
 const store=memoryStore(),device=await peer.openApplicationDevice({store,create:true});
 const seeded=await provisionNativeMember({peer,authority,device,definition});
 const publicKey=seeded.session.identity.publicKey;
 try{
  assert.equal(publicKey,device.identity.publicKey);
  assert.notEqual(seeded.ownerPublicKey,publicKey,'the browser owner, not the native device, holds the root');
  assert.equal(seeded.session.authority.descriptor.rootPrincipal,seeded.ownerPublicKey);
  assert.deepEqual({reader:seeded.session.authority.grant(publicKey).reader,writer:seeded.session.authority.grant(publicKey).writer,administrator:seeded.session.authority.grant(publicKey).administrator},{reader:true,writer:true,administrator:false});
  assert.equal(seeded.session.status.canAuthor,true);
 }finally{await seeded.session.close();}
 // Reopening reads the cached authority and granted epoch key from the device alone, as the tutorial's cachedSession does.
 const retained=await peer.openApplicationDevice({store}),cached=await authority.createAuthorityProvider({store:retained.store,applicationId:seeded.applicationId});
 const session=await peer.createApplicationSession({device:retained,definition,authority:cached});
 try{
  assert.equal(session.identity.publicKey,publicKey);
  assert.equal(session.status.canAuthor,true,'stored authority and epoch key are sufficient; no network or finalizer is consulted');
  const operation=await session.command('putNote',{noteId:'n1',text:'local'},{operationId:'fixture-op'});
  assert.equal(operation.stored,true);
  assert.equal((await operation.materialized({signal:AbortSignal.timeout(15000)})).outcome,'accepted');
  const facts=operation.inspect();
  assert.equal(facts.finalized,false);assert.deepEqual(facts.retained,[],'peer retention is an independent fact');
  const read=await session.query('notes',null);
  assert.deepEqual(read.value.map(note=>note.text),['local']);assert.equal(read.applicationId,seeded.applicationId);assert.equal(typeof read.revision.digest,'string');
 }finally{await session.close();}
});
for(const entry of ['session.mjs','assistant.mjs','sql/session.mjs','media/inference-peer.mjs']){
 test(`${entry} CLI closes its owner and exits despite a real half-open WebSocket`,{timeout:20000},async t=>{
  const result=await exerciseTutorialCLI(t,entry,{delayClose:true,largeOutput:true});
  assert.equal(result.aliveBeforeSignal,true,'the CLI must stay live until explicit stop');assert.equal(result.provisionedMemberOnly,true);
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
