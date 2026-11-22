import assert from 'node:assert/strict';
import test from 'node:test';
import { superviseParticipant } from '../../docs/tutorial/helpers/participant-lifecycle.mjs';
import { watchApplicationSetup } from '../../contract/setup-watch.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
const approved = (revision = 'approval-1') => ({ type: 'setup', version: 1, assistant: { proposalId: 'a'.repeat(64), approved: true, revision } });
function fixture(options = {}) {
  const stop = new AbortController(), closed = Promise.withResolvers(), reports = [], adapters = [];
  let listener, statusListener, processing = 0;
  const owned = { session: { signal: stop.signal }, processPairings: async () => { processing++; return options.results ?? []; } };
  const lifecycle = superviseParticipant({ owned, proposalId: 'a'.repeat(64), report: value => reports.push(value),
    retryMs: 10, maxRetryMs: 20,
    watch(callbacks) { listener = callbacks.onChange; statusListener = callbacks.onStatus; return { closed: closed.promise, close() { closed.resolve(); } }; },
    startAdapter({ signal, onStatus }) {
      const done = Promise.withResolvers(), entry = { signal, onStatus, done, closes: 0 };
      adapters.push(entry);
      return { closed: done.promise, waitUntilOnline: async () => {}, close() { entry.closes++; done.resolve(); } };
    }, ...options });
  return { lifecycle, stop, reports, adapters, notice: value => listener(value), status: value => statusListener(value), watchClosed: () => closed.resolve(), count: () => processing };
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
  f.adapters[0].onStatus({ state: 'disconnected', reason: 'participant_replaced' });
  assert(f.adapters[0].signal.aborted); f.adapters[0].done.resolve();
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


test('preparation retries only failures with independent capped backoff, then never polls a successful proposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const f = fixture({ proposalId: undefined, prepareAdapter: async () => {
    calls++; if (calls <= 3) throw Object.assign(Error('outage'), {code:'NETWORK_UNAVAILABLE'}); return 'a'.repeat(64);
  } });
  f.notice(approved()); await flush();
  assert.equal(calls, 1); assert.equal(f.count(), 1); assert.equal(f.adapters.length, 0);
  // Repeated successful pairing work must neither reset nor bypass preparation backoff.
  f.notice(approved()); await flush(); t.mock.timers.tick(9); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  f.notice(approved()); await flush(); t.mock.timers.tick(19); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 3);
  t.mock.timers.tick(20); await flush(); await flush(); assert.equal(calls, 4); assert.equal(f.adapters.length, 1);
  assert.deepEqual(f.reports.filter(x => x.state === 'assistant_retry').map(x => x.retryInMs), [10,20,20]);
  const pairings = f.count(); t.mock.timers.tick(86400000); await flush();
  assert.equal(calls, 4); assert.equal(f.count(), pairings); assert.equal(f.adapters.length, 1);
  await f.lifecycle.close();
});

test('stalled optional preparation neither serializes pairing nor owns shutdown; late completion is inert', async () => {
  const gate = Promise.withResolvers(); let prepareSignal;
  const f = fixture({ proposalId: undefined, prepareAdapter: ({signal}) => {prepareSignal = signal; return gate.promise;} });
  f.notice(approved()); await flush(); f.notice(approved()); await flush();
  assert.equal(f.count(), 2); assert.equal(f.adapters.length, 0);
  await f.lifecycle.close(); assert(prepareSignal.aborted);
  gate.resolve('a'.repeat(64)); await flush(); assert.equal(f.adapters.length, 0);
});

for (const code of ['agent_binding_revoked', 'forbidden']) {
  test(`terminal preparation ${code} stops optional retries while pairing remains available`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
    const f = fixture({ proposalId: undefined, prepareAdapter: async () => {calls++; throw Object.assign(Error(code), {code});} });
    f.notice(approved()); await flush(); t.mock.timers.tick(86400000); await flush();
    f.notice(approved('next')); await flush(); assert.equal(calls, 1); assert.equal(f.count(), 2);
    assert.equal(f.adapters.length, 0); assert(f.reports.some(x => x.state === 'assistant_stopped' && x.reason === code));
    await f.lifecycle.close();
  });
}

test('setup access revocation cancels a pending proposal and cannot be undone by late notices or replies', async () => {
  const gate = Promise.withResolvers(); let signal;
  const f = fixture({proposalId:undefined, prepareAdapter: options => {signal = options.signal; return gate.promise;}});
  f.notice(approved()); await flush(); f.status({state:'access_revoked'}); assert(signal.aborted);
  gate.resolve('a'.repeat(64)); await flush(); f.notice(approved('next')); await flush();
  assert.equal(f.adapters.length, 0); assert.equal(f.count(), 2);
  await f.lifecycle.close();
});

test('revocation between scheduling and starting an adapter fences the old approval', async () => {
  const f = fixture(); f.notice(approved());
  f.notice({...approved(),assistant:{proposalId:'a'.repeat(64),approved:false,revision:null}});
  await flush(); assert.equal(f.adapters.length, 0);
  f.notice(approved('next')); await flush(); assert.equal(f.adapters.length, 1);
  await f.lifecycle.close();
});

test('late online completion after revocation never forwards events and new consent can connect', async () => {
  const online = Promise.withResolvers(), adapters = []; let forwards = 0;
  const f = fixture({onOnline:()=>{forwards++;}, startAdapter({signal}) {
    const closed = Promise.withResolvers(); adapters.push({signal});
    return {closed:closed.promise,waitUntilOnline:()=>online.promise,close:()=>closed.resolve()};
  }});
  f.notice(approved()); await flush();
  f.notice({...approved(),assistant:{proposalId:'a'.repeat(64),approved:false,revision:null}});
  await flush(); assert(adapters[0].signal.aborted);
  online.resolve(); await flush(); assert.equal(forwards, 0);
  f.notice(approved('new-consent')); await flush(); await flush(); assert.equal(forwards, 1);
  assert.equal(adapters.length, 2); await f.lifecycle.close();
});


test('a revoked pairing credential also fences optional preparation without ending native ownership', async () => {
  const gate = Promise.withResolvers(); let signal, calls = 0;
  const f = fixture({proposalId:undefined, prepareAdapter: options => {signal = options.signal; return gate.promise;},
    owned:{session:{signal:new AbortController().signal},processPairings:async()=>{calls++; throw Object.assign(Error('revoked'),{code:'agent_binding_revoked'});}}});
  await flush(); f.notice(approved()); await flush(); assert(signal.aborted);
  gate.resolve('a'.repeat(64)); await flush(); f.notice(approved('next')); await flush();
  assert.equal(calls, 2); assert.equal(f.adapters.length, 0); await f.lifecycle.close();
});

test('a failed adapter transport while starting cannot leave an unhandled rejection or stop pairing', async () => {
  const transport = Promise.withResolvers();
  const f = fixture({startAdapter:()=>({closed:transport.promise,waitUntilOnline:()=>new Promise(()=>{}),close(){}})});
  f.notice(approved()); await flush(); transport.reject(Error('transport failed')); await flush();
  f.notice({...approved(),assistant:{proposalId:null,approved:false,revision:null}}); await flush();
  assert.equal(f.count(), 2); await f.lifecycle.close();
});


test('a synchronous approval-change status during adapter start cannot forward or restart stale consent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let forwards = 0, starts = 0, closes = 0;
  const f = fixture({onOnline:()=>{forwards++;}, startAdapter({onStatus}) {
    starts++; onStatus({state:'disconnected',reason:'approval_changed'});
    return {closed:new Promise(()=>{}),waitUntilOnline:async()=>{},close:()=>{closes++;}};
  }});
  f.notice(approved()); await flush(); t.mock.timers.tick(86400000); await flush();
  assert.equal(forwards, 0); assert.equal(starts, 1); assert.equal(closes, 1);
  f.notice(approved()); await flush(); assert.equal(starts, 1); await f.lifecycle.close();
});


test('optional synchronous activity failure stays isolated from the healthy transport',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture({onOnline(){throw Object.assign(Error('private diagnostic'),{code:'access_revoked'});}});
 f.notice(approved());await flush();await flush();t.mock.timers.tick(48*3600000);await flush();
 assert.equal(f.adapters.length,1);assert.equal(f.adapters[0].signal.aborted,false);assert.equal(f.adapters[0].closes,0);
 assert.equal(f.reports.filter(x=>x.state==='adapter_activity_failed').length,1);
 assert(!f.reports.some(x=>['assistant_retry','adapter_offline','assistant_stopped'].includes(x.state)));
 assert(!JSON.stringify(f.reports).includes('private diagnostic'));await f.lifecycle.close();
});
test('late optional activity errors after replacement or shutdown are fenced from newer components',async()=>{
 const activities=[];const f=fixture({onOnline(){const pending=Promise.withResolvers();activities.push(pending);return pending.promise;}});
 f.notice(approved());await flush();f.notice(approved('next'));await flush();await flush();
 assert.equal(f.adapters.length,2);activities[0].reject(Error('late old activity'));await flush();
 assert(!f.reports.some(x=>x.state==='adapter_activity_failed'));assert.equal(f.adapters[1].closes,0);
 await f.lifecycle.close();activities[1].reject(Error('late shutdown activity'));await flush();
 assert(!f.reports.some(x=>x.state==='adapter_activity_failed'));
});

test('a missing application keeps reporting setup failures without closing the channel or claiming revocation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probes = 0, ended = false;
  const f = fixture({ watch: callbacks => watchApplicationSetup({
    api: 'https://service.example/api/t/aaaaaaaaaaaa', token: 'tk_' + 'a'.repeat(32), ...callbacks,
    openSocket() { throw Error('upgrade rejected'); },
    fetcher: async () => { probes++; return Response.json({ error: { code: 'not_found', message: 'No such tendril' } }, { status: 404 }); },
  }) });
  f.lifecycle.done.then(() => { ended = true; });
  await flush(); t.mock.timers.tick(1000); await flush();
  const failures = f.reports.filter(x => x.setup?.state === 'application_not_found');
  assert.equal(probes, 2); assert.equal(failures.length, 2); assert.equal(ended, false);
  assert.deepEqual(failures.map(x => x.setup.retryInMs), [1000, 2000]);
  assert(failures.every(x => /Recreate the application/.test(x.setup.next)));
  assert(!f.reports.some(x => x.state === 'setup_channel_closed' || x.setup?.state === 'access_revoked'));
  assert(!JSON.stringify(f.reports).includes('Restore this retained host credential'));
  await f.lifecycle.close(); assert.equal(ended, true);
});

test('an unexpectedly closed setup channel preserves missing-application recovery guidance', async () => {
  const f = fixture();
  f.status({ state: 'application_not_found', retryInMs: 1000, next: 'Recreate the application and retain the old device storage.' });
  f.status({ state: 'closed' }); f.watchClosed(); await flush();
  const status = f.reports.find(x => x.state === 'setup_channel_closed');
  assert.equal(status.reason, 'application_not_found'); assert.match(status.next, /Recreate the application/);
  assert(!status.next.includes('credential'));
  await f.lifecycle.close();
});
