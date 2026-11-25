import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedRootEndpoint } from '../../session/browser-root.mjs';
import { BROWSER_OWNER_PROTOCOL } from '../../session/browser-transport.mjs';
import { p, worker, createPhysicalSession } from './physical-fixture.mjs';
const PROTOCOL = 'chronolog/authored-session/owner/v1';
const isClosed = frame => frame?.protocol === PROTOCOL && frame.kind === 'notice' && frame.topic === 'closed';
async function until(condition) { const end = Date.now() + 3000; while (!condition()) { if (Date.now() > end) throw Error('PRIVATE_ROOT_TEST_TIMEOUT'); await new Promise(setImmediate); } }
async function fixture(t, { maxRequests = 32, onEcho = value => value } = {}) {
  const definition = p.defineApplication({ id: 'root-liveness', version: '1', commands: {}, queries: {
    echo: p.defineQuery({ description: 'Read one test value through the actual captured query/owner path', input: { type: 'string' }, read: (_view, value) => onEcho(value) }),
  } });
  const session = await createPhysicalSession({ definition }), initial = await session.readView(); initial.release();
  const owner = worker.createApplicationOwner(session, { authorize: () => ({ maxRequests }) }), root = new EventTarget(), frames = [], attachment = crypto.randomUUID();
  const server = Object.assign(new EventTarget(), { postMessage(data) { queueMicrotask(() => root.dispatchEvent(new MessageEvent('message', { data }))); } });
  const detach = owner.attach(server);
  let time = 0, source = null, answerPing = false;
  root.postMessage = data => {
    if (data.protocol === PROTOCOL) { server.dispatchEvent(new MessageEvent('message', { data })); return; }
    if (data.type === 'root.ping' && !answerPing) return;
    queueMicrotask(() => root.dispatchEvent(new MessageEvent('message', { data: { protocol: BROWSER_OWNER_PROTOCOL, type: 'root.result', rootId: 'root', ownerInstanceId: owner.ownerInstanceId, id: data.id } })));
  };
  t.mock.method(performance, 'now', () => time); t.mock.timers.enable({ apis: ['setTimeout'] });
  const endpoint = createSharedRootEndpoint(root, { profileId: 'profile', rootId: 'root', ownerInstanceId: owner.ownerInstanceId, livenessTimeoutMs: 15000, requestTimeoutMs: 30000 });
  endpoint.addEventListener('message', ({ data }) => frames.push(data));
  endpoint.postMessage({ protocol: PROTOCOL, attachment, id: 1, kind: 'request', method: 'hello', args: [{ applicationId: session.applicationId }] });
  await until(() => frames.some(frame => frame.kind === 'response' && frame.id === 1));
  // Controlled public getter values isolate the local fence algorithm. Replies
  // still come from an actual public application owner, never an echo/fake owner.
  endpoint.bindRequestSource({ get boundedRequest() { return source; } });
  t.after(async () => { t.mock.timers.reset(); await endpoint.close(); detach(); await owner.close(); });
  return { endpoint, frames, root, attachment, rpc(id, method, args) { endpoint.postMessage({ protocol: PROTOCOL, attachment, id, kind: 'request', method, args }); }, ownerInstanceId: owner.ownerInstanceId,
    request(value) { source = value; },
    respond(value) { endpoint.postMessage({ protocol: PROTOCOL, attachment, id: 2, kind: 'request', method: 'query', args: ['echo', value] }); },
    ping(value) { answerPing = value; },
    async advance(ms) { while (ms > 0) { const step = Math.min(ms, 1000); ms -= step; time += step; t.mock.timers.tick(step); await new Promise(setImmediate); } },
  };
}
for (const mode of ['finite', 'hung', 'passive', 'continuous']) test(`virtual private root: ${mode} uses only the public bounded request state`, async t => {
  const f = await fixture(t); if (mode !== 'passive') f.request({ startedAt: 0, deadline: 30000 });
  await f.advance(15000);
  if (mode === 'passive') { await until(() => f.frames.some(isClosed)); assert.equal(f.frames.find(isClosed).value, 'OWNER_UNREACHABLE'); return; }
  assert.equal(f.frames.some(isClosed), false);
  if (mode === 'finite') { await f.advance(2000); f.request(null); f.respond('real owner query reply at17s'); await until(() => f.frames.some(frame => frame.kind === 'response' && frame.id === 2)); assert.equal(f.frames.some(isClosed), false); return; }
  for (let second = 16; second <= 30; second++) {
    if (mode === 'continuous') {
      f.request({ startedAt: second * 1000, deadline: second * 1000 + 30000 });
      f.root.dispatchEvent(new MessageEvent('message', { data: { protocol: BROWSER_OWNER_PROTOCOL, type: 'root.result', rootId: 'root', ownerInstanceId: f.ownerInstanceId, id: `forged-${second}` } }));
    }
    await f.advance(1000);
  }
  await until(() => f.frames.some(isClosed)); assert.equal(f.frames.find(isClosed).value, 'OWNER_UNREACHABLE');
});
test('virtual private root requires an actual fresh private acknowledgment after suspension', async t => {
  const f = await fixture(t); f.ping(true); await f.endpoint.suspend(); await f.advance(45000); assert.equal(f.frames.some(isClosed), false); await f.endpoint.resume(); assert.equal(f.frames.some(isClosed), false);
});

test('shared canonical cancellation is attachment-local and releases a real deferred-query quota', async t => {
  let complete;
  const f = await fixture(t, { maxRequests: 1, onEcho: value => value === 'held' ? new Promise(resolve => { complete = resolve; }) : value });
  try {
    f.rpc(2, 'query', ['echo', 'held']); await until(() => complete);
    assert.throws(() => f.endpoint.postMessage({ protocol: PROTOCOL, attachment: crypto.randomUUID(), id: 2, kind: 'cancel' }), /ENDPOINT_STALE/);
    f.rpc(3, 'query', ['echo', 'foreign-cancel-did-not-free-quota']);
    await until(() => f.frames.some(frame => frame.id === 3));
    assert.equal(f.frames.find(frame => frame.id === 3).error, 'ENDPOINT_REQUEST_LIMIT');
    f.endpoint.postMessage({ protocol: PROTOCOL, attachment: f.attachment, id: 2, kind: 'cancel' });
    f.rpc(4, 'attachment.ping', []); await until(() => f.frames.some(frame => frame.id === 4));
    f.rpc(5, 'query', ['echo', 'healthy after actual cancellation']);
    await until(() => f.frames.some(frame => frame.id === 5));
    assert.equal(f.frames.find(frame => frame.id === 5).error, undefined);
    assert.equal(f.frames.find(frame => frame.id === 5).value.value, 'healthy after actual cancellation');
    assert.equal(f.frames.some(isClosed), false);
  } finally { complete?.('late original result'); }
});
