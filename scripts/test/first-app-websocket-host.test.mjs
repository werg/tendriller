import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Agent, WebSocket, buildConnector } from 'undici';
import { FIRST_APP_WEBSOCKET_PROXY_WORKER } from '../first-app-websocket-host.mjs';

// No Tendriller or Chronolog code: isolate the native runtime's close boundary.
const fixture = `
import { DurableObject } from 'cloudflare:workers';
export class Channel extends DurableObject {
  lastClose;
  held;
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/denied') return new Response('authorization required', {
      status: 403, headers: { 'X-Fixture-Policy': 'unchanged' },
    });
    if (url.pathname === '/close') {
      for (const socket of this.ctx.getWebSockets()) socket.close(1013, 'Server completed its work');
      return new Response('close requested');
    }
    if (url.pathname === '/release') {
      this.held.close(1000, 'Owner completed cleanup');
      return new Response('released');
    }
    if (url.pathname === '/state') return Response.json(this.lastClose ?? null);
    const [client, server] = Object.values(new WebSocketPair());
    if (url.pathname === '/hold') {
      this.held = server;
      server.addEventListener('close', event => {
        this.lastClose = { code: event.code, reason: event.reason, readyState: server.readyState };
      });
      server.accept({ allowHalfOpen: true });
    } else this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'fixture.close.v1' } });
  }
  webSocketMessage(socket, message) { socket.send(message); }
  webSocketClose(socket, code, reason) {
    this.lastClose = { code, reason, readyState: socket.readyState };
    socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }
}
export default { fetch(request, env) {
  return env.CHANNEL.get(env.CHANNEL.idFromName(new URL(request.url).searchParams.get('id'))).fetch(request);
} };
`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(label)), 2_000);
  })]); } finally { clearTimeout(timer); }
}
const route = (base, path, id) => { const url = new URL(path, base); url.searchParams.set('id', id); return url; };

test('isolated host forwards WebSocket ownership and finishes the cold hibernatable TCP close', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'first-app-websocket-host-'));
  const host = new Miniflare({ ...convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, cf: false,
    workers: [
      { name: 'network', modules: true, script: FIRST_APP_WEBSOCKET_PROXY_WORKER,
        compatibilityDate: '2026-11-01', serviceBindings: { PACKED_HOST: 'fixture' } },
      { name: 'fixture', modules: true, script: fixture, compatibilityDate: '2026-11-01',
        durableObjects: { CHANNEL: { className: 'Channel', useSQLite: true } },
        unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }] },
    ],
  }), resourceTmpPath: join(directory, 'work'), enableDevRegistry: false, logRequests: false });
  const agents = [];
  // Disposing the isolated fixture after measurements also releases the direct
  // negative control. That cleanup is never counted as a successful close.
  t.after(async () => {
    await host.dispose();
    await Promise.all(agents.map(agent => agent.close()));
    await rm(directory, { recursive: true, force: true });
  });
  async function open(base, id, path = '/') {
    const physical = { socket: null, eof: false, closed: false };
    const connect = buildConnector({});
    const dispatcher = new Agent({ connect(options, callback) {
      connect(options, (error, socket) => {
        if (socket) {
          physical.socket = socket;
          socket.once('end', () => { physical.eof = true; });
          socket.once('close', () => { physical.closed = true; });
        }
        callback(error, socket);
      });
    } });
    agents.push(dispatcher);
    const url = route(base, path, id); url.protocol = 'ws:';
    const socket = new WebSocket(url, { dispatcher, protocols: ['fixture.close.v1'] });
    socket.binaryType = 'arraybuffer';
    const closed = Promise.withResolvers();
    socket.addEventListener('close', event => closed.resolve({ code: event.code, reason: event.reason, wasClean: event.wasClean }), { once: true });
    await deadline(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }), 'Synthetic socket did not open');
    assert.equal(socket.protocol, 'fixture.close.v1');
    return { socket, physical, closed: closed.promise };
  }
  async function closedCleanly(connection, expected) {
    assert.deepEqual(await deadline(connection.closed, 'Test host did not finish the physical close'), { ...expected, wasClean: true });
    assert.equal(connection.socket.readyState, WebSocket.CLOSED);
    assert.equal(connection.physical.eof, true, 'The server must send an actual TCP EOF');
    assert.equal(connection.physical.closed, true, 'The external TCP socket must close before fixture disposal');
  }
  const proxied = await host.ready;
  const direct = await host.unsafeGetDirectURL('fixture');

  const untouched = await fetch(route(proxied, '/denied', 'policy'));
  assert.equal(untouched.status, 403);
  assert.equal(untouched.headers.get('X-Fixture-Policy'), 'unchanged');
  assert.equal(await untouched.text(), 'authorization required');

  const cold = await open(direct, 'direct-cold');
  await (await fetch(route(direct, '/close', 'direct-cold'))).text();
  await wait(150);
  const observed = await (await fetch(route(direct, '/state', 'direct-cold'))).json();
  assert.equal(observed.readyState, WebSocket.CLOSED, 'The DO already exchanged its Close frames');
  assert.equal(cold.socket.readyState, WebSocket.CLOSING,
    'Pinned workerd cold-socket behavior changed; re-evaluate the test-host adapter');
  assert.equal(cold.physical.eof, false);
  assert.equal(cold.physical.closed, false);
  t.diagnostic('Direct cold hibernatable control: DO CLOSED, external client CLOSING, no TCP EOF before cleanup.');

  const serverClosed = await open(proxied, 'proxied-cold');
  await (await fetch(route(proxied, '/close', 'proxied-cold'))).text();
  await closedCleanly(serverClosed, { code: 1013, reason: 'Server completed its work' });

  // A host that receives Close but has not acknowledged it must remain visible
  // to the raw-socket cleanup gate. Do not let the proxy auto-ack on its behalf.
  const held = await open(proxied, 'held', '/hold');
  held.socket.close(1000, 'Owner completed cleanup');
  const heldState = await deadline((async () => {
    for (;;) {
      const state = await (await fetch(route(proxied, '/state', 'held'))).json();
      if (state) return state;
      await wait(10);
    }
  })(), 'Upstream did not receive the owner Close frame');
  assert.equal(heldState.readyState, WebSocket.CLOSING);
  await wait(75);
  assert.equal(held.socket.readyState, WebSocket.CLOSING,
    'The network boundary must not hide a missing upstream Close acknowledgment');
  assert.equal(held.physical.eof, false);
  assert.equal(held.physical.closed, false);
  await (await fetch(route(proxied, '/release', 'held'))).text();
  await closedCleanly(held, { code: 1000, reason: 'Owner completed cleanup' });

  const owned = await open(proxied, 'owned');
  await wait(50);
  assert.equal(owned.socket.readyState, WebSocket.OPEN, 'The proxy must not dispose an owned open connection');
  for (const input of ['unchanged text', Uint8Array.from([0, 1, 127, 128, 255])]) {
    const reply = new Promise(resolve => owned.socket.addEventListener('message', event => resolve(event.data), { once: true }));
    owned.socket.send(input);
    const received = await deadline(reply, 'Proxy changed or lost an application frame');
    if (typeof input === 'string') assert.equal(received, input);
    else {
      assert.ok(received instanceof ArrayBuffer, `Expected an ArrayBuffer, received ${received?.constructor?.name}: ${String(received)}`);
      assert.deepEqual(new Uint8Array(received), input);
    }
  }
  owned.socket.close(1000, 'Owner completed cleanup');
  await closedCleanly(owned, { code: 1000, reason: 'Owner completed cleanup' });
  const retired = await (await fetch(route(proxied, '/state', 'owned'))).json();
  assert.equal(retired.code, 1000);
  assert.equal(retired.reason, 'Owner completed cleanup');

  // Independent counters include both physical directions and distinguish relay
  // application frames from control/signaling traffic and unrelated sockets.
  const before = await (await fetch(new URL('/__first_app_transport', proxied))).json();
  const relay = await open(proxied, 'measured-relay', '/peers/relay');
  const binary = new Uint8Array([1,2,3,4,5,6]);
  const echoed = new Promise(resolve => relay.socket.addEventListener('message', resolve, {once:true}));
  relay.socket.send(binary); await deadline(echoed, 'Measured relay did not echo');
  const after = await (await fetch(new URL('/__first_app_transport', proxied))).json();
  assert.equal(after.instance, before.instance);
  assert.equal(after.relayUpgrades - before.relayUpgrades, 1);
  assert.equal(after.relayBinaryFrames - before.relayBinaryFrames, 2);
  assert.equal(after.relayBinaryBytes - before.relayBinaryBytes, binary.byteLength * 2);
  relay.socket.close(1000, 'measurement finished');
  await closedCleanly(relay, {code:1000,reason:'measurement finished'});
});
