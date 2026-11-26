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
test('links are named locally from the agent roster and the owner admission state, without another diagnostics read',async()=>{
 let reads=0,stateCalls=0;const agent='a'.repeat(64),own='b'.repeat(64),creator='c'.repeat(64),friend='d'.repeat(64),stranger='e'.repeat(64),self='f'.repeat(64);
 const notices=new Set();const admitted=Date.UTC(2026,10,3);
 const state={accounts:['acct-owner'],members:[{publicKey:self,self:true,via:'attested',subject:'device',label:'Browser device',accountId:'acct-owner'},
  {publicKey:own,via:'attested',subject:'device',label:'Browser device',accountId:'acct-owner',email:'owner@example.test',activation:BigInt(admitted),administrator:true},
  {publicKey:agent,via:'attested',subject:'agent',label:'@notekeeper',accountId:'acct-owner',administrator:false},
  {publicKey:creator,via:'creator',subject:'creator',label:'Page creator'},
  {publicKey:friend,via:'invited',subject:'device',label:'Browser device',accountId:'acct-friend',email:'friend@example.test'}]};
 const peers=[agent,own,creator,friend,stranger];
 const source={status:{phase:'connected',connectedPeers:peers,connectionRevision:0},onStatus(fn){fn(this.status);return()=>{};},
  async diagnostics(){reads++;return peers.map((peerId,index)=>({connectionId:'c'+index,peerId,kind:'direct',sentReliableBytes:5,receivedReliableBytes:7}));},
  extensions:{async call(name){stateCalls++;assert.equal(name,'admission.state');return state;},subscribe(fn){notices.add(fn);return()=>notices.delete(fn);}}};
 const binding=createTransportBinding(),reports=[];binding.api.onChange(report=>reports.push(report));binding.api.install(source);
 assert.equal(stateCalls,0);assert.equal(notices.size,1);
 await binding.api.refresh();assert.equal(reads,1);assert.equal(stateCalls,1);
 nameTransportAgents(binding.api,()=>[{handle:'notekeeper',public_key:agent}]);
 const names=binding.api.status().connections.map(link=>link.peer);
 assert.deepEqual(names.map(peer=>peer.role),['agent','own-device','own-device','member','unknown']);
 assert.equal(names[0].handle,'notekeeper');assert.equal(names[0].administrator,false);assert.equal(names[1].administrator,true);assert.equal(names[3].administrator,false);assert.equal(names[4].administrator,null);assert.match(names[1].label,/^added .*2026/);assert.equal(names[2].label,'created this page');assert.equal(names[3].email,'friend@example.test');
 for(const key of peers)assert.equal(JSON.stringify(binding.api.status()).includes(key),false);
 // A pushed membership change renames cached links with no diagnostics read.
 for(const fn of notices)fn({topic:'admission',state:{...state,members:state.members.filter(member=>member.publicKey!==friend)}});
 assert.equal(binding.api.status().connections[3].peer.role,'unknown');assert.equal(reads,1);
 // Without a roster the signed membership still says it is an agent, just without a handle.
 nameTransportAgents(binding.api,()=>{throw Error('roster');});assert.deepEqual(binding.api.status().connections[0].peer,{role:'agent',handle:'notekeeper',label:null,email:null,administrator:false});
 binding.suspend();assert.equal(notices.size,0);binding.resume();assert.equal(notices.size,1);
});
test('a creator viewer owns the page admission accounts, even when there are several',async()=>{
 const {describeTransportPeer}=await import('data:text/javascript;base64,'+Buffer.from((await build({entryPoints:[new URL('../src/transport-peers.ts',import.meta.url).pathname],bundle:true,format:'esm',platform:'node',write:false})).outputFiles[0].text).toString('base64'));
 const self='1'.repeat(64),phone='2'.repeat(64),friend='3'.repeat(64);
 const admission={accounts:['acct-owner','acct-owner-alias'],members:[{publicKey:self,self:true,via:'creator',subject:'creator',label:'Page creator',administrator:true},
  {publicKey:phone,via:'attested',subject:'device',label:'Browser device',accountId:'acct-owner',email:'owner@example.test',administrator:true},
  {publicKey:friend,via:'invited',subject:'device',label:'Browser device',accountId:'acct-friend',email:'friend@example.test',administrator:false}]};
 assert.equal(describeTransportPeer(phone,{agents:[],admission}).role,'own-device');
 assert.deepEqual(describeTransportPeer(friend,{agents:[],admission}),{role:'member',email:'friend@example.test',administrator:false});
});
test('a member that is not the viewer\'s account is never called the viewer\'s device',async()=>{
 const {describeTransportPeer}=await import('data:text/javascript;base64,'+Buffer.from((await build({entryPoints:[new URL('../src/transport-peers.ts',import.meta.url).pathname],bundle:true,format:'esm',platform:'node',write:false})).outputFiles[0].text).toString('base64'));
 const other='1'.repeat(64),creator='2'.repeat(64),self='3'.repeat(64);
 // An invited viewer: the page creator and the owner's devices belong to someone else.
 const admission={accounts:['acct-owner'],members:[{publicKey:self,self:true,via:'invited',subject:'device',accountId:'acct-guest',email:'guest@example.test'},
  {publicKey:creator,via:'creator',subject:'creator',label:'Page creator'},{publicKey:'4'.repeat(64),via:'attested',subject:'agent',label:'Agent'},{publicKey:other,via:'attested',subject:'device',accountId:'acct-owner',email:'owner@example.test'}]};
 assert.deepEqual(describeTransportPeer(other,{agents:[],admission}),{role:'member',email:'owner@example.test',administrator:false});
 assert.deepEqual(describeTransportPeer(creator,{agents:[],admission}),{role:'member',email:null,administrator:false});
 assert.equal(describeTransportPeer(self,{agents:[],admission}),null);
 assert.deepEqual(describeTransportPeer('4'.repeat(64),{agents:[],admission}),{role:'agent',handle:null,administrator:false});
 assert.equal(describeTransportPeer('9'.repeat(64),{agents:[],admission:null}),null);
});
