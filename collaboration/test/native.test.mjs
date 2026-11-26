import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, lstat, readFile, rm, chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { attachNativeSession, createNativeAttachmentKey, createNativeSessionSupervisor, createNativeWorkspaceSupervisor } from '../../session/native.mjs';
import { createCollaborationClient } from '../client.mjs';
import { createNativeFrames } from '../../session/native-transport.mjs';
import { diagnosticFinding, transportCauseSummary } from '../../session/diagnostics.mjs';
import { operationReference } from '../protocol.mjs';
import { createViewStore } from '../local.mjs';
import { p, native, worker, browser, definition, peerModule, openRetainedOwner, genesisForDevices } from './native-fixture.mjs';

async function fixture(t, { publisher = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const devicePath = join(root, 'device.sqlite'), ownerDirectory = join(root, 'owner');
  const device = await native.openNativeDevice({ path: devicePath, create: true });
  const deviceId = device.identity.publicKey;
  const { chainId, genesisBytes, casNodes, key } = await genesisForDevices([device]);
  await device.close();
  let opened = 0;
  const openOwner = async () => {
    opened++;
    return openRetainedOwner({ devicePath, genesisBytes, casNodes, key });
  };
  const attach = (token, options = {}) => attachNativeSession({ directory: ownerDirectory, token,
    applicationId: chainId,
    connect: browser.connectApplicationOwner, timeoutMs: 1500, ...options });
  return { root, ownerDirectory, devicePath, deviceId, applicationId: chainId, genesisBytes, casNodes, key, openOwner, attach, opened: () => opened };
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
export function attach({signal}){return attachNativeSession({directory:${JSON.stringify(f.ownerDirectory)},
token:process.env.TENDRILLER_NATIVE_ATTACHMENT_KEY,connect:connectApplicationOwner,signal,context:{runId:process.env.FIXTURE_RUN},
applicationId:${JSON.stringify(f.applicationId)}});}`);
  const cli = fileURLToPath(new URL('../../tools/cli/test/support/run-cli.mjs', import.meta.url));
  const run = (token, text) => {
    const process = spawn(globalThis.process.execPath, [cli, '--fixture', bootstrap, '--page', 'retained-main',
      'command', 'add', JSON.stringify(text), '--operation', 'same-terminal-id'], {
      env: { ...globalThis.process.env, TENDRILLER_NATIVE_ATTACHMENT_KEY: token, FIXTURE_RUN: text }, stdio: ['ignore', 'pipe', 'pipe'],
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
  const old = child(t, script, { ownerDirectory: f.ownerDirectory, devicePath: f.devicePath, genesisBytes: [...f.genesisBytes], casNodes: f.casNodes.map(n => ({ hash: n.hash, bytes: [...n.bytes], partition: n.partition })), key: [...f.key], token });
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
  await writeFile(join(f.ownerDirectory, 'profile.json'), JSON.stringify({ version: 1, profileId: 'retained-main', applicationId: f.applicationId, publicKey: 'ab'.repeat(32) }), { mode: 0o600 });
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
  const owner = child(t, source, { ownerDirectory: f.ownerDirectory, devicePath: f.devicePath, genesisBytes: [...f.genesisBytes], casNodes: f.casNodes.map(n => ({ hash: n.hash, bytes: [...n.bytes], partition: n.partition })), key: [...f.key], token });
  await owner.ready();
  const writer = await f.attach(token); t.after(() => writer.detach());
  await (await writer.session.command('add', 'before crash', { operationId: 'before-crash' })).materialized();
  const bootstrap = join(f.root, 'watch-attachment.mjs');
  await writeFile(bootstrap, `import {attachNativeSession} from ${JSON.stringify(nativeModule)};
import {connectApplicationOwner} from ${JSON.stringify(peerModule('browser'))};
export function attach({signal}){return attachNativeSession({directory:${JSON.stringify(f.ownerDirectory)},
token:process.env.TENDRILLER_NATIVE_ATTACHMENT_KEY,connect:connectApplicationOwner,signal,
applicationId:${JSON.stringify(f.applicationId)}});}`);
  // The real executable lifecycle with this attachment in place of tendril agent run.
  const cli = fileURLToPath(new URL('../../tools/cli/test/support/run-cli.mjs', import.meta.url));
  const invoke = args => {
    const process = spawn(globalThis.process.execPath, [cli, '--fixture', bootstrap, '--page', 'retained-main', ...args], {
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


// The owner's explicit publication adapter: the same surface the page module hands the supervisor
// (definition/publication/publicationOperation/preparePublication/publish). It signs with the workspace
// signer, retains each signed intent by its scoped operation ID and talks to a fake HTTP-level host.
async function publicationHarness(f, { grant = true } = {}) {
  const signer = await p.createSigningIdentity(), applicationId = f.applicationId;
  const state = { fault: 'healthy', records: [], submissions: [] }, intents = new Map();
  const causes = ['EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH', 'ETIMEDOUT'];
  const networkFailure = () => new TypeError('fetch failed', { cause: new AggregateError(causes.map(code =>
    Object.assign(Error('private credential https://secret.invalid/?token=private'), { code, address: '192.0.2.1', headers: { authorization: 'private' }, path: '/private/profile' })), 'private aggregate') });
  const classified = (error, code, outcome, phase, publication, receipt) => Object.assign(error, { code, outcome, phase, receipt,
    operationId: publication.payload.operationId, publicationId: publication.id });
  const peers = {
    async application() {
      if (state.fault === 'preparation') throw networkFailure();
      return { selection: { id: applicationId }, publisherKeys: grant ? [signer.publicKey] : [] };
    },
    async publication(id) {
      if (state.fault === 'selection' && id === undefined) throw networkFailure();
      return (id === undefined ? state.records.at(-1) : state.records.find(record => record.publication.id === id)) ?? null;
    },
    async publish(publication, assets) {
      state.submissions.push(structuredClone({ publication, assets }));
      if (state.records.some(record => record.publication.id === publication.id)) return state.records.find(record => record.publication.id === publication.id);
      const record = { publication, version: state.records.length + 1 };
      state.records.push(record);
      // The host committed; only its acknowledgement was lost, so the outcome is unknown, never "rejected".
      if (state.fault === 'submission') throw classified(networkFailure(), 'APPLICATION_PUBLICATION_OUTCOME_UNKNOWN', 'unknown', 'submission', publication, null);
      if (state.fault === 'selection') throw classified(networkFailure(), 'APPLICATION_PUBLICATION_COMMITTED', 'committed', 'selection', publication, record);
      return record;
    },
  };
  const control = Object.freeze({
    definition: async () => ({ definition: { id: definition.id } }),
    publication: () => peers.publication(),
    async publicationOperation(operationId) {
      const publication = intents.get(operationId);
      state.fault === 'selection' && (state.fault = 'healthy');
      return publication ? { publication, receipt: await peers.publication(publication.id) } : null;
    },
    async preparePublication({ operationId, entry = 'index.html', files }) {
      const saved = intents.get(operationId);
      if (saved) {
        if (saved.payload.entry !== entry || JSON.stringify(saved.payload.files) !== JSON.stringify(files)) throw Object.assign(Error('PEER_PUBLICATION_OPERATION_REUSED'), { code: 'PEER_PUBLICATION_OPERATION_REUSED' });
        return saved;
      }
      const [metadata, previous] = await Promise.all([peers.application(), peers.publication()]);
      if (metadata.selection?.id !== applicationId || !metadata.publisherKeys.includes(signer.publicKey)) throw Error('Independent publisher grant required');
      const signedOp = await p.signOperationCore({
        version: 1,
        chainId: p.hexToBytes(applicationId),
        author: p.hexToBytes(signer.publicKey),
        operationId,
        authorTimestampMs: BigInt(Date.now()),
        nonce: crypto.getRandomValues(new Uint8Array(16)),
        visibility: 'public',
        updates: [{ topic: '$publications', input: { action: 'publish', entry, files } }],
      }, signer.privateKey);
      const id = p.bytesToHex(p.operationIdDigest(signedOp.coreBytes));
      const publication = {
        id,
        payload: {
          applicationId,
          author: signer.publicKey,
          operationId,
          revision: previous === null ? 0 : previous.publication.payload.revision + 1,
          previous: previous?.publication.id ?? null,
          entry,
          files,
        },
        rawOp: p.encodeSignedOperation(signedOp),
      };
      intents.set(operationId, publication);
      return publication;
    },
    publish: (publication, assets) => peers.publish(publication, assets),
  });
  const supervisorFor = (t, options = {}) => createNativeSessionSupervisor({ directory: f.ownerDirectory, profileId: 'retained-main',
    openOwner: async () => Object.assign(await f.openOwner(), { control: options.control ?? control }), ...options.supervisor });
  return { signer, state, peers, control, causes, supervisorFor, intents };
}
const noLeak = error => assert.doesNotMatch(JSON.stringify(error), /private|192\.0|secret\.invalid|127\.0\.0\.1|http:|remoteAddress|localAddress/);
const publicationFiles = async text => {
  const bytes = Buffer.from(text), hash = createHash('sha256').update(bytes).digest('hex');
  return { files: [{ path: 'index.html', hash, size: bytes.length, type: 'text/html' }], assets: [{ hash, bytes: bytes.toString('base64') }] };
};

test('a real fetch socket reset does not poison later requests on the same native owner', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let resetNext = false, resets = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (resetNext) { resetNext = false; resets++; response.destroy(); return; }
    response.setHeader('Content-Type', 'application/json'); response.end('null');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const h = await publicationHarness(f);
  const control = { ...h.control, publication: async () => (await fetch(endpoint, { method: 'POST' })).json() };
  const supervisor = await h.supervisorFor(t, { control });
  t.after(() => supervisor.close());
  const publisher = await supervisor.createBinding({ id: 'publisher', policy: { capabilities: ['publish'], maxRequests: 1 } });
  const attached = await f.attach(publisher.token); t.after(() => attached.detach());
  assert.equal(await attached.control.publication(), null);
  resetNext = true;
  await assert.rejects(attached.control.publication(), error => {
    assert.equal(error.message, 'fetch failed');
    assert.ok(error.transportCauses.codes.some(code => ['UND_ERR_SOCKET', 'ECONNRESET'].includes(code)));
    assert.equal(diagnosticFinding(error).retrySafe, false);
    noLeak(error); return true;
  });
  assert.equal(resets, 1);
  assert.equal(await attached.control.publication(), null, 'restored connectivity reuses the existing owner and ordinary fetch path');
  assert.equal(f.opened(), 1);
});

test('one native owner preserves bounded transport causes and recovers each publication failure phase', { timeout: 20_000 }, async t => {
  const f = await fixture(t), h = await publicationHarness(f);
  const supervisor = await h.supervisorFor(t); t.after(() => supervisor.close());
  const publisher = await supervisor.createBinding({ id: 'publisher', policy: { capabilities: ['publish', 'queries'], maxRequests: 1 } });
  const attached = await f.attach(publisher.token); t.after(() => attached.detach());
  const { files, assets } = await publicationFiles('<main>Exact retained publication</main>');
  const input = { operationId: 'network-recovery', entry: 'index.html', files };
  const expected = { codes: h.causes, truncated: false };
  h.state.fault = 'preparation';
  let direct;
  await assert.rejects(h.control.preparePublication(input), error => { direct = error; assert.deepEqual(transportCauseSummary(error), expected); return true; });
  await assert.rejects(attached.control.preparePublication(input), error => {
    assert.equal(error.name, direct.name); assert.equal(error.message, direct.message);
    assert.deepEqual(error.transportCauses, expected);
    assert.equal(error.outcome, undefined); assert.equal(error.receipt, undefined);
    noLeak(error); return true;
  });
  assert.equal(h.state.records.length, 0);
  assert.equal(await attached.control.publicationOperation(input.operationId), null);
  h.state.fault = 'healthy';
  const publication = await attached.control.preparePublication(input);
  h.state.fault = 'submission';
  await assert.rejects(attached.control.publish(publication, assets), error => {
    assert.equal(error.code, 'APPLICATION_PUBLICATION_OUTCOME_UNKNOWN');
    assert.equal(error.outcome, 'unknown'); assert.equal(error.phase, 'submission');
    assert.equal(error.operationId, publication.payload.operationId); assert.equal(error.publicationId, publication.id);
    assert.equal(error.receipt, null); assert.deepEqual(error.transportCauses, expected);
    assert.equal(diagnosticFinding(error).retrySafe, false);
    noLeak(error); return true;
  });
  assert.equal(h.state.records.length, 1, 'network codes do not imply rejection or non-submission');
  const retained = await attached.control.publicationOperation(input.operationId);
  assert.equal(retained.publication.id, publication.id);
  h.state.fault = 'healthy';
  assert.deepEqual(await attached.control.preparePublication(input), publication, 'reuse the original signature');
  const receipt = await attached.control.publish(retained.publication, assets);
  assert.deepEqual(receipt.publication, publication);
  assert.deepEqual(h.state.submissions[1], h.state.submissions[0], 'exact retry retains the original signed intent and all asset bytes');
  assert.equal(h.state.records.length, 1, 'no replacement publication is created');
  const next = await attached.control.preparePublication({ ...input, operationId: 'acknowledged-then-disconnected' });
  h.state.fault = 'selection';
  await assert.rejects(attached.control.publish(next, assets), error => {
    assert.equal(error.code, 'APPLICATION_PUBLICATION_COMMITTED');
    assert.equal(error.outcome, 'committed'); assert.equal(error.phase, 'selection');
    assert.equal(error.operationId, next.payload.operationId); assert.equal(error.publicationId, next.id);
    assert.deepEqual(error.receipt, { publication: next, version: 2 });
    assert.deepEqual(error.transportCauses, expected); assert.equal(diagnosticFinding(error).retrySafe, false); return true;
  });
  h.state.fault = 'healthy';
  assert.deepEqual((await attached.control.publicationOperation(next.payload.operationId)).receipt, { publication: next, version: 2 });
  assert.deepEqual(await attached.control.publication(), { publication: next, version: 2 });
  assert.equal((await attached.session.query('notes', null)).value.length, 0);
  assert.equal(f.opened(), 1, 'failures release request slots and do not poison the owner lifetime');
});

test('attached publication retains one signed intent through a lost reply, reconnect and binding rotation', { timeout: 20_000 }, async t => {
  const f = await fixture(t), h = await publicationHarness(f);
  const supervisor = await h.supervisorFor(t); t.after(() => supervisor.close());
  const publisher = await supervisor.createBinding({ id: 'publisher', policy: { capabilities: ['publish'] } });
  const sibling = await supervisor.createBinding({ id: 'sibling', policy: { capabilities: ['publish', 'queries', 'commands', 'operations'] } });
  const first = await f.attach(publisher.token), other = await f.attach(sibling.token);
  t.after(() => Promise.allSettled([first.detach(), other.detach()]));
  const { files, assets } = await publicationFiles('<main>Live release</main>');
  const input = { operationId: 'release-one', entry: 'index.html', files };
  const publication = await first.control.preparePublication(input);
  assert.match(publication.payload.operationId, /^nativepub_[a-f0-9]{32}_[a-f0-9]{64}$/u, 'the binding scopes the publication operation identity');
  assert.equal(publication.payload.author, h.signer.publicKey);
  h.state.fault = 'submission';
  await assert.rejects(first.control.publish(publication, assets), error => error.code === 'APPLICATION_PUBLICATION_OUTCOME_UNKNOWN' && error.outcome === 'unknown');
  h.state.fault = 'healthy';
  const retained = await first.control.publicationOperation(input.operationId);
  assert.equal(retained.publication.id, publication.id);
  assert.deepEqual(await first.control.preparePublication(input), publication);
  await assert.rejects(first.control.preparePublication({ ...input, files: [{ ...input.files[0], size: 1 }] }), /PEER_PUBLICATION_OPERATION_REUSED/);
  await assert.rejects(other.control.publicationOperation(publication.payload.operationId), { code: 'OPERATION_BINDING_MISMATCH' });
  await assert.rejects(other.control.publish(publication, []), { code: 'OPERATION_BINDING_MISMATCH' });
  const distinct = await other.control.preparePublication(input);
  assert.notEqual(distinct.payload.operationId, publication.payload.operationId, 'another binding never inherits this signed intent');
  await (await other.session.command('add', 'work continues', { operationId: 'during-publication' })).materialized();
  const rotated = await supervisor.rotateBinding('publisher');
  await assert.rejects(f.attach(publisher.token));
  const resumed = await f.attach(rotated.token);
  t.after(() => resumed.detach());
  const retry = await resumed.control.preparePublication(input);
  assert.deepEqual(retry, publication);
  const receipt = await resumed.control.publish(retry, assets);
  assert.equal(receipt.version, 1);
  assert.equal((await resumed.control.publicationOperation(publication.payload.operationId)).receipt.version, 1);
  assert.equal(h.state.records.length, 1);
  assert.deepEqual(h.state.submissions[1], h.state.submissions[0], 'the resumed attachment resubmits the exact original signed intent');
  assert.equal((await other.session.query('notes', null)).value[0].text, 'work continues');
  await supervisor.revokeBinding('publisher');
  await assert.rejects(f.attach(rotated.token));
  assert.equal((await other.session.query('notes', null)).value.length, 1);
  assert.equal(f.opened(), 1, 'publishing never opens another signing owner');
});

test('a local publication capability cannot supply a missing signed publisher grant or reach an owner without a control', async t => {
  const f = await fixture(t), h = await publicationHarness(f, { grant: false });
  const supervisor = await h.supervisorFor(t); t.after(() => supervisor.close());
  const token = createNativeAttachmentKey();
  const local = await supervisor.createBinding({ id: 'local-publish', policy: { capabilities: ['publish', 'queries'] } });
  const observer = await supervisor.createBinding({ id: 'observer', policy: { capabilities: ['queries'] } });
  const publisher = await f.attach(local.token), observed = await f.attach(observer.token);
  t.after(() => Promise.allSettled([publisher.detach(), observed.detach()]));
  const { files } = await publicationFiles('<main>No grant</main>');
  await assert.rejects(publisher.control.preparePublication({ operationId: 'ungranted', entry: 'index.html', files }), /Independent publisher grant required/);
  assert.equal(h.state.records.length, 0); assert.equal(h.intents.size, 0, 'no signed intent exists without the independent grant');
  await assert.rejects(observed.control.publication(), { code: 'APPLICATION_ATTACHMENT_CAPABILITY_REQUIRED' });
  await assert.rejects(f.attach(token), error => error.code === 'SUPERVISOR_BINDING_REVOKED' || error.code === 'SUPERVISOR_AUTHENTICATION_REQUIRED');
  const g = await fixture(t);
  const bare = await createNativeSessionSupervisor({ directory: g.ownerDirectory, profileId: 'retained-main', openOwner: g.openOwner });
  t.after(() => bare.close());
  const barePublisher = await bare.createBinding({ id: 'publisher', policy: { capabilities: ['publish'] } });
  const withoutControl = await g.attach(barePublisher.token);
  t.after(() => withoutControl.detach());
  await assert.rejects(withoutControl.control.publication(), { code: 'CONTROL_PARTICIPANT_UNAVAILABLE' });
});

const fakePageOwner = (id, calls = []) => {
  const stop = new AbortController();
  return { ownerInstanceId: 'owner-' + id, endpoints: () => [], attach() {},
    session: { applicationId: id.repeat(64).slice(0, 64), identity: { publicKey: 'b'.repeat(64) }, signal: stop.signal },
    async close() { calls.push('closed'); } };
};

test('concurrent admissions of the same page admit exactly one owner and reserve the page before profile IO', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const supervisor = await createNativeWorkspaceSupervisor({ directory: join(root, 'owner'), workspaceId: 'workspace' });
  t.after(() => supervisor.close());
  const results = await Promise.allSettled([1, 2, 3].map(index => supervisor.addPage('aaaaaaaaaaaa', fakePageOwner('a'))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'only one concurrent admission succeeds');
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason.code), ['SUPERVISOR_PAGE_EXISTS', 'SUPERVISOR_PAGE_EXISTS']);
  assert.deepEqual(supervisor.pages().map(entry => entry.page), ['aaaaaaaaaaaa']);
  await assert.rejects(supervisor.addPage('aaaaaaaaaaaa', fakePageOwner('a')), { code: 'SUPERVISOR_PAGE_EXISTS' }, 'an admitted page stays reserved');
  assert.equal(await supervisor.removePage('aaaaaaaaaaaa'), true);
  assert.equal(await supervisor.removePage('aaaaaaaaaaaa'), false);
  await supervisor.addPage('aaaaaaaaaaaa', fakePageOwner('a'));
  assert.deepEqual(supervisor.pages().map(entry => entry.page), ['aaaaaaaaaaaa'], 'a released page can be admitted again');
});

test('shutdown during a page admission never resurrects an entry after close', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const supervisor = await createNativeWorkspaceSupervisor({ directory: join(root, 'owner'), workspaceId: 'workspace' });
  const owner = fakePageOwner('c');
  const admitting = supervisor.addPage('cccccccccccc', owner);
  const closed = supervisor.close();
  await assert.rejects(admitting, { code: 'OWNER_UNREACHABLE' });
  await closed;
  assert.deepEqual(supervisor.pages(), [], 'no late admission after close');
  await assert.rejects(supervisor.addPage('dddddddddddd', fakePageOwner('d')), { code: 'OWNER_UNREACHABLE' });
  assert.deepEqual(supervisor.pages(), []);
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
  const waiting = new Map(); let sequence = 0, endpoint, attached = false;
  const transport = createNativeFrames(socket, frame => {
    if (frame.type === 'control-reply') {
      const waiter = waiting.get(frame.id); waiting.delete(frame.id);
      if (frame.error) waiter.reject(Object.assign(Error(frame.error.message), frame.error));
      else waiter.resolve(frame.value);
    } else if (frame.type === 'frame') endpoint.dispatchEvent(new MessageEvent('message', { data: frame.value }));
  }, error => { for (const waiter of waiting.values()) waiter.reject(error); });
  endpoint = Object.assign(new EventTarget(), { postMessage(frame) {
    if (!attached) { attached = true; transport.send({ type: 'attach', protocol: 'tendriller.native-owner.v1', token, hello: frame }); }
    else transport.send({ type: 'frame', value: frame });
  } });
  const session = await browser.connectApplicationOwner(endpoint, { applicationId: f.applicationId });
  t.after(async () => { try { await session.detach(); } finally { transport.close(); socket.destroy(); await supervisor.close(); } });
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++sequence; waiting.set(id, { resolve, reject }); transport.send({ type: 'control', id, method, args });
  });
  const hash = 'aa'.repeat(32), slice = 'A'.repeat(512 * 1024);
  await assert.rejects(call('publishStage', ['invalid', hash, '', false]), { code: 'SUPERVISOR_PROTOCOL_INVALID' });
  await assert.rejects(call('publishCommit', ['invalid', {}]), { code: 'SUPERVISOR_PROTOCOL_INVALID' });
  for (let i = 0; i < 256; i++) await call('publishStage', ['files', i.toString(16).padStart(64, '0'), '', true]);
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

test('one workspace socket attaches to pages that share one managed signer but keep separate device stores', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signerDevice = await native.openNativeDevice({ path: join(root, 'identity.sqlite'), create: true });
  const signer = signerDevice.identity; await signerDevice.close();
  const openPage = async (applicationId, create) => {
    await mkdir(join(root, applicationId.slice(0, 4)), { recursive: true });
    return native.openNativeDevice({ path: join(root, applicationId.slice(0, 4), 'device.sqlite'), managedSigner: signer, ...(create ? { create: true } : {}) });
  };
  const pages = {};
  for (const [page, dirName] of [['aaaaaaaaaaaa', 'p1'], ['bbbbbbbbbbbb', 'p2']]) {
    const device = await openPage(dirName, true);
    assert.equal(device.identity.publicKey, signer.publicKey);
    const { chainId, genesisBytes, casNodes, key } = await genesisForDevices([device]);
    await device.close();
    pages[page] = { dirName, applicationId: chainId, genesisBytes, casNodes, key };
  }
  const token = createNativeAttachmentKey(), directory = join(root, 'owner');
  const supervisor = await createNativeWorkspaceSupervisor({ directory, workspaceId: 'workspace', bindings: [{ id: 'terminal', token }] });
  t.after(() => supervisor.close());
  for (const [page, { dirName, genesisBytes, casNodes, key }] of Object.entries(pages)) {
    const session = await p.createApplicationSession({ device: await openPage(dirName), definition, genesis: genesisBytes, casNodes, epochKeys: new Map([[0, key]]) });
    const profile = await supervisor.addPage(page, worker.createApplicationOwner(session));
    assert.equal(profile.publicKey, signer.publicKey);
  }
  assert.deepEqual(supervisor.pages().map(entry => entry.page), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  const attach = page => attachNativeSession({ directory, token, page, applicationId: pages[page].applicationId, connect: browser.connectApplicationOwner, timeoutMs: 1500 });
  const first = await attach('aaaaaaaaaaaa'), second = await attach('bbbbbbbbbbbb');
  await (await first.session.command('add', 'first page', { operationId: 'same' })).materialized();
  assert.equal((await second.session.query('notes', null)).value.length, 0, 'pages never share application history');
  assert.deepEqual((await first.session.query('notes', null)).value, [{ text: 'first page' }]);
  await assert.rejects(attachNativeSession({ directory, token, applicationId: pages.aaaaaaaaaaaa.applicationId, connect: browser.connectApplicationOwner, timeoutMs: 1500 }), { code: 'SUPERVISOR_PAGE_REQUIRED' });
  await assert.rejects(attachNativeSession({ directory, token, page: 'cccccccccccc', applicationId: pages.aaaaaaaaaaaa.applicationId, connect: browser.connectApplicationOwner, timeoutMs: 1500 }), { code: 'SUPERVISOR_PAGE_UNAVAILABLE' });
  await second.detach();
  assert.equal(await supervisor.removePage('bbbbbbbbbbbb'), true);
  assert.deepEqual(supervisor.pages().map(entry => entry.page), ['aaaaaaaaaaaa']);
  await first.detach();
});
