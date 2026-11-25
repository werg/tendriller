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

/**
 * Two in-memory sessions with ONLY the current public session surface: `status` (a connected-peer count and
 * a connection revision), `onStatus`, `signals`, `identity` and `signal`. `link` is test control outside the
 * session (a network being connected or cut); it is not a session API and no nested participation object exists.
 */
function createMockSignalPair() {
  const subscribers = [];
  const retained = new Map();
  const state = new Map();

  const makeSession = (deviceId, peerId) => {
    const controller = new AbortController();
    const listeners = new Set();
    state.set(deviceId, { peers: [peerId], connectionRevision: 1, listeners });
    const status = () => { const current = state.get(deviceId); return { canAuthor: true, phase: 'ready', database: 'ready', pendingOperations: 0,
      materializationError: null, connectedPeers: current.peers.length, connectionRevision: current.connectionRevision }; };
    const signals = {
      async send(topic, payload) {
        const frame = { topic, authorId: deviceId, issuedAtMs: Date.now(), payload };
        retained.set(topic, frame);
        for (const sub of [...subscribers]) {
          if (sub.topics.includes(topic) && !sub.signal?.aborted) sub.push(frame);
        }
      },
      subscribe({ topics, includeLatest = false, signal }) {
        const queue = [];
        let wake = null;
        const sub = {
          topics,
          signal,
          push(frame) { queue.push(frame); wake?.(); wake = null; },
        };
        if (includeLatest) {
          for (const topic of topics) {
            const existing = retained.get(topic);
            if (existing) queue.push(existing);
          }
        }
        subscribers.push(sub);
        signal?.addEventListener('abort', () => { wake?.(); wake = null; }, { once: true });
        return {
          async *[Symbol.asyncIterator]() {
            try {
              while (!signal?.aborted) {
                while (queue.length) yield queue.shift();
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
    // The public session identity is the signing public key; there is no separate device ID.
    return { identity: { publicKey: deviceId }, signal: controller.signal, close: () => controller.abort(), signals,
      get status() { return status(); },
      onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  };
  const publish = deviceId => { const current = state.get(deviceId);
    for (const fn of [...current.listeners]) fn({ canAuthor: true, phase: 'ready', database: 'ready', pendingOperations: 0, materializationError: null,
      connectedPeers: current.peers.length, connectionRevision: current.connectionRevision }); };
  const link = deviceId => ({
    setPeers(next) { const current = state.get(deviceId); current.peers = next; current.connectionRevision++; publish(deviceId); },
    /** An unrelated status change (for example pending operations): the same links and revision. */
    notify() { publish(deviceId); },
  });

  return {
    native: makeSession('native-peer', 'browser-peer'),
    browser: makeSession('browser-peer', 'native-peer'),
    link: { native: link('native-peer'), browser: link('browser-peer') },
  };
}

test('filtered feeds ignore default pushes and late replies from an older query', async t => {
  const { native, browser } = createMockSignalPair();
  let release;
  const server = serveDataFeeds(native, { items: async query => {
    if (query?.name === 'slow') await new Promise(resolve => { release = resolve; });
    return { name: query?.name ?? 'default' };
  } });
  const feed = useDataFeed(browser, { peer: native.identity.publicKey, feed: 'items', query: { name: 'filtered' } });
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
  const { native, browser, link } = createMockSignalPair();
  let server = serveDataFeeds(native, { value: async () => 1 });
  const feed = useDataFeed(browser, { peer: native.identity.publicKey, feed: 'value' });
  t.after(() => { feed.close(); server.close(); native.close(); browser.close(); });
  await waitUntil(() => feed.snapshot().data === 1);
  await server.push('value', 2);
  await waitUntil(() => feed.snapshot().data === 2);
  const previousGeneration = feed.snapshot().generation;
  server.close();
  await server.done;
  server = serveDataFeeds(native, { value: async () => 3 });
  link.browser.setPeers([]);
  link.browser.setPeers([native.identity.publicKey]);
  await waitUntil(() => feed.snapshot().data === 3);
  assert.notEqual(feed.snapshot().generation, previousGeneration);
  assert.equal(feed.snapshot().revision, 1);
});

test('unchanged successful polls advance freshness without incrementing the data revision', async t => {
  const { native, browser } = createMockSignalPair();
  const server = serveDataFeeds(native, { value: { pollMs: 25, maxAgeMs: 0, fetch: async () => 7 } });
  const feed = useDataFeed(browser, { peer: native.identity.publicKey, feed: 'value' });
  t.after(() => { feed.close(); server.close(); native.close(); browser.close(); });
  await waitUntil(() => feed.snapshot().data === 7);
  const initial = feed.snapshot();
  await waitUntil(() => feed.snapshot().fetchedAtMs > initial.fetchedAtMs);
  assert.equal(feed.snapshot().revision, initial.revision);
  assert.equal(feed.snapshot().data, 7);
});

test('offline runtime errors remain eligible for telemetry flush on reconnect', async t => {
  const { native, browser, link } = createMockSignalPair();
  link.browser.setPeers([]);
  const listeners = new Set(), buffered = [];
  const runtime = { errors: { list: () => buffered, on: fn => { listeners.add(fn); return () => listeners.delete(fn); } } };
  const collector = collectDevTelemetry(native);
  const telemetry = mountDevTelemetry({ session: browser, runtime, captureConsoleError: false });
  t.after(() => { telemetry.close(); collector.close(); native.close(); browser.close(); });
  const error = { id: 'offline-error', message: 'Lost connection' };
  buffered.push(error);
  for (const fn of listeners) fn(error);
  await Promise.resolve();
  link.browser.setPeers([native.identity.publicKey]);
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

test('serveDataFeeds and useDataFeed deliver live pushes, deduplicate unchanged snapshots, and serve on-demand/large pulls', async t => {
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
  const cpuFeed = useDataFeed(browser, { peer: native.identity.publicKey, feed: 'cpu', onUpdate: s => updates.push(s) });
  const reportFeed = useDataFeed(browser, { peer: native.identity.publicKey, feed: 'report' });
  t.after(() => { cpuFeed.close(); reportFeed.close(); server.close(); native.close(); browser.close(); });
  await waitUntil(() => cpuFeed.snapshot().data?.pct === 10);

  // Push event-driven update directly from native agent.
  await server.push('cpu', { pct: 42 });
  await waitUntil(() => cpuFeed.snapshot().data?.pct === 42);

  // Large payload triggers automatic chunked pull via signal-request.
  await waitUntil(() => reportFeed.snapshot().data?.payload === largeBlob);
});

test('mountDevTelemetry streams buffered and live runtime errors to collectDevTelemetry without durable writes', async t => {
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
  t.after(() => { telemetry.close(); collector.close(); native.close(); browser.close(); });

  await waitUntil(() => collector.entries().some(e => e.payload?.kind === 'error' && e.payload.entry?.id === 'boot-1'));
  await waitUntil(() => Boolean(collector.health()['browser-peer']));

  // Emit a live error after mount.
  const liveErr = { id: 'live-2', at: 2000, kind: 'report', message: 'Chart error' };
  buffered.push(liveErr);
  for (const fn of listeners) fn(liveErr);
  await waitUntil(() => collector.entries().some(e => e.payload?.entry?.id === 'live-2'));
});

test('ephemeral agent presence and streaming previews work with zero durable journal records', async t => {
  const { native, browser, link } = createMockSignalPair();
  const announcer = announceAgentPresence(native, { consumerId: 'agent-1', role: 'ops-agent', intervalMs: 60_000 });

  const states = [];
  const watcher = watchAgentPresence(browser, { peer: native.identity.publicKey, onChange: s => states.push(s.status) });
  const chunks = [];
  const stream = watchAgentStream(browser, { peer: native.identity.publicKey, onChunk: c => chunks.push(c) });
  t.after(async () => { stream.close(); watcher.close(); await announcer.close(); native.close(); browser.close(); });
  await waitUntil(() => watcher.snapshot().status === 'available');

  announcer.setState('busy');
  await waitUntil(() => watcher.snapshot().status === 'busy');

  await streamAgentReply(native, { requestAuthor: browser.identity.publicKey, requestOperationId: 'op-1', text: 'Checking CPU…' });
  await waitUntil(() => chunks.length === 1 && chunks[0].text === 'Checking CPU…');

  link.browser.setPeers([]);
  assert.equal(watcher.snapshot().status, 'stale');
  link.browser.setPeers([native.identity.publicKey]);

  await announcer.close();
  await waitUntil(() => watcher.snapshot().status === 'stopped');
});

test('untrusted console text is redacted and bounded before it leaves the page, and the original console still runs', async t => {
  const { native, browser } = createMockSignalPair();
  const original = console.error, seen = [];
  const stub = (...args) => { seen.push(args); };
  console.error = stub;
  const collector = collectDevTelemetry(native);
  const telemetry = mountDevTelemetry({ session: browser, runtime: { errors: { list: () => [], on: () => () => {} } }, captureConsoleError: true });
  t.after(() => { telemetry.close(); collector.close(); native.close(); browser.close(); console.error = original; });
  console.error('GET https://app.example/x?token=SECRET123&ok=1 failed', 'Authorization: Bearer abc.DEF-123', 'y'.repeat(2000));
  await waitUntil(() => collector.entries().some(item => item.payload?.kind === 'console_error'));
  const message = collector.entries().find(item => item.payload?.kind === 'console_error').payload.message;
  assert.match(message, /token=\[redacted\]&ok=1/); assert.match(message, /Bearer \[redacted\]/);
  assert(!message.includes('SECRET123') && !message.includes('abc.DEF-123'));
  assert(message.length <= 600, 'the telemetry message is bounded');
  assert.equal(seen.length, 1, 'the wrapped console.error still reaches the original');
  assert.notEqual(console.error, stub, 'telemetry wraps the console while mounted');
  telemetry.close(); assert.equal(console.error, stub, 'close restores the console it wrapped');
});

test('telemetry stays within its per-minute budget and reports health only when the link actually changes', async t => {
  const { native, browser, link } = createMockSignalPair();
  const listeners = new Set(), buffered = [];
  const runtime = { errors: { list: () => buffered, on: fn => { listeners.add(fn); return () => listeners.delete(fn); } } };
  const collector = collectDevTelemetry(native);
  const telemetry = mountDevTelemetry({ session: browser, runtime, captureConsoleError: false, maxPerMinute: 3 });
  t.after(() => { telemetry.close(); collector.close(); native.close(); browser.close(); });
  await waitUntil(() => collector.entries().some(item => item.payload?.kind === 'health'));
  for (let index = 0; index < 10; index++) { const entry = { id: 'burst-' + index, message: 'x' }; buffered.push(entry); for (const fn of listeners) fn(entry); }
  await new Promise(resolve => setTimeout(resolve, 40));
  assert(collector.entries().length <= 3, 'the minute budget bounds what leaves the page');
  // A status notification with no new peers or connection revision is not a link change.
  const before = collector.entries().filter(item => item.payload?.kind === 'health').length;
  link.browser.setPeers([native.identity.publicKey]);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert(collector.entries().filter(item => item.payload?.kind === 'health').length <= before + 1);
});

test('a feed started while offline loads when a peer connects, and a reconnect refreshes it without polling', async t => {
  const { native, browser, link } = createMockSignalPair();
  link.browser.setPeers([]);
  let calls = 0;
  const server = serveDataFeeds(native, { counter: { maxAgeMs: 0, fetch: async () => ++calls } });
  const feed = useDataFeed(browser, { peer: native.identity.publicKey, feed: 'counter' });
  t.after(() => { feed.close(); server.close(); native.close(); browser.close(); });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(feed.snapshot().data, null, 'nothing is requested while no peer is connected');
  assert.equal(calls, 0);
  link.browser.setPeers([native.identity.publicKey]);
  await waitUntil(() => feed.snapshot().data === 1);
  // Status notices that are not a new link (same count and revision) never trigger a request.
  for (let index = 0; index < 5; index++) link.browser.notify();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls, 1);
  link.browser.setPeers([]); link.browser.setPeers([native.identity.publicKey]);
  await waitUntil(() => feed.snapshot().data === 2);
  assert.equal(calls, 2, 'one refresh for the one reconnect');
});

test('a feed service replays its latest snapshots on a new link and drops pushes while no peer is connected', async t => {
  const { native, browser, link } = createMockSignalPair();
  const server = serveDataFeeds(native, { value: async () => 1 });
  const feed = useDataFeed(browser, { peer: native.identity.publicKey, feed: 'value' });
  t.after(() => { feed.close(); server.close(); native.close(); browser.close(); });
  await waitUntil(() => feed.snapshot().data === 1);
  link.native.setPeers([]);
  await server.push('value', 5);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(feed.snapshot().data, 1, 'no live broadcast while the native side has no peer');
  link.native.setPeers([browser.identity.publicKey]);
  await waitUntil(() => feed.snapshot().data === 5);
});

test('agent presence is announced and watched on link changes only, and a cut link marks it stale', async t => {
  const { native, browser, link } = createMockSignalPair();
  link.native.setPeers([]);
  const sent = [], send = native.signals.send;
  native.signals.send = async (topic, payload, options) => { sent.push(payload.state); return send(topic, payload, options); };
  const announcer = announceAgentPresence(native, { consumerId: 'agent-1', role: 'ops-agent', intervalMs: 60_000 });
  const watcher = watchAgentPresence(browser, { peer: native.identity.publicKey });
  t.after(async () => { watcher.close(); await announcer.close(); native.close(); browser.close(); });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(sent, [], 'nothing is announced while no peer is connected');
  assert.equal(watcher.snapshot().status, 'unknown');
  link.native.setPeers([browser.identity.publicKey]);
  await waitUntil(() => watcher.snapshot().status === 'available');
  const announced = sent.length;
  for (let index = 0; index < 5; index++) link.native.notify();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(sent.length, announced, 'status notices without a new link announce nothing');
  link.browser.setPeers([]);
  assert.equal(watcher.snapshot().status, 'stale');
});
