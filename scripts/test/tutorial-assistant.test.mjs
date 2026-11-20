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
    prepare:async options=>{assert.equal(options.events,events);return {options:{api:'https://staging.example/api/t/aaaaaaaaaaaa',token:'private'},review:{proposed:'a'.repeat(64),reviewUrl:'https://staging.example/review'}};},
    open:async()=>({session,close:async()=>{calls.push('owner_closed');}}),
    tools:()=>({}),
    watch({onChange}){queueMicrotask(()=>onChange({type:'setup',version:1,assistant:{proposalId:'a'.repeat(64),approved:true,revision:'consent'}}));
      return {closed:watchClosed.promise,close(){watchClosed.resolve();calls.push('watch_closed');}};},
    connect(){if(failConnect)throw Object.assign(Error('unavailable'),{code:'APPROVAL_UNAVAILABLE'});
      return {closed:closed.promise,waitUntilOnline:async()=>{calls.push('online');},close(){calls.push('adapter_closed');closed.resolve();}};},
    forward:async()=>{calls.push('events_forwarded');},report:value=>reports.push(value),
  };
  return {stop,calls,reports,closed,dependencies};
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
