import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { chartSeries, sourceKey } from '../../../examples/training-dashboard/model.mjs';

const point = (source, run, step, loss, ts) => ({ ts, data: { source, run, step, loss } });
test('overlapping training steps stay separate across sources and experiments', () => {
  const records = [point('a', 'run-1', 2, 0.4, 200), point('b', 'run-1', 1, 5, 100),
    point('a', 'run-2', 1, 10, 300), point('a', 'run-1', 1, 0.8, 100)];
  const model = chartSeries(records, 'loss');
  assert.equal(model.axis, 'step');
  assert.equal(model.groups.length, 3);
  assert.deepEqual(model.groups.find(g => g.label === 'a / run-1').points, [{ x: 1, y: 0.8 }, { x: 2, y: 0.4 }]);
  assert.equal(chartSeries(records, 'loss', sourceKey(records[0].data)).groups.length, 1);
});

test('mixed step availability uses timestamps consistently and ignores nonnumeric values', () => {
  const records = [point('a', 'one', 1, 4, 100), point('b', 'two', undefined, 3, 200), point('a', 'one', 2, 'NaN', 300)];
  records.push({ ts: 400, data: { source: 'b', run: 'two', metrics: { loss: 1 } } });
  const model = chartSeries(records, 'loss');
  assert.equal(model.axis, 'time');
  assert.deepEqual(model.groups.flatMap(g => g.points).map(p => p.x), [100, 200, 400]);
});

test('explicit false, zero and empty source/run values remain distinct from missing metadata', () => {
  const records = [point(false, 0, 1, 1, 100), point('', '', 1, 2, 100), point(null, null, 1, 3, 100)];
  const model = chartSeries(records, 'loss');
  assert.equal(model.groups.length, 3);
  assert.deepEqual(JSON.parse(sourceKey(records[0].data)), ['false', '0']);
  assert.deepEqual(JSON.parse(sourceKey(records[1].data)), ['', '']);
  assert.deepEqual(JSON.parse(sourceKey(records[2].data)), ['source', 'machine']);
  assert.equal(chartSeries(records, 'loss', sourceKey(records[0].data)).groups[0].points[0].y, 1);
});

const appScript = buildSync({
  entryPoints: [fileURLToPath(new URL('../../../examples/training-dashboard/app.js', import.meta.url))],
  bundle: true, format: 'iife', write: false,
}).outputFiles[0].text;
const configuredStreams = [
  { name: 'machine.utilization', durability: 'ephemeral' },
  { name: 'training.metrics', durability: 'durable' },
  { name: 'training.logs', durability: 'durable' },
];
const settle = () => new Promise(resolve => setImmediate(resolve));

function dashboard(list) {
  const listeners = new Map(), nodes = new Map(), subscriptions = [];
  const getNode = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', classList: { toggle() {} }, addEventListener() {} });
    return nodes.get(id);
  };
  const tendril = {
    connected: false,
    on(name, listener) { listeners.set(name, listener); },
    streams: {
      list,
      subscribe(name, receive, options) { subscriptions.push({ name, receive, options }); return () => {}; },
    },
  };
  runInNewContext(appScript, { window: { tendril }, document: { getElementById: getNode }, setInterval() {} });
  return {
    subscriptions, getNode,
    connect() { tendril.connected = true; listeners.get('connect')(); },
    disconnect() { tendril.connected = false; listeners.get('disconnect')(); },
  };
}

test('dashboard retries failed discovery on connection and registers each stream only once', async () => {
  let requests = 0;
  const app = dashboard(() => ++requests === 1
    ? Promise.reject(Error('Temporary configuration outage'))
    : Promise.resolve({ streams: configuredStreams }));
  await settle();
  assert.equal(requests, 1);
  assert.equal(app.subscriptions.length, 0);
  assert.equal(app.getNode('notice').textContent, 'Temporary configuration outage');
  assert.equal(app.getNode('notice').hidden, false);

  app.connect();
  await settle();
  assert.equal(requests, 2);
  assert.deepEqual(app.subscriptions.map(subscription => subscription.name), configuredStreams.map(stream => stream.name));
  assert.equal(Object.hasOwn(app.subscriptions[0].options, 'after'), false);
  assert.equal(app.subscriptions[1].options.after, 0);
  assert.equal(app.subscriptions[2].options.after, 0);
  assert.equal(app.getNode('notice').hidden, true);

  app.disconnect(); app.connect(); app.connect();
  await settle();
  assert.equal(requests, 2);
  assert.equal(app.subscriptions.length, 3);
});

test('dashboard remembers recovery while failed discovery is still in flight', async () => {
  const initial = Promise.withResolvers(), recovered = Promise.withResolvers();
  let requests = 0;
  const app = dashboard(() => ++requests === 1 ? initial.promise : recovered.promise);
  app.connect(); app.disconnect(); app.connect();
  assert.equal(requests, 1);
  initial.reject(Error('Initial request failed after reconnect'));
  await settle();
  assert.equal(requests, 2);
  assert.equal(app.subscriptions.length, 0);

  // More connection events during the retry must still share one discovery.
  app.connect(); app.connect();
  assert.equal(requests, 2);
  recovered.resolve({ streams: configuredStreams });
  await settle();
  assert.equal(requests, 2);
  assert.equal(app.subscriptions.length, 3);
  assert.equal(app.getNode('notice').hidden, true);
});
