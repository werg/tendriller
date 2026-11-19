import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { BROWSER_OWNER_PROTOCOL, createBroadcastOwner, createBroadcastEndpoint } from '../browser-transport.mjs';

async function until(predicate, description = 'condition') {
  const end = performance.now() + 3000;
  while (!predicate()) { if (performance.now() > end) throw Error(`Timed out: ${description}`); await delay(5); }
}
async function fixture({ timeoutMs = 200, maxRoutes = 32, silent = false } = {}) {
  const profileId = crypto.randomUUID(), channelName = `test:${profileId}`;
  const ownerChannel = new BroadcastChannel(channelName), observer = new BroadcastChannel(channelName);
  const traffic = [], accepted = [], clients = [], ports = new Set(); let attachments = 0;
  observer.addEventListener('message', ({ data }) => traffic.push(data));
  const owner = { ownerInstanceId: crypto.randomUUID(), attach(endpoint) {
    const listen = ({ data }) => {
      const port = data.port, endpointId = crypto.randomUUID(); attachments++; ports.add(port);
      port.addEventListener('message', ({ data: frame }) => {
        accepted.push({ endpointId, frame }); port.postMessage({ id: frame.id, value: frame.value, endpointId });
      }); port.start(); if (!silent) port.postMessage({ ready: { endpointId, context: data.handshake.context } });
    };
    endpoint.addEventListener('message', listen);
    return () => { endpoint.removeEventListener('message', listen); for (const port of ports) port.unref?.(); };
  } };
  const bridge = await createBroadcastOwner(ownerChannel, owner, { profileId, timeoutMs, maxRoutes });
  bridge.announce(); await until(() => traffic.some(frame => frame.type === 'ready'), 'owner announcement');
  const announcement = traffic.find(frame => frame.type === 'ready');
  async function attach(options = {}) {
    const channel = new BroadcastChannel(channelName), pair = new MessageChannel(), frames = [], replacements = [];
    const endpoint = createBroadcastEndpoint(channel, announcement, { profileId, livenessTimeoutMs: 1000,
      onReplaced: value => replacements.push(value), ...options });
    const record = { channel, endpoint, port: pair.port1, frames, replacements };
    clients.push(record); pair.port1.addEventListener('message', ({ data }) => frames.push(data)); pair.port1.start();
    endpoint.postMessage({ protocol: 'chronolog/peer-session/owner/v2', handshake: { context: { viewId: `private-view-${clients.length}` } }, port: pair.port2 });
    await until(() => frames.some(frame => frame.ready), 'private facade handshake');
    record.route = traffic.filter(frame => frame.type === 'hello').at(-1).route;
    record.send = async (id, value) => {
      pair.port1.postMessage({ id, value }); await until(() => frames.some(frame => frame.id === id), 'private response');
      return frames.find(frame => frame.id === id);
    };
    return record;
  }
  return { profileId, channelName, ownerChannel, observer, traffic, accepted, bridge, announcement, attach,
    get attachments() { return attachments; },
    async close() {
      for (const client of clients) { await client.endpoint.close(); client.port.close(); client.channel.close(); }
      await bridge.close(); ownerChannel.close(); observer.close(); for (const port of ports) port.close();
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
  client.endpoint.resume(); await until(() => client.frames.some(frame => frame.ended), 'owner crash timeout');
  assert.equal(client.frames.find(frame => frame.ended).ended.code, 'OWNER_UNREACHABLE');
  assert.equal(client.replacements.length, 1); assert.equal(f.accepted.length, 1);
  assert.throws(() => client.endpoint.resume(), /ENDPOINT_STALE/);
});

test('an unresponsive facade handshake times out without exposing its context to broadcasts', async t => {
  const f = await fixture({ silent: true }); t.after(() => f.close());
  const channel = new BroadcastChannel(f.channelName), endpoint = createBroadcastEndpoint(channel, f.announcement, { profileId: f.profileId });
  t.after(async () => { await endpoint.close(); channel.close(); });
  await assert.rejects(connectApplicationOwner(endpoint, { applicationId: 'a'.repeat(64), definitionId: 'absent', definitionVersion: '1',
    context: { viewId: 'private-timeout-context' }, timeoutMs: 150 }), /TIMEOUT/);
  assert.ok(!JSON.stringify(f.traffic).includes('private-timeout-context'));
});
