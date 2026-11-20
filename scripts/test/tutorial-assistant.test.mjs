import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tutorial-assistant-'));
  for (const name of ['assistant.mjs', 'session.mjs', 'local.mjs', 'domain.mjs', 'pairing-native.mjs']) await copyFile(join(root, 'docs/tutorial', name), join(directory, name));
  await mkdir(join(directory, 'helpers'));
  await copyFile(join(root,'docs/tutorial/helpers/participant-lifecycle.mjs'),join(directory,'helpers/participant-lifecycle.mjs'));
  for (const [scope, name, source] of [['@tendriller', 'core', 'dist/sdk'], ['@chronolog', 'peer-session', 'node_modules/@chronolog/peer-session']]) {
    await mkdir(join(directory, 'node_modules', scope), { recursive: true });
    await symlink(resolve(root, source), join(directory, 'node_modules', scope, name));
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, module: await import(pathToFileURL(join(directory, 'assistant.mjs')).href) };
}

test('assistant preparation retains one private key and event permissions are opt-in', async t => {
  const { directory, module } = await fixture(t), calls = [], original = globalThis.fetch, signal = new AbortController().signal;
  await mkdir(join(directory, '.tendriller'), { mode: 0o700 });
  await writeFile(join(directory, '.tendriller/handle.json'), JSON.stringify({ api: 'https://staging.example.test/api/t/aaaaaaaaaaaa',
    token: 'test-only-token', application: { id: 'a'.repeat(64) } }), { mode: 0o600 });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), signal: options.signal });
    return Response.json({ reviewUrl: 'https://staging.example.test/connections/aaaaaaaaaaaa' });
  };
  t.after(() => { globalThis.fetch = original; });
  await module.prepareAssistant({ signal });
  const key = await readFile(join(directory, '.tendriller/assistant-key.json'), 'utf8');
  await module.prepareAssistant({ signal });
  await module.prepareAssistant({ events: true, signal });
  assert.deepEqual(calls[0].body.events, []);
  assert.deepEqual(calls[0].body.queries, ['notes']);
  assert.deepEqual(calls[0].body.commands, ['addNote']);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[2].body.events[0].name, 'note.added');
  assert.deepEqual(calls[2].body.adapterHashes, calls[0].body.adapterHashes);
  assert.equal(await readFile(join(directory, '.tendriller/assistant-key.json'), 'utf8'), key);
  assert.equal((await stat(join(directory, '.tendriller/assistant-key.json'))).mode & 0o777, 0o600);
});

test('an already cancelled assistant run cannot prepare a proposal or open an owner', async t => {
  const { module, directory } = await fixture(t), stop = new AbortController();
  const reason = Error('cancelled before setup'); stop.abort(reason);
  await assert.rejects(module.prepareAssistant({ signal: stop.signal }), error => error === reason);
  await assert.rejects(module.runAssistant({ signal: stop.signal }, { prepare: () => { throw Error('must not propose'); }, open: () => { throw Error('must not open'); } }), error => error === reason);
  await assert.rejects(readFile(join(directory, '.tendriller/assistant-key.json')), { code: 'ENOENT' });
});

const flush = () => new Promise(resolve => setImmediate(resolve));
function runtime({events=false, failConnect=false}={}) {
  const stop=new AbortController(), calls=[], reports=[], closed=Promise.withResolvers(), watchClosed=Promise.withResolvers();
  const session={applicationId:'a'.repeat(64),signal:stop.signal};
  const dependencies={
    prepare:async options=>{calls.push('prepare');assert.equal(options.events,events);return {options:{api:'https://staging.example/api/t/aaaaaaaaaaaa',token:'private'},review:{proposed:'a'.repeat(64),reviewUrl:'https://staging.example/review'}};},
    tools:()=>({}),
    watch({onChange}){calls.push('watch');queueMicrotask(()=>onChange({type:'setup',version:1,assistant:{proposalId:'a'.repeat(64),approved:true,revision:'consent'}}));
      return {closed:watchClosed.promise,close(){watchClosed.resolve();calls.push('watch_closed');}};},
    connect(){if(failConnect)throw Object.assign(Error('unavailable'),{code:'APPROVAL_UNAVAILABLE'});
      return {closed:closed.promise,waitUntilOnline:async()=>{calls.push('online');},close(){calls.push('adapter_closed');closed.resolve();}};},
    forward:async()=>{calls.push('events_forwarded');},report:value=>reports.push(value),
  };
  const watch = dependencies.watch;
  dependencies.open = async () => {calls.push('open'); return {session, processPairings:async()=>{calls.push('pairings');return [];},watchSetup:watch,close:async()=>{calls.push('owner_closed');}};};
  delete dependencies.watch;
  return {stop,calls,reports,closed,watchClosed,dependencies};
}
test('optional adapter exit preserves the owner until the process is explicitly stopped',async t=>{
  const {module}=await fixture(t),f=runtime();let ended=false;
  const run=module.runAssistant({signal:f.stop.signal},f.dependencies).then(()=>{ended=true;});
  await flush();await flush();assert(f.calls.includes('online'));f.closed.resolve();await flush();await flush();
  assert(!f.calls.includes('owner_closed'));assert.equal(ended,false);
  f.stop.abort();await run;assert.equal(f.calls.filter(x=>x==='owner_closed').length,1);
  assert(!f.calls.includes('events_forwarded'));assert(f.reports.every(x=>x.futureWakeVerified!==true));
});
test('failed optional connection reports its state while preserving the native participant',async t=>{
  const {module}=await fixture(t),f=runtime({failConnect:true});
  const run=module.runAssistant({signal:f.stop.signal},f.dependencies);await flush();await flush();
  assert(f.reports.some(x=>x.state==='adapter_offline'&&x.code==='APPROVAL_UNAVAILABLE'));
  assert(!f.calls.includes('owner_closed'));f.stop.abort();await run;assert(f.calls.includes('owner_closed'));
});
test('optional event forwarding cannot turn finite history iteration into application shutdown',async t=>{
  const {module}=await fixture(t),f=runtime({events:true});
  const run=module.runAssistant({signal:f.stop.signal,events:true},f.dependencies);await flush();await flush();
  assert(f.calls.includes('events_forwarded'));assert(!f.calls.includes('owner_closed'));
  f.stop.abort();await run;assert(f.calls.includes('owner_closed'));
});


test('native owner and setup pairing run before a stalled proposal, then use its late proposal ID', async t => {
  const {module} = await fixture(t), f = runtime(), gate = Promise.withResolvers();
  const prepare = f.dependencies.prepare;
  f.dependencies.prepare = async options => { f.calls.push('preparing'); await gate.promise; return prepare(options); };
  const run = module.runAssistant({signal:f.stop.signal}, f.dependencies);
  await flush(); await flush();
  assert.deepEqual(f.calls.slice(0, 2), ['open', 'watch']);
  assert(f.calls.includes('pairings')); assert(!f.calls.includes('online'));
  assert(f.reports.some(x => x.state === 'participant_running' && x.processLifetime.includes('Until this process')));
  gate.resolve(); await flush(); await flush();
  assert(f.calls.includes('online')); assert(!f.calls.includes('owner_closed'));
  f.stop.abort(); await run;
});

test('proposal errors leave native pairing live and abort fences late preparation completion', async t => {
  const {module} = await fixture(t), f = runtime();
  f.dependencies.prepare = async () => { throw Object.assign(Error('private diagnostic'), {code:'NETWORK_UNAVAILABLE'}); };
  const run = module.runAssistant({signal:f.stop.signal}, f.dependencies);
  await flush(); await flush();
  assert(f.calls.includes('pairings')); assert(!f.calls.includes('owner_closed'));
  assert(f.reports.some(x => x.state === 'assistant_preparation_failed' && x.code === 'NETWORK_UNAVAILABLE'));
  assert(f.reports.some(x => x.state === 'assistant_retry'));
  assert(!JSON.stringify(f.reports).includes('private diagnostic'));
  f.stop.abort(); await run;
  assert.equal(f.calls.filter(x => x === 'owner_closed').length, 1);

  const late = runtime(), gate = Promise.withResolvers();
  const prepare = late.dependencies.prepare;
  late.dependencies.prepare = async options => { await gate.promise; return prepare(options); };
  const pending = module.runAssistant({signal:late.stop.signal}, late.dependencies);
  await flush(); late.stop.abort(); await pending;
  gate.resolve(); await flush(); await flush();
  assert(!late.reports.some(x => x.state === 'proposal_prepared'));
  assert(!late.calls.includes('online'));
  assert.equal(late.calls.filter(x => x === 'owner_closed').length, 1);
});


test('canonical event recovery review preserves a healthy provider and its exact cursor without idle redials', { timeout: 10000 }, async t => {
  const { module, directory } = await fixture(t), f = runtime({ events: true }), providers = [];
  const cursor = '"retained-private-event-cursor"\n', cursorFile = join(directory, '.tendriller/assistant-event-cursor.json');
  await mkdir(join(directory, '.tendriller'), { mode: 0o700 });
  await writeFile(cursorFile, cursor, { mode: 0o600 });
  let change, forwards = 0;
  const originalOpen = f.dependencies.open;
  f.dependencies.open = async options => {
    const owned = await originalOpen(options), originalWatch = owned.watchSetup;
    // Use the actual public forwardApplicationEvents, not a throwing substitute.
    owned.session.changes = async function* () { forwards++; yield { kind: 'recovery' }; };
    owned.session.readView = () => { throw Error('Recovery must be reviewed before reading or advancing'); };
    owned.watchSetup = callbacks => { change = callbacks.onChange; return originalWatch(callbacks); };
    return owned;
  };
  delete f.dependencies.forward;
  f.dependencies.connect = ({ signal }) => {
    const done = Promise.withResolvers(), provider = { signal, done, closes: 0 };
    providers.push(provider);
    return { closed: done.promise, waitUntilOnline: async () => {}, close() { provider.closes++; done.resolve(); } };
  };
  // Await the actual forwarding outcome. Filesystem completion is independent
  // of event-loop turns when the full suite runs under CPU/I/O contention.
  const waiting = new Map(), originalReport = f.dependencies.report;
  const failureCount = () => f.reports.filter(x => x.state === 'adapter_activity_failed').length;
  f.dependencies.report = value => {
    originalReport(value);
    for (const [count, resolve] of waiting) if (failureCount() >= count) { waiting.delete(count); resolve(); }
  };
  const settled = count => failureCount() >= count ? Promise.resolve() : new Promise(resolve => waiting.set(count, resolve));
  // Install virtual time after the asynchronous filesystem fixture is prepared.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = module.runAssistant({ signal: f.stop.signal, events: true }, f.dependencies);
  t.after(async () => { f.stop.abort(); await run; });
  await settled(1);
  assert.equal(forwards, 1); assert.equal(providers.length, 1); assert.equal(providers[0].closes, 0);
  assert.equal(providers[0].signal.aborted, false); assert(!f.calls.includes('owner_closed'));
  assert.deepEqual(f.reports.filter(x=>x.state==='adapter_activity_failed'), [{ state:'adapter_activity_failed',code:'adapter_activity_failed',participantRunning:true }]);
  const pairingCalls = f.calls.filter(x=>x==='pairings').length;
  t.mock.timers.tick(48 * 3600000); await flush();
  assert.equal(providers.length, 1); assert.equal(forwards, 1);
  assert.equal(f.calls.filter(x=>x==='pairings').length, pairingCalls);
  assert(!f.reports.some(x=>['assistant_retry','adapter_offline'].includes(x.state)));
  assert.equal(await readFile(cursorFile,'utf8'), cursor);
  // An actual consent revision replaces only its component, then retries the
  // reviewed activity once with the original cursor; unchanged consent does not.
  change({type:'setup',version:1,assistant:{proposalId:'a'.repeat(64),approved:true,revision:'consent'}});
  await flush(); assert.equal(providers.length,1);
  change({type:'setup',version:1,assistant:{proposalId:'a'.repeat(64),approved:true,revision:'new-consent'}});
  await settled(2); assert.equal(providers.length,2); assert.equal(providers[0].signal.aborted,true);
  assert.equal(providers[1].closes,0); assert.equal(await readFile(cursorFile,'utf8'),cursor);
  providers[1].done.resolve(); await flush(); await flush();
  t.mock.timers.tick(1000); await settled(3);
  assert.equal(providers.length,3); assert.equal(providers[2].signal.aborted,false);
  assert.equal(forwards,3); assert.equal(await readFile(cursorFile,'utf8'),cursor);
  assert(!f.calls.includes('owner_closed'));
});
