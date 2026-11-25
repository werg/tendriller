import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerConnection, describeConnectionError } from '../../docs/tutorial/shared/connection.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, connect, origin = 'https://page.example') {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin, reload() {} } });
  const states = [], controller = createOwnerConnection({ configuration: { page_url: 'https://page.example/' }, connect, onState: value => states.push(value) });
  t.after(() => { controller.close(); if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; });
  return { controller, states };
}
test('local session readiness is independent from zero peers, native process or finalizer', async t => {
  let calls = 0, closed = 0;
  const session = { status: { canAuthor: true, connectedPeers: 0, database: 'opening' }, onStatus(fn) { fn(this.status); return () => { closed++; }; } };
  const f = fixture(t, async () => { calls++; return { session }; });
  await f.controller.start(); assert.equal(f.controller.state.phase, 'connected'); assert.equal(calls, 1);
  assert.match(f.controller.state.detail, /zero peers/); f.controller.close(); assert.equal(closed, 1);
});
test('a keyless attachment remains usable while it waits for admission, without creating replacement identities', async t => {
  let observe, calls = 0;
  const f = fixture(t, async () => { calls++; return { status: { canAuthor: false }, onStatus(fn) { observe = fn; fn({ canAuthor: false }); return () => {}; } }; });
  await f.controller.start(); assert.equal(f.controller.state.phase, 'key-required'); assert.equal(calls, 1);
  observe({ canAuthor: true }); assert.equal(f.controller.state.phase, 'connected'); assert.equal(calls, 1);
});
test('closing an initial attachment attempt preserves its error and never opens another signer', async t => {
  let reject, scope, calls = 0;
  const f = fixture(t, ({ signal }) => { scope = signal; calls++; return new Promise((_, no) => { reject = no; }); });
  const opening = f.controller.start(), failure = Error('original attempt closed'); await tick(); f.controller.close(); assert.equal(scope.aborted, true); reject(failure);
  await assert.rejects(opening, error => error === failure); await assert.rejects(f.controller.retry(), /closed/); assert.equal(calls, 1); assert.equal(f.states.some(state => state.phase === 'connected'), false);
});
test('a static off-origin preview opens no identity, storage or host work', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; }, 'https://preview.example'); await f.controller.start(); assert.equal(calls, 0); assert.equal(f.controller.state.phase, 'preview');
});
test('missing keys and owner authentication have explicit restore/sign-in actions, not native waiting loops', () => {
  const missing = describeConnectionError({ code: 'BOOTSTRAP_KEY_MISSING' }); assert.match(missing.detail, /Never initialize replacement keys/); assert.equal(missing.retry, undefined);
  const account = describeConnectionError({ code: 'browser_account_required' }); assert.equal(account.action, 'reload'); assert.match(account.title, /Sign in/);
});
