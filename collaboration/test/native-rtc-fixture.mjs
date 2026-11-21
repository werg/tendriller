import assert from 'node:assert/strict';
import { participateNativeApplication } from '../native-rtc.mjs';
function inbox() {
  const values = [], waiters = []; let closed = false;
  return { push(value) { const waiter = waiters.shift(); if (waiter) waiter({ value, done: false }); else values.push(value); },
    close() { closed = true; for (const waiter of waiters.splice(0)) waiter({ done: true }); },
    [Symbol.asyncIterator]() { return { next: () => values.length ? Promise.resolve({ value: values.shift(), done: false }) : closed ? Promise.resolve({ done: true }) : new Promise(resolve => waiters.push(resolve)) }; } };
}
const ids = ['ab'.repeat(32), 'cd'.repeat(32)], queues = [inbox(), inbox()];
const observations = [], sent = [], stop = new AbortController(); let relayCalls = 0;
const unused = () => { throw Error('Discovery is owned by the session, outside this platform fixture'); };
const peers = {
  watchDiscovery: unused, discover: unused, advertise: unused, withdraw: unused, listenInvitations: unused, invite: unused,
  rendezvous(_channel, identity) {
    const index = ids.indexOf(identity); assert.ok(index >= 0);
    return { ready: Promise.resolve({ role: index ? 'answerer' : 'offerer' }), messages: queues[index],
      async send(value) { sent.push(value.type); queues[1-index].push(value); }, close() { queues[index].close(); } };
  },
  relay() { relayCalls++; throw Error('Expected actual native direct RTC'); },
};
// Deliberately use the real shipping Cloudflare STUN configuration.
const policy = { native: { iceUseIpv6: false, iceAdditionalHostAddresses: ['127.0.0.1'] } };
const ports = ids.map(deviceId => {
  const session = { deviceId, participate(options) { assert.equal(options.control, 'owned-control'); return options; } };
  return participateNativeApplication(session, { ...policy, peers, control: 'owned-control', onTransport: value => observations.push(value) });
});
const opening = ports.map((value, i) => value.transport.open({ peer: { identity: ids[1-i], route: { kind: 'rendezvous', channel: 'native-fixture' } } }, { signal: stop.signal }));
try {
  const pair = await Promise.all(opening);
  const readers = pair.map(connection => connection.frames()[Symbol.asyncIterator]());
  await Promise.all([pair[0].send(new Uint8Array([1, 2, 3])), pair[1].send(new Uint8Array([4, 5]))]);
  assert.deepEqual((await readers[1].next()).value, new Uint8Array([1, 2, 3]));
  assert.deepEqual((await readers[0].next()).value, new Uint8Array([4, 5]));
  assert.deepEqual(sent.sort(), ['answer', 'offer']); assert.equal(relayCalls, 0);
  assert.equal(observations.length, 2); assert.ok(observations.every(value => value.kind === 'direct'));
  await Promise.all(pair.map(connection => connection.close()));
  await Promise.all(readers.map(reader => reader.return?.()));
  assert.ok(pair.every(connection => connection.signal.aborted));
} finally {
  stop.abort();
  const results = await Promise.allSettled(opening);
  await Promise.allSettled(results.filter(value => value.status === 'fulfilled').map(value => value.value.close()));
}
// Cancellation uses the actual native opener, and must not enter fallback after stop.
const cancelled = new AbortController(), offered = Promise.withResolvers(), waiting = inbox();
const session = { deviceId: ids[0], participate(options) { return options; } };
const cancelledPorts = participateNativeApplication(session, { ...policy, control: 'owned-control', peers: {
  ...peers, rendezvous() { return { ready: Promise.resolve({ role: 'offerer' }), messages: waiting,
    async send() { offered.resolve(); }, close() { waiting.close(); } }; },
} });
const pending = cancelledPorts.transport.open({ peer: { identity: ids[1], route: { kind: 'rendezvous', channel: 'cancel-fixture' } } }, { signal: cancelled.signal });
const reason = Error('fixture cancelled');
const rejected = assert.rejects(pending, error => error === reason);
await offered.promise; cancelled.abort(reason); await rejected;
assert.equal(relayCalls, 0);
console.log(JSON.stringify({ passed: true, direct: 2, bidirectional: true, cancelled: true, relayCalls }));
// No forced exit: the test requires all native RTC sockets and timers to drain.
