import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:[new URL('../src/transport.ts',import.meta.url).pathname],bundle:true,format:'esm',platform:'node',write:false});
const {createTransportBinding}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('runtime registration is one local source, survives BFCache observation, and never starts a read by itself',async()=>{
 let subscriptions=0,reads=0;
 const source={status:{phase:'connected',connectedPeers:['a'.repeat(64)],connectionRevision:0},onStatus(fn){subscriptions++;fn(this.status);return()=>subscriptions--;},async diagnostics(){reads++;return[{peerId:'a'.repeat(64),kind:'direct',sentBytes:0,receivedBytes:0}];}};
 const binding=createTransportBinding(),reports=[];const off=binding.api.onChange(report=>reports.push(report));
 assert.equal(binding.api.status().state,'unavailable');binding.api.install(source);binding.api.install(source);
 assert.equal(subscriptions,1);assert.equal(reads,0);assert.throws(()=>binding.api.install({...source}),/TRANSPORT_ALREADY_INSTALLED/);
 await binding.api.refresh();assert.equal(reads,1);assert.equal(binding.api.status().connections[0].sentBytes,0);
 binding.suspend();binding.suspend();assert.equal(subscriptions,0);await binding.api.refresh();assert.equal(reads,1);
 binding.resume();binding.resume();assert.equal(subscriptions,1);assert.equal(reads,1);assert.equal(binding.api.status().sampled,false);
 assert(reports.length>=3);off();binding.suspend();assert.equal(subscriptions,0);
});
