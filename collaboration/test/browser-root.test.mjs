import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { defineApplication, describeApplication, PEER_GENERATION_CAPABILITIES } from '@chronolog/peer-session';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { serveBrowserOwner } from '../worker.mjs';
import { createSharedRootEndpoint } from '../browser-root.mjs';
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
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let held = incumbent ? 1 : 0, resourceClosed = false, opened = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { async request(_name, options, run) {
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
    finishClose?.(); for (const transport of transports) await transport.close(); await service.close();
    for (const port of ports) port.close();
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
  });
  function root() {
    const pair = new MessageChannel(), server = tracked(pair.port1); ports.push(pair.port1, pair.port2); scope.connect(server);
    const rootId = crypto.randomUUID();
    return { server, port: pair.port2, rootId, async boot() {
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
  return { scope, session, controller, service, root, attach, finishClose,
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
  attached.server.close(); await delay(260); assert.equal(attached.client.signal.aborted, false);
  await assert.rejects(attached.transport.resume(), /OWNER_UNREACHABLE/);
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
