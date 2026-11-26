import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:[new URL('../src/transport.ts',import.meta.url).pathname],bundle:true,format:'esm',platform:'node',write:false});
const {createTransportBinding,nameTransportAgents}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('runtime registration is one local source, survives BFCache observation, and never starts a read by itself',async()=>{
 let subscriptions=0,reads=0;
 const source={status:{phase:'connected',connectedPeers:['a'.repeat(64)],connectionRevision:0},onStatus(fn){subscriptions++;fn(this.status);return()=>subscriptions--;},async diagnostics(){reads++;return[{peerId:'a'.repeat(64),kind:'direct',sentReliableBytes:0,receivedReliableBytes:0}];}};
 const binding=createTransportBinding(),reports=[];const off=binding.api.onChange(report=>reports.push(report));
 assert.equal(binding.api.status().state,'unavailable');binding.api.install(source);binding.api.install(source);
 assert.equal(subscriptions,1);assert.equal(reads,0);assert.throws(()=>binding.api.install({...source}),/TRANSPORT_ALREADY_INSTALLED/);
 await binding.api.refresh();assert.equal(reads,1);assert.equal(binding.api.status().connections[0].sentBytes,0);
 binding.suspend();binding.suspend();assert.equal(subscriptions,0);await binding.api.refresh();assert.equal(reads,1);
 binding.resume();binding.resume();assert.equal(subscriptions,1);assert.equal(reads,1);assert.equal(binding.api.status().sampled,false);
 assert(reports.length>=3);off();binding.suspend();assert.equal(subscriptions,0);
});
test('agent names come from a local lookup, are validated handles, and re-render without another read',async()=>{
 let reads=0;const peer='a'.repeat(64);
 const source={status:{phase:'connected',connectedPeers:[peer],connectionRevision:0},onStatus(fn){fn(this.status);return()=>{};},async diagnostics(){reads++;return[{peerId:peer,kind:'relay',reason:'direct_failed',sentReliableBytes:5,receivedReliableBytes:7}];}};
 const binding=createTransportBinding(),reports=[];binding.api.onChange(report=>reports.push(report));binding.api.install(source);
 await binding.api.refresh();assert.equal(binding.api.status().connections[0].agent,null);
 nameTransportAgents(binding.api,id=>id===peer?'notekeeper':null);assert.equal(binding.api.status().connections[0].agent,'notekeeper');assert.equal(reports.at(-1).connections[0].agent,'notekeeper');
 nameTransportAgents(binding.api,()=>'Not A Handle <b>');assert.equal(binding.api.status().connections[0].agent,null);
 nameTransportAgents(binding.api,()=>{throw Error('roster');});assert.equal(binding.api.status().connections[0].agent,null);
 nameTransportAgents(binding.api,null);assert.equal(reads,1);assert.equal(JSON.stringify(binding.api.status()).includes(peer),false);
 const link=binding.api.status().connections[0];assert.equal(link.kind,'relay');assert.equal(link.reason,'direct_failed');assert.equal(link.sentBytes,5);assert.equal(link.receivedBytes,7);
});
