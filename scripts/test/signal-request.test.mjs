import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSignalRequests, serveSignalRequests, sendPieces, whenConnected } from '../../docs/tutorial/helpers/signal-request.mjs';
import { memoryAvailableGb, installSoakObserver, installStateSignalObservers } from '../first-app-peer.mjs';

// Two sessions on one in-memory live-signal bus. `faults` lets a test drop or refuse
// individual sends, as a slow phone link or a stalled relay would.
function bus(faults = {}, browserId = 'browser') {
  const subscribers = new Set(), sent = [];
  const session = (deviceId, peer) => ({
    deviceId,
    participation: { status: { connectedPeers: [peer] }, onStatus() { return () => {}; } },
    signals: {
      async send(topic, payload) {
        sent.push({ from: deviceId, topic, payload });
        const fault = await faults.send?.({ from: deviceId, topic, payload });
        if (fault === 'refuse') throw Object.assign(Error('stalled'), { code: 'SIGNAL_SEND_TIMEOUT' });
        if (fault === 'drop') return; // accepted locally, lost on the way (live signals are unreliable)
        for (const subscriber of subscribers) if (subscriber.from !== deviceId && subscriber.topics.includes(topic))
          subscriber.push({ authorId: deviceId, topic, payload: structuredClone(payload) });
      },
      subscribe({ topics, signal }) {
        const queue = [], waiters = [];
        const subscriber = { from: deviceId, topics, push(value) { const waiter = waiters.shift(); if (waiter) waiter({ value, done: false }); else queue.push(value); } };
        subscribers.add(subscriber);
        signal?.addEventListener('abort', () => { subscribers.delete(subscriber); for (const waiter of waiters.splice(0)) waiter({ done: true }); }, { once: true });
        return { [Symbol.asyncIterator]() { return { next: () => queue.length ? Promise.resolve({ value: queue.shift(), done: false })
          : signal?.aborted ? Promise.resolve({ done: true }) : new Promise(resolve => waiters.push(resolve)) }; } };
      },
    },
  });
  return { browser: session(browserId, 'native'), native: session('native', browserId), other: session('other', 'native'), sent, subscribers };
}

async function roundTrip(faults) {
  const { browser, native, sent } = bus(faults), stop = new AbortController();
  let computed = 0;
  void serveSignalRequests(native, { signal: stop.signal, handle: async () => { computed++; return { rows: Array.from({ length: 40 }, (_v, i) => 'row ' + i + ' ' + 'x'.repeat(900)) }; } });
  const requests = createSignalRequests(browser, { peer: 'native', retryMs: 50 });
  try {
    const answer = await requests.request('rows', null, { timeoutMs: 10_000 });
    return { answer, computed, sent };
  } finally { requests.close(); stop.abort(); }
}

test('a multi-piece reply completes even when a middle piece is lost in transit', async () => {
  let dropped = false;
  const { answer, computed, sent } = await roundTrip({ send: ({ topic, payload }) =>
    topic === 'app/reply' && payload.i === 2 && !dropped && (dropped = true) ? 'drop' : undefined });
  assert.equal(answer.rows.length, 40);
  assert.equal(computed, 1, 'a repeat request is answered from the cache, not recomputed');
  assert.ok(sent.filter(item => item.topic === 'app/request').length >= 2, 'the page asked again for the incomplete reply');
});

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('The expected protocol checkpoint was not reached');
}
async function fixture(t, { faults, handle, cacheMs } = {}) {
  const f = bus(faults), stop = new AbortController();
  f.service = serveSignalRequests(f.native, { signal: stop.signal, handle: handle ?? (() => null), ...(cacheMs === undefined ? {} : { cacheMs }) });
  f.requests = createSignalRequests(f.browser, { peer: 'native', retryMs: 10 });
  t.after(async () => { f.requests.close(); stop.abort(); await f.service; });
  return f;
}

test('complete JSON payloads fit the byte cap with Unicode, escaping and surrogate pairs', async t => {
  const answer = { value: '漢😀"\\\n'.repeat(6000) };
  const f = await fixture(t, { handle: () => answer, faults: { send({ topic, payload }) {
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).length <= 12 * 1024, topic);
  } } });
  assert.deepEqual(await f.requests.request('unicode'), answer);
  assert.ok(f.sent.filter(v => v.topic === 'app/reply').length > 2);
});

test('oversized answers produce one bounded readable error before sending fragments', async t => {
  const f = await fixture(t, { handle: () => 'x'.repeat(12 * 1024 * 1024) });
  await assert.rejects(f.requests.request('large'), { code: 'REQUEST_REPLY_TOO_LARGE' });
  const replies = f.sent.filter(v => v.topic === 'app/reply');
  assert.equal(replies.length, 1); assert.equal(replies[0].payload.code, 'REQUEST_REPLY_TOO_LARGE');
});

test('already-aborted and closed requests never install connectivity waits or send', async () => {
  const f = bus(); f.browser.participation.status.connectedPeers = [];
  let listeners = 0;
  f.browser.participation.onStatus = () => { listeners++; return () => listeners--; };
  const requests = createSignalRequests(f.browser, { peer: 'native', retryMs: 5 });
  const reason = Error('already stopped');
  await assert.rejects(requests.request('q', null, { signal: AbortSignal.abort(reason) }), error => error === reason);
  assert.equal(listeners, 0);
  const pending = requests.request('q');
  await until(() => listeners === 1); requests.close();
  await assert.rejects(pending, { code: 'REQUEST_CLOSED' });
  await assert.rejects(requests.request('q'), { code: 'REQUEST_CLOSED' });
  assert.equal(listeners, 0); assert.equal(f.sent.length, 0);
});

test('synchronous connectivity callbacks release their listener and respect pre-abort', async () => {
  const f = bus(); f.browser.participation.status.connectedPeers = [];
  let removed = 0;
  f.browser.participation.onStatus = callback => { callback({ connectedPeers: ['native'] }); return () => removed++; };
  await whenConnected(f.browser, 'native'); assert.equal(removed, 1);
  assert.throws(() => whenConnected(f.browser, 'native', { signal: AbortSignal.abort(Error('stop')) }), /stop/);
});

test('closing a sender with an abort-ignoring transport settles without another send', async () => {
  const f = bus(); let resolveSend;
  f.browser.signals.send = () => new Promise(resolve => { resolveSend = resolve; });
  const requests = createSignalRequests(f.browser, { peer: 'native', retryMs: 5 });
  const pending = requests.request('q'); await until(() => resolveSend); requests.close();
  await assert.rejects(pending, { code: 'REQUEST_CLOSED' }); resolveSend(); await turn();
  assert.equal(f.subscribers.size, 0);
});

test('a whole piece batch has one deadline and an already-aborted batch sends nothing', async () => {
  const f = bus({ send: () => 'refuse' });
  await assert.rejects(sendPieces(f.native, 'reply', [{ i: 0 }], { ttlMs: 30 }), { code: 'SIGNAL_SEND_TIMEOUT' });
  const count = f.sent.length;
  await assert.rejects(sendPieces(f.native, 'reply', [{ i: 0 }], { signal: AbortSignal.abort(Error('stop')) }), /stop/);
  assert.equal(f.sent.length, count);
});

test('same cached reply has only one send in flight under repeated client retries', async t => {
  let release, blocked = 0, computed = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { handle: () => { computed++; return 'x'.repeat(40_000); }, faults: { async send({ topic, payload }) {
    if (topic === 'app/reply' && payload.i === 0) { blocked++; await gate; }
  } } });
  const pending = f.requests.request('q');
  await until(() => f.sent.filter(v => v.topic === 'app/request').length >= 4);
  assert.equal(computed, 1); assert.equal(blocked, 1);
  release(); assert.equal((await pending).length, 40_000);
});

test('cache expiry cannot combine fragments from different computations', async t => {
  let calls = 0, firstGeneration;
  const f = await fixture(t, { cacheMs: 0, handle: () => ({ text: (calls++ === 0 ? 'A' : 'B').repeat(30_000) }), faults: { send({ topic, payload }) {
    if (topic !== 'app/reply') return;
    firstGeneration ??= payload.g;
    if (payload.g === firstGeneration && payload.i > 0) return 'drop';
  } } });
  assert.equal((await f.requests.request('changing')).text, 'B'.repeat(30_000));
  assert.ok(calls >= 2);
});

test('reply validation rejects huge indexes, changing counts and conflicting duplicates', async () => {
  for (const fragments of [
    [{ i: 0, n: Number.MAX_SAFE_INTEGER, z: '"x"' }],
    [{ i: 0, n: 2, z: '"x' }, { i: 1, n: 3, z: '"' }],
    [{ i: 0, n: 2, z: '"x' }, { i: 0, n: 2, z: '"y' }],
  ]) {
    const f = bus(), requests = createSignalRequests(f.browser, { peer: 'native' });
    try {
      const pending = requests.request('q'); await until(() => f.sent.length);
      const id = f.sent[0].payload.id;
      for (const part of fragments) await f.native.signals.send('app/reply', { id, g: 'generation', r: 'browser', ...part });
      await assert.rejects(pending, { code: 'REQUEST_REPLY_INVALID' });
    } finally { requests.close(); }
  }
});

test('cache identity includes author and preserves original question/input for a retained ID', async t => {
  const calls = [];
  const f = await fixture(t, { handle: (q, input, { from }) => { calls.push({ q, input, from }); return calls.at(-1); } });
  f.requests.close();
  const send = (session, q, input) => session.signals.send('app/request', { id: 'same-id', q, input });
  await send(f.browser, 'first', { value: 1 }); await until(() => f.sent.some(v => v.topic === 'app/reply'));
  const initial = f.sent.find(v => v.topic === 'app/reply').payload;
  await turn(); await send(f.browser, 'changed', { value: 2 });
  await until(() => f.sent.filter(v => v.topic === 'app/reply').length === 2);
  assert.equal(calls.length, 1); assert.deepEqual(f.sent.filter(v => v.topic === 'app/reply')[1].payload, initial);
  await send(f.other, 'other-question', { value: 3 }); await until(() => calls.length === 2);
  assert.deepEqual(calls[1], { q: 'other-question', input: { value: 3 }, from: 'other' });
});

test('pending handlers are bounded and cancellation settles even when providers ignore it', async () => {
  const f = bus(), stop = new AbortController(); let handlers = 0;
  const service = serveSignalRequests(f.native, { signal: stop.signal, handle: () => { handlers++; return new Promise(() => {}); } });
  for (let i = 0; i < 40; i++) await f.browser.signals.send('app/request', { id: String(i), q: 'q' });
  await until(() => handlers === 32); await turn(); assert.equal(handlers, 32);
  stop.abort(); await service; assert.equal(f.subscribers.size, 0);
});

test('client pending-request bound is enforced and close settles every waiter', async () => {
  const f = bus(); f.browser.participation.status.connectedPeers = [];
  const requests = createSignalRequests(f.browser, { peer: 'native' });
  const pending = Array.from({ length: 16 }, () => requests.request('q'));
  const results = Promise.allSettled(pending);
  await assert.rejects(requests.request('overflow'), { code: 'REQUEST_BUSY' });
  requests.close(); assert.ok((await results).every(v => v.status === 'rejected' && v.reason.code === 'REQUEST_CLOSED'));
});

test('terminal send failure rejects the service instead of silently abandoning replies', async () => {
  const f = bus(); f.native.signals.send = async () => { throw Object.assign(Error('broken'), { code: 'BROKEN_ROUTE' }); };
  const checked = assert.rejects(serveSignalRequests(f.native, { handle: () => 'answer' }), { code: 'BROKEN_ROUTE' });
  await f.browser.signals.send('app/request', { id: 'request', q: 'q' }); await checked;
});

test('memory diagnostics remain optional and distinguish missing from zero', () => {
  assert.equal(memoryAvailableGb(() => { throw Error('no /proc'); }), null);
  assert.equal(memoryAvailableGb(() => 'MemTotal: 123 kB\n'), null);
  assert.equal(memoryAvailableGb(() => 'MemAvailable: 0 kB\n'), 0);
  assert.equal(memoryAvailableGb(() => 'MemAvailable: 2097152 kB\n'), 2);
});

test('actual soak observer counts distinct indexes, not duplicate signals', async () => {
  const f = bus(), window = { tendril: { signals: { ...f.browser.signals, ready: async () => {} } } };
  await runInNewContext(`(${installSoakObserver.toString()})()`, { window, AbortController });
  const send = (i, n = 3) => f.native.signals.send('soak', { id: 'reply', i, n });
  try {
    for (const i of [0, 0, 1]) await send(i);
    await turn(); assert.equal(window.soak.complete, 0); assert.equal(window.soak.pieces, 2);
    await send(2); await send(2); await turn(); assert.equal(window.soak.complete, 1);
    await send(999, Number.MAX_SAFE_INTEGER); await turn(); assert.equal(window.soak.complete, 1);
  } finally { window.soak.stop.abort(); }
});

test('state subscriptions wait for installation and expose subscription errors', async () => {
  let ready, subscriptions = 0;
  const gate = new Promise(resolve => { ready = resolve; });
  const window = { tendril: { signals: { ready: () => gate, subscribe() { subscriptions++; throw Object.assign(Error('unavailable'), { code: 'unavailable' }); } } } };
  const installed = runInNewContext(`(${installStateSignalObservers.toString()})()`, { window });
  assert.equal(subscriptions, 0); ready(); await installed; await turn();
  assert.equal(subscriptions, 2); assert.equal(window.stateModeErrors.length, 2);
});

test('a piece refused with SIGNAL_SEND_TIMEOUT is retried and does not drop the rest of the reply', async () => {
  let refused = 0;
  const { answer, sent } = await roundTrip({ send: ({ topic, payload }) =>
    topic === 'app/reply' && payload.i === 1 && refused++ < 2 ? 'refuse' : undefined });
  assert.equal(answer.rows.length, 40);
  assert.equal(refused >= 3, true, 'the refused piece was attempted again');
  const pieces = new Set(sent.filter(item => item.topic === 'app/reply').map(item => item.payload.i));
  assert.equal(pieces.size, answer.rows.length ? Math.max(...pieces) + 1 : 0, 'every piece index was sent');
});

test('broadcast ID reuse cannot substitute another member answer or error', async t => {
  for (const attackerFails of [false, true]) {
    let release;
    const f = await fixture(t, { handle: (_q, input, { from }) => {
      if (from === 'browser') return new Promise(resolve => { release = resolve; });
      if (attackerFails) throw Error('attacker failure');
      return input;
    } });
    let settled = false;
    const pending = f.requests.request('q', 'victim').finally(() => { settled = true; });
    await until(() => release);
    const id = f.sent.find(v => v.topic === 'app/request').payload.id;
    await f.other.signals.send('app/request', { id, q: 'q', input: 'attacker' });
    await until(() => f.sent.some(v => v.topic === 'app/reply' && v.payload.r === 'other'));
    await turn(); assert.equal(settled, false);
    release('victim'); assert.equal(await pending, 'victim');
    assert.ok(f.sent.filter(v => v.topic === 'app/reply').every(v => ['browser', 'other'].includes(v.payload.r)));
  }
});

test('delayed old generations do not retire a valid newer assembly', async () => {
  const f = bus(), requests = createSignalRequests(f.browser, { peer: 'native' });
  try {
    const pending = requests.request('q'); await until(() => f.sent.length);
    const id = f.sent[0].payload.id;
    for (const part of [
      { g: 'new', i: 0, n: 2, z: '"new' },
      { g: 'old', i: 0, n: 2, z: '"old' },
      { g: 'new', i: 1, n: 2, z: ' answer"' },
    ]) await f.native.signals.send('app/reply', { id, r: 'browser', ...part });
    assert.equal(await pending, 'new answer');
  } finally { requests.close(); }
});

test('generation metadata and aggregate assembly bytes have shared hard bounds', async () => {
  for (const kind of ['count', 'bytes']) {
    const f = bus(), requests = createSignalRequests(f.browser, { peer: 'native' });
    try {
      const pending = requests.request('q');
      const checked = assert.rejects(pending, { code: kind === 'count' ? 'REQUEST_REPLY_INVALID' : 'REQUEST_REPLY_TOO_LARGE' });
      await until(() => f.sent.length); const id = f.sent[0].payload.id;
      const count = kind === 'count' ? 33 : 360;
      for (let i = 0; i < count; i++) await f.native.signals.send('app/reply', {
        id, r: 'browser', g: kind === 'count' ? String(i) : String(i % 2),
        i: Math.floor(i / 2), n: 512, z: kind === 'count' ? 'x' : 'x'.repeat(12_000),
      });
      await checked;
    } finally { requests.close(); }
  }
});

test('arbitrary thrown values yield bounded request errors without killing service', async t => {
  const hostile = { get message() { throw Error('getter'); }, get code() { throw Error('getter'); } };
  for (const thrown of [null, undefined, hostile]) {
    const f = await fixture(t, { handle: q => { if (q === 'bad') throw thrown; return 'healthy'; } });
    await assert.rejects(f.requests.request('bad'), { code: 'REQUEST_FAILED' });
    assert.equal(await f.requests.request('good'), 'healthy');
  }
});

test('timed-out providers retain actual execution capacity until real settlement', async () => {
  const realTimeout = globalThis.setTimeout;
  // Scale only the service's fixed 30s deadlines, not caller waits or retry timers.
  globalThis.setTimeout = (callback, ms, ...args) => realTimeout(callback, ms === 30_000 ? 5 : ms, ...args);
  const f = bus(), stop = new AbortController(), providers = []; let calls = 0;
  const service = serveSignalRequests(f.native, { signal: stop.signal, cacheMs: 0, handle: () => {
    calls++; return new Promise((resolve, reject) => providers.push({ resolve, reject }));
  } });
  try {
    for (let i = 0; i < 32; i++) await f.browser.signals.send('app/request', { id: String(i), q: 'q' });
    await until(() => f.sent.filter(v => v.topic === 'app/reply').length === 32);
    assert.equal(calls, 32);
    for (let i = 32; i < 64; i++) await f.browser.signals.send('app/request', { id: String(i), q: 'q' });
    await until(() => f.sent.filter(v => v.topic === 'app/reply').length === 64);
    assert.equal(calls, 32);
    assert.ok(f.sent.filter(v => v.topic === 'app/reply').slice(32).every(v => v.payload.code === 'REQUEST_BUSY'));
    stop.abort(); await service;
    const sent = f.sent.length;
    providers.forEach((p, i) => i % 2 ? p.reject(null) : p.resolve('too late'));
    await turn(); assert.equal(f.sent.length, sent);
  } finally { globalThis.setTimeout = realTimeout; stop.abort(); await service; }
});

test('generated replies fit the actual public session signed signal encoder', async () => {
  const p = await import('@chronolog/peer-session');
  const device = await p.openApplicationDevice({ store: new p.MemoryBytesStore(), create: true });
  let session;
  try {
    const definition = p.defineApplication({ id: 'signal-budget', version: '1', commands: {}, queries: {} });
    const signer = await p.createPeerIdentity(), key = crypto.getRandomValues(new Uint8Array(32));
    const execution = await p.executionManifestArtifacts(await p.eventExecutionManifest());
    const descriptor = await p.signApplicationDescriptor({ applicationId: '73'.repeat(32), historyId: 'signal-budget',
      profile: 'peer-generation-v1', policy: 'eligible-members-v1', controlPublicKey: signer.publicKey,
      schemaAdministrator: device.identity.publicKey, definitionDigest: await p.applicationDefinitionDigest(definition),
      executionManifestDigest: p.bytesToHex(execution.executionManifestDigest), schemaDigest: null }, signer);
    const control = await p.signControlRevision({ applicationId: descriptor.payload.applicationId,
      profile: descriptor.payload.profile, policy: descriptor.payload.policy, revision: 0, previous: null,
      epoch: 0, keyDigest: await p.bytesDigest(key), recoveryFloor: null,
      grants: [p.participantGrant(device.identity.publicKey, { administrator: true })] }, signer);
    const registry = await p.createGenerationRegistry({ store: new p.MemoryBytesStore(), descriptor, controls: [control], signer });
    await registry.select(await p.signTransitionRequest({ applicationId: descriptor.payload.applicationId,
      profile: descriptor.payload.profile, policy: descriptor.payload.policy, transitionId: 'initial', expectedGeneration: null,
      coordinator: device.identity.publicKey, requester: device.identity.publicKey, controlRevision: 0, reason: 'create', base: null }, device.identity));
    session = await p.openPeerApplication({ device, definition, authority: await registry.read(), epochKeys: new Map([[0, key]]), signals: { localEcho: true } });
    // Real encoder accepts 16KiB JSON but rejects its larger signed CBOR frame.
    await assert.rejects(session.signals.send('app/reply', { z: 'x'.repeat(16_300) }), { code: 'SIGNAL_FRAME_TOO_LARGE' });
    const f = bus({}, session.deviceId), stop = new AbortController();
    assert.match(session.deviceId, /^[a-f0-9]{64}$/);
    const service = serveSignalRequests(f.native, { signal: stop.signal, handle: () => ({ rows: '漢😀"\\\n'.repeat(12_000) }) });
    try {
      await f.browser.signals.send('app/request', { id: crypto.randomUUID(), q: 'rows' });
      await until(() => f.sent.some(v => v.topic === 'app/reply' && v.payload.i === v.payload.n - 1));
      const replies = f.sent.filter(v => v.topic === 'app/reply'); assert.ok(replies.length > 2);
      assert.ok(replies.every(v => v.payload.r === session.deviceId));
      for (const { payload } of replies) {
        assert.ok(new TextEncoder().encode(JSON.stringify(payload)).length <= 12 * 1024);
        await session.signals.send('app/reply', payload);
      }
      assert.equal(session.status.database, 'idle');
    } finally { stop.abort(); await service; }
  } finally { await session?.close(); await device.close(); }
});
