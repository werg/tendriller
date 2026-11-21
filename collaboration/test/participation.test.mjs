import test from 'node:test';
import assert from 'node:assert/strict';
import { participateApplication, PEER_TRANSPORT_POLICY } from '../../session/participation.mjs';
const a='ab'.repeat(32),b='cd'.repeat(32);
function fixture(openDirectConnection) {
  const calls=[],events=[];
  const peers=Object.fromEntries(['watchDiscovery','discover','advertise','withdraw','listenInvitations'].map(name=>[name,()=>{throw Error('Unexpected host work');}]));
  Object.assign(peers,{rendezvous(){calls.push('signaling');return {ready:Promise.resolve({role:'offerer'}),close(){calls.push('close-signaling');}};},invite:async()=>{},relay(){calls.push('relay');throw Error('Direct traffic must not use the relay');}});
  let options;const result={signal:new AbortController().signal};
  const session={deviceId:a,participate(value){options=value;return result;}};
  assert.equal(participateApplication(session,{peers,control:{},openDirectConnection,onTransport:e=>events.push(e)}),result);
  return{calls,events,options};
}
test('one default policy supplies STUN and a bounded RTC attempt without host work during construction',async()=>{
  let received;const connection={close(){}};const f=fixture(async options=>{received=options;return connection;});
  assert.deepEqual(f.calls,[]);
  assert.equal(await f.options.transport.open({peer:{identity:b,route:{kind:'invitation',peerId:b}}},{signal:new AbortController().signal}),connection);
  assert.equal(received.configuration,PEER_TRANSPORT_POLICY.configuration);assert.equal(received.timeoutMs,PEER_TRANSPORT_POLICY.directTimeoutMs);
  assert.deepEqual(f.calls,['signaling','close-signaling']);assert.deepEqual(f.events,[{peerId:b,kind:'direct'}]);
  assert.equal(Object.isFrozen(PEER_TRANSPORT_POLICY.configuration.iceServers[0]),true);
  assert.ok(PEER_TRANSPORT_POLICY.configuration.iceServers.every(x=>!x.urls.startsWith('turn:')));
});
test('a platform adapter is required; application code cannot accidentally ship a missing direct opener',()=>{
  assert.throws(()=>participateApplication({participate(){}},{peers:{},control:{}}),{code:'PEER_TRANSPORT_REQUIRED'});
});
