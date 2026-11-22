import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({ entryPoints: [new URL('../src/voice/microphone.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'Microphone', platform: 'browser', write: false });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function locks() {
  let owner = null;
  return {
    calls: [],
    async request(name, options, callback) {
      this.calls.push({ name, options });
      const key = owner ? null : {};
      if (key) owner = key;
      try { return await callback(key); }
      finally { if (key && owner === key) owner = null; }
    },
    get occupied() { return !!owner; },
  };
}
function environment({ manager = locks(), battery, permission, saveData = false, secure = true } = {}) {
  const timers = new Map(); let serial = 0, batteryReads = 0, permissionReads = 0;
  const setTimeout = (callback, ms) => { const id = ++serial; timers.set(id, { callback, ms }); return id; };
  const clearTimeout = id => timers.delete(id);
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget();
  const connection = Object.assign(new EventTarget(), { saveData });
  const navigator = { locks: manager, connection };
  if (battery !== undefined) navigator.getBattery = async () => { batteryReads++; return typeof battery === 'function' ? battery() : battery; };
  if (permission !== undefined) navigator.permissions = { query: async () => { permissionReads++; return typeof permission === 'function' ? permission() : permission; } };
  const context = { navigator, document, window, isSecureContext: secure, setTimeout, clearTimeout, DOMException };
  runInNewContext(built.outputFiles[0].text, context);
  const stops = [];
  return { ...context.Microphone, navigator, window, document, connection, manager, timers, stops,
    get batteryReads() { return batteryReads; }, get permissionReads() { return permissionReads; },
    acquire(options = {}) { return context.Microphone.acquireMicrophoneSession({ wake: true, onStop: reason => stops.push(reason), ...options }); },
    async expire(ms) {
      const found = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(found, `No ${ms}ms timer`); timers.delete(found[0]); found[1].callback(); await tick();
    },
  };
}

test('a module is inert and one lease excludes all other tabs until actual shutdown', async () => {
  const manager = locks();
  const permission = Object.assign(new EventTarget(), { state: 'granted' });
  const battery = Object.assign(new EventTarget(), { charging: false, level: 0.8 });
  const first = environment({ manager, permission, battery }), second = environment({ manager });
  assert.equal(first.permissionReads, 0); assert.equal(first.batteryReads, 0); assert.equal(manager.calls.length, 0);
  const lease = await first.acquire();
  assert.equal(manager.occupied, true);
  assert.equal(manager.calls[0].name, 'tendriller-microphone');
  assert.equal(manager.calls[0].options.ifAvailable, true);
  await assert.rejects(second.acquire(), /Another tab/);
  first.document.visibilityState = 'hidden'; first.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(first.stops.length, 1); assert.match(first.stops[0], /hidden/);
  // A policy signal cannot unlock a still-open or still-pending microphone.
  assert.equal(manager.occupied, true);
  await assert.rejects(second.acquire(), /Another tab/);
  lease.release(); lease.release(); await tick();
  assert.equal(manager.occupied, false); assert.equal(first.timers.size, 0);
  const replacement = await second.acquire(); replacement.release(); await tick();
  assert.equal(manager.occupied, false);
  first.document.visibilityState = 'visible'; first.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(first.stops.length, 1);
});

test('insecure, hidden, unsupported and already-cancelled starts never acquire a lock', async () => {
  const insecure = environment({ secure: false }); await assert.rejects(insecure.acquire(), /HTTPS/); assert.equal(insecure.manager.calls.length, 0);
  const hidden = environment(); hidden.document.visibilityState = 'hidden'; await assert.rejects(hidden.acquire(), /Open this page/); assert.equal(hidden.manager.calls.length, 0);
  const unsupported = environment({ manager: null }); await assert.rejects(unsupported.acquire(), /Web Locks/);
  const controller = new AbortController(); controller.abort();
  const cancelled = environment(); await assert.rejects(cancelled.acquire({ signal: controller.signal }), { name: 'AbortError' }); assert.equal(cancelled.manager.calls.length, 0);
});

test('permission denial and low battery reject before ownership; absence of optional APIs still works', async () => {
  const permission = Object.assign(new EventTarget(), { state: 'denied' });
  const denied = environment({ permission }); await assert.rejects(denied.acquire(), /permission was denied/); assert.equal(denied.manager.calls.length, 0);
  const battery = Object.assign(new EventTarget(), { charging: false, level: 0.2 });
  const low = environment({ battery }); await assert.rejects(low.acquire(), /save battery/); assert.equal(low.manager.calls.length, 0);
  const saver = environment({ saveData: true }); await assert.rejects(saver.acquire(), /Data Saver/); assert.equal(saver.manager.calls.length, 0);
  const unavailable = environment({ permission: () => { throw Error('unsupported descriptor'); }, battery: () => { throw Error('unsupported'); } });
  const lease = await unavailable.acquire(); lease.release();
  const tap = await low.acquire({ wake: false }); tap.release();
});

test('late battery information, permission revocation and Data Saver changes stop existing capture', async () => {
  let resolveBattery;
  const battery = Object.assign(new EventTarget(), { charging: false, level: 0.1 });
  const late = environment({ battery: () => new Promise(resolve => { resolveBattery = resolve; }) });
  const starting = late.acquire(); await tick(); await late.expire(1000);
  const lateLease = await starting;
  resolveBattery(battery); await tick(); assert.equal(late.stops.length, 1); assert.match(late.stops[0], /battery/);
  lateLease.release();

  const permission = Object.assign(new EventTarget(), { state: 'prompt' });
  const revoked = environment({ permission }); const revokedLease = await revoked.acquire();
  permission.state = 'denied'; permission.dispatchEvent(new Event('change'));
  permission.dispatchEvent(new Event('change')); assert.equal(revoked.stops.length, 1); assert.match(revoked.stops[0], /revoked/);
  revokedLease.release();

  const saver = environment(); const saverLease = await saver.acquire(); saver.connection.saveData = true; saver.connection.dispatchEvent(new Event('change'));
  assert.equal(saver.stops.length, 1); assert.match(saver.stops[0], /Data Saver/); saverLease.release();
});

test('battery changes and page freeze stop once; release detaches every observer', async () => {
  const battery = Object.assign(new EventTarget(), { charging: true, level: 0.1 });
  const charging = environment({ battery }); const lease = await charging.acquire();
  battery.charging = false; battery.dispatchEvent(new Event('chargingchange'));
  charging.window.dispatchEvent(new Event('pagehide')); charging.document.dispatchEvent(new Event('freeze'));
  assert.equal(charging.stops.length, 1); assert.match(charging.stops[0], /battery/); lease.release();
  assert.equal(charging.timers.size, 0);
  const frozen = environment(); const frozenLease = await frozen.acquire(); frozen.document.dispatchEvent(new Event('freeze'));
  assert.equal(frozen.stops.length, 1); assert.match(frozen.stops[0], /suspended/); frozenLease.release();
  const detached = environment({ battery }); const detachedLease = await detached.acquire({ wake: false }); detachedLease.release();
  detached.window.dispatchEvent(new Event('pagehide')); assert.deepEqual(detached.stops, []);
});

test('session time limits cannot be extended and do not automatically release the microphone', async () => {
  const env = environment(); const lease = await env.acquire({ maxDurationMs: 600000 });
  await env.expire(300000); assert.equal(env.stops.length, 1); assert.match(env.stops[0], /time limit/); assert.equal(env.manager.occupied, true);
  lease.release(); await tick(); assert.equal(env.manager.occupied, false);
  for (const value of [0, -1, NaN, Infinity]) await assert.rejects(env.acquire({ maxDurationMs: value }), /positive finite/);
  const shortened = environment(); const shortLease = await shortened.acquire({ maxDurationMs: 100 }); await shortened.expire(100); assert.equal(shortened.stops.length, 1); shortLease.release();
});

test('cancellation interrupts optional API waits and safely returns a delayed lock', async () => {
  const controller = new AbortController(); let completePermission;
  const waiting = environment({ permission: () => new Promise(resolve => { completePermission = resolve; }) });
  const pending = waiting.acquire({ signal: controller.signal }); await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(waiting.manager.calls.length, 0); assert.equal(waiting.timers.size, 0);
  completePermission(Object.assign(new EventTarget(), { state: 'granted' })); await tick(); assert.deepEqual(waiting.stops, []);

  let enter; let held = false;
  const delayed = environment({ manager: { request(_name, _options, callback) { return new Promise(resolve => { enter = async () => { held = true; await callback({}); held = false; resolve(); }; }); } } });
  const cancel = new AbortController(); const acquiring = delayed.acquire({ signal: cancel.signal }); await tick(); cancel.abort();
  await assert.rejects(acquiring, { name: 'AbortError' }); await enter();
  assert.equal(held, false); assert.equal(delayed.timers.size, 0); assert.deepEqual(delayed.stops, []);
});
