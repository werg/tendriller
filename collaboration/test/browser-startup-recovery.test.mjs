import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { openBrowserOwner } from '../../session/browser.mjs';
import { serveBrowserOwner } from '../../session/worker.mjs';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName, createBroadcastEndpoint } from '../../session/browser-transport.mjs';
import { FixtureLocks } from './fixtures/locks.mjs';
import { p, createPhysicalSession } from './physical-fixture.mjs';

async function until(check) {
  const end = performance.now() + 2000;
  while (!check()) { assert(performance.now() < end, 'fixture phase did not arrive'); await delay(2); }
}
async function fixture(t, { deadFirst = true, releaseOnHello = true } = {}) {
  const saved = new Map(['navigator', 'location', 'Worker', 'RTCPeerConnection'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const locks = new FixtureLocks(), traffic = [], workers = [], routes = [];
  const request = locks.request.bind(locks), prefix = 'tendriller:root-lifetime:retained:';
  locks.request = (name, options, run) => {
    if (name.startsWith(prefix)) routes.push(name.slice(prefix.length));
    return request(name, options, run);
  };
  let releaseOld, opened = 0, service, attachment; const siblings = [];
  const oldLease = locks.request('chronolog-owner:retained', { mode: 'exclusive' }, () => new Promise(resolve => { releaseOld = resolve; }));
  await until(() => releaseOld);
  // A real signed application session behind the public owner; only the browser transport is faked.
  const session = await createPhysicalSession({ definition: p.defineApplication({ id: 'startup', version: '1', commands: {}, queries: {} }) });
  class Scope extends EventTarget { postMessage(data) { queueMicrotask(() => workers[0]?.dispatchEvent(new MessageEvent('message', { data }))); } close() {} }
  const scope = new Scope();
  class Worker extends EventTarget {
    terminated = false;
    constructor() { super(); workers.push(this); }
    postMessage(data) { queueMicrotask(() => scope.dispatchEvent(new MessageEvent('message', { data }))); }
    terminate() { this.terminated = true; }
  }
  for (const [name, value] of Object.entries({ navigator: { locks }, location: new URL('https://startup.test/'), Worker, RTCPeerConnection: undefined })) Object.defineProperty(globalThis, name, { configurable: true, value });
  const channel = new BroadcastChannel(ownerChannelName('retained'));
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ghost = { protocol: BROWSER_OWNER_PROTOCOL, type: 'ready', profileId: 'retained', ownerInstanceId: crypto.randomUUID(), publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
  let ghostDead = !deadFirst;
  channel.addEventListener('message', ({ data }) => {
    traffic.push(data);
    if (data.type === 'discover' && !ghostDead) channel.postMessage(ghost);
    if (data.type === 'hello' && data.ownerInstanceId === ghost.ownerInstanceId && releaseOnHello) { ghostDead = true; releaseOld(); }
  });
  service = serveBrowserOwner({ scope, profileId: 'retained', rootLimits: { retireGraceMs: 0 }, async openSession() { opened++; return { session }; } });
  if (!deadFirst) releaseOld();
  t.after(async () => {
    await attachment?.detach(); for(const sibling of siblings){await sibling.client.detach();await sibling.transport.close();sibling.channel.close();} releaseOld(); await oldLease; await service.close(); await session.close().catch(() => {}); channel.close();
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  return { locks, ghost, channel, traffic, workers, routes, service, session, get opened() { return opened; },
    async sibling() {
      const active = traffic.find(frame=>frame.type==='ready'&&frame.ownerInstanceId===service.owner.ownerInstanceId);
      const siblingChannel=new BroadcastChannel(ownerChannelName('retained'));
      const transport=createBroadcastEndpoint(siblingChannel,active,{profileId:'retained'});
      const client=await connectApplicationOwner(transport,{applicationId:session.applicationId});
      siblings.push({client,transport,channel:siblingChannel}); return client;
    },
    async open(options = {}) { attachment = await openBrowserOwner({ workerUrl: 'https://startup.test/worker.mjs', profileId: 'retained', requiresDedicatedWorker: true,
      applicationId: session.applicationId, timeoutMs: 5000, persistStorage: false, storageKeepAliveMs: 0, ...options }); return attachment; } };
}

test('dead first announcement recovers through a new encrypted owner attachment using the same fenced candidate', async t => {
  const f = await fixture(t), stop = new AbortController(), active = await f.open({ signal: stop.signal });
  assert.notEqual(active.session.endpoint.ownerInstanceId, f.ghost.ownerInstanceId);
  assert.equal(f.opened, 1); assert.equal(f.workers.length, 1); assert.equal(f.workers[0].terminated, false);
  const hellos = f.traffic.filter(frame => frame.type === 'hello');
  assert(hellos.some(frame => frame.ownerInstanceId === f.ghost.ownerInstanceId));
  assert(hellos.some(frame => frame.ownerInstanceId === active.session.endpoint.ownerInstanceId));
  assert.equal(new Set(hellos.filter(frame => frame.ownerInstanceId === f.ghost.ownerInstanceId).map(frame => frame.route)).size, 1);
  assert.equal([...f.locks.held.keys()].filter(name => name.startsWith('tendriller:root-lifetime:')).length, 1, 'failed route released its witness');
  const winner = active.session.endpoint.ownerInstanceId;
  f.channel.postMessage(f.ghost);
  await delay(30); assert.equal(active.session.signal.aborted, false); assert.equal(active.session.endpoint.ownerInstanceId, winner);
  assert.equal((await active.session.endpoints()).length, 1, 'authenticated owner still serves the same facade');
  const sibling=await f.sibling();
  stop.abort(Error('CALLER_CLOSED'));
  await until(()=>active.session.signal.aborted);
  await until(()=>[...f.locks.held.keys()].filter(name=>name.startsWith('tendriller:root-lifetime:')).length===1);
  assert.equal((await sibling.endpoints()).length,1,'caller abort retains the sibling and physical owner');
  assert.equal(f.session.signal.aborted,false);
  assert.equal(f.workers[0].terminated, false);
});

test('one overall deadline bounds a silent provisional owner and cleans its witness without stealing the incumbent lock', async t => {
  const f = await fixture(t, { releaseOnHello: false }), started = performance.now(); let attempts;
  await assert.rejects(f.open({ timeoutMs: 3200 }), error => {
    assert.equal(error.code, 'OWNER_UNREACHABLE');
    assert.equal(error.startup.phase, 'attachment');
    assert.equal(error.startup.lastOwnerInstanceId, f.ghost.ownerInstanceId);
    attempts=error.startup.attempts;assert(attempts>=2,'the original budget permits retry');return true;
  });
  assert(performance.now() - started < 4200);
  await until(() => f.locks.held.size === 1 && f.locks.pending.size === 0);
  // Count routes at their local lifetime acquisition, not a remote BroadcastChannel
  // observer: a final attempt can expire during async crypto before its first hello.
  assert.equal(f.routes.length, attempts);
  assert.equal(new Set(f.routes).size, attempts, 'each attempt has one distinct route under the original deadline');
  const helloRoutes = new Set(f.traffic.filter(frame => frame.type === 'hello').map(frame => frame.route));
  assert(helloRoutes.has(f.routes[0]), 'the provisional owner received a real attachment attempt');
  for (const route of helloRoutes) assert(f.routes.includes(route), 'hello belongs to an allocated attempt');
  assert(f.locks.held.has('chronolog-owner:retained')); assert.equal(f.opened, 0); assert.equal(f.workers[0].terminated, false);
});

test('the overall deadline cancels a final route before async key generation can send its first hello', { timeout: 5000 }, async t => {
  const f = await fixture(t, { releaseOnHello: false });
  const generateKey = crypto.subtle.generateKey.bind(crypto.subtle), deriveKey = crypto.subtle.deriveKey.bind(crypto.subtle);
  const postMessage = BroadcastChannel.prototype.postMessage, sentHellos = [];
  let generation = 0, releaseKey, finishCrypto, now = 0;
  const heldKey = new Promise(resolve => { releaseKey = resolve; });
  const finishedCrypto = new Promise(resolve => { finishCrypto = resolve; });
  t.mock.method(BroadcastChannel.prototype, 'postMessage', function (frame) {
    if (frame.type === 'hello') sentHellos.push(frame.route);
    return postMessage.call(this, frame);
  });
  t.mock.method(crypto.subtle, 'deriveKey', async (...args) => {
    const key = await deriveKey(...args);
    if (generation === 2) finishCrypto();
    return key;
  });
  t.mock.method(crypto.subtle, 'generateKey', async (...args) => {
    if (++generation === 2) await heldKey;
    return generateKey(...args);
  });
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const opening = f.open({ timeoutMs: 3200 });
    const rejected = assert.rejects(opening, error => {
      assert.equal(error.code, 'OWNER_UNREACHABLE');
      assert.equal(error.startup.attempts, 2);
      assert.equal(error.startup.phase, 'attachment');
      return true;
    });
    await until(() => f.traffic.some(frame => frame.type === 'hello'));
    now = 3000; t.mock.timers.tick(3000);
    await until(() => generation === 2);
    assert.equal(new Set(f.routes).size, 2, 'the retry already owns a distinct local witness');
    now = 3200; t.mock.timers.tick(200);
    await rejected;
    await until(() => f.locks.held.size === 1 && f.locks.pending.size === 0);
    releaseKey();
    // Drain the final real derivation and its continuation, not an arbitrary delay.
    await finishedCrypto; await nextTurn();
    assert(sentHellos.every(route => route === f.routes[0]), 'canceled route cannot send a late hello');
    assert.equal(new Set(f.traffic.filter(frame => frame.type === 'hello').map(frame => frame.route)).size, 1);
    assert.equal(f.routes.length, 2, 'late crypto cannot start another attempt');
    assert(f.locks.held.has('chronolog-owner:retained'));
    assert.equal(f.opened, 0); assert.equal(f.workers[0].terminated, false);
  } finally { releaseKey(); t.mock.timers.reset(); t.mock.restoreAll(); }
});

test('caller abort is terminal during provisional authentication and releases its route', async t => {
  const f = await fixture(t, { releaseOnHello: false }), stop = new AbortController(), reason = Error('CALLER_STOP');
  const opening = f.open({ signal: stop.signal });
  const rejected = assert.rejects(opening, error => error === reason);
  await until(() => f.traffic.some(frame => frame.type === 'hello')); stop.abort(reason); await rejected;
  await until(() => f.locks.held.size === 1 && f.locks.pending.size === 0);
  assert.equal(f.opened, 0); assert.equal(f.traffic.filter(frame => frame.type === 'discover').length, 1);
});

test('authenticated application mismatch fails once without rediscovery or terminating the candidate', async t => {
  const f = await fixture(t, { deadFirst: false });
  await assert.rejects(f.open({ applicationId: 'e'.repeat(64) }), /ENDPOINT_APPLICATION_MISMATCH/);
  assert.equal(f.traffic.filter(frame => frame.type === 'discover').length, 1); assert.equal(f.opened, 1);
  assert.equal(f.session.signal.aborted, false); assert.equal(f.workers[0].terminated, false);
});
