import assert from 'node:assert/strict';
import test from 'node:test';
import { createObservationSource } from '../../docs/tutorial/shared/observation/browser.mjs';
import { mountObservations } from '../../docs/tutorial/shared/observation/panel.mjs';
import { serveObservations } from '../../docs/tutorial/shared/observation/receiver.mjs';
import { TOPICS, fresh } from '../../docs/tutorial/shared/observation/protocol.mjs';

const app = 'a'.repeat(64), browser = 'b'.repeat(64), native = 'c'.repeat(64);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const end = Date.now() + 1500; while (!predicate()) { assert(Date.now() < end); await sleep(5); } }
function network() {
  const listeners = new Set(), sent = [], statusListeners = new Set(); let online = true, sequence = 0;
  const deliver = value => { sent.push(structuredClone(value)); for (const listener of listeners) if (listener.topics.includes(value.topic)) { listener.queue.push(structuredClone(value)); listener.wake?.(); } };
  const endpoint = deviceId => ({ deviceId, applicationId: app, signal: new AbortController().signal,
    get status() { return { connectedPeers: online ? 1 : 0 }; }, onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    signals: {
      async send(topic, payload, { signal, stream } = {}) { signal?.throwIfAborted(); deliver({ scope: app, authorId: deviceId, sessionId: 'stream-transport', sequence: ++sequence, topic, payload, stream, issuedAtMs: Date.now() }); },
      subscribe({ topics, signal }) { return { async *[Symbol.asyncIterator]() {
        const entry = { topics, queue: [], wake: null }; listeners.add(entry);
        const wake = () => entry.wake?.(); signal.addEventListener('abort', wake);
        try { while (!signal.aborted) { if (entry.queue.length) yield entry.queue.shift(); else await new Promise(resolve => { entry.wake = resolve; if (signal.aborted || entry.queue.length) resolve(); }); } }
        finally { listeners.delete(entry); signal.removeEventListener('abort', wake); }
      } }; },
    },
  });
  return { endpoint, sent, deliver, disconnect() { online = false; for (const fn of statusListeners) fn(); }, reconnect() { online = true; for (const fn of statusListeners) fn(); } };
}
function runtime() {
  const handles = new Set();
  return { on: () => () => {}, sensors: {
    register(options) {
      const owner = new AbortController(); let phase = options.state;
      const handle = { signal: owner.signal, setState(state) { if (!owner.signal.aborted) phase = state; }, get phase() { return phase; },
        unregister() { if (owner.signal.aborted) return; owner.abort(); handles.delete(handle); options.stop(); } };
      handles.add(handle); return handle;
    }, stopAll() { for (const handle of [...handles]) handle.unregister(); }, status: () => [...handles].map(handle => handle.phase),
  } };
}
const fix = (time = Date.now()) => ({ source: 'location', sampledAtMs: time, latitude: 52.52, longitude: 13.405, accuracyM: 3 });
const sample = (time = Date.now()) => ({ recipient: native, streamId: 'capture-one', sequence: 1, requestId: null, fix: fix(time) });

test('receiver validates authenticated identity, exact sample schema and sample age independently of transport issue time', async t => {
  const net = network(); let clock = Date.now();
  const receiver = serveObservations({ session: net.endpoint(native), allowedDevices: [browser], maxAgeMs: 200, now: () => clock });
  t.after(() => receiver.close());
  const payload = sample(clock);
  for (const envelope of [
    { authorId: 'd'.repeat(64), payload }, { scope: 'e'.repeat(64), payload },
    { payload: { ...payload, fix: { ...payload.fix, accuracyM: 101 } } },
    { payload: { ...payload, fix: { ...payload.fix, sampledAtMs: clock - 1000 } } },
    { payload: { ...payload, fix: { ...payload.fix, sampledAtMs: clock + 2000 } } },
  ]) net.deliver({ scope: app, authorId: browser, sessionId: 'real-session', stream: { streamId: 'capture-one', target: native }, topic: TOPICS.sample, issuedAtMs: clock, ...envelope });
  await sleep(10); assert.notEqual(receiver.snapshot()[browser].phase, 'fresh');
  net.deliver({ scope: app, authorId: browser, sessionId: 'real-session', stream: { streamId: 'capture-one', target: native }, topic: TOPICS.sample, payload });
  await until(() => receiver.snapshot()[browser].phase === 'fresh');
  const replies = net.sent.filter(value => value.topic === TOPICS.reply && value.payload.status === 'accepted');
  assert.equal(replies.length, 1); assert.equal(replies[0].payload.streamId, payload.streamId); assert.equal(replies[0].payload.sequence, 1);
  net.deliver({ scope: app, authorId: browser, sessionId: 'real-session', stream: { streamId: 'capture-one', target: native }, topic: TOPICS.sample, payload });
  await sleep(10); assert.equal(net.sent.filter(value => value.topic === TOPICS.reply && value.payload.status === 'accepted').length, 1);
  clock += 300;
  await until(() => receiver.snapshot()[browser].phase === 'stale');
  net.disconnect(); assert.equal(receiver.snapshot()[browser].phase, 'disconnected');
  assert.equal(fresh(fix(clock + 1001), clock), false);
});

test('pending location registers before permission, and Stop invalidates late callbacks and prevents auto-restart', async t => {
  const net = network(), track = runtime(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' }), window = new EventTarget();
  let success, acquired = 0; const cleared = [];
  const navigator = { geolocation: { watchPosition(fn) { acquired++; assert.deepEqual(track.sensors.status(), ['pending']); success = fn; return 4; }, clearWatch(id) { cleared.push(id); } } };
  const source = createObservationSource({ session: net.endpoint(browser), runtime: track, nativeDeviceId: native, document, window, navigator, coalesceMs: 100 });
  t.after(() => source.close());
  await net.endpoint(native).signals.send(TOPICS.request, { recipient: browser, requestId: 'request-one', source: 'location', expiresAtMs: Date.now() + 20_000 }, { stream: { streamId: 'requests', target: browser } });
  await until(() => source.snapshot().request !== null);
  assert.equal(acquired, 0); assert.equal(source.snapshot().sharing, false);
  assert.throws(() => source.start({ isTrusted: false }, 'location'), /deliberate local/);
  source.start({ isTrusted: true }, 'location'); track.sensors.stopAll();
  success({ timestamp: Date.now(), coords: { latitude: 52.52, longitude: 13.405, accuracy: 3 } });
  await sleep(150); assert.deepEqual(cleared, [4]); assert.equal(source.snapshot().sharing, false);
  assert.equal(net.sent.filter(value => value.topic === TOPICS.sample).length, 0);
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(acquired, 1);
});

test('visibility teardown stops a live location source and stale fixes are discarded before transport', async t => {
  const net = network(), track = runtime(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' }), window = new EventTarget();
  let success; const cleared = [];
  const navigator = { geolocation: { watchPosition(fn) { success = fn; return 6; }, clearWatch(id) { cleared.push(id); } } };
  const source = createObservationSource({ session: net.endpoint(browser), runtime: track, nativeDeviceId: native, document, window, navigator, coalesceMs: 100 });
  t.after(() => source.close());
  source.start({ isTrusted: true }, 'location');
  success({ timestamp: Date.now() - 10_000, coords: { latitude: 52.52, longitude: 13.405, accuracy: 2 } });
  await sleep(120); assert.equal(net.sent.filter(value => value.topic === TOPICS.sample).length, 0);
  success({ timestamp: Date.now(), coords: { latitude: 52.52, longitude: 13.405, accuracy: 2 } });
  await until(() => net.sent.some(value => value.topic === TOPICS.sample));
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(source.snapshot().sharing, false); assert.deepEqual(cleared, [6]);
});


test('requested source and correlation stay fixed within the authenticated stream', async t => {
  const net = network(), receiver = serveObservations({ session: net.endpoint(native), allowedDevices: [browser] });
  t.after(() => receiver.close());
  const request = await receiver.requestObservation(browser, 'location');
  const value = { ...sample(), requestId: request.requestId }, options = { stream: { streamId: value.streamId, target: native } };
  await net.endpoint(browser).signals.send(TOPICS.sample, { ...value, fix: { ...value.fix, source: 'simulated' } }, options);
  await sleep(15); assert.notEqual(receiver.snapshot()[browser].phase, 'fresh', 'A simulator result cannot answer a location request.');
  await net.endpoint(browser).signals.send(TOPICS.sample, value, options);
  await until(() => receiver.snapshot()[browser].phase === 'fresh');
  await net.endpoint(browser).signals.send(TOPICS.sample, { ...value, sequence: 2, requestId: null }, options);
  await net.endpoint(browser).signals.send(TOPICS.sample, { ...value, sequence: 3, fix: { ...value.fix, source: 'simulated' } }, options);
  await sleep(15);
  assert.equal(receiver.snapshot()[browser].sample.sequence, 1, 'Source and correlation cannot change mid-stream.');
});


test('disconnection stops physical acquisition and reconnection cannot silently restart it', async t => {
  const net = network(), track = runtime(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' }), window = new EventTarget();
  let success, acquired = 0; const cleared = [];
  const navigator = { geolocation: { watchPosition(fn) { acquired++; success = fn; return 9; }, clearWatch(id) { cleared.push(id); } } };
  const source = createObservationSource({ session: net.endpoint(browser), runtime: track, nativeDeviceId: native, document, window, navigator, coalesceMs: 100 });
  t.after(() => source.close()); source.start({ isTrusted: true }, 'location');
  net.disconnect(); assert.equal(source.snapshot().sharing, false); assert.equal(source.snapshot().receiver, 'disconnected'); assert.deepEqual(cleared, [9]);
  net.reconnect(); success({ timestamp: Date.now(), coords: { latitude: 52.52, longitude: 13.405, accuracy: 3 } });
  await sleep(120); assert.equal(acquired, 1); assert.equal(source.snapshot().sharing, false); assert.equal(net.sent.filter(value => value.topic === TOPICS.sample).length, 0);
});

test('a late native acknowledgement after Stop cannot replace the retained review candidate', async t => {
  const net = network(), track = runtime(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' }), window = new EventTarget();
  const source = createObservationSource({ session: net.endpoint(browser), runtime: track, nativeDeviceId: native, document, window, coalesceMs: 100 });
  t.after(() => source.close()); source.start({ isTrusted: true }, 'simulated');
  await until(() => net.sent.some(value => value.topic === TOPICS.sample));
  const sent = net.sent.find(value => value.topic === TOPICS.sample).payload; source.stop();
  await net.endpoint(native).signals.send(TOPICS.reply, { recipient: browser, streamId: sent.streamId, sequence: sent.sequence, requestId: sent.requestId, sampledAtMs: sent.fix.sampledAtMs, status: 'accepted' }, { stream: { streamId: 'replies', target: browser } });
  await sleep(10); assert.equal(source.reviewedSample(), null); assert.equal(source.snapshot().sharing, false);
});

test('one slow send retains only the newest source fix and no backlog survives Stop', async t => {
  const net = network(), track = runtime(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' }), window = new EventTarget();
  let success, release; const held = new Promise(resolve => { release = resolve; }), session = net.endpoint(browser), original = session.signals.send;
  const emitted = []; session.signals.send = async (...args) => { if (args[0] === TOPICS.sample) { emitted.push(args[1]); if (emitted.length === 1) await held; } return original(...args); };
  const navigator = { geolocation: { watchPosition(fn) { success = fn; return 3; }, clearWatch() {} } };
  const source = createObservationSource({ session, runtime: track, nativeDeviceId: native, document, window, navigator, coalesceMs: 100 });
  t.after(async () => { release(); await source.close(); }); source.start({ isTrusted: true }, 'location');
  const capture = latitude => success({ timestamp: Date.now(), coords: { latitude, longitude: 13.405, accuracy: 3 } });
  capture(1); await until(() => emitted.length === 1); for (let index = 1; index <= 1000; index++) capture(index / 100);
  await sleep(110); assert.equal(emitted.length, 1); release(); await until(() => emitted.length === 2);
  assert.equal(emitted[1].fix.latitude, 10); capture(11); source.stop(); await sleep(120); assert.equal(emitted.length, 2);
});


for (const appliedBeforeLoss of [false, true]) test(`review journal survives view reopen and ${appliedBeforeLoss ? 'inspection resolves an applied operation' : 'retry preserves exact input and identity'}`, async t => {
  const net = network(), track = runtime(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' }), window = new EventTarget();
  track.capabilities = async () => ({ capabilities: { location: { available: false, permission: 'unknown' } } });
  const entries = new Map(), storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const elements = new Map(), $ = selector => {
    if (!elements.has(selector)) {
      const listeners = new Set(); elements.set(selector, { value: '', textContent: '', disabled: false, readOnly: false,
        addEventListener(type, callback) { if (type === 'click') listeners.add(callback); }, removeEventListener(type, callback) { listeners.delete(callback); },
        click() { for (const listener of [...listeners]) listener({ isTrusted: true }); },
      });
    }
    return elements.get(selector);
  };
  const session = net.endpoint(browser), commands = []; let inspections = 0;
  session.command = async (name, input, options) => {
    commands.push({ name, input: structuredClone(input), options: structuredClone(options) });
    assert.deepEqual(Object.keys(options), ['operationId'], 'Durable command options contain no uncloneable AbortSignal.');
    if (commands.length === 1) throw Error('The command response was lost.');
    return { applied: async () => ({ status: 'applied', outcome: 'accepted' }) };
  };
  session.operations = { inspect: async () => { inspections++; return appliedBeforeLoss ? { state: { status: 'applied', outcome: 'accepted' } } : null; } };
  const receiver = serveObservations({ session: net.endpoint(native), allowedDevices: [browser] });
  let controls; t.after(async () => { await controls?.close(); await receiver.close(); });
  const mount = () => mountObservations({ container: { querySelector: $ }, session, runtime: track, nativeDeviceId: native, storage, document, window, coalesceMs: 100 });
  controls = mount(); controls.source.start({ isTrusted: true }, 'simulated');
  await until(() => controls.source.snapshot().receiver === 'accepted');
  $('#observation-review').value = 'Original reviewed text'; $('#observation-retain').click();
  await until(() => $('#observation-result').textContent.includes('unresolved'));
  assert.equal(entries.size, 1); const original = structuredClone(commands[0]);
  await controls.close(); controls = mount();
  assert.equal(commands.length, 1, 'Reopening only renders the pending operation; it cannot replay it.');
  assert.equal($('#observation-review').readOnly, true);
  $('#observation-review').value = 'Late edit must not change the pending input';
  $(appliedBeforeLoss ? '#observation-inspect' : '#observation-retry').click();
  await until(() => entries.size === 0); assert.equal(inspections, 1);
  if (appliedBeforeLoss) assert.equal(commands.length, 1);
  else { assert.equal(commands.length, 2); assert.deepEqual(commands[1], original); }
  assert.match($('#observation-result').textContent, /Applied: accepted/);
});

test('stale rejection for an unaccepted sample never populates reviewedSample', async t => {
  const net = network(), track = runtime(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' }), window = new EventTarget();
  const source = createObservationSource({ session: net.endpoint(browser), runtime: track, nativeDeviceId: native, document, window, coalesceMs: 100 });
  t.after(() => source.close());
  source.start({ isTrusted: true }, 'simulated');
  await until(() => net.sent.some(value => value.topic === TOPICS.sample));
  const sent = net.sent.find(value => value.topic === TOPICS.sample).payload;
  await net.endpoint(native).signals.send(TOPICS.reply, {
    recipient: browser, streamId: sent.streamId, sequence: sent.sequence,
    requestId: sent.requestId, sampledAtMs: sent.fix.sampledAtMs, status: 'stale',
  }, { stream: { streamId: 'replies', target: browser } });
  await until(() => source.snapshot().receiver === 'stale');
  assert.equal(source.reviewedSample(), null);
  assert.equal(source.snapshot().sample, null);
});

test('expired observation requests cannot start a new stream before the periodic expiry tick', async t => {
  const net = network();
  let clock = Date.now();
  const receiver = serveObservations({ session: net.endpoint(native), allowedDevices: [browser], now: () => clock });
  t.after(() => receiver.close());
  const request = await receiver.requestObservation(browser, 'location');
  clock = request.expiresAtMs + 1;
  const late = { ...sample(clock), requestId: request.requestId };
  await net.endpoint(browser).signals.send(TOPICS.sample, late, { stream: { streamId: late.streamId, target: native } });
  await sleep(15);
  assert.notEqual(receiver.snapshot()[browser].phase, 'fresh');
});

test('corrupt localStorage drafts are ignored and Retry settles an already-applied operation without calling session.retry', async t => {
  const net = network(), track = runtime(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' }), window = new EventTarget();
  track.capabilities = async () => ({ capabilities: { location: { available: false, permission: 'unknown' } } });
  const key = `observation-pending:${app}:${browser}`;
  const entries = new Map([[key, '{"operationId":123}']]);
  const storage = { getItem: k => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, v), removeItem: k => entries.delete(k) };
  const elements = new Map(), $ = selector => {
    if (!elements.has(selector)) {
      const listeners = new Set();
      elements.set(selector, {
        value: '', textContent: '', disabled: false, readOnly: false,
        addEventListener(type, cb) { if (type === 'click') listeners.add(cb); },
        removeEventListener(type, cb) { listeners.delete(cb); },
        click() { for (const cb of [...listeners]) cb({ isTrusted: true }); },
      });
    }
    return elements.get(selector);
  };
  let retryCalls = 0;
  const session = net.endpoint(browser);
  session.retry = async () => { retryCalls++; };
  session.operations = { inspect: async () => ({ state: { status: 'applied', outcome: 'rejected', rejectionCode: 'INVALID_REVIEWED_OBSERVATION' } }) };
  let controls = mountObservations({ container: { querySelector: $ }, session, runtime: track, nativeDeviceId: native, storage, document, window, coalesceMs: 100 });
  t.after(() => controls.close());
  assert.equal($('#observation-review').readOnly, false, 'malformed storage must not lock the review editor');
  await controls.close();
  entries.set(key, JSON.stringify({ operationId: 'op-1', input: { text: 'Saved text', streamId: 'stream-1', sequence: 1, requestId: null, fix: fix() } }));
  controls = mountObservations({ container: { querySelector: $ }, session, runtime: track, nativeDeviceId: native, storage, document, window, coalesceMs: 100 });
  assert.equal($('#observation-review').value, 'Saved text');
  $('#observation-retry').click();
  await until(() => entries.size === 0);
  assert.equal(retryCalls, 0, 'Retry must not call session.retry when inspection shows the operation already applied');
  assert.match($('#observation-result').textContent, /INVALID_REVIEWED_OBSERVATION/);
});
