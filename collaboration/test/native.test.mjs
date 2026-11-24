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
import { createNativeFrames } from '../../session/native-transport.mjs';
import { operationReference } from '../protocol.mjs';
import { createViewStore } from '../local.mjs';
import { p, native, browser, definition, peerModule, openRetainedOwner } from './native-fixture.mjs';

async function fixture(t, { publisher = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const devicePath = join(root, 'device.sqlite'), ownerDirectory = join(root, 'owner');
  const device = await native.openNativeDevice({ path: devicePath, create: true }), host = await p.createPeerIdentity();
  const deviceId = device.identity.publicKey, key = crypto.getRandomValues(new Uint8Array(32));
  const execution = await p.executionManifestArtifacts(await p.eventExecutionManifest());
  const descriptor = await p.signApplicationDescriptor({ applicationId: '73'.repeat(32), historyId: 'native-owner-test',
    profile: 'peer-generation-v1', policy: 'eligible-members-v1', controlPublicKey: host.publicKey, schemaAdministrator: deviceId,
    executionManifestDigest: p.bytesToHex(execution.executionManifestDigest), definitionDigest: await p.applicationDefinitionDigest(definition), schemaDigest: null }, host);
  const control = await p.signControlRevision({ applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile,
    policy: descriptor.payload.policy, revision: 0, previous: null, epoch: 0, keyDigest: await p.bytesDigest(key), recoveryFloor: null,
    grants: [p.participantGrant(deviceId, { administrator: true, publisher })] }, host);
  const registry = await p.createGenerationRegistry({ store: new p.MemoryBytesStore(), descriptor, controls: [control], signer: host });
  await registry.select(await p.signTransitionRequest({ applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile,
    policy: descriptor.payload.policy, transitionId: 'initial', expectedGeneration: null, requester: deviceId, coordinator: deviceId,
    controlRevision: 0, reason: 'create', base: null }, device.identity));
  const authority = await registry.read(); await device.close();
  let opened = 0;
  const openOwner = async () => {
    opened++;
    return openRetainedOwner({ devicePath, authority, key });
  };
  const attach = (token, options = {}) => attachNativeSession({ directory: ownerDirectory, token,
    applicationId: descriptor.payload.applicationId, definitionId: definition.id, definitionVersion: definition.version,
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
      preparePublication: async input => ({ id: 'publication', payload: { operationId: input.operationId } }),
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
  const assets = [{ hash: 'a'.repeat(64), bytes: Buffer.alloc(900_000, 'x').toString('base64') }];
  const publication = await attached.control.preparePublication({ operationId: 'release' });
  assert.deepEqual(await attached.control.publish(publication, assets), { publication });
  assert.deepEqual(receivedAssets, assets, 'large attached publication keeps exact staged bytes');
  const observer = await supervisor.createBinding({ id: 'observer', policy: { capabilities: ['queries'] } });
  const observed = await f.attach(observer.token);
  t.after(() => observed.detach());
  await assert.rejects(observed.control.publication(), { code: 'APPLICATION_ATTACHMENT_CAPABILITY_REQUIRED' });
  const defaultBinding = await supervisor.createBinding({ id: 'default' });
  const defaultClient = await f.attach(defaultBinding.token);
  t.after(() => defaultClient.detach());
  await assert.rejects(defaultClient.control.publication(), { code: 'APPLICATION_ATTACHMENT_CAPABILITY_REQUIRED' });
  assert.equal((await defaultClient.session.query('notes', null)).value.length, 0);
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
  assert.equal(first.session.deviceId, f.deviceId); assert.equal(second.session.deviceId, f.deviceId);
  assert.equal(first.session.endpoint.ownerInstanceId, second.session.endpoint.ownerInstanceId);
  assert.notEqual(first.session.endpoint.endpointId, second.session.endpoint.endpointId);
  assert.equal(first.session.endpoint.identity.agentBindingId, 'reviewer');
  const [left, right] = await Promise.all([
    first.session.command('add', 'reviewed', { operationId: 'same-local-id' }),
    second.session.command('add', 'planned', { operationId: 'same-local-id' }),
  ]);
  const [a, b] = await Promise.all([left.applied(), right.applied()]);
  assert.notEqual(a.operationId, b.operationId); assert.equal(a.outcome, 'accepted'); assert.equal(b.outcome, 'accepted');
  const typed = (await first.session.query('types', null)).value;
  assert.equal(typed.integer, 9223372036854775807n); assert.deepEqual(typed.bytes, new Uint8Array([0, 127, 255]));
  const cancellation = new AbortController();
  const stream = first.session.signals.subscribe({ topics: ['wait-for-live-progress'], signal: cancellation.signal });
  const pending = stream[Symbol.asyncIterator]().next();
  await new Promise(resolve => setImmediate(resolve));
  cancellation.abort(Error('stop this waiter'));
  assert.equal((await pending).done, true, 'cancellation closes this live subscription normally');
  assert.equal((await second.session.query('notes', null)).value.length, 2);
  await first.detach();
  assert.equal((await second.session.operations.inspect('same-local-id')).state.attemptId, b.attemptId);
  await second.detach(); await supervisor.close();
  supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner });
  const returning = await f.attach(firstKey); t.after(() => returning.detach());
  assert.equal(returning.session.deviceId, f.deviceId);
  assert.equal((await returning.session.operations.inspect('same-local-id')).state.attemptId, a.attemptId);
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
  const store=createViewStore({storage,applicationId:first.session.applicationId,historyId:first.session.historyId,profileId:'retained-main',viewId:'first'});
  const client=createCollaborationClient({session:first.session,store});
  const before=operationReference(first.session,'same-local-id'),foreign=operationReference(other.session,'same-local-id');
  assert.notEqual(before.operationId,foreign.operationId);
  assert.equal(first.session.scopeOperationId(before.operationId),before.operationId);
  assert.equal(Object.getOwnPropertyDescriptor(first.session,'scopeOperationId').writable,false);
  const command=first.session.command.bind(first.session);let applied,uncertain;
  first.session.command=async(...args)=>{const operation=await command(...args);applied=await operation.applied();
    throw Object.assign(Error('saved response lost'),{code:'TIMEOUT'});};
  await assert.rejects(client.request({kind:'review',title:'Native attached request',input:{proposal:1},
    target:{kind:'signer',deviceId:f.deviceId},slots:[{slotId:'review',eligibleSigners:[f.deviceId]}]},
  {operationId:'same-local-id'}),error=>{uncertain=error;return error.code==='TIMEOUT';});
  first.session.command=command;
  assert.deepEqual(uncertain.operationReference,before);assert.equal(before.operationId,applied.operationId);
  assert.equal(uncertain.operationIdentities.localOperationId,'same-local-id');
  assert.equal(store.pending().length,1);assert.equal(store.pending()[0].reference.operationId,applied.operationId);
  const inspected=await client.inspectOperation(before);
  const full=operationReference(first.session,before.operationId,inspected.state);
  assert.equal(full.attemptId,applied.attemptId);assert.equal(full.historyId,first.session.historyId);
  assert.equal(inspected.attempt.payload.header.author,f.deviceId);
  await assert.rejects(createCollaborationClient({session:other.session}).retry(full),{code:'OPERATION_BINDING_MISMATCH'});
  assert.equal(other.session.signal.aborted,false,'A denied operation does not disconnect the authenticated sibling');
  await assert.rejects(other.session.operations.inspect(full.operationId),{code:'OPERATION_BINDING_MISMATCH'});
  assert.equal((await other.session.query('requests',null)).value.length,1);
  const rotated=await supervisor.rotateBinding('reviewer');await assert.rejects(f.attach(token));
  const resumed=await f.attach(rotated.token);t.after(()=>resumed.detach());
  assert.equal(resumed.session.scopeOperationId('same-local-id'),before.operationId);
  const returning=createCollaborationClient({session:resumed.session});
  await returning.retry(full);
  assert.equal((await returning.inspectOperation(full)).attempt.id,applied.attemptId);
  const requests=(await resumed.session.query('requests',null)).value;
  assert.equal(requests.length,1);assert.equal(requests[0].interactionId,uncertain.operationIdentities.interactionId);
  assert.equal(f.opened(),1);
});

const nativeModule = new URL('../../session/native.mjs', import.meta.url).href;
function child(t, source, data) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], {
    env: { ...globalThis.process.env, TENDRILLER_NATIVE_TEST: JSON.stringify(data) }, stdio: ['ignore', 'pipe', 'pipe'],
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
applicationId:${JSON.stringify(f.authority.descriptor.payload.applicationId)},definitionId:${JSON.stringify(definition.id)},definitionVersion:${JSON.stringify(definition.version)}});}`);
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
  assert.equal(one.outcome, 'accepted'); assert.equal(two.outcome, 'accepted');
  assert.notEqual(one.operationId, two.operationId); assert.equal(f.opened(), 1);
  const surviving = await f.attach(firstKey); t.after(() => surviving.detach());
  assert.equal((await surviving.session.query('notes', null)).value.length, 2);
});

test('process crash releases the fence and a successor resumes the same signer and exact saved attempt', { timeout: 20_000 }, async t => {
  const f = await fixture(t), token = createNativeAttachmentKey();
  const script = `import {createNativeSessionSupervisor} from ${JSON.stringify(nativeModule)};
import {openRetainedOwner} from ${JSON.stringify(new URL('./native-fixture.mjs', import.meta.url).href)};
const data=JSON.parse(process.env.TENDRILLER_NATIVE_TEST);
const supervisor=await createNativeSessionSupervisor({directory:data.ownerDirectory,profileId:'retained-main',
openOwner:()=>openRetainedOwner(data),bindings:[{id:'retained-agent',token:data.token}]});
process.stdout.write(JSON.stringify({deviceId:supervisor.profile.deviceId,ownerInstanceId:supervisor.ownerInstanceId})+'\\n');`;
  const old = child(t, script, { ownerDirectory: f.ownerDirectory, devicePath: f.devicePath, authority: f.authority, key: [...f.key], token });
  const previous = await old.ready();
  assert.equal(previous.deviceId, f.deviceId);
  await assert.rejects(createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner }),
    error => error.code === 'OWNER_BUSY');
  assert.equal(f.opened(), 0);
  const first = await f.attach(token); t.after(() => first.detach().catch(() => {}));
  const operation = await first.session.command('add', 'before process loss', { operationId: 'retained-across-crash' });
  const accepted = await operation.applied();
  old.process.kill('SIGKILL'); assert.equal((await old.closed).signal, 'SIGKILL');
  const supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner });
  t.after(() => supervisor.close());
  assert.equal(supervisor.profile.deviceId, previous.deviceId); assert.notEqual(supervisor.ownerInstanceId, previous.ownerInstanceId);
  const returning = await f.attach(token); t.after(() => returning.detach());
  const original = await returning.session.operations.inspect('retained-across-crash');
  assert.equal(original.state.attemptId, accepted.attemptId);
  await returning.session.retry('retained-across-crash');
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
  await assert.rejects(observed.session.command('add', 'forbidden', { operationId: 'denied' }), /APPLICATION_ATTACHMENT_FORBIDDEN/);
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
  assert.equal((await accepted.applied()).outcome, 'accepted');
  const persisted = await readFile(join(f.ownerDirectory, 'bindings.json'), 'utf8');
  assert.ok(!persisted.includes(rotated.token)); assert.ok(!persisted.includes(observer.token));
  await replacement.detach(); await supervisor.close();
  supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner });
  await assert.rejects(f.attach(observer.token));
  const resumed = await f.attach(rotated.token); t.after(() => resumed.detach());
  assert.equal((await resumed.session.operations.inspect('retained')).state.outcome, 'accepted');
});

test('private directory and immutable profile identity are enforced before exposing a socket', async t => {
  const f = await fixture(t); await mkdir(f.ownerDirectory); await chmod(f.ownerDirectory, 0o755);
  await assert.rejects(createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner }),
    error => error.code === 'SUPERVISOR_PRIVATE_PATH_REQUIRED');
  assert.equal(f.opened(), 0);
  await chmod(f.ownerDirectory, 0o700);
  await writeFile(join(f.ownerDirectory, 'profile.json'), JSON.stringify({ version: 1, deviceId: 'other' }), { mode: 0o600 });
  await assert.rejects(createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main', openOwner: f.openOwner }),
    error => error.code === 'SUPERVISOR_PROFILE_CHANGED');
});

test('CLI watch reports a crashed owner and its event cursor resumes the retained history', { timeout: 20_000 }, async t => {
  const f = await fixture(t), token = createNativeAttachmentKey();
  const source = `import {createNativeSessionSupervisor} from ${JSON.stringify(nativeModule)};
import {openRetainedOwner} from ${JSON.stringify(new URL('./native-fixture.mjs', import.meta.url).href)};
const data=JSON.parse(process.env.TENDRILLER_NATIVE_TEST);
const supervisor=await createNativeSessionSupervisor({directory:data.ownerDirectory,profileId:'retained-main',
openOwner:()=>openRetainedOwner(data),bindings:[{id:'listener',token:data.token}]});
console.log(JSON.stringify({ready:true}));`;
  const owner = child(t, source, { ownerDirectory: f.ownerDirectory, devicePath: f.devicePath, authority: f.authority, key: [...f.key], token });
  await owner.ready();
  const writer = await f.attach(token); t.after(() => writer.detach());
  await (await writer.session.command('add', 'before crash', { operationId: 'before-crash' })).applied();
  const bootstrap = join(f.root, 'watch-attachment.mjs');
  await writeFile(bootstrap, `import {attachNativeSession} from ${JSON.stringify(nativeModule)};
import {connectApplicationOwner} from ${JSON.stringify(peerModule('browser'))};
export function openSession(){throw Error('WATCH_MUST_NOT_OPEN_ANOTHER_SIGNER');}
export function attachSession({signal}){return attachNativeSession({directory:${JSON.stringify(f.ownerDirectory)},
token:process.env.TENDRILLER_NATIVE_ATTACHMENT_KEY,connect:connectApplicationOwner,signal,
applicationId:${JSON.stringify(f.authority.descriptor.payload.applicationId)},definitionId:${JSON.stringify(definition.id)},
definitionVersion:${JSON.stringify(definition.version)}});}`);
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
  assert.equal(firstChange.kind, 'applied');
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
  await (await resumed.session.command('add', 'after crash', { operationId: 'after-crash' })).applied();
  const replay = await invoke(['events', '--cursor', firstBatch.cursor, '--topics', '["note"]']).closed;
  assert.equal(replay.code, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout).events.map(event => event.payload), [{ text: 'after crash' }]);
});


test('attached publication retains one signed intent through a lost reply, reconnect and binding rotation', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { publisher: true });
  const publications = await p.createPublicationRegistry({ store: new p.MemoryBytesStore(), authority: async () => f.authority });
  let loseReply = true;
  const exchange = async request => {
    let result;
    if (request.facet === 'control' && request.action === 'read') result = f.authority;
    else if (request.facet === 'publication' && request.action === 'read') {
      const records = await publications.read(), id = request.payload.id;
      const publication = id === undefined ? records.at(-1) : records.find(value => value.id === id);
      result = publication ? { publication, version: publication.payload.revision + 1 } : null;
    } else if (request.facet === 'publication' && request.action === 'publish') {
      const publication = await publications.publish(request.payload.publication);
      if (loseReply) { loseReply = false; throw Error('LOST_PUBLICATION_REPLY'); }
      result = { publication, version: publication.payload.revision + 1 };
    } else throw Error('UNEXPECTED_HOST_REQUEST');
    return p.createParticipantResponse(request, result);
  };
  const supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main',
    openOwner: async () => {
      const owner = await f.openOwner();
      return Object.assign(owner, { control: owner.session.connectControlParticipant({ exchange }) });
    },
  });
  t.after(() => supervisor.close());
  const publisher = await supervisor.createBinding({ id: 'publisher', policy: { capabilities: ['publish'] } });
  const sibling = await supervisor.createBinding({ id: 'sibling', policy: { capabilities: ['publish', 'queries', 'commands', 'operations'] } });
  const first = await f.attach(publisher.token), other = await f.attach(sibling.token);
  t.after(() => Promise.allSettled([first.detach(), other.detach()]));
  const bytes = Buffer.from('<main>Live release</main>'), hash = await p.bytesDigest(bytes);
  const input = { operationId: 'release-one', entry: 'index.html', files: [{ path: 'index.html', hash, size: bytes.length, type: 'text/html' }] };
  const publication = await first.control.preparePublication(input);
  assert.match(publication.payload.operationId, /^nativepub_[a-f0-9]{32}_[a-f0-9]{64}$/u);
  assert.equal(publication.payload.author, f.deviceId);
  await assert.rejects(first.control.publish(publication, [{ hash, bytes: bytes.toString('base64') }]),
    error => error.code === 'APPLICATION_PUBLICATION_OUTCOME_UNKNOWN' && error.outcome === 'unknown');
  const retained = await first.control.publicationOperation(input.operationId);
  assert.equal(retained.publication.id, publication.id);
  assert.equal(retained.receipt, null);
  assert.deepEqual(await first.control.preparePublication(input), publication);
  await assert.rejects(first.control.preparePublication({ ...input, files: [{ ...input.files[0], size: 1 }] }),
    /PEER_PUBLICATION_OPERATION_REUSED/);
  await assert.rejects(other.control.publicationOperation(publication.payload.operationId), { code: 'OPERATION_BINDING_MISMATCH' });
  await assert.rejects(other.control.publish(publication, []), { code: 'OPERATION_BINDING_MISMATCH' });
  const distinct = await other.control.preparePublication(input);
  assert.notEqual(distinct.payload.operationId, publication.payload.operationId);
  await (await other.session.command('add', 'work continues', { operationId: 'during-publication' })).applied();
  const rotated = await supervisor.rotateBinding('publisher');
  await assert.rejects(f.attach(publisher.token));
  const resumed = await f.attach(rotated.token);
  t.after(() => resumed.detach());
  const retry = await resumed.control.preparePublication(input);
  assert.deepEqual(retry, publication);
  const receipt = await resumed.control.publish(retry, [{ hash, bytes: bytes.toString('base64') }]);
  assert.equal(receipt.version, 1);
  assert.equal((await resumed.control.publicationOperation(publication.payload.operationId)).receipt.version, 1);
  assert.equal((await publications.read()).length, 1);
  assert.equal((await other.session.query('notes', null)).value[0].text, 'work continues');
  await supervisor.revokeBinding('publisher');
  await assert.rejects(f.attach(rotated.token));
  assert.equal((await other.session.query('notes', null)).value.length, 1);
  assert.equal(f.opened(), 1, 'publishing never opens another signing owner');
});

test('explicit recovery preserves legacy unscoped publication intents without relaxing ordinary bindings', { timeout: 30_000 }, async t => {
  for (const lostReply of [false, true]) await t.test(lostReply ? 'lost host acknowledgement' : 'retained host acknowledgement', async t => {
    const f = await fixture(t, { publisher: true });
    const publications = await p.createPublicationRegistry({ store: new p.MemoryBytesStore(), authority: async () => f.authority });
    let dropReply = lostReply;
    const exchange = async request => {
      let result;
      if (request.facet === 'control' && request.action === 'read') result = f.authority;
      else if (request.facet === 'publication' && request.action === 'read') {
        const records = await publications.read(), id = request.payload.id;
        const publication = id === undefined ? records.at(-1) : records.find(value => value.id === id);
        result = publication ? { publication, version: publication.payload.revision + 1 } : null;
      } else if (request.facet === 'publication' && request.action === 'publish') {
        const publication = await publications.publish(request.payload.publication);
        if (dropReply) { dropReply = false; throw Error('LOST_LEGACY_PUBLICATION_REPLY'); }
        result = { publication, version: publication.payload.revision + 1 };
      } else throw Error('UNEXPECTED_HOST_REQUEST');
      return p.createParticipantResponse(request, result);
    };
    const bytes = Buffer.from('<main>Saved before publication scoping</main>'), hash = await p.bytesDigest(bytes);
    const input = { operationId: 'legacy-release', entry: 'index.html', files: [{ path: 'index.html', hash, size: bytes.length, type: 'text/html' }] };
    const assets = [{ hash, bytes: bytes.toString('base64') }];
    // The previous standalone ownership path saves a real signature under the
    // original ID, before any scoped attachment or current supervisor exists.
    const previousOwner = await f.openOwner();
    t.after(() => previousOwner.close());
    const previousControl = previousOwner.session.connectControlParticipant({ exchange });
    const original = await previousControl.preparePublication(input);
    assert.equal(original.payload.operationId, input.operationId);
    let originalReceipt = null;
    if (lostReply) await assert.rejects(previousControl.publish(original, assets),
      error => error.code === 'APPLICATION_PUBLICATION_OUTCOME_UNKNOWN' && error.outcome === 'unknown');
    else originalReceipt = await previousControl.publish(original, assets);
    await previousOwner.close();

    const supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main',
      openOwner: async () => {
        const owner = await f.openOwner();
        return Object.assign(owner, { control: owner.session.connectControlParticipant({ exchange }) });
      },
    });
    t.after(() => supervisor.close());
    const ordinaryBinding = await supervisor.createBinding({ id: 'ordinary', policy: { capabilities: ['publish'] } });
    const ordinary = await f.attach(ordinaryBinding.token); t.after(() => ordinary.detach());
    assert.equal(await ordinary.control.publicationOperation(input.operationId), null);
    await assert.rejects(ordinary.control.publish(original, assets), { code: 'OPERATION_BINDING_MISMATCH' });

    const recoveryBinding = await supervisor.createBinding({ id: 'legacy-recovery',
      policy: { capabilities: ['publish'], preserveOperationId: true, maxRequests: 1 } });
    const recovery = await f.attach(recoveryBinding.token); t.after(() => recovery.detach());
    const saved = await recovery.control.publicationOperation(input.operationId);
    assert.deepEqual(saved, { publication: original, receipt: originalReceipt });
    const receipt = await recovery.control.publish(saved.publication, assets);
    assert.deepEqual(receipt.publication, original, 'Recovery must preserve the exact signed payload and signature.');
    if (originalReceipt) assert.deepEqual(receipt, originalReceipt);
    assert.deepEqual(await recovery.control.publicationOperation(input.operationId), { publication: original, receipt });
    assert.equal((await publications.read()).length, 1, 'An exact legacy retry cannot add a second publication.');
    await recovery.detach(); await supervisor.revokeBinding('legacy-recovery');
    await assert.rejects(f.attach(recoveryBinding.token));

    assert.equal(await ordinary.control.publicationOperation(input.operationId), null,
      'Explicit recovery must not expose unscoped journal records to the ordinary binding.');
    const next = await ordinary.control.preparePublication(input);
    assert.match(next.payload.operationId, /^nativepub_[a-f0-9]{32}_[a-f0-9]{64}$/u);
    assert.notEqual(next.payload.operationId, original.payload.operationId);
    await assert.rejects(ordinary.control.publish(original, assets), { code: 'OPERATION_BINDING_MISMATCH' });
    assert.equal(f.opened(), 2, 'Recovery attaches to one resumed owner after the old standalone owner closes.');
  });
});

test('local publication capability cannot supply a missing signed publisher grant', async t => {
  const f = await fixture(t), token = createNativeAttachmentKey();
  const supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main',
    bindings: [{ id: 'local-admin', token, policy: { capabilities: ['ownerAdmin'] } }],
    openOwner: async () => {
      const owner = await f.openOwner();
      return Object.assign(owner, { control: owner.session.connectControlParticipant({ exchange: async request =>
        p.createParticipantResponse(request, request.facet === 'control' ? f.authority : null) }) });
    },
  });
  t.after(() => supervisor.close());
  const attached = await f.attach(token); t.after(() => attached.detach());
  await assert.rejects(attached.control.preparePublication({ operationId: 'no-publisher', entry: 'index.html',
    files: [{ path: 'index.html', hash: 'ab'.repeat(32), size: 1, type: 'text/html' }] }), /PEER_PUBLICATION_FORBIDDEN/);
});

test('raw authenticated publication uploads bound fragments, files and aggregate bytes and discard failed stages', { timeout: 20_000 }, async t => {
  const f = await fixture(t), token = createNativeAttachmentKey();
  let published = 0;
  const supervisor = await createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main',
    bindings: [{ id: 'publisher', token, policy: { capabilities: ['publish', 'queries'] } }],
    openOwner: async () => Object.assign(await f.openOwner(), { control: { publish: async () => { published++; } } }),
  });
  const socket = createConnection(supervisor.socketPath);
  await once(socket, 'connect');
  const waiting = new Map(); let sequence = 0, port;
  const transport = createNativeFrames(socket, frame => {
    if (frame.type === 'control-reply') {
      const waiter = waiting.get(frame.id); waiting.delete(frame.id);
      if (frame.error) waiter.reject(Object.assign(Error(frame.error.message), frame.error));
      else waiter.resolve(frame.value);
    } else if (frame.type === 'frame') port.postMessage(frame.value);
  }, error => { for (const waiter of waiting.values()) waiter.reject(error); });
  const session = await browser.connectApplicationOwner({
    addEventListener() {}, removeEventListener() {},
    postMessage(frame) {
      port = frame.port;
      port.addEventListener('message', event => { try { transport.send({ type: 'frame', value: event.data }); } catch {} });
      port.start();
      transport.send({ type: 'attach', protocol: 'tendriller.native-owner.v1', token, ownerProtocol: frame.protocol, handshake: frame.handshake });
    },
  }, { applicationId: f.authority.descriptor.payload.applicationId, definitionId: definition.id, definitionVersion: definition.version });
  t.after(async () => { try { await session.detach(); } finally { port.close(); transport.close(); socket.destroy(); await supervisor.close(); } });
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++sequence; waiting.set(id, { resolve, reject }); transport.send({ type: 'control', id, method, args });
  });
  const hash = 'aa'.repeat(32), slice = 'A'.repeat(512 * 1024);
  await assert.rejects(call('publishStage', ['invalid', hash, '', false]), { code: 'SUPERVISOR_PROTOCOL_INVALID' });
  await assert.rejects(call('publishCommit', ['invalid', {}]), { code: 'SUPERVISOR_PROTOCOL_INVALID' });
  for (let i = 0; i < 128; i++) await call('publishStage', ['files', i.toString(16).padStart(64, '0'), '', true]);
  await assert.rejects(call('publishStage', ['files', hash, '', true]), { code: 'SUPERVISOR_PROTOCOL_INVALID' });
  await assert.rejects(call('publishCommit', ['files', {}]), { code: 'SUPERVISOR_PROTOCOL_INVALID' });
  await call('publishStage', ['incomplete', hash, slice, false]);
  await assert.rejects(call('publishCommit', ['incomplete', {}]), { code: 'SUPERVISOR_PROTOCOL_INVALID' });
  for (let i = 0; i < 4; i++) await call('publishStage', ['slot-' + i, hash, '', true]);
  await assert.rejects(call('publishStage', ['slot-4', hash, '', true]), { code: 'APPLICATION_ATTACHMENT_REQUEST_LIMIT' });
  for (let i = 0; i < 4; i++) await call('publishAbort', ['slot-' + i]);
  for (let i = 0; i < 11; i++) await call('publishStage', ['one', hash, slice, false]);
  for (let i = 0; i < 11; i++) await call('publishStage', ['two', hash, slice, false]);
  await assert.rejects(call('publishStage', ['two', hash, slice, false]), { code: 'PEER_PUBLICATION_TOO_LARGE' });
  await call('publishAbort', ['one']);
  assert.equal((await session.query('notes', null)).value.length, 0, 'upload rejection leaves the authenticated data facade usable');
  assert.equal(published, 0);
});
