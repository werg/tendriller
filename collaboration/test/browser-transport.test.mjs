import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { rootLifetimeLockName } from '../root-lifetime.mjs';
import { BROWSER_OWNER_PROTOCOL, createBroadcastOwner, createBroadcastEndpoint } from '../browser-transport.mjs';

async function until(predicate, description = 'condition', timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() > end) throw Error(`Timed out: ${description}`); await new Promise(setImmediate); }
}
async function fixture({ timeoutMs = 200, maxRoutes = 32, silent = false, onRequest, idleTimeoutMs = 60000 } = {}) {
  const witnesses = new Map(); let queries = 0;
  let query = async () => ({ held: [...witnesses.values()], pending: [] });
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    query() { queries++; return query(); },
    async request(name, _options, run) {
      if (witnesses.has(name)) return run(null);
      const witness = { name, mode: 'exclusive', clientId: crypto.randomUUID() }; witnesses.set(name, witness);
      try { return await run({ name }); } finally { if (witnesses.get(name) === witness) witnesses.delete(name); }
    },
  } } });
  const profileId = crypto.randomUUID(), channelName = `test:${profileId}`;
  const ownerChannel = new BroadcastChannel(channelName), observer = new BroadcastChannel(channelName);
  const traffic = [], accepted = [], clients = [], ports = new Set(); let attachments = 0;
  observer.addEventListener('message', ({ data }) => traffic.push(data));
  const owner = { ownerInstanceId: crypto.randomUUID(), attach(endpoint) {
    const listen = ({ data }) => {
      const port = data.port, endpointId = crypto.randomUUID(); attachments++; ports.add(port);
      port.addEventListener('message', ({ data: frame }) => {
        accepted.push({ endpointId, frame });
        if (onRequest) onRequest({ port, frame, endpointId });
        else port.postMessage({ id: frame.id, value: frame.value, endpointId });
      }); port.start(); if (!silent) port.postMessage({ ready: { endpointId, context: data.handshake.context } });
    };
    endpoint.addEventListener('message', listen);
    return () => { endpoint.removeEventListener('message', listen); for (const port of ports) port.unref?.(); };
  } };
  const bridge = await createBroadcastOwner(ownerChannel, owner, { profileId, timeoutMs, maxRoutes, idleTimeoutMs });
  bridge.announce(); await until(() => traffic.some(frame => frame.type === 'ready'), 'owner announcement');
  const announcement = traffic.find(frame => frame.type === 'ready');
  async function attach({ waitReady = true, ...options } = {}) {
    const channel = new BroadcastChannel(channelName), pair = new MessageChannel(), frames = [], replacements = [];
    const endpoint = createBroadcastEndpoint(channel, announcement, { profileId, livenessTimeoutMs: 1000,
      onReplaced: value => replacements.push(value), ...options });
    const record = { channel, endpoint, port: pair.port1, frames, replacements };
    clients.push(record); pair.port1.addEventListener('message', ({ data }) => frames.push(data)); pair.port1.start();
    endpoint.postMessage({ protocol: 'chronolog/peer-session/owner/v2', handshake: { context: { viewId: `private-view-${clients.length}` } }, port: pair.port2 });
    record.waitReady = async () => {
      await until(() => frames.some(frame => frame.ready), 'private facade handshake');
      record.route = traffic.filter(frame => frame.type === 'hello').at(-1).route;
    };
    if (waitReady) await record.waitReady();
    record.send = async (id, value) => {
      pair.port1.postMessage({ id, value }); await until(() => frames.some(frame => frame.id === id), 'private response');
      return frames.find(frame => frame.id === id);
    };
    record.park = async () => {
      record.endpoint.suspend();
      const id = crypto.randomUUID(); pair.port1.postMessage({ id, method: 'endpoint.suspend' });
      await until(() => frames.some(frame => frame.id === id), 'owner accepted suspension');
    };
    return record;
  }
  return { profileId, channelName, ownerChannel, observer, traffic, accepted, bridge, announcement, attach,
    witnesses, get queries() { return queries; }, setQuery(value) { query = value; },
    get attachments() { return attachments; },
    async close() {
      for (const client of clients) { await client.endpoint.close(); client.port.close(); client.channel.close(); }
      await bridge.close(); ownerChannel.close(); observer.close(); for (const port of ports) port.close();
      if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
    } };
}

test('private route handshakes and structured facade values stay confidential between siblings', async t => {
  const f = await fixture(); t.after(() => f.close());
  const left = await f.attach(), right = await f.attach();
  const value = { secret: 'not-visible-on-the-broadcast-channel', bytes: Uint8Array.of(0, 255, 7), count: 7n,
    zero: -0, nan: NaN, infinity: Infinity, absent: undefined, array: [null, false, 'text'] };
  assert.deepEqual((await left.send(1, value)).value, value);
  assert.deepEqual((await right.send(1, { other: true })).value, { other: true });
  assert.notEqual(f.accepted[0].endpointId, f.accepted[1].endpointId);
  assert.ok(!JSON.stringify(f.traffic).includes(value.secret));
  assert.ok(!JSON.stringify(f.traffic).includes('private-view'));
  assert.equal(f.bridge.routes, 2);
});

test('observed route identifiers do not permit forgery, replay, reflection, or replacing a pinned owner', async t => {
  const f = await fixture(); t.after(() => f.close());
  const left = await f.attach(), right = await f.attach();
  await left.send(1, 'original');
  const outgoing = f.traffic.filter(frame => frame.type === 'sealed' && frame.route === left.route && frame.direction === 'owner');
  const original = outgoing.at(-1), reply = f.traffic.filter(frame => frame.type === 'sealed' && frame.route === left.route && frame.direction === 'client').at(-1);
  for (const frame of outgoing) f.observer.postMessage(frame);
  const corrupted = structuredClone(original); corrupted.sequence++; corrupted.ciphertext[0] ^= 1; f.observer.postMessage(corrupted);
  f.observer.postMessage({ ...original, route: right.route, sequence: 3 });
  f.observer.postMessage({ ...reply, direction: 'owner', sequence: original.sequence + 1 });
  f.observer.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'frame', direction: 'owner', ownerInstanceId: f.announcement.ownerInstanceId,
    route: left.route, frame: { id: 900, value: 'forged' } });
  f.observer.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'frame', direction: 'client', ownerInstanceId: f.announcement.ownerInstanceId,
    route: left.route, frame: { ended: { code: 'ENDPOINT_STALE' } } });
  f.observer.postMessage({ ...f.announcement, ownerInstanceId: crypto.randomUUID() });
  f.observer.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'retired', ownerInstanceId: f.announcement.ownerInstanceId, route: left.route });
  assert.equal((await left.send(2, 'left-still-valid')).value, 'left-still-valid');
  assert.equal((await right.send(2, 'right-still-valid')).value, 'right-still-valid');
  assert.deepEqual(f.accepted.map(value => value.frame.value), ['original', 'left-still-valid', 'right-still-valid']);
  assert.equal(left.frames.some(frame => frame.ended), false); assert.equal(left.replacements.length, 0);
});

test('a recorded hello and ciphertext cannot resurrect a retired route or replay its commands', async t => {
  const f = await fixture(); t.after(() => f.close()); const client = await f.attach();
  await client.send(1, 'saved-before-detach');
  const hello = f.traffic.find(frame => frame.type === 'hello' && frame.route === client.route);
  const oldFrames = f.traffic.filter(frame => frame.type === 'sealed' && frame.route === client.route && frame.direction === 'owner');
  const oldWelcome = f.traffic.find(frame => frame.type === 'welcome' && frame.route === client.route);
  await client.endpoint.close(); await until(() => f.bridge.routes === 0, 'detached route');
  f.observer.postMessage(hello);
  await until(() => f.traffic.filter(frame => frame.type === 'welcome' && frame.route === client.route).length === 2, 'fresh challenge');
  const freshWelcome = f.traffic.filter(frame => frame.type === 'welcome' && frame.route === client.route).at(-1);
  assert.notDeepEqual(freshWelcome.ciphertext, oldWelcome.ciphertext);
  for (const frame of oldFrames) f.observer.postMessage(frame);
  await until(() => f.bridge.routes === 0, 'unproved replay timeout');
  assert.equal(f.attachments, 1); assert.equal(f.accepted.length, 1);
});

test('a crashed owner expires the facade; suspension pauses liveness without claiming ownership', async t => {
  const f = await fixture(); t.after(() => f.close()); const client = await f.attach({ livenessTimeoutMs: 150 });
  await client.send(1, 'retained-operation'); client.endpoint.suspend(); f.ownerChannel.close();
  await delay(230); assert.equal(client.frames.some(frame => frame.ended), false);
  await assert.rejects(client.endpoint.resume(), /OWNER_UNREACHABLE/); await until(() => client.frames.some(frame => frame.ended), 'owner crash timeout');
  assert.equal(client.frames.find(frame => frame.ended).ended.code, 'OWNER_UNREACHABLE');
  assert.equal(client.replacements.length, 1); assert.equal(f.accepted.length, 1);
  await assert.rejects(client.endpoint.resume(), /ENDPOINT_STALE/);
});

test('an unresponsive facade handshake times out without exposing its context to broadcasts', async t => {
  const f = await fixture({ silent: true }); t.after(() => f.close());
  const channel = new BroadcastChannel(f.channelName), endpoint = createBroadcastEndpoint(channel, f.announcement, { profileId: f.profileId });
  t.after(async () => { await endpoint.close(); channel.close(); });
  await assert.rejects(connectApplicationOwner(endpoint, { applicationId: 'a'.repeat(64), definitionId: 'absent', definitionVersion: '1',
    context: { viewId: 'private-timeout-context' }, timeoutMs: 150 }), /TIMEOUT/);
  assert.ok(!JSON.stringify(f.traffic).includes('private-timeout-context'));
});

test('synchronous pagehide release is scoped to one route and cannot be replayed against siblings or a new handshake', async t => {
  const f = await fixture(); t.after(() => f.close());
  const departing = await f.attach(), sibling = await f.attach();
  await departing.send(1, 'before-navigation');
  assert.equal(f.traffic.some(frame => frame.type === 'release'), false);
  f.observer.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'release', ownerInstanceId: f.announcement.ownerInstanceId,
    route: sibling.route, token: crypto.getRandomValues(new Uint8Array(32)) });
  assert.equal((await sibling.send(1, 'unforgeable-release')).value, 'unforgeable-release');
  assert.equal(departing.endpoint.relinquish(), undefined);
  await until(() => f.bridge.routes === 1 && f.traffic.some(frame => frame.type === 'release'), 'synchronous scoped release');
  const release = f.traffic.find(frame => frame.type === 'release');
  f.observer.postMessage({ ...release, route: sibling.route });
  f.observer.postMessage(release);
  assert.equal((await sibling.send(2, 'sibling-stays-live')).value, 'sibling-stays-live');
  const hello = f.traffic.find(frame => frame.type === 'hello' && frame.route === departing.route);
  f.observer.postMessage(hello);
  await until(() => f.bridge.routes === 2, 'fresh challenge after retired hello replay');
  f.observer.postMessage(release);
  await sibling.send(3, 'fresh-handshake-does-not-inherit-release');
  assert.equal(f.bridge.routes, 2);
  await until(() => f.bridge.routes === 1, 'unproved fresh handshake expiry');
  const replacement = await f.attach(); f.observer.postMessage({ ...release, route: replacement.route });
  assert.equal((await replacement.send(1, 'replacement-stays-live')).value, 'replacement-stays-live');
});

test('a burst of many signal-sized frames queues on the fallback route instead of retiring or stalling it', async t => {
  // This is a delivery/ordering check, not a crypto throughput benchmark.
  // Keep its fixture leases generous under parallel test/crypto load; the
  // virtual-clock tests below retain the exact negative liveness fences.
  const f = await fixture({ timeoutMs: 30000 }); t.after(() => f.close());
  const client = await f.attach({ livenessTimeoutMs: 30000 }), piece = 'x'.repeat(15_000);
  // An application reply of 200 pieces, posted without waiting, as an owner forwards live signals.
  for (let id = 1; id <= 200; id++) client.port.postMessage({ id, value: piece });
  await until(() => client.frames.filter(frame => frame.id).length === 200, 'all 200 replies', 30000);
  assert.deepEqual(client.frames.filter(frame => frame.id).map(frame => frame.id), Array.from({ length: 200 }, (_value, index) => index + 1));
  assert.deepEqual(client.replacements, []); assert.equal(f.bridge.routes, 1);
});


function virtualClock(t) {
  let time = 0;
  t.mock.method(performance, 'now', () => time);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return async ms => {
    while (ms > 0) {
      const step = Math.min(ms, 1000); ms -= step; time += step;
      t.mock.timers.tick(step);
      await new Promise(setImmediate);
    }
  };
}
function pauseOwnerOutput(f, t) {
  const queued = [], send = f.ownerChannel.postMessage.bind(f.ownerChannel);
  t.mock.method(f.ownerChannel, 'postMessage', value => queued.push(value));
  return { queued, flush() { for (const packet of queued.splice(0)) send(packet); } };
}

for (const mode of ['finite', 'hung', 'passive', 'continuous', 'replay', 'late']) {
  test(`virtual elected liveness: ${mode} preserves the authenticated bounded fence`, async t => {
    const advance = virtualClock(t);
    let response;
    const f = await fixture({ onRequest: value => {
      if (value.frame.value === 'liveness baseline') value.port.postMessage({ id: value.frame.id, value: value.frame.value });
      else response = value;
    } });
    t.after(async () => { t.mock.timers.reset(); await f.close(); });
    const client = await f.attach({ livenessTimeoutMs: 15000, requestTimeoutMs: 30000 });
    // This authenticated response follows the opening ping in the encrypted
    // queues. Drain it before pausing output or advancing the virtual clock.
    await client.send(9999, 'liveness baseline');
    let request = ['finite', 'hung', 'continuous'].includes(mode) ? { startedAt: 0, deadline: 30000 } : null;
    client.endpoint.bindRequestSource({ get boundedRequest() { return request; } });
    const replay = f.traffic.find(packet => packet.type === 'sealed' && packet.direction === 'owner');
    assert.ok(replay);
    const output = pauseOwnerOutput(f, t);
    client.port.postMessage({ id: 1, value: 'held' });
    await until(() => response, 'owner received private request');
    for (let second = 1; second <= (mode === 'late' ? 40 : mode === 'finite' ? 17 : ['hung', 'continuous'].includes(mode) ? 30 : 15); second++) {
      if (mode === 'late' && second === 10) request = { startedAt: 10000, deadline: 40000 };
      if (mode === 'continuous' && second >= 6 && second < 30) {
        // Keep the initial call through the first 5s pulse. Replacing it before
        // that sample would legitimately select a later first grace window.
        request = { startedAt: second * 1000, deadline: second * 1000 + 30000 };
        client.port.postMessage({ id: second + 1, value: 'new caller request' });
        // A caller can copy route/owner IDs, but cannot supply authenticated progress.
        f.observer.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'frame', ownerInstanceId: f.announcement.ownerInstanceId,
          route: client.route, frame: { id: second, value: 'fake reply' } });
        await until(() => response?.frame.id === second + 1, 'owner received replacement request');
      }
      if (mode === 'replay') f.observer.postMessage(replay);
      await advance(1000);
      if (second < (mode === 'late' ? 40 : ['hung', 'continuous'].includes(mode) ? 30 : 15) || mode === 'finite') {
        assert.equal(client.frames.some(frame => frame.ended), false);
      }
    }
    if (mode === 'finite') {
      request = null;
      response.port.postMessage({ id: 1, value: 'finished at17s' });
      await until(() => output.queued.length >= 4, 'queued authenticated reply');
      output.flush();
      await until(() => client.frames.some(frame => frame.id === 1), 'finite reply');
      assert.equal(client.frames.find(frame => frame.id === 1).value, 'finished at17s');
      assert.equal(client.frames.some(frame => frame.ended), false);
    } else {
      await until(() => client.frames.some(frame => frame.ended), 'bounded liveness termination');
      assert.equal(client.frames.find(frame => frame.ended).ended.code, 'OWNER_UNREACHABLE');
      assert.equal(client.replacements.length, 1);
    }
  });
}

test('virtual elected resume needs real owner evidence after a long suspension', async t => {
  const advance = virtualClock(t), f = await fixture();
  t.after(async () => { t.mock.timers.reset(); await f.close(); });
  const client = await f.attach({ livenessTimeoutMs: 15000 });
  client.endpoint.suspend(); await advance(45000);
  assert.equal(client.frames.some(frame => frame.ended), false);
  await client.endpoint.resume();
  await client.send(1, 'resumed-original-route');
  assert.equal(client.frames.some(frame => frame.ended), false);
});

test('virtual elected repeated resume cannot keep a silent owner alive; close fences the probe', async t => {
  const advance = virtualClock(t), f = await fixture();
  t.after(async () => { t.mock.timers.reset(); await f.close(); });
  const client = await f.attach({ livenessTimeoutMs: 15000 });
  client.endpoint.suspend(); await advance(20000);
  pauseOwnerOutput(f, t);
  const first = client.endpoint.resume(), second = client.endpoint.resume();
  const failure = assert.rejects(first, /OWNER_UNREACHABLE/), duplicate = assert.rejects(second, /OWNER_UNREACHABLE/);
  await advance(15000); await failure; await duplicate;
  await until(() => client.frames.some(frame => frame.ended), 'resume probe expiration');
  assert.equal(client.replacements.length, 1);
  t.mock.restoreAll();
  const another = await f.attach({ livenessTimeoutMs: 15000 });
  // Restore real owner delivery for the second private handshake above before
  // creating a fresh paused probe; the closure itself must not await its timer.
  another.endpoint.suspend(); pauseOwnerOutput(f, t);
  const pending = another.endpoint.resume(), rejected = assert.rejects(pending, /ENDPOINT_STALE/);
  await another.endpoint.close(); await rejected;

});

test('forged oversized bursts cannot retire either authenticated route direction', async t => {
  const f = await fixture({ timeoutMs: 5000 }); t.after(() => f.close());
  const client = await f.attach({ livenessTimeoutMs: 10000 });
  await client.send(1, 'before-forgery');
  const attacker = new BroadcastChannel(f.channelName); t.after(() => attacker.close());
  let release, entered = 0, rejected = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'decrypt', async (...args) => {
    if (args[2]?.byteLength !== 2 * 1048576) return decrypt(...args);
    entered++;
    try { await gate; throw Error('FORGED_CIPHERTEXT'); } finally { rejected++; }
  });
  try {
    for (const direction of ['client', 'owner']) {
      const sequence = Math.max(...f.traffic.filter(packet => packet.type === 'sealed' && packet.route === client.route &&
        packet.direction === direction).map(packet => packet.sequence)) + 1;
      for (let i = 0; i < 7; i++) attacker.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'sealed',
        ownerInstanceId: f.announcement.ownerInstanceId, route: client.route, direction, sequence,
        ciphertext: new Uint8Array(2 * 1048576) });
    }
    await until(() => entered === 2 && f.traffic.filter(packet => packet.ciphertext?.byteLength === 2 * 1048576).length === 14,
      'both receive queues filled before authentication');
    assert.equal(f.bridge.routes, 1, 'unauthenticated overflow cannot authorize owner-side retirement');
    assert.deepEqual(client.replacements, [], 'unauthenticated overflow cannot replace the client route');
    release(); await until(() => rejected === 12, 'bounded admitted forgeries rejected');
    assert.equal((await client.send(2, 'after-forgery')).value, 'after-forgery');
    assert.equal(f.accepted.length, 2);
    assert.equal(f.bridge.routes, 1);
    assert.deepEqual(client.replacements, []);
  } finally { release(); }
});

test('elected suspended documents keep their route without page timers; a discarded sibling is swept', async t => {
  const f = await fixture({ idleTimeoutMs: 100 }); t.after(() => f.close());
  const alive = await f.attach(), orphan = await f.attach();
  await alive.park(); await orphan.park();
  const before = f.queries;
  await until(() => f.queries >= before + 3, 'multiple parked sweeps');
  assert.equal(f.bridge.routes, 2); assert.equal(alive.frames.some(frame => frame.ended), false);
  // Document destruction releases its browser lock without endpoint.detach.
  f.witnesses.delete(rootLifetimeLockName(f.profileId, orphan.route));
  await until(() => f.bridge.routes === 1, 'discarded document reclaimed');
  assert.equal((await alive.send('still-here', 'healthy-hidden')).value, 'healthy-hidden');
  assert.equal(f.attachments, 2);
});

for (const maxRoutes of [2, 3]) test(`elected admission reaps discarded parked routes before attach (quota ${maxRoutes})`, async t => {
  const f = await fixture({ maxRoutes }); t.after(() => f.close());
  const alive = await f.attach(), orphan = await f.attach();
  await alive.park(); await orphan.park();
  f.witnesses.delete(rootLifetimeLockName(f.profileId, orphan.route));
  const newcomer = await f.attach();
  assert.equal(f.bridge.routes, 2); assert.equal(f.attachments, 3);
  assert.equal((await alive.send('retained', 'same-owner')).value, 'same-owner');
  assert.equal((await newcomer.send('new', 'new-route')).value, 'new-route');
});

for (const failure of ['reject', 'malformed', 'partial']) test(`elected parked sweep preserves routes on ${failure} query evidence`, async t => {
  const f = await fixture({ idleTimeoutMs: 100 }); t.after(() => f.close());
  const client = await f.attach(); await client.park();
  const before = f.queries;
  f.setQuery(async () => {
    if (failure === 'reject') throw Error('browser unavailable');
    return failure === 'malformed' ? {} : { held: [{ name: 'unrelated', mode: 'exclusive' }] };
  });
  await until(() => f.queries >= before + 2, 'failed sweeps');
  assert.equal(f.bridge.routes, 1); assert.equal(client.frames.some(frame => frame.ended), false);
  f.setQuery(async () => ({ held: [...f.witnesses.values()] }));
  assert.equal((await client.send('preserved', 'healthy-frozen')).value, 'healthy-frozen');
});

test('an elected opening acquires its witness before hello and explicit close releases it', async t => {
  const f = await fixture(); t.after(() => f.close());
  const client = await f.attach();
  const name = rootLifetimeLockName(f.profileId, client.route);
  assert.ok(f.witnesses.has(name));
  await client.endpoint.close();
  assert.equal(f.witnesses.has(name), false);
  await until(() => f.bridge.routes === 0, 'explicit route release');
});

test('elected capacity admission has one bounded query and a late snapshot cannot reclaim or attach', async t => {
  const f = await fixture({ maxRoutes: 1, timeoutMs: 100 }); t.after(() => f.close());
  const alive = await f.attach(); await alive.park();
  let resolve;
  const before = f.queries;
  f.setQuery(() => new Promise(yes => { resolve = yes; }));
  const first = await f.attach({ waitReady: false });
  await until(() => f.queries === before + 1, 'pending admission query');
  const second = await f.attach({ waitReady: false });
  await until(() => f.traffic.filter(frame => frame.type === 'hello').length >= 3, 'both incoming hellos');
  assert.equal(f.queries, before + 1); assert.equal(f.bridge.routes, 1); assert.equal(f.attachments, 1);
  await delay(150); // Cross the configured query/admission deadline, not a readiness guess.
  resolve({ held: [] }); await new Promise(setImmediate);
  assert.equal(f.bridge.routes, 1); assert.equal(f.attachments, 1);
  assert.equal(first.frames.some(frame => frame.ready), false); assert.equal(second.frames.some(frame => frame.ready), false);
  assert.equal(alive.frames.some(frame => frame.ended), false);
  assert.equal((await alive.send('after-timeout', 'preserved')).value, 'preserved');
});

test('owner close fences an authenticated attach whose witness proof is still pending', async t => {
  const f = await fixture(); t.after(() => f.close());
  let resolve;
  f.setQuery(() => new Promise(yes => { resolve = yes; }));
  const client = await f.attach({ waitReady: false });
  await until(() => typeof resolve === 'function', 'authenticated attach proof');
  assert.equal(f.bridge.routes, 1); assert.equal(f.attachments, 0);
  await f.bridge.close(); resolve({ held: [...f.witnesses.values()] });
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(f.bridge.routes, 0); assert.equal(f.attachments, 0);
  assert.equal(client.frames.some(frame => frame.ready), false);
});

test('endpoint close cancels a pending document lock promptly and fences its late native grant before hello', async t => {
  const f = await fixture(); t.after(() => f.close());
  const locks = navigator.locks, request = locks.request.bind(locks);
  let grant;
  locks.request = (...args) => new Promise((resolve, reject) => { grant = () => request(...args).then(resolve, reject); });
  const client = await f.attach({ waitReady: false });
  await until(() => typeof grant === 'function', 'pending document lock');
  await client.endpoint.close();
  assert.equal(f.traffic.some(frame => frame.type === 'hello'), false);
  grant(); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(f.witnesses.size, 0); assert.equal(f.attachments, 0);
  assert.equal(f.traffic.some(frame => frame.type === 'hello'), false);
});
