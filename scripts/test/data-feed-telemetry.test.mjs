import test from 'node:test';
import assert from 'node:assert/strict';
import { serveDataFeeds, useDataFeed } from '../../docs/tutorial/shared/helpers/data-feed.mjs';
import { mountDevTelemetry, collectDevTelemetry } from '../../docs/tutorial/shared/helpers/dev-telemetry.mjs';
import {
  announceAgentPresence,
  watchAgentPresence,
  streamAgentReply,
  watchAgentStream,
} from '../../docs/tutorial/shared/helpers/agent-requests.mjs';

function createMockSignalPair() {
  const subscribers = [];
  const retained = new Map();
  const statusListeners = new Map([['native-peer', new Set()], ['browser-peer', new Set()]]);
  const frameKey = frame => JSON.stringify([frame.authorId, frame.sessionId, frame.topic, frame.stream ?? null]);
  const matchesStream = (frame, selectors) => !selectors || selectors.some(selector =>
    Object.entries(selector).every(([key, value]) => (key === 'authorId' || key === 'sessionId'
      ? frame[key] : frame.stream?.[key]) === value));
  const deliver = frame => {
    const key = frameKey(frame), previous = retained.get(key);
    if (!previous || previous.sequence < frame.sequence) retained.set(key, frame);
    for (const sub of [...subscribers]) {
      if (sub.topics.includes(frame.topic) && !sub.signal?.aborted && matchesStream(frame, sub.streams)) sub.push(frame);
    }
  };

  const makeSession = (deviceId, peerId) => {
    const controller = new AbortController();
    let peers = [peerId], sequence = 0;
    const participation = {
      get status() { return { state: 'connected', phase: 'connected', connectedPeers: peers }; },
      onStatus(fn) {
        statusListeners.get(deviceId).add(fn);
        return () => statusListeners.get(deviceId).delete(fn);
      },
      setPeers(next) {
        peers = next;
        for (const fn of statusListeners.get(deviceId)) fn(this.status);
      },
    };
    const signals = {
      async send(topic, payload, { ttlMs = 45_000, stream } = {}) {
        const issuedAtMs = Date.now();
        const frame = { scope: 'presence-test', topic, authorId: deviceId,
          sessionId: deviceId + '-session', sequence: ++sequence, issuedAtMs,
          expiresAtMs: issuedAtMs + ttlMs, payload, ...(stream ? { stream } : {}) };
        deliver(frame);
        return frame;
      },
      subscribe({ topics, mode = 'all', streams, includeLatest = false, signal }) {
        // Public Chronolog contract: retained replay is available only in latest mode.
        if (includeLatest && mode !== 'latest') throw Error('SIGNAL_SUBSCRIPTION_MODE_INVALID');
        const queue = [], latest = new Map();
        let wake = null;
        const sub = {
          topics, streams, signal,
          push(frame) {
            if (frame.expiresAtMs <= Date.now()) return;
            const key = frameKey(frame);
            if (mode === 'latest') {
              if ((latest.get(key) ?? 0) >= frame.sequence) return;
              latest.set(key, frame.sequence);
              const previous = queue.findIndex(item => frameKey(item) === key);
              if (previous !== -1) queue.splice(previous, 1);
            }
            queue.push(frame); wake?.(); wake = null;
          },
        };
        if (includeLatest) {
          for (const existing of retained.values()) {
            if (topics.includes(existing.topic) && matchesStream(existing, streams)) sub.push(existing);
          }
        }
        subscribers.push(sub);
        signal?.addEventListener('abort', () => { wake?.(); wake = null; }, { once: true });
        return {
          async *[Symbol.asyncIterator]() {
            try {
              while (!signal?.aborted) {
                while (queue.length) {
                  const frame = queue.shift();
                  if (frame.expiresAtMs > Date.now()) yield frame;
                }
                if (signal?.aborted) break;
                await new Promise(resolve => { wake = resolve; });
              }
            } finally {
              const idx = subscribers.indexOf(sub);
              if (idx >= 0) subscribers.splice(idx, 1);
            }
          },
        };
      },
    };
    return { deviceId, signal: controller.signal, close: () => controller.abort(), signals, participation };
  };

  return {
    native: makeSession('native-peer', 'browser-peer'),
    browser: makeSession('browser-peer', 'native-peer'),
    deliver,
  };
}

test('filtered feeds ignore default pushes and late replies from an older query', async t => {
  const { native, browser } = createMockSignalPair();
  let release;
  const server = serveDataFeeds(native, { items: async query => {
    if (query?.name === 'slow') await new Promise(resolve => { release = resolve; });
    return { name: query?.name ?? 'default' };
  } });
  const feed = useDataFeed(browser, { peer: native.deviceId, feed: 'items', query: { name: 'filtered' } });
  t.after(() => { feed.close(); server.close(); native.close(); browser.close(); });
  await waitUntil(() => feed.snapshot().data?.name === 'filtered');
  await server.push('items', { name: 'default' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(feed.snapshot().data.name, 'filtered');
  const slow = feed.refresh({ name: 'slow' });
  await waitUntil(() => release);
  await feed.refresh({ name: 'new' });
  release();
  await slow;
  assert.equal(feed.snapshot().data.name, 'new');
});

test('a restarted feed service can replace a higher revision from the previous generation', async t => {
  const { native, browser } = createMockSignalPair();
  let server = serveDataFeeds(native, { value: async () => 1 });
  const feed = useDataFeed(browser, { peer: native.deviceId, feed: 'value' });
  t.after(() => { feed.close(); server.close(); native.close(); browser.close(); });
  await waitUntil(() => feed.snapshot().data === 1);
  await server.push('value', 2);
  await waitUntil(() => feed.snapshot().data === 2);
  const previousGeneration = feed.snapshot().generation;
  server.close();
  await server.done;
  server = serveDataFeeds(native, { value: async () => 3 });
  browser.participation.setPeers([]);
  browser.participation.setPeers([native.deviceId]);
  await waitUntil(() => feed.snapshot().data === 3);
  assert.notEqual(feed.snapshot().generation, previousGeneration);
  assert.equal(feed.snapshot().revision, 1);
});

test('unchanged successful polls advance freshness without incrementing the data revision', async t => {
  const { native, browser } = createMockSignalPair();
  const server = serveDataFeeds(native, { value: { pollMs: 25, maxAgeMs: 0, fetch: async () => 7 } });
  const feed = useDataFeed(browser, { peer: native.deviceId, feed: 'value' });
  t.after(() => { feed.close(); server.close(); native.close(); browser.close(); });
  await waitUntil(() => feed.snapshot().data === 7);
  const initial = feed.snapshot();
  await waitUntil(() => feed.snapshot().fetchedAtMs > initial.fetchedAtMs);
  assert.equal(feed.snapshot().revision, initial.revision);
  assert.equal(feed.snapshot().data, 7);
});

test('offline runtime errors remain eligible for telemetry flush on reconnect', async t => {
  const { native, browser } = createMockSignalPair();
  browser.participation.setPeers([]);
  const listeners = new Set(), buffered = [];
  const runtime = { errors: { list: () => buffered, on: fn => { listeners.add(fn); return () => listeners.delete(fn); } } };
  const collector = collectDevTelemetry(native);
  const telemetry = mountDevTelemetry({ session: browser, runtime, captureConsoleError: false });
  t.after(() => { telemetry.close(); collector.close(); native.close(); browser.close(); });
  const error = { id: 'offline-error', message: 'Lost connection' };
  buffered.push(error);
  for (const fn of listeners) fn(error);
  await Promise.resolve();
  browser.participation.setPeers([native.deviceId]);
  await waitUntil(() => collector.entries().some(item => item.payload?.entry?.id === error.id));
});

test('streaming preview truncation respects encoded frame bytes for Unicode and escaped text', async () => {
  const sent = [];
  const session = { signals: { async send(_topic, payload) { sent.push(payload); } } };
  for (const text of ['😀'.repeat(8000), '"\\'.repeat(8000)]) {
    await streamAgentReply(session, { requestAuthor: 'a'.repeat(64), requestOperationId: 'id', text });
    const payload = sent.at(-1);
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).length <= 12 * 1024);
    assert.ok(text.startsWith(payload.text));
    assert.doesNotMatch(payload.text, /[\uD800-\uDBFF]$/u);
  }
});

const waitUntil = async (fn, timeoutMs = 1500) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw Error('Timed out waiting for condition');
    await new Promise(r => setTimeout(r, 15));
  }
};

test('serveDataFeeds and useDataFeed deliver live pushes, deduplicate unchanged snapshots, and serve on-demand/large pulls', async () => {
  const { native, browser } = createMockSignalPair();
  let calls = 0;
  const largeBlob = 'x'.repeat(16_000); // > 10 KiB inline threshold -> pullRequired over chunked signal-request
  const server = serveDataFeeds(native, {
    cpu: {
      maxAgeMs: 0,
      fetch: async () => ({ pct: ++calls * 10 }),
    },
    report: async () => ({ summary: 'big', payload: largeBlob }),
  });

  const updates = [];
  const cpuFeed = useDataFeed(browser, { peer: native.deviceId, feed: 'cpu', onUpdate: s => updates.push(s) });
  await waitUntil(() => cpuFeed.snapshot().data?.pct === 10);

  // Push event-driven update directly from native agent.
  await server.push('cpu', { pct: 42 });
  await waitUntil(() => cpuFeed.snapshot().data?.pct === 42);

  // Large payload triggers automatic chunked pull via signal-request.
  const reportFeed = useDataFeed(browser, { peer: native.deviceId, feed: 'report' });
  await waitUntil(() => reportFeed.snapshot().data?.payload === largeBlob);

  cpuFeed.close();
  reportFeed.close();
  server.close();
  native.close();
  browser.close();
});

test('mountDevTelemetry streams buffered and live runtime errors to collectDevTelemetry without durable writes', async () => {
  const { native, browser } = createMockSignalPair();
  const listeners = new Set();
  const buffered = [{ id: 'boot-1', at: 1000, kind: 'error', message: 'Boot failed' }];
  const runtime = {
    identity: { page: 'dash', version: 3, publication: 'pub-3', documentPath: 'index.html' },
    errors: {
      list: () => buffered.slice(),
      on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    },
  };

  const collector = collectDevTelemetry(native);
  const telemetry = mountDevTelemetry({ session: browser, runtime, captureConsoleError: false });

  await waitUntil(() => collector.entries().some(e => e.payload?.kind === 'error' && e.payload.entry?.id === 'boot-1'));
  await waitUntil(() => Boolean(collector.health()['browser-peer']));

  // Emit a live error after mount.
  const liveErr = { id: 'live-2', at: 2000, kind: 'report', message: 'Chart error' };
  buffered.push(liveErr);
  for (const fn of listeners) fn(liveErr);
  await waitUntil(() => collector.entries().some(e => e.payload?.entry?.id === 'live-2'));

  telemetry.close();
  collector.close();
  native.close();
  browser.close();
});

test('ephemeral agent presence and streaming previews work with zero durable journal records', async () => {
  const { native, browser } = createMockSignalPair();
  const announcer = announceAgentPresence(native, { consumerId: 'agent-1', role: 'ops-agent', intervalMs: 60_000 });

  const states = [];
  const watcher = watchAgentPresence(browser, { peer: native.deviceId, onChange: s => states.push(s.status) });
  await waitUntil(() => watcher.snapshot().status === 'available');

  announcer.setState('busy');
  await waitUntil(() => watcher.snapshot().status === 'busy');

  const chunks = [];
  const stream = watchAgentStream(browser, { peer: native.deviceId, onChunk: c => chunks.push(c) });
  await streamAgentReply(native, { requestAuthor: browser.deviceId, requestOperationId: 'op-1', text: 'Checking CPU…' });
  await waitUntil(() => chunks.length === 1 && chunks[0].text === 'Checking CPU…');

  browser.participation.setPeers([]);
  assert.equal(watcher.snapshot().status, 'stale');
  browser.participation.setPeers([native.deviceId]);

  await announcer.close();
  await waitUntil(() => watcher.snapshot().status === 'stopped');

  stream.close();
  watcher.close();
  native.close();
  browser.close();
});

test('presence follows the actual worker and its topic while the native owner stays connected', async t => {
  const { native, browser } = createMockSignalPair();
  const workerLifetime = new AbortController();
  const fetcher = announceAgentPresence(native, { consumerId: 'fetcher', topics: ['fetch'], intervalMs: 60_000 });
  const watcher = watchAgentPresence(browser, {
    peer: native.deviceId, consumerId: 'assistant', requestTopic: 'chat',
  });
  let assistant;
  t.after(async () => {
    await assistant?.close(); await fetcher.close(); watcher.close(); native.close(); browser.close();
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(watcher.snapshot().status, 'unknown', 'a connected fetcher is not an assistant');
  const invalid = { consumerId: 'assistant', runId: 'run', role: 'assistant',
    topics: ['chat'], state: 'unexpected', startedAtMs: 1, atMs: 2 };
  await native.signals.send('agent/presence', invalid, { stream: { streamId: 'assistant' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(watcher.snapshot().status, 'unknown', 'malformed state cannot become available');
  assistant = announceAgentPresence(native, { consumerId: 'assistant', topics: ['chat'],
    signal: workerLifetime.signal, intervalMs: 60_000 });
  await waitUntil(() => watcher.snapshot().status === 'available');
  workerLifetime.abort(Error('Worker stopped'));
  await assistant.done;
  await waitUntil(() => watcher.snapshot().status === 'stopped');
  assert.equal(native.signal.aborted, false);
  assert.deepEqual(native.participation.status.connectedPeers, ['browser-peer']);
  await fetcher.ping();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(watcher.snapshot().status, 'stopped', 'another worker cannot refresh the stopped assistant');
});

test('presence and streamed replies retain the authenticated frame author', async t => {
  const { native, browser } = createMockSignalPair();
  const watcher = watchAgentPresence(browser, { peer: native.deviceId, consumerId: 'assistant', requestTopic: 'chat' });
  const chunks = [], stream = watchAgentStream(browser, { peer: native.deviceId, onChunk: value => chunks.push(value) });
  t.after(() => { watcher.close(); stream.close(); native.close(); browser.close(); });
  await native.signals.send('agent/presence', { author: 'forged', consumerId: 'assistant',
    runId: 'run', role: 'assistant', topics: ['chat'], state: 'listening', startedAtMs: 1, atMs: 2 },
  { stream: { streamId: 'assistant' } });
  await native.signals.send('agent/stream', { author: 'forged', text: 'Preview' });
  await waitUntil(() => watcher.snapshot().status === 'available' && chunks.length === 1);
  assert.equal(watcher.snapshot().consumer.author, native.deviceId);
  assert.equal(chunks[0].author, native.deviceId);
  watcher.close();
  assert.equal(watcher.snapshot().status, 'unknown', 'a closed observer cannot keep a Live snapshot');
});

test('an already stopped worker never subscribes or starts a presence interval', async () => {
  const lifetime = new AbortController(); lifetime.abort();
  let sends = 0;
  const presence = announceAgentPresence({ deviceId: 'worker', signals: {
    send() { sends++; return Promise.resolve(); },
    subscribe() { throw Error('Stopped worker must not subscribe'); },
  } }, { signal: lifetime.signal, intervalMs: 5 });
  await presence.done;
  assert.equal(sends, 0);
  assert.throws(() => presence.setState('not-a-state'), /AGENT_PRESENCE_STATE_INVALID/);
});

for (const scenario of ['same worker run', 'earlier attachment', 'prior signal session']) {
  test('a reordered listening frame from ' + scenario + ' cannot revive a stopped worker', async t => {
    const { native, browser, deliver } = createMockSignalPair();
    const watcher = watchAgentPresence(browser, {
      peer: native.deviceId, consumerId: 'assistant', requestTopic: 'chat',
    });
    t.after(() => { watcher.close(); native.close(); browser.close(); });
    const now = Date.now(), changedRun = scenario !== 'same worker run';
    const earlier = {
      scope: 'presence-test', topic: 'agent/presence', authorId: native.deviceId,
      sessionId: scenario === 'prior signal session' ? 'old-session' : 'native-peer-session',
      sequence: scenario === 'prior signal session' ? 90 : 1,
      issuedAtMs: now - 1000, expiresAtMs: now + 44_000,
      stream: { streamId: 'assistant', endpointId: 'worker-view', endpointIncarnation: 'old-attachment' },
      payload: { consumerId: 'assistant', runId: 'old-run', role: 'assistant', topics: ['chat'],
        startedAtMs: now - 1000, atMs: now - 1000, state: 'listening' },
    };
    const stopped = { ...earlier, sessionId: 'native-peer-session', sequence: 2,
      issuedAtMs: now, expiresAtMs: now + 45_000,
      stream: { ...earlier.stream, endpointIncarnation: changedRun ? 'new-attachment' : 'old-attachment' },
      payload: { ...earlier.payload, runId: changedRun ? 'new-run' : 'old-run',
        startedAtMs: changedRun ? now : now - 1000, atMs: now, state: 'stopped' } };
    // Distinct valid frames arrive out of order; the old listening frame has
    // never reached this receiver, so ordinary replay deduplication cannot help.
    deliver(stopped);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(watcher.snapshot().status, 'stopped');
    deliver(earlier);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(watcher.snapshot().status, 'stopped');
    assert.equal(watcher.snapshot().consumer.runId, stopped.payload.runId);
  });
}

test('late retained presence expires at the signed frame deadline without a new full freshness window', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const { native, browser } = createMockSignalPair();
  const frame = await native.signals.send('agent/presence', {
    consumerId: 'assistant', runId: 'run', role: 'assistant', topics: ['chat'],
    state: 'listening', startedAtMs: Date.now(), atMs: Date.now(),
  }, { ttlMs: 45_000, stream: { streamId: 'assistant' } });
  t.mock.timers.setTime(frame.expiresAtMs - 1);
  const watcher = watchAgentPresence(browser, {
    peer: native.deviceId, consumerId: 'assistant', requestTopic: 'chat', staleAfterMs: 45_000,
  });
  t.after(() => { watcher.close(); native.close(); browser.close(); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(watcher.snapshot().status, 'available', 'the retained frame is still fresh at receipt');
  t.mock.timers.setTime(frame.expiresAtMs);
  assert.equal(watcher.snapshot().status, 'stale', 'receipt cannot extend the signed expiry');
  assert.equal(native.signal.aborted, false, 'transport owner remains connected');
});

test('latest presence preserves distinct workers sharing one signer before request-topic filtering', async t => {
  const { native, browser } = createMockSignalPair();
  const assistant = announceAgentPresence(native, {
    consumerId: 'assistant', runId: 'assistant-run', topics: ['chat'], intervalMs: 60_000,
  });
  const fetcher = announceAgentPresence(native, {
    consumerId: 'fetcher', runId: 'fetcher-run', topics: ['fetch'], intervalMs: 60_000,
  });
  // Both workers publish before the observer subscribes; the retained store must
  // keep separate streams instead of letting the fetcher replace the assistant.
  await Promise.all([assistant.ping(), fetcher.ping()]);
  const watcher = watchAgentPresence(browser, { peer: native.deviceId, requestTopic: 'chat' });
  t.after(async () => {
    await assistant.close(); await fetcher.close(); watcher.close(); native.close(); browser.close();
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(watcher.snapshot().status, 'available');
  assert.equal(watcher.snapshot().consumer.consumerId, 'assistant');
});
