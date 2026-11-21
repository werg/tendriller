import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { defineApplication, describeApplication, PEER_GENERATION_CAPABILITIES } from '@chronolog/peer-session';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { serveBrowserOwner } from '../worker.mjs';
import { createSharedRootEndpoint } from '../browser-root.mjs';
import { acquireRootLifetime, rootLifetimeLockName } from '../root-lifetime.mjs';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName, createBroadcastEndpoint, isOwnerAnnouncement } from '../browser-transport.mjs';

async function until(condition, description) {
  const end = performance.now() + 2500;
  while (!condition()) { if (performance.now() > end) throw Error(`Timed out: ${description}`); await delay(5); }
}
class Scope extends EventTarget {
  closed = false; replies = [];
  postMessage(value) { this.replies.push(value); }
  send(value) { this.dispatchEvent(new MessageEvent('message', { data: { protocol: BROWSER_OWNER_PROTOCOL, ...value } })); }
  close() { this.closed = true; }
  connect(port) { const event = new Event('connect'); Object.defineProperty(event, 'ports', { value: [port] }); this.dispatchEvent(event); }
}
function tracked(port) {
  const listeners = new Set();
  return { listeners, closed: false,
    addEventListener(type, callback) { listeners.add(callback); port.addEventListener(type, callback); },
    removeEventListener(type, callback) { listeners.delete(callback); port.removeEventListener(type, callback); },
    postMessage(...args) { port.postMessage(...args); }, start() { port.start(); },
    close() { this.closed = true; port.close(); },
  };
}
function next(port, predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { port.removeEventListener('message', receive); reject(Error('Root response timeout')); }, timeoutMs);
    const receive = ({ data }) => { if (predicate(data)) { clearTimeout(timer); port.removeEventListener('message', receive); resolve(data); } };
    port.addEventListener('message', receive); port.start?.();
  });
}
async function fixture(t, { rootLimits, load, delayedClose = false, incumbent = false } = {}) {
  const witnesses = new Map(), witnessHandles = []; let queryCalls = 0, query = async () => ({ held: [...witnesses.values()], pending: [] });
  const pageLocks = clientId => ({
    query: () => query(),
    async request(name, options, run) {
      if (witnesses.has(name)) return run(null);
      const witness = { name, mode: 'exclusive', clientId }; witnesses.set(name, witness);
      try { return await run({ name, mode: 'exclusive' }); }
      finally { if (witnesses.get(name) === witness) witnesses.delete(name); }
    },
  });
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let held = incumbent ? 1 : 0, resourceClosed = false, opened = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { query() { queryCalls++; return query(); }, async request(_name, options, run) {
    if (_name.startsWith('tendriller:root-lifetime:')) return pageLocks(_name).request(_name, options, run);
    if (held && options.ifAvailable) return run(null);
    if (held) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    held++; try { return await run({}); } finally { held--; }
  } } } });
  const scope = new Scope(), controller = new AbortController(), ports = [], transports = [];
  let finishClose; const closeGate = delayedClose ? new Promise(resolve => { finishClose = resolve; }) : Promise.resolve();
  const description = describeApplication(defineApplication({ id: 'root-fixture', version: '1', commands: {}, queries: {} })); let closing;
  const session = { applicationId: 'a'.repeat(64), historyId: 'root-fixture', storageId: 'retained', deviceId: 'b'.repeat(64),
    signal: controller.signal, revision: null, status: { phase: 'ready', database: 'idle', role: 'coordinator', generation: 'c'.repeat(64), coordinator: 'b'.repeat(64), connectedPeers: 0 }, signals: { delivery: 'neighbors' },
    describe: () => ({ ...description, capabilities: { ...PEER_GENERATION_CAPABILITIES, sql: false } }), onStatus(listener) { listener(this.status); return () => {}; }, onRecovery: () => () => {},
    close() { return closing ??= Promise.resolve().then(async () => { controller.abort(Error('TEST_SESSION_ENDED')); await closeGate; resourceClosed = true; }); },
  };
  const config = { profileId: 'retained', openSession: async () => { opened++; return { session }; }, rootLimits };
  const service = serveBrowserOwner({ scope, ...(load ? { load: () => load(config) } : config) });
  t.after(async () => {
    finishClose?.(); for (const witness of witnessHandles) await witness.release(); for (const transport of transports) await transport.close(); await service.close();
    for (const port of ports) port.close();
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
  });
  function root() {
    const pair = new MessageChannel(), server = tracked(pair.port1); ports.push(pair.port1, pair.port2); scope.connect(server);
    const rootId = crypto.randomUUID(); let witness;
    return { releaseWitness: () => witness?.release(), server, port: pair.port2, rootId, async boot({ acquire = true } = {}) {
      if (acquire && !witness) { witness = await acquireRootLifetime('retained', rootId, { locks: pageLocks(rootId) }); witnessHandles.push(witness); }
      const ready = next(pair.port2, data => ['ready', 'failure'].includes(data.type));
      pair.port2.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'boot', mode: 'shared', profileId: 'retained', id: rootId });
      return ready;
    }, control(type, ownerInstanceId, extra = {}) {
      const id = crypto.randomUUID(), response = next(pair.port2, data => data.id === id);
      pair.port2.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: `root.${type}`, profileId: 'retained', ownerInstanceId, rootId, id, ...extra });
      return response;
    } };
  }
  async function attach() {
    const connection = root(), ready = await connection.boot(); assert.equal(ready.type, 'ready');
    const transport = createSharedRootEndpoint(connection.port, { profileId: 'retained', rootId: connection.rootId,
      ownerInstanceId: ready.ownerInstanceId, livenessTimeoutMs: 200 }); transports.push(transport);
    const client = await connectApplicationOwner(transport, { applicationId: session.applicationId, definitionId: description.id, definitionVersion: description.version, timeoutMs: 1000 });
    return { ...connection, transport, client };
  }
  return { scope, session, controller, service, root, attach, finishClose, witnesses,
    get queryCalls() { return queryCalls; }, setQuery(value) { query = value; },
    get held() { return held; }, get resourceClosed() { return resourceClosed; }, get opened() { return opened; } };
}

test('repeated direct facade detaches reclaim root listeners and capacity without ending the owner', async t => {
  const f = await fixture(t, { rootLimits: { maxPorts: 2 } }), sibling = await f.attach();
  const instance = sibling.client.endpoint.ownerInstanceId;
  for (let index = 0; index < 12; index++) {
    const current = await f.attach(); assert.equal(current.client.endpoint.ownerInstanceId, instance);
    await current.client.detach();
    await until(() => current.server.closed, 'explicit root detach'); assert.equal(current.server.listeners.size, 0);
    assert.equal(f.service.owner.endpoints().length, 1);
  }
  assert.equal(f.opened, 1); assert.equal(f.held, 1); assert.equal(f.session.signal.aborted, false);
  assert.equal((await sibling.client.endpoints()).length, 1);
});

test('pending roots are bounded and explicit cancellation or timeout releases them before configuration resolves', async t => {
  let configure; const configured = new Promise(resolve => { configure = resolve; });
  const f = await fixture(t, { load: async value => { await configured; return value; }, rootLimits: { maxPorts: 1, pendingTimeoutMs: 100 } });
  const cancelled = f.root(); cancelled.port.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'boot', mode: 'shared', profileId: 'retained', id: cancelled.rootId });
  const reply = await cancelled.control('detach'); assert.equal(reply.type, 'root.result');
  await until(() => cancelled.server.closed, 'cancelled pending root');
  configure(); await delay(0);
  const idle = f.root(), extra = f.root();
  const denied = await next(extra.port, data => data.type === 'failure'); assert.equal(denied.code, 'OWNER_BUSY');
  await until(() => idle.server.closed, 'pending root expiry');
  assert.equal(idle.server.listeners.size, 0); assert.equal(f.opened, 0); assert.equal(f.held, 0);
  const attached = await f.attach(); assert.equal(attached.client.status.database, 'idle');
});

for (const action of ['suspend','park']) test(`SharedWorker leases respect ${action} and reclaim only an unreachable root`, async t => {
  const f = await fixture(t, { rootLimits: { idleTimeoutMs: 100 } }), active = await f.attach();
  const abandoned = f.root(), ready = await abandoned.boot();
  await abandoned.control(action, ready.ownerInstanceId, action === 'park' ? { frozen: false } : {}); await delay(170);
  assert.equal(abandoned.server.closed, false); assert.equal(active.client.signal.aborted, false);
  await abandoned.control('resume', ready.ownerInstanceId);
  await until(() => abandoned.server.closed, 'resumed unreachable root');
  assert.equal(abandoned.server.listeners.size, 0); assert.equal(f.held, 1); assert.equal(f.session.signal.aborted, false);
  assert.equal((await active.client.endpoints()).length, 1);
});

test('session abort closes roots and releases the owner lock only after resources finish closing', async t => {
  const f = await fixture(t, { delayedClose: true }), a = await f.attach(), b = await f.attach();
  f.controller.abort(Error('UNDERLYING_SESSION_CLOSED'));
  await until(() => a.client.signal.aborted && b.client.signal.aborted, 'both old facades close');
  assert.equal(a.server.listeners.size, 0); assert.equal(b.server.listeners.size, 0);
  assert.equal(f.held, 1); assert.equal(f.resourceClosed, false); assert.equal(f.scope.closed, false);
  f.finishClose(); await f.service.close();
  assert.equal(f.held, 0); assert.equal(f.resourceClosed, true); assert.equal(f.scope.closed, true);
});

test('a dead SharedWorker root fails its facade closed and suspended observation resumes against the same binding', async t => {
  const f = await fixture(t), attached = await f.attach();
  await attached.client.suspend(); await attached.transport.suspend();
  attached.server.close();
  await until(() => attached.client.signal.aborted, 'native closed port fences its facade');
  await assert.rejects(attached.transport.resume(), /OWNER_UNREACHABLE|ENDPOINT_STALE/);
  // A failed resume must close the old facade, not leave an apparently live session.
  await until(() => attached.client.signal.aborted, 'dead resumed facade');
  assert.equal(f.held, 1); assert.equal(f.session.signal.aborted, false);
});


test('retiring an elected owner preserves attached siblings and closes only after the last route', async t => {
  const f = await fixture(t, { rootLimits: { retireGraceMs: 300 } }), observer = new BroadcastChannel(ownerChannelName('retained'));
  t.after(() => observer.close());
  const announcement = next(observer, data => isOwnerAnnouncement(data, 'retained'));
  f.scope.send({ type: 'boot', mode: 'elected', profileId: 'retained', id: 'candidate' });
  const ready = await announcement, clients = [];
  for (let index = 0; index < 2; index++) {
    const channel = new BroadcastChannel(ownerChannelName('retained'));
    const endpoint = createBroadcastEndpoint(channel, ready, { profileId: 'retained', livenessTimeoutMs: 1000 });
    const client = await connectApplicationOwner(endpoint, { applicationId: f.session.applicationId, definitionId: 'root-fixture', definitionVersion: '1', timeoutMs: 1000 });
    clients.push(client); t.after(async () => { await endpoint.close(); channel.close(); });
  }
  await clients[0].detach();
  f.scope.send({ type: 'retire', profileId: 'retained', id: 'retirement' });
  await until(() => f.scope.replies.some(value => value.type === 'retired' && value.id === 'retirement'), 'retirement acknowledgement');
  assert.equal(f.held, 1); assert.equal(f.scope.closed, false); assert.equal(clients[1].signal.aborted, false);
  assert.equal((await clients[1].endpoints()).length, 1);
  await clients[1].detach();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.scope.closed, false, 'a same-page reattach still finds the owner during the grace');
  await until(() => f.scope.closed, 'last route closes retired owner');
  assert.equal(f.held, 0); assert.equal(f.resourceClosed, true);
});

test('retiring a queued dedicated candidate cancels its lock wait without opening storage', async t => {
  const f = await fixture(t, { incumbent: true });
  f.scope.send({ type: 'boot', mode: 'elected', profileId: 'retained', id: 'candidate' });
  await delay(0); f.scope.send({ type: 'retire', profileId: 'retained', id: 'retirement' });
  await until(() => f.scope.closed, 'queued candidate retired');
  assert.equal(f.opened, 0); assert.equal(f.held, 1);
  assert.ok(f.scope.replies.some(value => value.type === 'retired' && value.id === 'retirement'));
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function park(root, frozen = false) {
  root.transport.park({ frozen });
  await root.control('park', root.client.endpoint.ownerInstanceId, { frozen });
}

for (const frozen of [false, true]) test(`parked sweep preserves a healthy ${frozen ? 'frozen' : 'hidden'} witness beyond the ordinary lease and reclaims its discarded sibling`, async t => {
  const f = await fixture(t, { rootLimits: { idleTimeoutMs: 100, parkedSweepMs: 100 } });
  const sibling = await f.attach(), orphan = await f.attach();
  await park(orphan, frozen);
  const before = f.queryCalls;
  await until(() => f.queryCalls >= before + 2, 'two independent parked sweeps');
  assert.equal(orphan.server.closed, false); assert.equal(orphan.client.signal.aborted, false);
  assert.equal(f.service.owner.endpoints().length, 2);
  // Simulate browser document destruction: no detach message or page JS runs.
  await orphan.releaseWitness();
  await until(() => orphan.server.closed, 'discarded parked root reclaimed');
  assert.equal(orphan.server.listeners.size, 0);
  assert.equal(sibling.client.signal.aborted, false); assert.equal(f.held, 1); assert.equal(f.opened, 1);
  assert.equal(f.session.signal.aborted, false);
  assert.equal((await sibling.client.endpoints()).length, 1);
});

test('new admission reclaims an abandoned parked root at capacity without changing the owner', async t => {
  const f = await fixture(t, { rootLimits: { maxPorts: 2, parkedSweepMs: 120000 } });
  const sibling = await f.attach(), orphan = await f.attach();
  const ownerId = sibling.client.endpoint.ownerInstanceId;
  await park(orphan); await orphan.releaseWitness();
  const before = f.queryCalls, fresh = await f.attach();
  assert.equal(orphan.server.closed, true); assert.equal(orphan.server.listeners.size, 0);
  assert.equal(fresh.client.endpoint.ownerInstanceId, ownerId);
  assert.equal(f.service.owner.endpoints().length, 2); assert.ok(f.queryCalls > before);
  assert.equal(f.held, 1); assert.equal(f.opened, 1); assert.equal(sibling.client.signal.aborted, false);
});

test('admission scans parked roots before capacity is full and does not keep a discarded RTC route around', async t => {
  const f = await fixture(t, { rootLimits: { maxPorts: 3, parkedSweepMs: 120000 } });
  const sibling = await f.attach(), orphan = await f.attach();
  await park(orphan); await orphan.releaseWitness();
  const fresh = await f.attach();
  assert.equal(orphan.server.closed, true);
  assert.equal(f.service.owner.endpoints().length, 2);
  assert.equal(fresh.client.endpoint.ownerInstanceId, sibling.client.endpoint.ownerInstanceId);
});

for (const invalid of ['reject', 'malformed', 'bad-entry']) test(`a ${invalid} lifetime query preserves healthy parked roots`, async t => {
  const f = await fixture(t, { rootLimits: { maxPorts: 2, parkedSweepMs: 100 } });
  const sibling = await f.attach(), healthy = await f.attach(); await park(healthy, true);
  let observed = 0;
  f.setQuery(async () => {
    observed++;
    if (invalid === 'reject') throw Error('query unavailable');
    if (invalid === 'malformed') return {};
    return { held: [{ name: 'unrelated', mode: 'exclusive' }], pending: [] };
  });
  await until(() => observed >= 1, 'invalid sweep completed');
  const denied = f.root(), reply = await denied.boot();
  assert.equal(reply.type, 'failure'); assert.equal(reply.code, 'OWNER_BUSY');
  assert.equal(healthy.server.closed, false); assert.equal(healthy.client.signal.aborted, false);
  assert.equal(sibling.client.signal.aborted, false); assert.equal(f.service.owner.endpoints().length, 2);
  assert.equal(f.held, 1); assert.equal(f.opened, 1);
});

test('only one incoming root waits on a coalesced query and queued boot is consumed after admission', async t => {
  const f = await fixture(t, { rootLimits: { maxPorts: 3, parkedSweepMs: 120000, pendingTimeoutMs: 1000 } });
  const sibling = await f.attach(), parked = await f.attach(); await park(parked);
  const started = deferred(), release = deferred(); let scans = 0;
  f.setQuery(async () => { scans++; if (scans === 1) { started.resolve(); await release.promise; } return { held: [...f.witnesses.values()], pending: [] }; });
  t.after(() => release.resolve());
  const pending = f.root(), boot = pending.boot(); await started.promise;
  const extra = f.root(), denied = await extra.boot();
  assert.equal(denied.type, 'failure'); assert.equal(denied.code, 'OWNER_BUSY');
  assert.equal(scans, 1); assert.equal(f.service.owner.endpoints().length, 2);
  release.resolve(); assert.equal((await boot).type, 'ready');
  assert.equal(pending.server.closed, false); assert.equal(parked.server.closed, false);
  assert.equal(sibling.client.signal.aborted, false); assert.equal(f.held, 1);
});

test('a blocked lifetime query times out admission without reaping healthy roots or admitting a late port', async t => {
  const f = await fixture(t, { rootLimits: { maxPorts: 2, parkedSweepMs: 120000, pendingTimeoutMs: 100 } });
  const sibling = await f.attach(), parked = await f.attach(); await park(parked);
  const release = deferred();
  f.setQuery(async () => { await release.promise; return { held: [], pending: [] }; });
  t.after(() => release.resolve());
  const pending = f.root(), reply = await pending.boot();
  assert.equal(reply.type, 'failure'); assert.equal(reply.code, 'OWNER_BUSY');
  assert.equal(pending.server.closed, true); assert.equal(parked.server.closed, false);
  assert.equal(sibling.client.signal.aborted, false);
  await delay(30); release.resolve(); await delay(0);
  assert.equal(parked.server.closed, false); assert.equal(f.service.owner.endpoints().length, 2);
  assert.equal(f.held, 1);
});

test('an old pending sweep cannot replace a fresh admission query or reap the new root', async t => {
  const f = await fixture(t, { rootLimits: { maxPorts: 2, parkedSweepMs: 100, pendingTimeoutMs: 1000 } });
  const sibling = await f.attach(), old = await f.attach(); await park(old);
  const started = deferred(), release = deferred(); let scans = 0;
  f.setQuery(async () => {
    scans++;
    const snapshot = { held: [...f.witnesses.values()], pending: [] };
    if (scans === 1) { started.resolve(); await release.promise; }
    return snapshot;
  });
  t.after(() => release.resolve());
  await started.promise;
  await old.releaseWitness();
  const fresh = f.root(), boot = fresh.boot();
  release.resolve(); const ready = await boot;
  assert.equal(ready.type, 'ready'); assert.ok(scans >= 3, 'old sweep, fresh admission scan, and fresh boot proof');
  assert.equal(old.server.closed, true); assert.equal(fresh.server.closed, false);
  assert.equal(sibling.client.signal.aborted, false); assert.equal(f.held, 1); assert.equal(f.opened, 1);
});

test('a reused lock name from a different document does not keep the old root alive', async t => {
  const f = await fixture(t, { rootLimits: { parkedSweepMs: 100 } });
  const sibling = await f.attach(), old = await f.attach(); await park(old);
  await old.releaseWitness();
  const name = rootLifetimeLockName('retained', old.rootId);
  f.witnesses.set(name, { name, mode: 'exclusive', clientId: 'different-document' });
  await until(() => old.server.closed, 'original document witness lost');
  assert.equal(sibling.client.signal.aborted, false); assert.equal(f.held, 1);
  assert.equal(f.service.owner.endpoints().length, 1);
});

test('closing the worker cancels pending admission and fences a late lifetime snapshot', async t => {
  const f = await fixture(t, { rootLimits: { maxPorts: 1, parkedSweepMs: 120000, pendingTimeoutMs: 1000 } });
  const parked = await f.attach(); await park(parked);
  const started = deferred(), release = deferred();
  f.setQuery(async () => { started.resolve(); await release.promise; return { held: [], pending: [] }; });
  t.after(() => release.resolve());
  const pending = f.root(), boot = pending.boot(); await started.promise;
  await f.service.close();
  assert.equal((await boot).code, 'OWNER_UNREACHABLE'); assert.equal(pending.server.closed, true);
  release.resolve(); await delay(0);
  assert.equal(f.held, 0); assert.equal(f.resourceClosed, true); assert.equal(parked.server.listeners.size, 0);
});

test('a shared boot without a document witness cannot open owner storage', async t => {
  const f = await fixture(t), root = f.root();
  const reply = await root.boot({ acquire: false });
  assert.equal(reply.type, 'failure'); assert.equal(reply.code, 'OWNER_ROOT_LIFETIME_MISSING');
  assert.equal(f.opened, 0); assert.equal(f.held, 0);
  await until(() => root.server.closed, 'unwitnessed root disposed');
  assert.equal(root.server.listeners.size, 0);
});

test('replayed shared boot replaces its lifetime registration without leaving parked sweeps behind', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, { rootLimits: { parkedSweepMs: 100 } }), root = f.root();
  const ready = await root.boot(); assert.equal(ready.type, 'ready');
  await root.control('park', ready.ownerInstanceId, { frozen: true });
  for (let index = 0; index < 8; index++) {
    const replay = await root.boot();
    assert.equal(replay.type, 'ready'); assert.equal(replay.ownerInstanceId, ready.ownerInstanceId);
  }
  await root.control('resume', ready.ownerInstanceId);
  const queries = f.queryCalls;
  t.mock.timers.tick(300); await new Promise(setImmediate);
  assert.equal(f.queryCalls, queries, 'resuming the only root leaves no orphaned parked registration/timer');
  assert.equal(root.server.closed, false); assert.equal(f.opened, 1); assert.equal(f.held, 1);
  await root.control('park', ready.ownerInstanceId, { frozen: false });
  await root.control('detach', ready.ownerInstanceId);
  t.mock.timers.tick(300); await new Promise(setImmediate);
  assert.equal(f.queryCalls, queries, 'detaching removes the final registration');
  assert.equal(root.server.closed, true);
});
