import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, lstat, readFile, rm, chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { attachNativeSession, createNativeAttachmentKey, createNativeSessionSupervisor } from '../../session/native.mjs';
import { createCollaborationClient } from '../client.mjs';
import { operationReference } from '../protocol.mjs';
import { createViewStore } from '../local.mjs';
import { p, native, browser, definition, peerModule, openRetainedOwner, authorityForDevices } from './native-fixture.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const devicePath = join(root, 'device.sqlite'), ownerDirectory = join(root, 'owner');
  const device = await native.openNativeDevice({ path: devicePath, create: true });
  const deviceId = device.identity.publicKey;
  const { authority, key } = await authorityForDevices([device], { applicationId: '73'.repeat(32) });
  await device.close();
  let opened = 0;
  const openOwner = async () => {
    opened++;
    return openRetainedOwner({ devicePath, authority, key });
  };
  const attach = (token, options = {}) => attachNativeSession({ directory: ownerDirectory, token,
    applicationId: authority.descriptor.payload.applicationId,
    connect: browser.connectApplicationOwner, timeoutMs: 1500, ...options });
  return { root, ownerDirectory, devicePath, deviceId, authority, key, openOwner, attach, opened: () => opened };
}

test('publication-only supervisor capability composes with Chronolog and bounds concurrent control calls', async t => {
  const f = await fixture(t), token = createNativeAttachmentKey();
  let release, receivedAssets;
  const supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main',
    bindings: [{ id: 'publisher', token, policy: { capabilities: ['publish', 'queries'], maxRequests: 1 } }],
    openOwner: async () => Object.assign(await f.openOwner(), { control: {
      definition: () => new Promise(resolve => { release = resolve; }),
      publication: async () => null,
      publish: async (publication, assets) => { receivedAssets = assets; return { publication }; },
    } }),
  });
  t.after(() => supervisor.close());
  const attached = await f.attach(token);
  t.after(() => attached.detach());
  assert.equal((await attached.session.query('notes', null)).value.length, 0);
  const first = attached.control.definition();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(attached.control.publication(), { code: 'APPLICATION_ATTACHMENT_REQUEST_LIMIT' });
  release({ id: 'definition' });
  assert.deepEqual(await first, { id: 'definition' });
  assert.equal(await attached.control.publication(), null);
  const assets = [{ hash: 'a'.repeat(64), bytes: 'eA=='.repeat(300_000) }];
  assert.deepEqual(await attached.control.publish({ id: 'publication' }, assets), { publication: { id: 'publication' } });
  assert.deepEqual(receivedAssets, assets, 'large attached publication keeps exact staged bytes');
  const observer = await supervisor.createBinding({ id: 'observer', policy: { capabilities: ['queries'] } });
  const observed = await f.attach(observer.token);
  t.after(() => observed.detach());
  await assert.rejects(observed.control.publication(), { code: 'APPLICATION_ATTACHMENT_CAPABILITY_REQUIRED' });
});

test('two authenticated native clients share one signer, isolate identical local operation IDs, detach and reopen', async t => {
  const f = await fixture(t), firstKey = createNativeAttachmentKey(), secondKey = createNativeAttachmentKey();
  let supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner,
    bindings: [{ id: 'reviewer', token: firstKey }, { id: 'planner', token: secondKey }] });
  t.after(() => supervisor.close());
  assert.equal((await lstat(f.ownerDirectory)).mode & 0o777, 0o700);
  assert.equal((await lstat(supervisor.socketPath)).mode & 0o777, 0o600);
  await assert.rejects(createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner }),
    error => error.code === 'OWNER_BUSY');
  assert.equal(f.opened(), 1, 'the profile fence precedes signer/store opening');
  const [first, second] = await Promise.all([f.attach(firstKey), f.attach(secondKey)]);
  t.after(() => Promise.allSettled([first.detach(), second.detach()]));
  assert.equal(first.session.identity.publicKey, f.deviceId); assert.equal(second.session.identity.publicKey, f.deviceId);
  assert.equal(first.session.endpoint.ownerInstanceId, second.session.endpoint.ownerInstanceId);
  assert.notEqual(first.session.endpoint.endpointId, second.session.endpoint.endpointId);
  assert.equal(first.session.endpoint.identity.agentBindingId, 'reviewer');
  const [left, right] = await Promise.all([
    first.session.command('add', 'reviewed', { operationId: 'same-local-id' }),
    second.session.command('add', 'planned', { operationId: 'same-local-id' }),
  ]);
  await Promise.all([left.materialized(), right.materialized()]);
  const [a, b] = await Promise.all([left.inspect(), right.inspect()]);
  assert.notEqual(a.operationId, b.operationId); assert.equal(a.materialized.outcome, 'accepted'); assert.equal(b.materialized.outcome, 'accepted');
  const typed = (await first.session.query('types', null)).value;
  assert.equal(typed.integer, 9223372036854775807n); assert.deepEqual(typed.bytes, new Uint8Array([0, 127, 255]));
  const cancellation = new AbortController();
  const stream = first.session.signals.subscribe({ topics: ['wait-for-live-progress'], signal: cancellation.signal });
  const pending = stream[Symbol.asyncIterator]().next();
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = Error('stop this waiter'); cancellation.abort(cancelled);
  await assert.rejects(pending, error => error === cancelled);
  assert.equal(first.session.signal.aborted, false, 'canceling one stream never detaches the owner attachment');
  assert.equal((await second.session.query('notes', null)).value.length, 2);
  await first.detach();
  assert.equal((await (await second.session.operations.get('same-local-id')).inspect()).proposalId, b.proposalId);
  await second.detach(); await supervisor.close();
  supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner });
  const returning = await f.attach(firstKey); t.after(() => returning.detach());
  assert.equal(returning.session.identity.publicKey, f.deviceId);
  assert.equal((await (await returning.session.operations.get('same-local-id')).inspect()).proposalId, a.proposalId);
  assert.equal((await returning.session.query('notes', null)).value.length, 2);
});

test('native collaboration full references survive a lost response, reconnect and binding rotation', {timeout:20_000}, async t => {
  const f=await fixture(t),token=createNativeAttachmentKey(),otherToken=createNativeAttachmentKey();
  const supervisor=await createNativeSessionSupervisor({directory:f.ownerDirectory,profileId:'retained-main',openOwner:f.openOwner,
    bindings:[{id:'reviewer',token},{id:'planner',token:otherToken}]});
  t.after(()=>supervisor.close());
  const first=await f.attach(token),other=await f.attach(otherToken);
  t.after(()=>Promise.allSettled([first.detach(),other.detach()]));
  const data=new Map(),storage={get length(){return data.size;},key:index=>[...data.keys()][index]??null,
    getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
  const store=createViewStore({storage,applicationId:first.session.applicationId,profileId:'retained-main',viewId:'first'});
  const client=createCollaborationClient({session:first.session,store});
  const before=operationReference(first.session,'same-local-id'),foreign=operationReference(other.session,'same-local-id');
  assert.notEqual(before.operationId,foreign.operationId);
  assert.equal(first.session.scopeOperationId(before.operationId),before.operationId);
  assert.equal(Object.getOwnPropertyDescriptor(first.session,'scopeOperationId').writable,false);
  const command=first.session.command.bind(first.session);let saved,uncertain;
  first.session.command=async(...args)=>{const operation=await command(...args);await operation.materialized();saved=await operation.inspect();
    throw Object.assign(Error('saved response lost'),{code:'TIMEOUT'});};
  await assert.rejects(client.request({kind:'review',title:'Native attached request',input:{proposal:1},
    target:{kind:'signer',deviceId:f.deviceId},slots:[{slotId:'review',eligibleSigners:[f.deviceId]}]},
  {operationId:'same-local-id'}),error=>{uncertain=error;return error.code==='TIMEOUT';});
  first.session.command=command;
  assert.deepEqual(uncertain.operationReference,before);assert.equal(before.operationId,saved.operationId);
  assert.equal(uncertain.operationIdentities.localOperationId,'same-local-id');
  assert.equal(store.pending().length,0,'An uncertain reply cannot invent a signed proposal ID');
  assert.deepEqual(store.readDraft(`submission:${before.operationId}`),uncertain.operationSubmission);
  const inspected=await client.inspectOperation(before);
  const full=operationReference(first.session,before.operationId,inspected);
  assert.equal(full.proposalId,saved.proposalId);assert.equal(full.applicationId,first.session.applicationId);
  store.retainOperation(full,uncertain.operationSubmission);assert.equal(store.pending().length,1);
  assert.equal(inspected.author,f.deviceId);
  await assert.rejects(createCollaborationClient({session:other.session}).retry(full),{code:'OPERATION_BINDING_MISMATCH'});
  assert.equal(other.session.signal.aborted,false,'A denied operation does not disconnect the authenticated sibling');
  await assert.rejects(other.session.operations.get(full.proposalId),{code:'OPERATION_BINDING_MISMATCH'});
  assert.equal((await other.session.query('requests',null)).value.length,1);
  const rotated=await supervisor.rotateBinding('reviewer');await assert.rejects(f.attach(token));
  const resumed=await f.attach(rotated.token);t.after(()=>resumed.detach());
  assert.equal(resumed.session.scopeOperationId('same-local-id'),before.operationId);
  const returning=createCollaborationClient({session:resumed.session});
  await returning.retry(full);
  assert.equal((await returning.inspectOperation(full)).proposalId,saved.proposalId);
  const requests=(await resumed.session.query('requests',null)).value;
  assert.equal(requests.length,1);assert.equal(requests[0].interactionId,uncertain.operationIdentities.interactionId);
  assert.equal(f.opened(),1);
});

const nativeModule = new URL('../../session/native.mjs', import.meta.url).href;
function child(t, source, data) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], {
    env: { ...globalThis.process.env, TENDRILLER_NATIVE_TEST: p.bytesToHex(p.encodeRecord(data)) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  let output = '', error = '';
  process.stdout.on('data', chunk => { output += chunk; });
  process.stderr.on('data', chunk => { error = (error + chunk).slice(-8192); });
  const closed = once(process, 'close').then(([code, signal]) => ({ code, signal, output, error }));
  return { process, closed, ready: async () => {
    if (!output.includes('\n')) await Promise.race([
      new Promise(resolve => process.stdout.once('data', resolve)),
      closed.then(result => { throw Error(`Child owner exited before ready: ${result.error}`); }),
    ]);
    return JSON.parse(output.trim().split('\n')[0]);
  } };
}

test('two actual terminal processes attach without reopening storage and retain independent operation namespaces', { timeout: 20_000 }, async t => {
  const f = await fixture(t), firstKey = createNativeAttachmentKey(), secondKey = createNativeAttachmentKey();
  const supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner,
    bindings: [{ id: 'terminal-one', token: firstKey }, { id: 'terminal-two', token: secondKey }] });
  t.after(() => supervisor.close());
  const bootstrap = join(f.root, 'attachment.mjs');
  await writeFile(bootstrap, `import {attachNativeSession} from ${JSON.stringify(nativeModule)};
import {connectApplicationOwner} from ${JSON.stringify(peerModule('browser'))};
export function openSession(){throw Error('A terminal must not reopen the signer');}
export function attachSession({signal,context}){return attachNativeSession({directory:${JSON.stringify(f.ownerDirectory)},
token:process.env.TENDRILLER_NATIVE_ATTACHMENT_KEY,connect:connectApplicationOwner,signal,context,
applicationId:${JSON.stringify(f.authority.descriptor.payload.applicationId)}});}`);
  const cli = fileURLToPath(new URL('../../tools/cli/bin/tendril.mjs', import.meta.url));
  const run = (token, text) => {
    const process = spawn(globalThis.process.execPath, [cli, '--session', bootstrap, '--mode', 'attach', '--profile', 'retained-main',
      '--run', text, 'command', 'add', JSON.stringify(text), '--operation', 'same-terminal-id'], {
      env: { ...globalThis.process.env, TENDRILLER_NATIVE_ATTACHMENT_KEY: token }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
    let output = '', error = '';
    process.stdout.on('data', chunk => { output += chunk; }); process.stderr.on('data', chunk => { error += chunk; });
    return once(process, 'close').then(([code]) => { assert.equal(code, 0, error); return JSON.parse(output); });
  };
  const [one, two] = await Promise.all([run(firstKey, 'first terminal'), run(secondKey, 'second terminal')]);
  assert.equal(one.stored, true); assert.equal(two.stored, true);
  assert.notEqual(one.operationId, two.operationId); assert.equal(f.opened(), 1);
  const surviving = await f.attach(firstKey); t.after(() => surviving.detach());
  assert.equal((await surviving.session.query('notes', null)).value.length, 2);
});

test('process crash releases the fence and a successor resumes the same signer and exact stored authored proposal', { timeout: 20_000 }, async t => {
  const f = await fixture(t), token = createNativeAttachmentKey();
  const script = `import {createNativeSessionSupervisor} from ${JSON.stringify(nativeModule)};
import {p,openRetainedOwner} from ${JSON.stringify(new URL('./native-fixture.mjs', import.meta.url).href)};
const data=p.decodeRecord(p.hexToBytes(process.env.TENDRILLER_NATIVE_TEST));
const supervisor=await createNativeSessionSupervisor({directory:data.ownerDirectory,profileId:'retained-main',
openOwner:()=>openRetainedOwner(data),bindings:[{id:'retained-agent',token:data.token}]});
process.stdout.write(JSON.stringify({deviceId:supervisor.profile.publicKey,ownerInstanceId:supervisor.ownerInstanceId})+'\\n');`;
  const old = child(t, script, { ownerDirectory: f.ownerDirectory, devicePath: f.devicePath, authority: f.authority, key: [...f.key], token });
  const previous = await old.ready();
  assert.equal(previous.deviceId, f.deviceId);
  await assert.rejects(createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner }),
    error => error.code === 'OWNER_BUSY');
  assert.equal(f.opened(), 0);
  const first = await f.attach(token); t.after(() => first.detach().catch(() => {}));
  const operation = await first.session.command('add', 'before process loss', { operationId: 'retained-across-crash' });
  await operation.materialized();
  const accepted = await operation.inspect();
  old.process.kill('SIGKILL'); assert.equal((await old.closed).signal, 'SIGKILL');
  const supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner });
  t.after(() => supervisor.close());
  assert.equal(supervisor.profile.publicKey, previous.deviceId); assert.notEqual(supervisor.ownerInstanceId, previous.ownerInstanceId);
  const returning = await f.attach(token); t.after(() => returning.detach());
  const original = await (await returning.session.operations.get('retained-across-crash')).inspect();
  assert.equal(original.proposalId, accepted.proposalId);
  await returning.session.operations.retry('retained-across-crash');
  assert.equal((await returning.session.query('notes', null)).value.length, 1);
});

test('revocation and key rotation persist independently; malformed clients do not stop healthy clients', {timeout:15_000}, async t => {
  const f = await fixture(t);
  let supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner });
  t.after(() => supervisor.close());
  const observer = await supervisor.createBinding({ id: 'observer', policy: { capabilities: ['queries'], queries: ['notes'] } });
  const writer = await supervisor.createBinding({ id: 'writer' });
  const observed = await f.attach(observer.token), writing = await f.attach(writer.token);
  t.after(() => Promise.allSettled([observed.detach(), writing.detach()]));
  await assert.rejects(observed.session.command('add', 'forbidden', { operationId: 'denied' }), /ENDPOINT_CAPABILITY_FORBIDDEN/);
  await assert.rejects(f.attach(createNativeAttachmentKey()),{code:'SUPERVISOR_BINDING_REVOKED'});
  const malformed = createConnection(supervisor.socketPath); await once(malformed, 'connect');
  // Consume the bounded terminal error so this deliberately raw client observes
  // EOF; an unread Node stream can retain data after the server has closed.
  malformed.resume();
  malformed.write(Buffer.from([0x7f, 0xff, 0xff, 0xff])); await once(malformed, 'close');
  assert.equal((await writing.session.query('notes', null)).value.length, 0);
  const rotated = await supervisor.rotateBinding('writer');
  await assert.rejects(f.attach(writer.token));
  const replacement = await f.attach(rotated.token); t.after(() => replacement.detach());
  assert.equal(replacement.session.endpoint.identity.agentBindingId, 'writer');
  await supervisor.revokeBinding('observer');
  await assert.rejects(f.attach(observer.token));
  const accepted = await replacement.session.command('add', 'retained after revocation', { operationId: 'retained' });
  assert.equal((await accepted.materialized()).outcome, 'accepted');
  const persisted = await readFile(join(f.ownerDirectory, 'bindings.json'), 'utf8');
  assert.ok(!persisted.includes(rotated.token)); assert.ok(!persisted.includes(observer.token));
  await replacement.detach(); await supervisor.close();
  supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner });
  await assert.rejects(f.attach(observer.token));
  const resumed = await f.attach(rotated.token); t.after(() => resumed.detach());
  assert.equal((await (await resumed.session.operations.get('retained')).inspect()).materialized.outcome, 'accepted');
});

test('private directory and immutable profile identity are enforced before exposing a socket', async t => {
  const f = await fixture(t); await mkdir(f.ownerDirectory); await chmod(f.ownerDirectory, 0o755);
  await assert.rejects(createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner }),
    error => error.code === 'SUPERVISOR_PRIVATE_PATH_REQUIRED');
  assert.equal(f.opened(), 0);
  await chmod(f.ownerDirectory, 0o700);
  await writeFile(join(f.ownerDirectory, 'profile.json'), JSON.stringify({ version: 1, profileId: 'retained-main', applicationId: f.authority.descriptor.payload.applicationId, publicKey: 'ab'.repeat(32) }), { mode: 0o600 });
  await assert.rejects(createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner }),
    error => error.code === 'SUPERVISOR_PROFILE_CHANGED');
});

test('CLI watch reports a crashed owner and snapshot cursors cannot silently cross a revised projection', { timeout: 20_000 }, async t => {
  const f = await fixture(t), token = createNativeAttachmentKey();
  const source = `import {createNativeSessionSupervisor} from ${JSON.stringify(nativeModule)};
import {p,openRetainedOwner} from ${JSON.stringify(new URL('./native-fixture.mjs', import.meta.url).href)};
const data=p.decodeRecord(p.hexToBytes(process.env.TENDRILLER_NATIVE_TEST));
const supervisor=await createNativeSessionSupervisor({directory:data.ownerDirectory,profileId:'retained-main',
openOwner:()=>openRetainedOwner(data),bindings:[{id:'listener',token:data.token}]});
console.log(JSON.stringify({ready:true}));`;
  const owner = child(t, source, { ownerDirectory: f.ownerDirectory, devicePath: f.devicePath, authority: f.authority, key: [...f.key], token });
  await owner.ready();
  const writer = await f.attach(token); t.after(() => writer.detach());
  await (await writer.session.command('add', 'before crash', { operationId: 'before-crash' })).materialized();
  const bootstrap = join(f.root, 'watch-attachment.mjs');
  await writeFile(bootstrap, `import {attachNativeSession} from ${JSON.stringify(nativeModule)};
import {connectApplicationOwner} from ${JSON.stringify(peerModule('browser'))};
export function openSession(){throw Error('WATCH_MUST_NOT_OPEN_ANOTHER_SIGNER');}
export function attachSession({signal}){return attachNativeSession({directory:${JSON.stringify(f.ownerDirectory)},
token:process.env.TENDRILLER_NATIVE_ATTACHMENT_KEY,connect:connectApplicationOwner,signal,
applicationId:${JSON.stringify(f.authority.descriptor.payload.applicationId)}});}`);
  const cli = process.env.TENDRILLER_TOOLS_TEST_CLI ?? fileURLToPath(new URL('../../tools/cli/bin/tendril.mjs', import.meta.url));
  const invoke = args => {
    const process = spawn(globalThis.process.execPath, [cli, '--session', bootstrap, '--mode', 'attach', ...args], {
      env: { ...globalThis.process.env, TENDRILLER_NATIVE_ATTACHMENT_KEY: token }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    process.stdout.on('data', bytes => { stdout += bytes; }); process.stderr.on('data', bytes => { stderr += bytes; });
    const closed = once(process, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
    return { process, closed, async ready() {
      while (!stdout.includes('\n')) await Promise.race([
        once(process.stdout, 'data'),
        closed.then(result => { throw Error('Watch exited before first item: ' + result.stderr); }),
      ]);
      return JSON.parse(stdout.split('\n')[0]);
    } };
  };
  const changes = invoke(['watch']), events = invoke(['watch', '--events', '--topics', '["note"]', '--limit', '1']);
  const [firstChange, firstBatch] = await Promise.all([changes.ready(), events.ready()]);
  assert.equal(firstChange.kind, 'status');
  assert.equal(firstChange.status.canAuthor, true);
  assert.deepEqual(firstBatch.events.map(event => event.payload), [{ text: 'before crash' }]);
  owner.process.kill('SIGKILL'); assert.equal((await owner.closed).signal, 'SIGKILL');
  for (const [mode, invocation] of [['changes', changes], ['events', events]]) {
    const result = await invocation.closed;
    assert.equal(result.code, 1, result.stderr); assert.equal(result.signal, null);
    const failure = result.stderr.split('\n').filter(line => line.startsWith('{')).map(JSON.parse).at(-1);
    assert(['OWNER_UNREACHABLE', 'ECONNRESET'].includes(failure.error.code), result.stderr);
    assert.match(failure.error.message, /Owner connection lost/);
    assert.equal(failure.watch.mode, mode);
    assert.equal(failure.watch.cursor, mode === 'events' ? firstBatch.cursor : null);
    assert.doesNotMatch(JSON.stringify(failure), /before crash/);
  }
  const missing = await invoke(['watch']).closed;
  assert.equal(missing.code, 1, 'a missing owner fails instead of retrying indefinitely');
  const supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner });
  t.after(() => supervisor.close());
  const resumed = await f.attach(token); t.after(() => resumed.detach());
  await (await resumed.session.command('add', 'after crash', { operationId: 'after-crash' })).materialized();
  const replay = await invoke(['events', '--cursor', firstBatch.cursor, '--topics', '["note"]']).closed;
  assert.equal(replay.code, 1, replay.stderr);
  assert.match(replay.stderr, /CURSOR/);
  const fresh = await invoke(['events', '--topics', '["note"]']).closed;
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.deepEqual(JSON.parse(fresh.stdout).events.map(event => event.payload.text), ['before crash', 'after crash']);
});
