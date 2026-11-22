import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createPeerInvitationListener } from '../invitations.mjs';
import { watchApplicationSetup } from '../setup-watch.mjs';

// Exercise the runtime's WHATWG WebSocket, including its close-code validation.
async function host(t, { rejectUpgrade = false } = {}) {
  const connected = Promise.withResolvers(), closed = Promise.withResolvers(), sockets = new Set();
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    if (rejectUpgrade) { socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'); return; }
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 6) return;
      const length = received[1] & 127;
      // These receive-only clients send just one bounded, masked close frame.
      if (received.length < 6 + length) return;
      const payload = Buffer.from(received.subarray(6, 6 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= received[2 + i % 4];
      closed.resolve({ opcode: received[0] & 15, masked: Boolean(received[1] & 128), code: payload.readUInt16BE(0) });
      socket.end(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
    });
    connected.resolve({ send(text) {
      const payload = Buffer.from(text); assert(payload.length < 126);
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    } });
  });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: 'ws://127.0.0.1:' + server.address().port, connected: connected.promise, closed: closed.promise };
}

test('a real client upgrade error rejects invitations without an uncaught invalid close code', { timeout: 5000 }, async t => {
  const server = await host(t, { rejectUpgrade: true });
  const socket = new WebSocket(server.url), listener = createPeerInvitationListener(socket, 'target');
  await assert.rejects(listener.ready, { code: 'invitation_failed' });
  assert.deepEqual(await listener.closed, { code: 1011, reason: 'Invitation transport failed' });
  await assert.rejects(listener.invitations[Symbol.asyncIterator]().next(), { code: 'invitation_failed' });
});

test('a real client sends a legal close frame while retaining an invalid invitation result', { timeout: 5000 }, async t => {
  const server = await host(t);
  const socket = new WebSocket(server.url), listener = createPeerInvitationListener(socket, 'target');
  (await server.connected).send('{');
  await assert.rejects(listener.ready, SyntaxError);
  assert.deepEqual(await listener.closed, { code: 1008, reason: 'Invalid invitation frame' });
  assert.deepEqual(await server.closed, { opcode: 8, masked: true, code: 1000 });
});

test('an invalid setup notice closes a real client safely without reconnecting', { timeout: 5000 }, async t => {
  const server = await host(t), notices = [], statuses = []; let opens = 0, probes = 0;
  const watch = watchApplicationSetup({ api: 'https://service.example/api/t/aaaaaaaaaaaa', token: 'tk_' + 'a'.repeat(32),
    onChange: notice => notices.push(notice), onStatus: status => statuses.push(status),
    openSocket() { opens++; return new WebSocket(server.url); },
    fetcher() { probes++; throw Error('Invalid notices must not reconnect'); } });
  t.after(() => watch.close());
  (await server.connected).send('{"unexpected":true}');
  await watch.closed;
  assert.deepEqual(await server.closed, { opcode: 8, masked: true, code: 1000 });
  assert.deepEqual(notices, []); assert.equal(opens, 1); assert.equal(probes, 0);
  assert.deepEqual(statuses.map(status => status.state), ['connected', 'closed']);
});
