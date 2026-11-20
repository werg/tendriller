import assert from 'node:assert/strict';
import test from 'node:test';
import { superviseParticipant } from '../../docs/tutorial/helpers/participant-lifecycle.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
const approved = (revision = 'approval-1') => ({ type: 'setup', version: 1, assistant: { proposalId: 'a'.repeat(64), approved: true, revision } });
function fixture(options = {}) {
  const stop = new AbortController(), closed = Promise.withResolvers(), reports = [], adapters = [];
  let listener, processing = 0;
  const owned = { session: { signal: stop.signal }, processPairings: async () => { processing++; return options.results ?? []; } };
  const lifecycle = superviseParticipant({ owned, proposalId: 'a'.repeat(64), report: value => reports.push(value),
    retryMs: 10, maxRetryMs: 20,
    watch(callbacks) { listener = callbacks.onChange; return { closed: closed.promise, close() { closed.resolve(); } }; },
    startAdapter({ signal, onStatus }) {
      const done = Promise.withResolvers(), entry = { signal, onStatus, done, closes: 0 };
      adapters.push(entry);
      return { closed: done.promise, waitUntilOnline: async () => {}, close() { entry.closes++; done.resolve(); } };
    }, ...options });
  return { lifecycle, stop, reports, adapters, notice: value => listener(value), watchClosed: () => closed.resolve(), count: () => processing };
}

test('a delayed owner and a closed setup channel never stop the native participant', async () => {
  const f = fixture(); let ended = false; f.lifecycle.done.then(() => { ended = true; });
  f.notice({ ...approved(), assistant: { proposalId: 'a'.repeat(64), approved: false, revision: null } });
  await flush(); assert.equal(f.adapters.length, 0); assert.equal(f.count(), 1);
  f.watchClosed(); await flush(); assert.equal(ended, false);
  assert(f.reports.some(x => x.state === 'setup_channel_closed' && x.participantRunning));
  await f.lifecycle.close(); assert.equal(ended, true);
});

test('approval starts an adapter, revocation stops only that component, and new consent reconnects it', async () => {
  const f = fixture(); f.notice(approved()); await flush(); await flush();
  assert.equal(f.adapters.length, 1);
  f.notice({ ...approved(), assistant: { proposalId: 'a'.repeat(64), approved: false, revision: null } });
  await flush(); await flush(); assert(f.adapters[0].signal.aborted);
  f.notice(approved('approval-2')); await flush(); await flush();
  assert.equal(f.adapters.length, 2); assert(!f.adapters[1].signal.aborted);
  await f.lifecycle.close(); assert(f.adapters[1].signal.aborted);
});

test('a replaced adapter is fenced until a new consent revision and never aborts pairing', async () => {
  const f = fixture(); f.notice(approved()); await flush();
  f.adapters[0].onStatus({ state: 'disconnected', reason: 'participant_replaced' }); f.adapters[0].done.resolve();
  await flush(); await flush(); f.notice(approved()); await flush(); assert.equal(f.adapters.length, 1);
  assert(f.count() >= 2); f.notice(approved('next')); await flush(); await flush(); assert.equal(f.adapters.length, 2);
  await f.lifecycle.close();
});

test('idle setup does no polling and expiry triggers just one retained-request reconciliation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let count = 0;
  const f = fixture({ owned: { session: { signal: new AbortController().signal }, processPairings: async () => {
    count++; return count === 1 ? [{ state: 'pending', expiresAt: 1500 }] : [{ state: 'expired', expiresAt: 1500 }];
  } } });
  f.notice(approved()); await flush(); t.mock.timers.tick(501); await flush(); assert.equal(count, 2);
  t.mock.timers.tick(48 * 3600000); await flush(); assert.equal(count, 2);
  await f.lifecycle.close();
});

test('notifications arriving during reconciliation coalesce without concurrent signing operations', async () => {
  let active = 0, max = 0, calls = 0; const gate = Promise.withResolvers();
  const f = fixture({ owned: { session: { signal: new AbortController().signal }, processPairings: async () => {
    calls++; max = Math.max(max, ++active); if (calls === 1) await gate.promise; active--; return [];
  } } });
  f.notice(approved()); f.notice(approved()); f.notice(approved()); gate.resolve(); await flush();
  assert.equal(max, 1); assert.equal(calls, 2); await f.lifecycle.close();
});


test('commit reconciles its retained ordering pause immediately without another notice', async () => {
  let paused = true, calls = 0;
  const f = fixture({ owned: { session: { signal: new AbortController().signal, orderingPause: async () => paused },
    processPairings: async () => { calls++; if (calls === 1) return [{ state: 'committed' }]; paused = false; return [{ state: 'verified' }]; }
  } });
  f.notice(approved()); await flush(); await flush();
  assert.equal(calls, 2); assert.equal(paused, false);
  await f.lifecycle.close();
});
