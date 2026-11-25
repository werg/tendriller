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

  const makeSession = (deviceId, peerId) => {
    const controller = new AbortController();
    let peers = [peerId];
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
    return { deviceId, signal: controller.signal, close: () => controller.abort(), signals, participation };
  };

  return {
    native: makeSession('native-peer', 'browser-peer'),
    browser: makeSession('browser-peer', 'native-peer'),
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
