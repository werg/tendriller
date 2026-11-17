import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeersClient } from '../peers.mjs';
import { createReleaseWatch, RELEASE_SOCKET_PROTOCOL } from '../releases.mjs';

const id = '12'.repeat(32);
const activation = n => ({ id: n.toString(16).padStart(64, '0'), signature: 'signature',
  payload: { profile: 'chronolog-release-v1', revision: n, releaseId: id } });
class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; this.dispatchEvent(new Event('close')); }
  send(value) { this.sent.push(value); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}

test('public peer release client carries signed controls and exact bytes without doing work during construction', async () => {
  const calls = [], uploads = [], socket = new Socket();
  const state = { profile: 'chronolog-release-v1', policies: [], activations: [] };
  const controller = new AbortController(), bytes = new Uint8Array([0, 255, 42]);
  const peers = createPeersClient({ base: 'https://example.test/api/page', protocols: ['tendriller.rendezvous.v1', 'bearer.test'],
    request: async (path, options) => { calls.push({ path, options }); return state; },
    raw: async (path, options = {}) => {
      uploads.push({ path, options });
      return options.method === 'PUT' ? Response.json({ digest: id, bytes: bytes.byteLength }) : new Response(bytes);
    },
    socket: (url, protocols) => { calls.push({ url: String(url), protocols }); return socket; },
  });
  assert.equal(calls.length, 0); assert.equal(uploads.length, 0);
  assert.deepEqual(await peers.releases.state({ signal: controller.signal }), state);
  assert.equal(calls[0].path, 'peers/releases'); assert.equal(calls[0].options.signal, controller.signal);
  assert.deepEqual(await peers.releases.content.put(id, bytes, { mediaType: 'application/wasm', signal: controller.signal }), { digest: id, bytes: 3 });
  assert.equal(uploads[0].options.body, bytes);
  assert.equal(uploads[0].options.headers['Content-Type'], 'application/wasm');
  assert.equal(uploads[0].options.signal, controller.signal);
  assert.deepEqual(await peers.releases.content.get(id), bytes);
  await assert.rejects(peers.releases.content.get('../private'), { code: 'invalid_release_digest' });
  const abort = new AbortController();
  const notices = peers.releases.watch({ signal: abort.signal })[Symbol.asyncIterator]();
  assert.equal(calls.at(-1).url, 'wss://example.test/api/page/peers/releases/socket');
  assert.deepEqual(calls.at(-1).protocols, [RELEASE_SOCKET_PROTOCOL, 'bearer.test']);
  const next = notices.next(); socket.receive(activation(1));
  assert.deepEqual((await next).value, activation(1));
  abort.abort(); await assert.rejects(notices.next(), { name: 'AbortError' });
  assert.deepEqual(socket.sent, []);
  assert.throws(() => peers.releases.watch({ signal: abort.signal }), { name: 'AbortError' });
});

test('release subscriptions coalesce signed selection hints and close when their consumer leaves', async () => {
  const socket = new Socket(), reader = createReleaseWatch(socket)[Symbol.asyncIterator]();
  socket.receive(activation(1)); socket.receive(activation(2)); socket.receive(activation(3));
  assert.deepEqual((await reader.next()).value, activation(3));
  const next = reader.next(); socket.receive(activation(4));
  assert.deepEqual((await next).value, activation(4));
  await reader.return(); assert.equal(socket.closed.code, 1000); assert.deepEqual(socket.sent, []);
});

test('signed release writes preserve transport cancellation', async () => {
  const calls = [], controller = new AbortController();
  const peers = createPeersClient({ base: 'https://example.test/page', raw: async () => new Response(),
    request: async (path, options) => {
      calls.push({ path, options });
      return path.endsWith('/manifests') ? { id, manifest: activation(1) } : activation(1);
    },
  });
  await peers.releases.configure({ requestId: 'policy', expectedPolicy: null, publishers: [] }, { signal: controller.signal });
  await peers.releases.publish(activation(1), { signal: controller.signal });
  await peers.releases.activate(activation(1), { signal: controller.signal });
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.options.signal, controller.signal);
});

test('release subscriptions reject private application frames and oversized notices', async () => {
  for (const message of [{ type: 'application', ciphertext: 'private' }, { ...activation(1), signature: 'x'.repeat(17 * 1024) }]) {
    const socket = new Socket(), reader = createReleaseWatch(socket)[Symbol.asyncIterator]();
    const next = reader.next(); socket.receive(message);
    await assert.rejects(next, { code: 'invalid_release_notice' });
    assert.equal(socket.closed.code, 1008); assert.deepEqual(socket.sent, []);
  }
});

test('release content downloads enforce the file bound and cancel the stream', async () => {
  let cancelled = false;
  const peers = createPeersClient({ base: 'https://example.test/page', request: async () => null,
    raw: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(32 * 1024 * 1024)); controller.enqueue(new Uint8Array(1));
    }, cancel() { cancelled = true; } })),
  });
  await assert.rejects(peers.releases.content.get(id), { code: 'release_content_limit' });
  assert.equal(cancelled, true);
});
