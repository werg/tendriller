import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerLiveness } from '../browser-liveness.mjs';

function fixture() {
  let time = 0, request = null;
  const session = { get boundedRequest() { return request; } };
  const state = createOwnerLiveness({ livenessTimeoutMs: 15000, requestTimeoutMs: 30000, now: () => time });
  state.bind(session);
  return { state, at(value) { time = value; }, request(value) { request = value; } };
}

test('a finite 30s request can return at17s without a premature15s fence', () => {
  const f = fixture(); f.request({ startedAt: 0, deadline: 30000 });
  assert.equal(f.state.deadline(), 30000);
  f.at(15000); assert.equal(f.state.deadline(), 30000);
  f.at(17000); f.request(null); f.state.authenticated();
  assert.equal(f.state.deadline(), 32000);
});

test('silent hung request stays bounded at its original30s deadline', () => {
  const f = fixture(); f.request({ startedAt: 0, deadline: 30000 });
  assert.equal(f.state.deadline(), 30000);
  f.at(29999); assert.equal(f.state.deadline(), 30000);
  f.at(30000); assert.ok(f.state.deadline() <= 30000);
});

test('no request or indefinitely passive observation retains the15s silence fence', () => {
  const f = fixture(); f.request(null); f.at(15000);
  assert.equal(f.state.deadline(), 15000);
});

test('continuous/concurrent caller requests and cancellation cannot renew a silent owner', () => {
  const f = fixture(); f.request({ startedAt: 0, deadline: 30000 });
  assert.equal(f.state.deadline(), 30000);
  for (let time = 1000; time < 30000; time += 1000) {
    f.at(time); f.request({ startedAt: time, deadline: time + 30000 });
    assert.equal(f.state.deadline(), 30000);
  }
  f.at(30000); f.request({ startedAt: 30000, deadline: 60000 });
  assert.equal(f.state.deadline(), 30000);
});

test('cancellation withdraws protection without arming a replacement window', () => {
  const f = fixture(); f.request({ startedAt: 0, deadline: 30000 }); f.state.deadline();
  f.at(5000); f.request(null); assert.equal(f.state.deadline(), 15000);
  f.request({ startedAt: 5000, deadline: 35000 }); assert.equal(f.state.deadline(), 30000);
});

test('a new request cannot revive already expired owner evidence', () => {
  const f = fixture(); f.at(15000); f.request({ startedAt: 15000, deadline: 45000 });
  assert.equal(f.state.deadline(), 15000);
});

test('only an authenticated response rearms the first bounded deadline', () => {
  const f = fixture(); f.request({ startedAt: 0, deadline: 30000 }); f.state.deadline();
  f.at(17000); f.request({ startedAt: 17000, deadline: 47000 });
  assert.equal(f.state.deadline(), 30000);
  f.state.authenticated(); assert.equal(f.state.deadline(), 47000);
});

test('invalid/future/overlong caller metadata supplies no grace', () => {
  for (const request of [{ startedAt: 1, deadline: 30001 }, { startedAt: 0, deadline: Infinity },
    { startedAt: 0, deadline: 30001 }, { startedAt: 0, deadline: 0 }]) {
    const f = fixture(); f.request(request); assert.equal(f.state.deadline(), 15000);
  }
});

test('close clears request source and rejects unavailable or duplicate facade binding', () => {
  const f = fixture(); f.request({ startedAt: 0, deadline: 30000 }); f.state.deadline();
  assert.throws(() => f.state.bind({ boundedRequest: null }), /CONTRACT_INCOMPATIBLE/);
  f.state.clear(); assert.equal(f.state.deadline(), 15000);
  const fresh = createOwnerLiveness({ livenessTimeoutMs: 15000, requestTimeoutMs: 30000 });
  assert.throws(() => fresh.bind({}), /CONTRACT_INCOMPATIBLE/);
});
