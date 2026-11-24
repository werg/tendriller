import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [new URL('../src/wake-lock.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'WakeLock', platform: 'browser', write: false,
});

function harness({ supported = true, deferRequest = false } = {}) {
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const registrations = [];
  const stoppedListeners = new Set();
  const sentinels = [];
  let pendingResolve = null;

  const makeSentinel = () => {
    const s = Object.assign(new EventTarget(), {
      released: false,
      releaseCalls: 0,
      async release() {
        this.releaseCalls++;
        if (this.released) return;
        this.released = true;
        this.dispatchEvent(new Event('release'));
      },
    });
    sentinels.push(s);
    return s;
  };

  const navigator = supported ? {
    wakeLock: {
      request(type) {
        assert.equal(type, 'screen');
        if (deferRequest) {
          return new Promise(resolve => { pendingResolve = () => resolve(makeSentinel()); });
        }
        return Promise.resolve(makeSentinel());
      },
    },
  } : {};

  const ctx = { navigator, document: doc, EventTarget, Event, Promise, AbortController };
  runInNewContext(compiled.outputFiles[0].text, ctx);

  const register = opts => {
    const ac = new AbortController();
    const rec = { ...opts, state: opts.state ?? 'pending', unregistered: false, stopCalls: 0 };
    registrations.push(rec);
    return {
      signal: ac.signal,
      setState(state) { if (!ac.signal.aborted) rec.state = state; },
      unregister() {
        if (rec.unregistered) return;
        rec.unregistered = true;
        ac.abort();
        rec.stopCalls++;
        void opts.stop();
      },
    };
  };
  const onStopped = fn => { stoppedListeners.add(fn); return () => stoppedListeners.delete(fn); };
  const emitStopped = () => { for (const fn of [...stoppedListeners]) fn(); };
  return {
    createWakeLockLease: opts => ctx.WakeLock.createWakeLockLease(register, onStopped, opts),
    doc, registrations, sentinels, emitStopped, resolvePending: () => pendingResolve?.(),
  };
}

test('createWakeLockLease returns unsupported cleanly when Wake Lock API is absent', async () => {
  const h = harness({ supported: false });
  const lease = await h.createWakeLockLease({ label: 'Keep awake' });
  assert.equal(lease.supported, false);
  assert.equal(lease.active, false);
  await lease.release();
  assert.equal(h.registrations.length, 0);
});

test('createWakeLockLease registers wake_lock sensor, releases on stop, and re-acquires when autoReacquire is true', async () => {
  const h = harness({ supported: true });
  const lease = await h.createWakeLockLease({ label: 'Dashboard awake', autoReacquire: true });
  assert.equal(lease.supported, true);
  assert.equal(lease.active, true);
  assert.equal(h.registrations.length, 1);
  assert.equal(h.registrations[0].kind, 'wake_lock');
  assert.equal(h.registrations[0].state, 'active');

  // Hide document -> releases lock
  h.doc.visibilityState = 'hidden';
  h.doc.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve();
  assert.equal(lease.active, false);
  assert.equal(h.sentinels[0].released, true);

  // Return to visible -> autoReacquire grabs a new sentinel
  h.doc.visibilityState = 'visible';
  h.doc.dispatchEvent(new Event('visibilitychange'));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(h.sentinels.length, 2);
  assert.equal(lease.active, true);

  // Stop sensors releases and permanently closes lease
  h.emitStopped();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(lease.active, false);
  assert.equal(h.sentinels[1].released, true);
});

test('createWakeLockLease releases a deferred sentinel if cancelled before grant resolves', async () => {
  const h = harness({ supported: true, deferRequest: true });
  const pendingLease = h.createWakeLockLease({ label: 'Hands-free' });
  h.emitStopped();
  h.resolvePending();
  const lease = await pendingLease;
  await new Promise(r => setTimeout(r, 10));
  assert.equal(lease.active, false);
  assert.equal(h.sentinels[0].released, true);
});
