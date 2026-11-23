import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [new URL("../src/capabilities.ts", import.meta.url).pathname],
  bundle: true, format: "iife", globalName: "Capabilities", platform: "browser", write: false,
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function environment() {
  const window = new EventTarget(), timers = new Map(), queries = [], changed = [];
  let blockQueries = false, nextTimer = 0;
  window.isSecureContext = true;
  const status = state => ({ state, addEventListener() {}, removeEventListener() {} });
  const navigator = {
    geolocation: {}, userAgent: "fixture", maxTouchPoints: 0,
    permissions: { query() {
      if (!blockQueries) return Promise.resolve(status("prompt"));
      return new Promise(resolve => queries.push(resolve));
    } },
  };
  const context = {
    window, navigator, document: {}, screen: {}, Date,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  runInNewContext(compiled.outputFiles[0].text, context);
  const observer = context.Capabilities.observeCapabilities(() => [], report => changed.push(report));
  return {
    queries, changed, stop: observer.dispose, status,
    refresh() {
      blockQueries = true;
      window.dispatchEvent(new Event("online"));
      const [id, callback] = [...timers].at(-1) ?? [];
      assert.ok(callback, "expected a scheduled capabilities refresh");
      timers.delete(id);
      callback();
    },
  };
}

test("a slower older permission response cannot overwrite a newer report", async () => {
  const env = environment();
  env.refresh(); await flush();
  env.refresh(); await flush();
  assert.equal(env.queries.length, 2);
  env.queries[1](env.status("denied")); await flush();
  assert.equal(env.changed.length, 1);
  assert.equal(env.changed[0].capabilities.location.permission, "denied");
  env.queries[0](env.status("granted")); await flush();
  assert.equal(env.changed.length, 1, "outdated permission result must not be presented");
  env.stop();
});

test("a detached observer does not publish a pending permission result", async () => {
  const env = environment();
  env.refresh(); await flush();
  assert.equal(env.queries.length, 1);
  env.stop();
  env.queries[0](env.status("granted")); await flush();
  assert.equal(env.changed.length, 0);
});

function inspectEnvironment() {
  const requested = [], replies = new Map();
  let mediaProbes = 0;
  const context = { window: { isSecureContext: true }, document: {}, screen: {},
    navigator: { userAgent: 'fixture', geolocation: {}, bluetooth: {},
      get mediaDevices() { mediaProbes++; return { getUserMedia() { throw Error('no acquisition allowed'); } }; },
      permissions: { query({ name }) {
        requested.push(name);
        return new Promise((resolve, reject) => replies.set(name, { resolve, reject }));
      } },
    } };
  runInNewContext(compiled.outputFiles[0].text, context);
  return { inspect: context.Capabilities.describeCapabilities, requested, replies, context, get mediaProbes() { return mediaProbes; } };
}

test('filtered permission probes run in parallel and preserve deterministic report order', async () => {
  const env = inspectEnvironment();
  const pending = env.inspect([], ['location', 'camera', 'microphone', 'camera', 'unknown']);
  assert.deepEqual(env.requested, ['camera', 'microphone', 'geolocation'],
    'all queries must start before any of them resolves');
  env.replies.get('geolocation').resolve({ state: 'granted' });
  env.replies.get('microphone').reject(Error('unsupported permission name'));
  env.replies.get('camera').resolve({ state: 'denied' });
  const report = await pending;
  assert.deepEqual(Object.keys(report.capabilities), ['camera', 'microphone', 'location']);
  assert.equal(report.capabilities.camera.permission, 'denied');
  assert.equal(report.capabilities.microphone.permission, 'unknown');
  assert.equal(report.capabilities.location.permission, 'granted');
  assert.equal(report.secure, true);
});

test('empty and unknown filters never probe unrelated APIs or permissions', async () => {
  const env = inspectEnvironment();
  for (const filter of [[], ['unknown', '__proto__', 'constructor']]) {
    const report = await env.inspect([], filter);
    assert.deepEqual(Object.keys(report.capabilities), []);
  }
  const report = await env.inspect([], ['keyboard', 'serial']);
  assert.equal(report.capabilities.keyboard.available, true);
  assert.equal(report.capabilities.serial.available, false);
  assert.equal(env.mediaProbes, 0);
  assert.deepEqual(env.requested, []);
  await assert.rejects(env.inspect([], 'camera'), { name: 'TypeError' });
  await assert.rejects(env.inspect([], [1]), { name: 'TypeError' });
});

test('registered kinds activate known capabilities without inventing unknown capability keys', async () => {
  const env = inspectEnvironment();
  const pending = env.inspect(['bluetooth', 'serial', 'custom-loop', 'screen', 'motion'], ['bluetooth', 'serial', 'screen_capture', 'orientation', 'custom-loop']);
  env.replies.get('bluetooth').resolve({ state: 'prompt' });
  const report = await pending;
  assert.equal(report.capabilities.bluetooth.active, true);
  assert.equal(report.capabilities.serial.active, true);
  assert.equal(report.capabilities.screen_capture.active, true);
  assert.equal(report.capabilities.orientation.active, true);
  assert.equal(report.capabilities['custom-loop'], undefined);
  const idle = await env.inspect([], ['serial', 'screen_capture']);
  assert.equal(idle.capabilities.serial.active, null);
  assert.equal(idle.capabilities.screen_capture.active, false);
});
