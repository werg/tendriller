import assert from 'node:assert/strict';
import test from 'node:test';
import { participateApplication } from '../../session/participation.mjs';

function makeStubController({ stableLinkMs, dropAfterMs }) {
  const selfKey = '11'.repeat(32);
  const remoteKey = '22'.repeat(32);
  const sessionAbort = new AbortController();
  const attempts = [];
  const peers = {
    async discover() {
      return { peers: [{ advertisement: { version: 1, peerId: remoteKey, storageId: 'remote-store', routes: [{ kind: 'invitation', peerId: remoteKey }] } }] };
    },
    async advertise() { return { ok: true }; },
    async withdraw() { return { ok: true }; },
    watchDiscovery(_id, { signal }) {
      const ready = Promise.resolve();
      return {
        ready,
        closed: Promise.resolve({ code: 1000, reason: '' }),
        notifications: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'ready' };
            if (!signal?.aborted) {
              await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
            }
          },
        },
        close() {},
      };
    },
    listenInvitations(_id, { signal }) {
      return {
        ready: Promise.resolve(),
        closed: Promise.resolve({ code: 1000, reason: '' }),
        invitations: {
          async *[Symbol.asyncIterator]() {
            if (!signal?.aborted) {
              await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
            }
          },
        },
        close() {},
      };
    },
    async invite() { return { invited: remoteKey, channel: 'ch' }; },
    rendezvous() {
      return {
        ready: Promise.resolve({ role: 'offerer', session: 'sess-1' }),
        close() {},
      };
    },
    relay() { throw new Error('unused'); },
  };
  const session = {
    identity: { publicKey: selfKey },
    device: { storageId: 'self-store' },
    signal: sessionAbort.signal,
    isReader: key => key === remoteKey,
    onChange: () => () => {},
    async connectPeer({ connection }) {
      attempts.push(Date.now());
      const linkAbort = new AbortController();
      const timer = setTimeout(() => linkAbort.abort(new Error('FLAPPED')), dropAfterMs);
      timer.unref?.();
      return {
        signal: linkAbort.signal,
        async close() { clearTimeout(timer); linkAbort.abort(); await connection.close(); },
      };
    },
  };
  const controller = participateApplication(session, {
    peers,
    stableLinkMs,
    passiveDialDelayMs: 0,
    directTimeoutMs: 500,
    async openDirectConnection() {
      return {
        async close() {},
        send() {},
      };
    },
  });
  return { controller, attempts, stop: async () => { await controller.close(); sessionAbort.abort(); } };
}

test('flapping short-lived peer links do not reset reconnect retryCount and back off exponentially', async () => {
  // Override setTimeout? No — test the real delay delta: with retryCount NOT reset on a 50ms link,
  // attempt 1 -> drop (+50ms) -> retry #1 after 1000ms -> drop (+50ms) -> retry #2 after 2000ms!
  // Let's verify gap2 > gap1 (around 2000ms vs 1000ms).
  const { attempts, stop } = makeStubController({ stableLinkMs: 5000, dropAfterMs: 30 });
  try {
    const deadline = Date.now() + 4500;
    while (attempts.length < 3 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(attempts.length, 3, `expected 3 attempts within 4.5s, got ${attempts.length}`);
    const gap1 = attempts[1] - attempts[0];
    const gap2 = attempts[2] - attempts[1];
    assert.ok(gap1 >= 900 && gap1 < 1600, `expected first retry gap ~1030ms, got ${gap1}ms`);
    assert.ok(gap2 >= 1800, `expected second retry gap to back off to ~2030ms instead of resetting, got ${gap2}ms`);
  } finally {
    await stop();
  }
});

test('a peer link that stays healthy for stableLinkMs resets reconnect retryCount', async () => {
  const { attempts, stop } = makeStubController({ stableLinkMs: 20, dropAfterMs: 80 });
  try {
    const deadline = Date.now() + 3000;
    while (attempts.length < 3 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(attempts.length, 3, `expected 3 attempts within 3s, got ${attempts.length}`);
    const gap1 = attempts[1] - attempts[0];
    const gap2 = attempts[2] - attempts[1];
    assert.ok(gap1 >= 950 && gap1 < 1600, `expected first retry gap ~1080ms, got ${gap1}ms`);
    assert.ok(gap2 >= 950 && gap2 < 1600, `expected second retry gap to stay ~1080ms after stable reset, got ${gap2}ms`);
  } finally {
    await stop();
  }
});

test('a failed connection attempt still schedules a peer retry after clearing opening state', async () => {
  const selfKey = '11'.repeat(32);
  const remoteKey = '22'.repeat(32);
  const sessionAbort = new AbortController();
  let dialCount = 0;
  const peers = {
    async discover() {
      return { peers: [{ advertisement: { version: 1, peerId: remoteKey, storageId: 'remote-store', routes: [{ kind: 'invitation', peerId: remoteKey }] } }] };
    },
    async advertise() { return { ok: true }; },
    async withdraw() { return { ok: true }; },
    watchDiscovery(_id, { signal }) {
      return {
        ready: Promise.resolve(),
        closed: Promise.resolve({ code: 1000, reason: '' }),
        notifications: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'ready' };
            if (!signal?.aborted) await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
          },
        },
        close() {},
      };
    },
    listenInvitations(_id, { signal }) {
      return {
        ready: Promise.resolve(),
        closed: Promise.resolve({ code: 1000, reason: '' }),
        invitations: {
          async *[Symbol.asyncIterator]() {
            if (!signal?.aborted) await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
          },
        },
        close() {},
      };
    },
    async invite() { return { invited: remoteKey, channel: 'ch' }; },
    rendezvous() { return { ready: Promise.resolve({ role: 'offerer', session: 'sess-1' }), close() {} }; },
    relay() { throw new Error('relay_rate_limited'); },
  };
  const session = {
    identity: { publicKey: selfKey },
    device: { storageId: 'self-store' },
    signal: sessionAbort.signal,
    isReader: key => key === remoteKey,
    onChange: () => () => {},
    async connectPeer({ connection }) {
      const linkAbort = new AbortController();
      return { signal: linkAbort.signal, async close() { linkAbort.abort(); await connection.close(); } };
    },
  };
  const controller = participateApplication(session, {
    peers,
    passiveDialDelayMs: 0,
    directTimeoutMs: 200,
    async openDirectConnection() {
      dialCount++;
      if (dialCount === 1) throw new Error('TRANSIENT_DIAL_FAILURE');
      return { async close() {}, send() {} };
    },
  });
  try {
    const deadline = Date.now() + 3000;
    while (controller.status.connectedPeers.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(dialCount >= 2, `expected retry after failed dial, saw ${dialCount} attempt(s)`);
    assert.deepEqual(controller.status.connectedPeers, [remoteKey]);
  } finally {
    await controller.close();
    sessionAbort.abort();
  }
});
