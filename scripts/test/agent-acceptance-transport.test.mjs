import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeRelaySockets } from '../agent-acceptance/transport-probe.mjs';
import { relayTransportMeasurement } from '../agent-acceptance/observer-data.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('relay probe requires both actual paired lanes and binary traffic, and forgets closed transports without recording secrets', () => {
  class Socket extends EventTarget {
    readyState = 1;
    send() {}
    message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const deviceId = 'aa'.repeat(32), remoteDeviceId = 'bb'.repeat(32), records = [];
  const api = 'https://staging.example/api/agent/pages/' + 'a'.repeat(12);
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
  const Observed = observeRelaySockets(Socket, { api: 'https://staging.example/api/agent/pages/' + 'a'.repeat(12), deviceId, remoteDeviceId, record: value => records.push(value) });
  new Observed('wss://other.example/api/agent/pages/' + 'a'.repeat(12) + '/peers/relay'); assert.equal(records.length, 0);
  const route = lane => 'wss://staging.example/api/agent/pages/' + 'a'.repeat(12) + '/peers/relay?channel=x&peerId=' + deviceId + '&remotePeerId=' + remoteDeviceId + '&lane=' + lane;
  const reliable = new Observed(route('reliable')), live = new Observed(route('live'));
  assert.equal(records.at(-1).transport, null);
  for (const [socket, lane, session] of [[reliable, 'reliable', 'a'.repeat(36)], [live, 'live', 'b'.repeat(36)]])
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'ready', version: 1, lane, peerId: deviceId, remotePeerId: remoteDeviceId, session }) }));
  reliable.send(new Uint8Array(1)); reliable.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(1) }));
  assert.equal(records.at(-1).transport, null);
});

test('observer validates protocol, live process binding, peer identities, freshness and actual paired traffic', () => {
  const expected = { process: { pid: 42, birth: '123' }, pageId: 'a'.repeat(12), deviceId: 'aa'.repeat(32), remoteDeviceId: 'bb'.repeat(32), at: Date.now() };
  const record = { protocol: 'tendriller-relay-observation-v1', pid: 42, birth: '123', pageId: expected.pageId,
    deviceId: expected.deviceId, remoteDeviceId: expected.remoteDeviceId, observedAt: new Date(expected.at).toISOString(), transport: 'websocket-relay',
    pairs: [[{ lane: 'reliable', open: true, paired: true, closed: false, session: 'a'.repeat(36), sent: 1, received: 1 },
      { lane: 'live', open: true, paired: true, closed: false, session: 'a'.repeat(36), sent: 0, received: 0 }]] };
  assert.equal(relayTransportMeasurement(record, expected).transport, 'websocket-relay');
  for (const [key, value] of Object.entries({ protocol: 'invented', pid: 43, birth: '124', pageId: 'b'.repeat(12),
    deviceId: expected.remoteDeviceId, remoteDeviceId: expected.deviceId, observedAt: new Date(expected.at - 5001).toISOString() }))
    assert.throws(() => relayTransportMeasurement({ ...record, [key]: value }, expected), undefined, key);
  assert.throws(() => relayTransportMeasurement({ ...record, observedAt: new Date(expected.at + 1001).toISOString() }, expected));
  for (const change of [r => { r.pairs[0][0].closed = true; }, r => { r.pairs[0][0].received = 0; }, r => { r.pairs[0][1].session = 'b'.repeat(36); }]) {
    const altered = structuredClone(record); change(altered); assert.throws(() => relayTransportMeasurement(altered, expected));
  }
  assert.throws(() => relayTransportMeasurement('websocket-relay', expected));
});

test('failed close invalidation terminates the instrumented process so a stale positive cannot qualify as live', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-write-failure-')), output = join(directory, 'transport.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { observeRelaySockets } from ${JSON.stringify(new URL('../agent-acceptance/transport-probe.mjs', import.meta.url).href)};
    import { writeFileSync } from 'node:fs';
    class Socket extends EventTarget { readyState = 1; send() {} }
    let fail = false;
    const deviceId = 'aa'.repeat(32), remoteDeviceId = 'bb'.repeat(32);
    const Observed = observeRelaySockets(Socket, { api: 'https://staging.example/api/agent/pages/aaaaaaaaaaaa', deviceId, remoteDeviceId,
      onFailure: () => process.exit(74), record: value => { if (fail) throw Error('write failed'); writeFileSync(${JSON.stringify(output)}, JSON.stringify(value)); } });
    const route = lane => 'wss://staging.example/api/agent/pages/aaaaaaaaaaaa/peers/relay?channel=x&peerId=' + deviceId + '&remotePeerId=' + remoteDeviceId + '&lane=' + lane;
    const reliable = new Observed(route('reliable')), live = new Observed(route('live'));
    for (const [socket, lane] of [[reliable, 'reliable'], [live, 'live']]) socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'ready', version: 1, lane, peerId: deviceId, remotePeerId: remoteDeviceId, session: 'a'.repeat(36) }) }));
    reliable.send(new Uint8Array(1)); reliable.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(1) }));
    fail = true; reliable.dispatchEvent(new Event('close'));
    process.exit(99);
  `], { timeout: 5000, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(child.status, 74); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
  assert.equal(JSON.parse(readFileSync(output)).transport, 'websocket-relay');
  assert.equal(existsSync('/proc/' + child.pid), false, 'observer process measurement rejects the stale file because its owner is gone');
});
