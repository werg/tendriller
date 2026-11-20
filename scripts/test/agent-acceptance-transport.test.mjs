import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeRelaySockets } from '../agent-acceptance/transport-probe.mjs';

test('relay probe requires both actual paired lanes and binary traffic, and forgets closed transports without recording secrets', () => {
  class Socket extends EventTarget {
    readyState = 1;
    send() {}
    message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const deviceId = 'aa'.repeat(32), remoteDeviceId = 'bb'.repeat(32), records = [];
  const api = 'https://staging.example/api/t/' + 'a'.repeat(12);
  const Observed = observeRelaySockets(Socket, { api, deviceId, remoteDeviceId, record: value => records.push(value) });
  const route = lane => api.replace('https:', 'wss:') + '/peers/relay?channel=private-channel&peerId=' + deviceId + '&remotePeerId=' + remoteDeviceId + '&lane=' + lane + '&token=NEVER_RECORD';
  const reliable = new Observed(route('reliable'), ['PRIVATE_AUTH']), live = new Observed(route('live'), ['PRIVATE_AUTH']);
  const ready = (socket, lane, remote = remoteDeviceId) => socket.message(JSON.stringify({ t: 'ready', version: 1, lane, peerId: deviceId, remotePeerId: remote, session: 'a'.repeat(36) }));
  ready(reliable, 'reliable'); ready(live, 'live', deviceId);
  reliable.send(new Uint8Array([1])); reliable.message(new ArrayBuffer(2));
  assert.equal(records.at(-1).transport, null, 'a fabricated or different remote is not paired');
  ready(live, 'live'); assert.equal(records.at(-1).transport, 'websocket-relay');
  reliable.message('PRIVATE_APPLICATION_TEXT');
  const serialized = JSON.stringify(records);
  for (const privateText of ['NEVER_RECORD', 'PRIVATE_AUTH', 'private-channel', 'PRIVATE_APPLICATION_TEXT', 'wss:']) assert(!serialized.includes(privateText));
  reliable.close(); assert.equal(records.at(-1).transport, null);
  assert.equal(records.at(-1).deviceId, deviceId); assert.equal(records.at(-1).remoteDeviceId, remoteDeviceId);
});

test('relay construction, wrong application, or mismatched session never establishes a measured transport', () => {
  class Socket extends EventTarget { readyState = 1; send() {} }
  const deviceId = 'aa'.repeat(32), remoteDeviceId = 'bb'.repeat(32), records = [];
  const Observed = observeRelaySockets(Socket, { api: 'https://staging.example/api/t/' + 'a'.repeat(12), deviceId, remoteDeviceId, record: value => records.push(value) });
  new Observed('wss://other.example/api/t/' + 'a'.repeat(12) + '/peers/relay'); assert.equal(records.length, 0);
  const route = lane => 'wss://staging.example/api/t/' + 'a'.repeat(12) + '/peers/relay?channel=x&peerId=' + deviceId + '&remotePeerId=' + remoteDeviceId + '&lane=' + lane;
  const reliable = new Observed(route('reliable')), live = new Observed(route('live'));
  assert.equal(records.at(-1).transport, null);
  for (const [socket, lane, session] of [[reliable, 'reliable', 'a'.repeat(36)], [live, 'live', 'b'.repeat(36)]])
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'ready', version: 1, lane, peerId: deviceId, remotePeerId: remoteDeviceId, session }) }));
  reliable.send(new Uint8Array(1)); reliable.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(1) }));
  assert.equal(records.at(-1).transport, null);
});
