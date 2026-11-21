import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedRootEndpoint } from '../browser-root.mjs';
import { BROWSER_OWNER_PROTOCOL } from '../browser-transport.mjs';

async function until(condition) {
  const end = Date.now() + 3000;
  while (!condition()) { if (Date.now() > end) throw Error('PRIVATE_ROOT_TEST_TIMEOUT'); await new Promise(setImmediate); }
}
async function fixture(t) {
  let time = 0, source = null, workerPort, answerPing = false;
  t.mock.method(performance, 'now', () => time);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = new EventTarget(), frames = [], pair = new MessageChannel();
  root.postMessage = data => {
    if (data.port) { workerPort = data.port; workerPort.start(); return; }
    if (data.type === 'root.ping' && !answerPing) return;
    queueMicrotask(() => root.dispatchEvent(new MessageEvent('message', { data: {
      protocol: BROWSER_OWNER_PROTOCOL, type: 'root.result', rootId: 'root', ownerInstanceId: 'owner', id: data.id,
    } })));
  };
  const endpoint = createSharedRootEndpoint(root, { profileId: 'profile', rootId: 'root', ownerInstanceId: 'owner',
    livenessTimeoutMs: 15000, requestTimeoutMs: 30000 });
  pair.port1.addEventListener('message', ({ data }) => frames.push(data)); pair.port1.start();
  endpoint.postMessage({ port: pair.port2, protocol: 'test', handshake: {} });
  endpoint.bindRequestSource({ get boundedRequest() { return source; } });
  t.after(async () => { t.mock.timers.reset(); await endpoint.close(); workerPort?.close(); pair.port1.close(); pair.port2.close(); });
  return { endpoint, frames, root,
    request(value) { source = value; },
    respond(value) { workerPort.postMessage(value); },
    ping(value) { answerPing = value; },
    async advance(ms) { while (ms > 0) { const step = Math.min(ms, 1000); ms -= step; time += step; t.mock.timers.tick(step); await new Promise(setImmediate); } },
  };
}

for (const mode of ['finite', 'hung', 'passive', 'continuous']) {
  test(`virtual private SharedWorker root: ${mode} uses public bounded request state only`, async t => {
    const f = await fixture(t);
    if (mode !== 'passive') f.request({ startedAt: 0, deadline: 30000 });
    // The first ping is due at15s, so retain the first actual request through it.
    await f.advance(15000);
    if (mode === 'passive') {
      await until(() => f.frames.some(frame => frame.ended));
      assert.equal(f.frames.find(frame => frame.ended).ended.code, 'OWNER_UNREACHABLE'); return;
    }
    assert.equal(f.frames.some(frame => frame.ended), false);
    if (mode === 'finite') {
      await f.advance(2000);
      f.request(null); f.respond({ id: 1, value: 'real owner reply at17s' });
      await until(() => f.frames.some(frame => frame.id === 1));
      assert.equal(f.frames.some(frame => frame.ended), false);
      return;
    }
    for (let second = 16; second <= 30; second++) {
      if (mode === 'continuous') {
        f.request({ startedAt: second * 1000, deadline: second * 1000 + 30000 });
        // Public-looking replies with no matching private control waiter cannot
        // refresh the owner clock or supply any admission/progress evidence.
        f.root.dispatchEvent(new MessageEvent('message', { data: { protocol: BROWSER_OWNER_PROTOCOL,
          type: 'root.result', rootId: 'root', ownerInstanceId: 'owner', id: `fake-${second}` } }));
      }
      await f.advance(1000);
    }
    await until(() => f.frames.some(frame => frame.ended));
    assert.equal(f.frames.find(frame => frame.ended).ended.code, 'OWNER_UNREACHABLE');
  });
}

test('virtual private root resumes a long suspension only after actual owner acknowledgement', async t => {
  const f = await fixture(t); f.ping(true); await f.endpoint.suspend();
  await f.advance(45000);
  assert.equal(f.frames.some(frame => frame.ended), false);
  await f.endpoint.resume();
  assert.equal(f.frames.some(frame => frame.ended), false);
});
