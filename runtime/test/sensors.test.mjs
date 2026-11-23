import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
const built = await build({ entryPoints: [new URL('../src/sensors.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'iife', globalName: 'Sensors', write: false });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function environment(media = {}) {
  const window = new EventTarget(), watches = new Set(), watchRequests = new Map(), locationRequests = [];
  let calls = 0, track, nextWatch = 0, now = Date.now();
  class Track extends EventTarget {
    constructor(kind = 'video') { super(); this.kind = kind; this.readyState = 'live'; this.stopCalls = 0; this.source = Symbol(); }
    stop() { this.stopCalls++; this.readyState = 'ended'; }
    clone() { return nativeCloneTrack(this); }
  }
  const nativeCloneTrack = source => {
    const copy = new Track(source.kind); copy.readyState = source.readyState; copy.source = source.source; return copy;
  };
  class Stream extends EventTarget {
    constructor(tracks = []) { super(); this.tracks = [...tracks]; this.reads = 0; }
    getTracks() { return this.unstableOrder && ++this.reads % 2 ? [...this.tracks].reverse() : [...this.tracks]; }
    // Native MediaStream.clone creates clones internally, without invoking the
    // JavaScript override of MediaStreamTrack.prototype.clone.
    clone() { return new Stream(this.tracks.map(nativeCloneTrack)); }
    addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
    addRemoteTrack(track) {
      this.addTrack(track);
      this.dispatchEvent(Object.assign(new Event('addtrack'), { track }));
    }
  }
  class Recognition extends EventTarget { start() {} abort() { this.dispatchEvent(new Event('end')); } }
  Object.assign(window, { MediaStreamTrack: Track, MediaStream: Stream, SpeechRecognition: Recognition });
  const defaultMedia = constraints => {
    const tracks = [];
    if (constraints?.video) tracks.push(new Track('video'));
    if (constraints?.audio) tracks.push(new Track('audio'));
    track = tracks[0]; return Promise.resolve(new Stream(tracks));
  };
  const navigator = {
    mediaDevices: {
      getUserMedia(...args) { calls++; return (media.getUserMedia ?? defaultMedia)(...args); },
      getDisplayMedia(...args) { calls++; return (media.getDisplayMedia ?? defaultMedia)(...args); },
    },
    geolocation: {
      watchPosition(success, error, options) {
        const id = ++nextWatch; watches.add(id); watchRequests.set(id, { success, error, options }); return id;
      },
      getCurrentPosition(success, error, options) { locationRequests.push({ success, error, options }); },
      // Retain callbacks in the fixture to exercise an already queued native
      // delivery even after clearWatch has stopped future acquisition.
      clearWatch(id) { watches.delete(id); },
    },
  };
  const context = { window, navigator, queueMicrotask, setInterval() {}, setTimeout() {}, Date: class extends Date { static now() { return now; } }, DOMException, AbortController };
  runInNewContext(built.outputFiles[0].text, context);
  const tracker = context.Sensors.installSensorWrappers();
  return { tracker, window, navigator, watches, watchRequests, locationRequests, Track, Stream, Recognition, advance(ms) { now += ms; }, get calls() { return calls; }, get track() { return track; } };
}
test('observation never requests permissions, and stop covers tracks, clones, location, motion and recognition', async () => {
  const env = environment(); assert.equal(env.calls, 0);
  await env.navigator.mediaDevices.getUserMedia({ video: true }); const copy = env.track.clone();
  env.navigator.geolocation.watchPosition(() => {}); const motion = () => {};
  env.window.addEventListener('devicemotion', motion); const recognition = new env.Recognition(); recognition.start();
  await flush(); assert.deepEqual([...env.tracker.status().active], ['camera', 'microphone', 'location', 'motion']);
  assert.equal(env.tracker.stopAll(), 5); assert.equal(env.track.readyState, 'ended'); assert.equal(copy.readyState, 'ended');
  assert.equal(env.watches.size, 0); assert.deepEqual([...env.tracker.status().active], []);
});
test('once, aborted, explicitly removed and duplicate motion subscriptions reflect actual active use', async () => {
  const env = environment(), fn = () => {};
  env.window.addEventListener('devicemotion', fn, { once: true }); assert.deepEqual([...env.tracker.status().active], ['motion']);
  env.window.dispatchEvent(new Event('devicemotion')); await flush(); assert.deepEqual([...env.tracker.status().active], []);
  const signal = new AbortController(); env.window.addEventListener('deviceorientation', fn, { signal: signal.signal });
  signal.abort(); await flush(); assert.deepEqual([...env.tracker.status().active], []);
  env.window.addEventListener('devicemotion', fn); env.window.addEventListener('devicemotion', fn);
  env.window.removeEventListener('devicemotion', fn); await flush(); assert.deepEqual([...env.tracker.status().active], []);
});

test('sensor status separates active media from concurrent pending requests and settles every outcome', async () => {
  const first = deferred(), second = deferred(), denied = deferred();
  const requests = [first, second, denied];
  const env = environment({ getUserMedia: () => requests.shift().promise }), changes = [];
  const status = () => ({ active: [...env.tracker.status().active], pending: [...env.tracker.status().pending] });
  env.tracker.onChange(() => changes.push(status()));
  const a = env.navigator.mediaDevices.getUserMedia({ video: true });
  await flush();
  assert.deepEqual(status(), { active: [], pending: ['camera'] });
  first.resolve(new env.Stream([new env.Track('video')])); await a; await flush();
  assert.deepEqual(status(), { active: ['camera'], pending: [] });
  const b = env.navigator.mediaDevices.getUserMedia({ video: true });
  const c = env.navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  const rejection = assert.rejects(c, { name: 'NotAllowedError' });
  await flush();
  assert.deepEqual(status(), { active: ['camera'], pending: ['camera', 'microphone'] });
  denied.reject(new DOMException('Denied', 'NotAllowedError')); await rejection; await flush();
  assert.deepEqual(status(), { active: ['camera'], pending: ['camera'] });
  second.resolve(new env.Stream([new env.Track('video')])); await b; await flush();
  assert.deepEqual(status(), { active: ['camera'], pending: [] });
  assert.equal(env.tracker.stopAll(), 2);
  assert.deepEqual(status(), { active: [], pending: [] });
  assert.deepEqual(changes, [
    { active: [], pending: ['camera'] },
    { active: ['camera'], pending: [] },
    { active: ['camera'], pending: ['camera', 'microphone'] },
    { active: ['camera'], pending: ['camera'] },
    { active: ['camera'], pending: [] },
    { active: [], pending: [] },
  ]);
});

test('pending location stays cancellable until its native result, without claiming an active fix', async () => {
  const env = environment(), changes = [];
  const status = () => ({ active: [...env.tracker.status().active], pending: [...env.tracker.status().pending] });
  env.tracker.onChange(() => changes.push(status()));
  env.navigator.geolocation.getCurrentPosition(() => {}); await flush();
  assert.deepEqual(status(), { active: [], pending: ['location'] });
  env.advance(60_000);
  assert.deepEqual(status(), { active: [], pending: ['location'] }, 'an unanswered request does not expire with the recent-fix indicator');
  assert.equal(env.tracker.stopAll(), 1);
  assert.deepEqual(status(), { active: [], pending: [] });
  env.locationRequests[0].success('late fix'); await flush();
  assert.deepEqual(status(), { active: [], pending: [] });
  env.navigator.geolocation.getCurrentPosition(() => {}); await flush();
  env.locationRequests[1].error({ code: 1 }); await flush();
  assert.deepEqual(status(), { active: [], pending: [] }, 'denial does not imply active location use');
  env.navigator.geolocation.getCurrentPosition(() => {}); await flush();
  env.locationRequests[2].success('new fix'); await flush();
  assert.deepEqual(status(), { active: ['location'], pending: [] });
  env.advance(15_001);
  assert.deepEqual(status(), { active: [], pending: [] });
  assert.ok(changes.some(change => change.pending.includes('location')));
});

test('Stop all rejects pending camera, microphone and screen requests immediately and stops every late track', async t => {
  for (const [name, method, constraints, kinds] of [
    ['camera', 'getUserMedia', { video: true }, ['video']],
    ['microphone', 'getUserMedia', { audio: true }, ['audio']],
    ['camera and microphone', 'getUserMedia', { video: true, audio: true }, ['video', 'audio']],
    ['screen and system audio', 'getDisplayMedia', { video: true, audio: true }, ['video', 'audio']],
  ]) await t.test(name, async () => {
    const native = deferred(), env = environment({ [method]: () => native.promise });
    const request = env.navigator.mediaDevices[method](constraints);
    const cancelled = assert.rejects(request, { name: 'AbortError' });
    assert.deepEqual([...env.tracker.status().pending], method === 'getDisplayMedia' ? ['screen']
      : [constraints.video ? 'camera' : null, constraints.audio ? 'microphone' : null].filter(Boolean));
    assert.equal(env.calls, 1, 'native acquisition still starts synchronously');
    assert.equal(env.tracker.stopAll(), 1);
    await cancelled; // The native chooser has not returned yet.
    assert.deepEqual([...env.tracker.status().pending], []);
    assert.equal(env.tracker.stopAll(), 0, 'the cancelled request is counted only once');
    const tracks = kinds.map(kind => new env.Track(kind));
    native.resolve(new env.Stream(tracks));
    await flush();
    assert.ok(tracks.every(track => track.readyState === 'ended' && track.stopCalls === 1));
    assert.deepEqual([...env.tracker.status().active], []);
  });
});

test('Stop all also cancels a native grant whose promise continuation has not run', async () => {
  const native = deferred(), env = environment({ getUserMedia: () => native.promise });
  const request = env.navigator.mediaDevices.getUserMedia({ video: true });
  const cancelled = assert.rejects(request, { name: 'AbortError' });
  const track = new env.Track(), stream = new env.Stream([track]);
  native.resolve(stream);
  env.tracker.stopAll();
  await cancelled; await flush();
  assert.equal(track.readyState, 'ended');
  assert.deepEqual([...env.tracker.status().active], []);
});

test('native acquisition errors are preserved, including a late rejection after cancellation', async () => {
  const denied = new DOMException('Permission denied', 'NotAllowedError');
  const env = environment({ getUserMedia: () => Promise.reject(denied) });
  await assert.rejects(env.navigator.mediaDevices.getUserMedia({ video: true }), error => error === denied);
  assert.equal(env.tracker.stopAll(), 0);
  const thrown = new TypeError('Invalid constraints');
  const invalid = environment({ getUserMedia: () => { throw thrown; } });
  await assert.rejects(invalid.navigator.mediaDevices.getUserMedia({ video: true }), error => error === thrown);
  assert.equal(invalid.tracker.stopAll(), 0);
  const native = deferred(), pending = environment({ getUserMedia: () => native.promise });
  const cancelled = assert.rejects(pending.navigator.mediaDevices.getUserMedia({ video: true }), { name: 'AbortError' });
  pending.tracker.stopAll(); await cancelled;
  native.reject(denied); await flush();
  assert.equal(pending.tracker.stopAll(), 0);
});

test('whole-stream clones, track clones and dynamically added tracks remain covered by Stop all', async () => {
  const env = environment();
  const stream = await env.navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  const copy = stream.clone(), trackCopy = stream.getTracks()[0].clone();
  const added = new env.Track('audio'); copy.addRemoteTrack(added);
  assert.deepEqual([...env.tracker.status().active], ['camera', 'microphone']);
  assert.equal(env.tracker.stopAll(), 6);
  for (const track of [...stream.getTracks(), ...copy.getTracks(), trackCopy]) assert.equal(track.readyState, 'ended');
  const late = new env.Track('video'); copy.addRemoteTrack(late);
  assert.equal(late.readyState, 'ended');
  const afterStop = copy.clone();
  const later = new env.Track('audio'); afterStop.addRemoteTrack(later);
  assert.equal(later.readyState, 'ended', 'a clone of a stopped stream retains the cancellation boundary');
  assert.deepEqual([...env.tracker.status().active], []);
});

test('a cancelled late stream cannot add capture again, while fresh media requests and their clones work', async () => {
  const native = deferred(); let first = true;
  const env = environment({ getDisplayMedia: () => {
    if (first) { first = false; return native.promise; }
    return Promise.resolve(new env.Stream([new env.Track('video'), new env.Track('audio')]));
  } });
  const cancelled = assert.rejects(env.navigator.mediaDevices.getDisplayMedia({ video: true }), { name: 'AbortError' });
  env.tracker.stopAll(); await cancelled;
  const old = new env.Stream([new env.Track('video')]); native.resolve(old); await flush();
  const late = new env.Track('audio'); old.addRemoteTrack(late);
  assert.equal(late.readyState, 'ended');
  const fresh = await env.navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const copied = fresh.clone();
  assert.ok([...fresh.getTracks(), ...copied.getTracks()].every(track => track.readyState === 'live'));
  assert.deepEqual([...env.tracker.status().active], ['screen']);
  old.addRemoteTrack(fresh.getTracks()[0]);
  assert.equal(fresh.getTracks()[0].readyState, 'live', 'reusing a fresh track in an old stream does not revoke its new acquisition');
  assert.equal(env.tracker.stopAll(), 4);
  assert.ok([...fresh.getTracks(), ...copied.getTracks()].every(track => track.readyState === 'ended'));
});

test('cloning a manually composed stream preserves each captured source without adopting unknown external tracks', async () => {
  const env = environment();
  const camera = (await env.navigator.mediaDevices.getUserMedia({ video: true })).getTracks()[0];
  const screen = (await env.navigator.mediaDevices.getDisplayMedia({ video: true })).getTracks()[0];
  const externalVideo = new env.Track('video'), externalAudio = new env.Track('audio');
  const composed = new env.Stream([camera, externalVideo, screen, externalAudio]);
  composed.unstableOrder = true;
  const copy = composed.clone(); copy.unstableOrder = true;
  const secondCopy = copy.clone();
  const copiedTracks = [...copy.getTracks(), ...secondCopy.getTracks()];
  assert.equal(copiedTracks.length, 8);
  assert.ok(copiedTracks.every(track => track.readyState === 'live'));
  assert.deepEqual([...env.tracker.status().active], ['camera', 'screen'], 'unobserved external audio is not classified as a microphone');
  assert.equal(env.tracker.stopAll(), 6);
  for (const track of [camera, screen, ...copiedTracks.filter(track => track.source === camera.source || track.source === screen.source)]) {
    assert.equal(track.readyState, 'ended');
  }
  for (const track of [externalVideo, externalAudio, ...copiedTracks.filter(track => track.source === externalVideo.source || track.source === externalAudio.source)]) {
    assert.equal(track.readyState, 'live', 'unknown external tracks are not given a fabricated sensor acquisition');
  }
  assert.deepEqual([...env.tracker.status().active], []);
});

test('a clone of an old stream preserves a freshly acquired track epoch and leaves unrelated additions unknown', async () => {
  const env = environment();
  const old = await env.navigator.mediaDevices.getUserMedia({ video: true });
  const original = old.getTracks()[0]; env.tracker.stopAll();
  const fresh = (await env.navigator.mediaDevices.getUserMedia({ video: true })).getTracks()[0];
  const external = new env.Track('audio');
  // Script addTrack does not fire a native addtrack event. The wrapper must
  // inspect original track provenance instead of assuming the container's age.
  old.addTrack(fresh); old.addTrack(external); old.unstableOrder = true;
  const copy = old.clone();
  const bySource = source => copy.getTracks().find(track => track.source === source);
  assert.equal(bySource(original.source).readyState, 'ended');
  assert.equal(bySource(fresh.source).readyState, 'live');
  assert.equal(bySource(external.source).readyState, 'live');
  assert.deepEqual([...env.tracker.status().active], ['camera']);
  assert.equal(env.tracker.stopAll(), 2);
  assert.equal(fresh.readyState, 'ended'); assert.equal(bySource(fresh.source).readyState, 'ended');
  assert.equal(external.readyState, 'live'); assert.equal(bySource(external.source).readyState, 'live');
});

test('Stop all abandons one-shot location callbacks and watch deliveries without blocking new requests', () => {
  const env = environment(), delivered = [], options = { maximumAge: 0 };
  env.navigator.geolocation.getCurrentPosition(value => delivered.push(value), error => delivered.push(error), options);
  const watch = env.navigator.geolocation.watchPosition(value => delivered.push(value), error => delivered.push(error), options);
  const oldPosition = env.locationRequests[0], oldWatch = env.watchRequests.get(watch);
  assert.equal(oldPosition.options, options); assert.equal(oldWatch.options, options);
  assert.equal(env.tracker.stopAll(), 2);
  assert.equal(env.watches.size, 0);
  oldPosition.success('old position'); oldPosition.error('old position failure');
  oldWatch.success('old watch'); oldWatch.error('old watch failure');
  assert.deepEqual(delivered, []);
  assert.deepEqual([...env.tracker.status().active], []);
  env.navigator.geolocation.getCurrentPosition(value => delivered.push(value));
  const freshWatch = env.navigator.geolocation.watchPosition(value => delivered.push(value));
  env.locationRequests[1].success('new position'); env.watchRequests.get(freshWatch).success('new watch');
  assert.deepEqual(delivered, ['new position', 'new watch']);
  assert.equal(env.tracker.stopAll(), 1, 'a finished one-shot read is no longer pending');
});

test('cleared watches suppress queued callbacks, and one-shot native errors release pending bookkeeping', () => {
  const env = environment(), delivered = [];
  const id = env.navigator.geolocation.watchPosition(value => delivered.push(value), error => delivered.push(error));
  env.navigator.geolocation.clearWatch(id);
  env.watchRequests.get(id).success('old'); env.watchRequests.get(id).error('old error');
  assert.deepEqual(delivered, []);
  env.navigator.geolocation.getCurrentPosition(value => delivered.push(value));
  env.locationRequests[0].error({ code: 1, message: 'Denied' });
  assert.equal(env.tracker.stopAll(), 0, 'a failed read is removed even without an application error callback');
  env.navigator.geolocation.getCurrentPosition(() => {}, error => delivered.push(error));
  const failure = { code: 2, message: 'Unavailable' };
  env.locationRequests[1].error(failure);
  assert.deepEqual(delivered, [failure]);
  assert.equal(env.tracker.stopAll(), 0);
});

test('cooperative resources preserve legacy snapshots and expose pending, active and detached state', async () => {
  const env = environment(), snapshots = [];
  const plain = () => JSON.parse(JSON.stringify(env.tracker.status()));
  assert.deepEqual(plain(), { active: [], pending: [] });
  env.tracker.onChange(() => snapshots.push(plain()));
  let stopped = 0;
  const handle = env.tracker.register({ kind: 'serial', label: 'Bench meter', stop() { stopped++; } });
  assert.equal(env.calls, 0);
  assert.equal(handle.signal.aborted, false);
  assert.deepEqual(plain().pending, ['serial']);
  assert.equal(plain().resources[0].label, 'Bench meter');
  await flush();
  handle.setState('active'); await flush();
  assert.deepEqual(plain().active, ['serial']);
  const snapshot = env.tracker.status();
  snapshot.resources[0].state = 'failed';
  snapshot.active.push('forged');
  assert.equal(plain().resources[0].state, 'active');
  assert.deepEqual(plain().active, ['serial']);
  handle.unregister(); handle.unregister();
  assert.equal(handle.signal.aborted, true);
  assert.equal(stopped, 1);
  assert.equal(env.tracker.stopAll(), 0);
  handle.setState('active');
  assert.deepEqual(plain(), { active: [], pending: [] });
  await flush();
  assert.deepEqual(snapshots.map(s => s.resources?.[0].state ?? 'removed'), ['pending', 'active', 'removed']);
});

test('Stop all invalidates every custom signal before cleanup and tracks async stopping honestly', async () => {
  const env = environment(), firstDone = deferred(), secondDone = deferred(), order = [];
  let a, b;
  a = env.tracker.register({ kind: 'bluetooth', label: 'Scale', state: 'active', stop() {
    assert.equal(a.signal.aborted, true); assert.equal(b.signal.aborted, true);
    a.unregister(); b.unregister();
    order.push('a'); return firstDone.promise;
  } });
  b = env.tracker.register({ kind: 'wake_lock', stop() {
    assert.equal(a.signal.aborted, true); assert.equal(b.signal.aborted, true);
    order.push('b'); return secondDone.promise;
  } });
  a.signal.addEventListener('abort', () => { a.unregister(); b.unregister(); });
  assert.equal(env.tracker.stopAll(), 2);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(env.tracker.stopAll(), 0);
  assert.deepEqual([...env.tracker.status().active], []);
  assert.deepEqual([...env.tracker.status().pending], []);
  assert.deepEqual([...env.tracker.status().resources].map(r => r.state), ['stopping', 'stopping']);
  a.setState('active'); b.setState('failed');
  assert.equal(env.tracker.status().resources[0].state, 'stopping');
  const replacement = env.tracker.register({ kind: 'bluetooth', state: 'active', stop() {} });
  firstDone.resolve(); await flush();
  assert.equal(env.tracker.status().resources.length, 2);
  secondDone.resolve(); await flush();
  assert.equal(env.tracker.status().resources.length, 1);
  assert.equal(replacement.signal.aborted, false);
  replacement.unregister();
  assert.equal(env.tracker.status().resources, undefined);
});

test('pending cooperative chooser can close a late grant without reviving a cancelled resource', async () => {
  const env = environment(), chooser = deferred();
  let port, closeCalls = 0, stopCalls = 0, acquisition;
  const handle = env.tracker.register({ kind: 'serial', stop() {
    stopCalls++;
    return acquisition.then(() => { if (port) { port.close(); port = null; } });
  } });
  acquisition = chooser.promise.then(value => {
    if (handle.signal.aborted) { value.close(); return; }
    port = value; handle.setState('active');
  });
  assert.equal(env.tracker.stopAll(), 1);
  assert.equal(handle.signal.aborted, true);
  assert.equal(env.tracker.status().resources[0].state, 'stopping');
  chooser.resolve({ close() { closeCalls++; } });
  await acquisition; await flush();
  assert.equal(closeCalls, 1);
  assert.equal(stopCalls, 1);
  assert.equal(env.tracker.status().resources, undefined);
  handle.unregister();
  assert.equal(env.tracker.stopAll(), 0);
});

test('cooperative stop failures are observed and visible until explicitly acknowledged', async () => {
  for (const asyncFailure of [false, true]) {
    const env = environment();
    let calls = 0;
    const handle = env.tracker.register({ kind: 'usb', state: 'active', stop() {
      calls++;
      if (asyncFailure) return Promise.reject(Error('cannot close'));
      throw Error('cannot close');
    } });
    assert.equal(env.tracker.stopAll(), 1);
    await flush();
    assert.equal(env.tracker.status().resources[0].state, 'failed');
    assert.equal(handle.signal.aborted, true);
    assert.equal(env.tracker.stopAll(), 0);
    assert.equal(calls, 1);
    handle.unregister(); handle.unregister();
    assert.equal(env.tracker.status().resources[0].state, 'failed', 'ordinary repeated disposal cannot acknowledge failed cleanup');
    assert.equal(env.tracker.stopAll(), 0);
    handle.unregister({ acknowledgeFailure: true });
    handle.unregister({ acknowledgeFailure: true });
    assert.equal(env.tracker.status().resources, undefined);
    assert.equal(calls, 1);
  }
});

test('registration changes notify even when kinds are duplicated and metadata never leaks into legacy snapshots', async () => {
  const env = environment(), changes = [];
  env.tracker.onChange(() => changes.push(JSON.parse(JSON.stringify(env.tracker.status()))));
  const first = env.tracker.register({ kind: 'camera', label: 'Scan loop', state: 'active', stop() {} });
  await flush();
  const second = env.tracker.register({ kind: 'camera', label: 'Document loop', state: 'active', stop() {} });
  await flush();
  assert.deepEqual([...env.tracker.status().active], ['camera']);
  assert.equal(changes.length, 2);
  second.setState('failed'); await flush();
  assert.equal(changes.at(-1).resources[1].state, 'failed');
  first.unregister(); second.unregister();
  assert.deepEqual(JSON.parse(JSON.stringify(env.tracker.status())), { active: [], pending: [] });
});

test('invalid cooperative metadata fails before allocating a registration', () => {
  const env = environment();
  for (const options of [null, {}, { kind: '', stop() {} }, { kind: 'serial' },
    { kind: 'serial\nfake', stop() {} }, { kind: 'serial', label: 'Bench\nmeter', stop() {} },
    { kind: 'serial', label: '   ', stop() {} },
    { kind: 'serial', state: 'complete', stop() {} }, { kind: 'serial', label: '', stop() {} }])
    assert.throws(() => env.tracker.register(options), { name: 'TypeError' });
  assert.equal(env.tracker.status().resources, undefined);
  const trimmed = env.tracker.register({ kind: 'serial', label: '  Bench meter  ', stop() {} });
  assert.equal(env.tracker.status().resources[0].label, 'Bench meter');
  trimmed.unregister();
});

test('abort listeners can deliberately start a new acquisition without the old stop epoch cancelling it', async () => {
  const env = environment();
  let request;
  const handle = env.tracker.register({ kind: 'serial', stop() {} });
  handle.signal.addEventListener('abort', () => {
    request = env.navigator.mediaDevices.getUserMedia({ video: true });
  });
  assert.equal(env.tracker.stopAll(), 1);
  const stream = await request;
  assert.equal(stream.getTracks()[0].readyState, 'live');
  assert.deepEqual([...env.tracker.status().active], ['camera']);
  assert.equal(env.tracker.stopAll(), 1);
});

test('failure acknowledgement cannot stop fresh work, hide pending cleanup or accept truthy substitutes', async () => {
  const env = environment(), cleanup = deferred();
  let calls = 0;
  const handle = env.tracker.register({ kind: 'serial', state: 'failed', stop() { calls++; return cleanup.promise; } });
  handle.unregister({ acknowledgeFailure: true });
  assert.equal(handle.signal.aborted, false, 'a page-reported failed phase is not a failed stop attempt');
  assert.equal(env.tracker.status().resources[0].state, 'failed');
  assert.equal(calls, 0);
  handle.unregister();
  assert.equal(handle.signal.aborted, true);
  assert.equal(calls, 1);
  handle.unregister({ acknowledgeFailure: true });
  handle.unregister();
  assert.equal(env.tracker.status().resources[0].state, 'stopping');
  cleanup.reject(Error('device is still open'));
  await flush();
  for (const options of [true, null, [], {}, { acknowledgeFailure: false },
    { acknowledgeFailure: true, extra: true },
    { acknowledgeFailure: 'yes' }, { acknowledgeFailure: 1 }, Object.create({ acknowledgeFailure: true })]) {
    assert.throws(() => handle.unregister(options), { name: 'TypeError' });
    assert.equal(env.tracker.status().resources[0].state, 'failed');
  }
  handle.unregister();
  assert.equal(env.tracker.stopAll(), 0);
  assert.equal(env.tracker.status().resources[0].state, 'failed');
  handle.unregister({ acknowledgeFailure: true });
  assert.equal(env.tracker.status().resources, undefined);
  assert.equal(calls, 1);
});
