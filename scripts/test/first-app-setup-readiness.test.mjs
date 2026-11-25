import test from 'node:test';
import assert from 'node:assert/strict';
import { observeSetupReadiness } from '../first-app-setup-readiness.mjs';

function fixture() {
  let callbacks, calls = 0;
  const gates = [];
  const observer = observeSetupReadiness({
    watchSetup(value) { callbacks = value; return { close() {} }; },
    processPairings() { calls++; const gate = Promise.withResolvers(); gates.push(gate); return gate.promise; },
  });
  observer.watch({ onChange() {} });
  return { observer, gates, calls: () => calls, status: state => callbacks.onStatus({ state }), notice: () => callbacks.onChange({}) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('direct recovery cannot settle setup until reconnection, its initial notice and pairing read complete', async () => {
  const f = fixture();f.status('reconnecting');
  let finished = false;
  const waiting = f.observer.wait().then(value => { finished = true; return value; });
  await flush();assert.equal(finished, false);assert.equal(f.calls(), 0);
  f.status('connected');await flush();assert.equal(finished, false, 'open is not initial-notice readiness');
  f.notice();const work = f.observer.processPairings();await flush();assert.equal(finished, false);
  f.gates[0].resolve([]);await work;
  const ready = await waiting;assert.equal(ready.ready, true);assert.equal(ready.reconciled, 1);assert.equal(f.calls(), 1);
});

test('an earlier notice or completed read cannot qualify a replacement watch connection', async () => {
  const f = fixture();f.status('connected');f.notice();
  const first=f.observer.processPairings();f.gates[0].resolve([]);await first;assert.equal(f.observer.snapshot().ready,true);
  f.status('reconnecting');f.status('connected');assert.equal(f.observer.snapshot().ready,false);
  f.notice();const second=f.observer.processPairings();assert.equal(f.observer.snapshot().ready,false);
  f.gates[1].resolve([]);await second;assert.equal(f.observer.snapshot().ready,true);assert.equal(f.observer.snapshot().revision,2);
});

test('a notice during a pending read requires the supervisor coalesced follow-up read', async () => {
  const f=fixture();f.status('connected');f.notice();const first=f.observer.processPairings();f.notice();
  f.gates[0].resolve([]);await first;assert.equal(f.observer.snapshot().ready,false);
  const second=f.observer.processPairings();f.gates[1].resolve([]);await second;assert.equal(f.observer.snapshot().ready,true);
});

test('failed reconciliation and abort cannot report readiness', async () => {
  const f=fixture();f.status('connected');f.notice();const read=f.observer.processPairings();
  const failure=Error('pairing read failed');f.gates[0].reject(failure);await assert.rejects(read,error=>error===failure);
  assert.equal(f.observer.snapshot().ready,false);
  const stop=new AbortController();const waiting=f.observer.wait({signal:stop.signal});const reason=Error('stop');stop.abort(reason);
  await assert.rejects(waiting,error=>error===reason);
});

test('terminal closure and finite readiness timeout fail closed', async () => {
  const f=fixture();const waiting=f.observer.wait();f.status('closed');await assert.rejects(waiting,/SETUP_CONTROL_CLOSED/);
  const g=fixture();await assert.rejects(g.observer.wait({timeoutMs:5}),/SETUP_CONTROL_READY_TIMEOUT/);
});

test('real participant supervisor drives the readiness barrier through reconnect reconciliation', async () => {
  const { superviseParticipant } = await import('../../docs/tutorial/shared/participant-lifecycle.mjs');
  const stopped = new AbortController(), closed = Promise.withResolvers();
  let callbacks, read;
  const owned = {
    session: { signal: stopped.signal },
    watchSetup(value) { callbacks = value; return { closed: closed.promise, close() { closed.resolve(); } }; },
    processPairings() { read = Promise.withResolvers(); return read.promise; },
  };
  const observer = observeSetupReadiness(owned);
  const supervisor = superviseParticipant({ owned: { ...owned, processPairings: options => observer.processPairings(options) },
    watch: options => observer.watch(options) });
  try {
    callbacks.onStatus({ state: 'reconnecting' });
    let ready = false;const waiting = observer.wait().then(value => { ready = true;return value; });
    await flush();assert.equal(ready, false);
    callbacks.onStatus({ state: 'connected' });await flush();assert.equal(ready, false);
    callbacks.onChange({ type: 'setup', version: 1, assistant: { approved: false, proposalId: null, revision: null } });
    await flush();assert.ok(read);assert.equal(ready, false);
    read.resolve([]);await waiting;assert.equal(ready, true);
  } finally { await supervisor.close(); }
});
