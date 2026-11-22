import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { defineApplication, describeApplication, PEER_GENERATION_CAPABILITIES } from '@chronolog/peer-session';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { openBrowserOwner } from '../../session/browser.mjs';
import { serveBrowserOwner } from '../../session/worker.mjs';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName, createBroadcastEndpoint } from '../../session/browser-transport.mjs';
import { FixtureLocks } from './fixtures/locks.mjs';

async function until(check) {
  const end = performance.now() + 2000;
  while (!check()) { assert(performance.now() < end, 'fixture phase did not arrive'); await delay(2); }
}
async function fixture(t, { deadFirst = true, releaseOnHello = true } = {}) {
  const saved = new Map(['navigator', 'location', 'Worker', 'RTCPeerConnection'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const locks = new FixtureLocks(), traffic = [], workers = [], stop = new AbortController();
  let releaseOld, opened = 0, service, attachment; const siblings = [];
  const oldLease = locks.request('chronolog-owner:retained', { mode: 'exclusive' }, () => new Promise(resolve => { releaseOld = resolve; }));
  await until(() => releaseOld);
  const description = describeApplication(defineApplication({ id: 'startup', version: '1', commands: {}, queries: {} }));
  const session = { applicationId: 'a'.repeat(64), historyId: 'retained', storageId: 'retained', deviceId: 'b'.repeat(64), signal: stop.signal,
    revision: null, status: { phase: 'ready', database: 'idle', role: 'coordinator', generation: 'c'.repeat(64), coordinator: 'b'.repeat(64), connectedPeers: 0 },
    signals: { delivery: 'neighbors' }, describe: () => ({ ...description, capabilities: { ...PEER_GENERATION_CAPABILITIES, sql: false } }),
    onStatus(listener) { listener(this.status); return () => {}; }, onRecovery: () => () => {}, async close() { stop.abort(Error('SESSION_CLOSED')); } };
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
    await attachment?.detach(); for(const sibling of siblings){await sibling.client.detach();await sibling.transport.close();sibling.channel.close();} releaseOld(); await oldLease; await service.close(); channel.close();
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  return { locks, ghost, channel, traffic, workers, service, session, get opened() { return opened; },
    async sibling() {
      const active = traffic.find(frame=>frame.type==='ready'&&frame.ownerInstanceId===service.owner.ownerInstanceId);
      const siblingChannel=new BroadcastChannel(ownerChannelName('retained'));
      const transport=createBroadcastEndpoint(siblingChannel,active,{profileId:'retained'});
      const client=await connectApplicationOwner(transport,{applicationId:session.applicationId,definitionId:'startup',definitionVersion:'1'});
      siblings.push({client,transport,channel:siblingChannel}); return client;
    },
    async open(options = {}) { attachment = await openBrowserOwner({ workerUrl: 'https://startup.test/worker.mjs', profileId: 'retained', requiresDedicatedWorker: true,
      applicationId: session.applicationId, definitionId: 'startup', definitionVersion: '1', timeoutMs: 5000, persistStorage: false, storageKeepAliveMs: 0, ...options }); return attachment; } };
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
  const f = await fixture(t, { releaseOnHello: false }), started = performance.now();
  await assert.rejects(f.open({ timeoutMs: 3200 }), error => {
    assert.equal(error.code, 'OWNER_UNREACHABLE'); assert.deepEqual(error.startup, { phase: 'attachment', attempts: 2, lastOwnerInstanceId: f.ghost.ownerInstanceId }); return true;
  });
  assert(performance.now() - started < 4200);
  assert.equal(new Set(f.traffic.filter(frame=>frame.type==='hello').map(frame=>frame.route)).size,2,'each retry has its own route under the original deadline'); await until(() => f.locks.held.size === 1 && f.locks.pending.size === 0);
  assert(f.locks.held.has('chronolog-owner:retained')); assert.equal(f.opened, 0); assert.equal(f.workers[0].terminated, false);
});

test('caller abort is terminal during provisional authentication and releases its route', async t => {
  const f = await fixture(t, { releaseOnHello: false }), stop = new AbortController(), reason = Error('CALLER_STOP');
  const opening = f.open({ signal: stop.signal });
  const rejected = assert.rejects(opening, error => error === reason);
  await until(() => f.traffic.some(frame => frame.type === 'hello')); stop.abort(reason); await rejected;
  await until(() => f.locks.held.size === 1 && f.locks.pending.size === 0);
  assert.equal(f.opened, 0); assert.equal(f.traffic.filter(frame => frame.type === 'discover').length, 1);
});

test('authenticated contract mismatch fails once without rediscovery or terminating the candidate', async t => {
  const f = await fixture(t, { deadFirst: false });
  await assert.rejects(f.open({ definitionVersion: 'wrong' }), /CONTRACT_INCOMPATIBLE/);
  assert.equal(f.traffic.filter(frame => frame.type === 'discover').length, 1); assert.equal(f.opened, 1);
  assert.equal(f.session.signal.aborted, false); assert.equal(f.workers[0].terminated, false);
});

test('invalid ready metadata is definitive and is not retried as owner loss', async t => {
  const f = await fixture(t, { deadFirst: false }); f.session.deviceId = 'invalid';
  await assert.rejects(f.open(), /APPLICATION_WORKER_METADATA_INVALID/);
  assert.equal(f.traffic.filter(frame => frame.type === 'discover').length, 1);
  assert.equal(f.opened, 1);
});
