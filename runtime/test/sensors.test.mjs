import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
const built = await build({ entryPoints: [new URL('../src/sensors.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'iife', globalName: 'Sensors', write: false });
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
function environment() {
  const window = new EventTarget(), watches = new Set(); let calls = 0, track;
  class Track extends EventTarget { kind = 'video'; readyState = 'live'; stop() { this.readyState = 'ended'; } clone() { return new Track(); } }
  class Recognition extends EventTarget { start() {} abort() { this.dispatchEvent(new Event('end')); } }
  Object.assign(window, { MediaStreamTrack: Track, SpeechRecognition: Recognition });
  const navigator = { mediaDevices: { async getUserMedia() { calls++; track = new Track(); return Object.assign(new EventTarget(), { getTracks: () => [track] }); } },
    geolocation: { watchPosition() { const id = watches.size + 1; watches.add(id); return id; }, clearWatch(id) { watches.delete(id); } } };
  const context = { window, navigator, queueMicrotask, setInterval() {}, setTimeout() {}, Date };
  runInNewContext(built.outputFiles[0].text, context);
  const tracker = context.Sensors.installSensorWrappers();
  return { tracker, window, navigator, watches, Track, Recognition, get calls() { return calls; }, get track() { return track; } };
}
test('observation never requests permissions, and stop covers tracks, clones, location, motion and recognition', async () => {
  const env = environment(); assert.equal(env.calls, 0);
  await env.navigator.mediaDevices.getUserMedia({ video: true }); const copy = env.track.clone();
  env.navigator.geolocation.watchPosition(() => {}); const motion = () => {};
  env.window.addEventListener('devicemotion', motion); const recognition = new env.Recognition(); recognition.start();
  await flush(); assert.deepEqual([...env.tracker.active()], ['camera', 'microphone', 'location', 'motion']);
  assert.equal(env.tracker.stopAll(), 5); assert.equal(env.track.readyState, 'ended'); assert.equal(copy.readyState, 'ended');
  assert.equal(env.watches.size, 0); assert.deepEqual([...env.tracker.active()], []);
});
test('once, aborted, explicitly removed and duplicate motion subscriptions reflect actual active use', async () => {
  const env = environment(), fn = () => {};
  env.window.addEventListener('devicemotion', fn, { once: true }); assert.deepEqual([...env.tracker.active()], ['motion']);
  env.window.dispatchEvent(new Event('devicemotion')); await flush(); assert.deepEqual([...env.tracker.active()], []);
  const signal = new AbortController(); env.window.addEventListener('deviceorientation', fn, { signal: signal.signal });
  signal.abort(); await flush(); assert.deepEqual([...env.tracker.active()], []);
  env.window.addEventListener('devicemotion', fn); env.window.addEventListener('devicemotion', fn);
  env.window.removeEventListener('devicemotion', fn); await flush(); assert.deepEqual([...env.tracker.active()], []);
});
