import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Keep the real kernel and capability observer. Substitute only the connection,
// push setup and sensor source so permission replies and browser signals can race.
const compiled = await build({ entryPoints: [new URL('../src/kernel.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'Kernel', platform: 'browser', write: false,
  plugins: [{ name: 'kernel-fixtures', setup(build) {
    build.onLoad({ filter: /\/runtime\/src\/(core|push|sensors)\.ts$/ }, ({ path }) => ({ loader: 'js', contents:
      path.endsWith('/core.ts') ? 'export const createCore = () => globalThis.fixture.core;'
        : path.endsWith('/push.ts') ? 'export const setupPush = () => ({});'
          : 'export const installSensorWrappers = () => globalThis.fixture.tracker;' }));
  } }],
});
const settle = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };

async function environment({ peer = false, preview = false } = {}) {
  const listeners = new Map(), sensorListeners = new Set(), reports = [], sensorReports = [], sensorUsage = [], timers = new Map();
  let active = [], pending = [], timerId = 0, pendingCamera;
  const bus = {
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
    emit(type, value) { for (const fn of listeners.get(type) || []) fn(value); },
  };
  bus.on('capabilities', report => reports.push(report.capabilities.camera.active));
  bus.on('sensors', status => sensorReports.push({ active: [...status.active], pending: [...status.pending] }));
  const window = Object.assign(new EventTarget(), { isSecureContext: true });
  const mediaDevices = Object.assign(new EventTarget(), { getUserMedia() { throw Error('must not request media'); } });
  const status = () => Object.assign(new EventTarget(), { state: 'granted' });
  const context = { URL, AbortController, AbortSignal, window, document: {}, screen: {}, location: new URL('https://fixture.test/page/'),
    navigator: { userAgent: 'Fixture', mediaDevices, permissions: { query({ name }) {
      if (name === 'camera' && pendingCamera) { const reply = pendingCamera; pendingCamera = undefined; return reply; }
      return Promise.resolve(status());
    } } },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    fixture: { core: { bus, raw(frame) { sensorUsage.push(frame); } }, tracker: {
      status: () => ({ active: [...active], pending: [...pending] }), onChange(fn) { sensorListeners.add(fn); return () => sensorListeners.delete(fn); },
    } },
  };
  runInNewContext(compiled.outputFiles[0].text, context);
  const runtime = context.Kernel.startRuntime({ id: 'page', base: '/page/', version: 0, documentPath: null,
    preview,
    ...(peer ? { application: { kind: 'peer', id: 'history' } } : {}) });
  await settle();
  const flushTimers = () => { for (const [id, fn] of timers) { timers.delete(id); fn(); } };
  return { reports, sensorReports, sensorUsage, runtime,
    deferCamera() { let resolve; pendingCamera = new Promise(done => { resolve = done; }); return () => resolve(status()); },
    sensors(value, notify = true) { active = value; if (notify) for (const fn of sensorListeners) fn(); },
    pending(value) { pending = value; for (const fn of sensorListeners) fn(); },
    flushTimers,
    capabilitySignal() { mediaDevices.dispatchEvent(new Event('devicechange')); flushTimers(); },
    hide() { window.dispatchEvent(new Event('pagehide')); },
  };
}

test('a slow sensor capability reply cannot overwrite a newer sensor report', async () => {
  const env = await environment(), release = env.deferCamera();
  env.sensors(['camera']);
  assert.deepEqual(env.sensorReports, [{ active: ['camera'], pending: [] }], 'sensor indicators must update before permission queries settle');
  env.flushTimers();
  env.sensors([]); env.flushTimers(); await settle();
  assert.deepEqual(env.reports, [false]);
  release(); await settle();
  assert.deepEqual(env.reports, [false]);
});

test('a slow sensor capability reply cannot overwrite a newer browser-signal report', async () => {
  const env = await environment(), release = env.deferCamera();
  env.sensors(['camera']); env.flushTimers();
  env.sensors([], false); env.capabilitySignal(); await settle();
  assert.deepEqual(env.reports, [false]);
  release(); await settle();
  assert.deepEqual(env.reports, [false]);
});

test('pagehide suppresses a pending sensor capability report', async () => {
  const env = await environment(), release = env.deferCamera();
  env.sensors(['camera']); env.flushTimers(); env.hide(); release(); await settle();
  assert.deepEqual(env.reports, []);
});

test('pending sensor snapshots reach subscribers without claiming active capture to the service', async () => {
  const env = await environment();
  env.pending(['camera']);
  assert.deepEqual(env.runtime.sensors.status(), { active: [], pending: ['camera'] });
  assert.deepEqual(env.sensorReports, [{ active: [], pending: ['camera'] }]);
  assert.deepEqual(env.sensorUsage.map(frame => [...frame.active]), [[]]);
  env.flushTimers(); await settle();
  assert.deepEqual(env.reports, [false]);
});

test('peer sensor changes remain local while capability observations stay available', async () => {
  const env = await environment({ peer: true });
  env.sensors(['camera']); env.flushTimers(); await settle();
  assert.deepEqual(env.sensorReports, [{ active: ['camera'], pending: [] }]);
  assert.deepEqual(env.reports, [true]);
  assert.deepEqual(env.sensorUsage, []);
});

test('hosted composition binds live signals while peer composition waits for its chosen implementation', async () => {
  const hosted = await environment(), peer = await environment({ peer: true });
  assert.equal(hosted.runtime.signals.available, true);
  await assert.rejects(hosted.runtime.signals.send('typing', true), { code: 'signal_disconnected' });
  assert.equal(peer.runtime.signals.available, false);
  await assert.rejects(peer.runtime.signals.send('typing', true), { code: 'signal_unavailable' });
  assert.deepEqual(hosted.sensorUsage, []); assert.deepEqual(peer.sensorUsage, []);
});

test('preview requires an explicit live port instead of opening a real network connection', async () => {
  const preview = await environment({ preview: true });
  assert.equal(preview.runtime.signals.available, false);
  await assert.rejects(preview.runtime.signals.send('typing', true), { code: 'signal_unavailable' });
  assert.deepEqual(preview.sensorUsage, []);
});
