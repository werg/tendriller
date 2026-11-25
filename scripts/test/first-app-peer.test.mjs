import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { closeTestPeer, nativeTestPeerSource } from '../first-app-peer.mjs';

const BROWSER = 'a'.repeat(64);
const PROPOSAL = 'b'.repeat(64);

// The generated peer is run against a stub of the CURRENT public surface: the tutorial's
// openSession() result, the session (identity.publicKey, status/onStatus, query, command,
// operations.get/retry, signals) and its separate participation controller. Cleanup order is
// recorded so close semantics are observed rather than assumed.
async function participant(t, { failInference = false, failOwner = false, orphan = false, fixtureTransport = false, networkQualification = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'peer-close-'));
  const calls = join(directory, 'cleanup-calls'), commands = join(directory, 'command-calls'), sent = join(directory, 'signal-calls');
  await mkdir(join(directory, 'media'));
  await mkdir(join(directory, 'helpers'));
  await writeFile(join(directory, 'session.mjs'), `import {appendFile} from 'node:fs/promises';
const status={canAuthor:true,phase:'ready',database:'ready',connectedPeers:0,pendingOperations:0,materializationError:null};
const listeners=new Set();
const facts={stored:true,pending:null,materialized:{proposalId:${JSON.stringify(PROPOSAL)},revision:{digest:'d',view:'local'},outcome:'accepted',rejectionCode:null,failingStatementIndex:null},
  retained:[{signer:'remote-peer'}],finalized:false,excluded:false};
const operation=Object.assign({id:${JSON.stringify(PROPOSAL)},operationId:'operation-1'},{
  inspect(){return {...facts,author:'fixture-key'};},
  async materialized(options){options.signal.throwIfAborted();return facts.materialized;},
  async retained(){throw Error('Local commands must not wait for peer retention');},
  async finalized(){throw Error('Local commands must not wait for finality');}});
export async function openSession() {
  const resource = setInterval(() => {}, 1000);
  const participation={status:{phase:'closed',connectedPeers:[],connectionRevision:0},onStatus(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},async diagnostics(){return [];}};
  const session={applicationId:'f'.repeat(64),identity:{publicKey:'fixture-key'},signal:new AbortController().signal,
    get status(){return status;},onStatus(listener){listeners.add(listener);listener(status);return()=>{listeners.delete(listener);};},
    participation,
    async query(name,input){return {applicationId:'f'.repeat(64),revision:{digest:'d',view:'local'},value:[name,input]};},
    async command(name,input,options){await appendFile(${JSON.stringify(commands)},JSON.stringify({name,input,options})+'\\n');return operation;},
    operations:{get(id){return id===${JSON.stringify(PROPOSAL)}?operation:null;},async retry(id){await appendFile(${JSON.stringify(commands)},'retry:'+id+'\\n');return operation;}},
    signals:{async send(topic,payload){await appendFile(${JSON.stringify(sent)},JSON.stringify({topic,payload})+'\\n');}},
    close(){throw Error('Must close the entire owned bootstrap');}};
  return {session,supervisor:{ownerInstanceId:'fixture-owner'},
    async close(){await appendFile(${JSON.stringify(calls)},'owner\\n');clearInterval(resource);listeners.clear();${failOwner ? "throw Error('owner close failed');" : ''}}};
}`);
  await writeFile(join(directory, 'helpers/signal-request.mjs'), `import {appendFile} from 'node:fs/promises';
export function serveSignalRequests(){return Promise.resolve();}
export async function sendPieces(_session,topic,parts){await appendFile(${JSON.stringify(sent)},JSON.stringify({burst:topic,parts:parts.length})+'\\n');return 1;}`);
  await writeFile(join(directory, 'media/inference-service.mjs'), `import {appendFile} from 'node:fs/promises';
export function servePeerInference(options){return {snapshot(){return {allowed:options.allowedDevices};},async close(){
  await appendFile(${JSON.stringify(calls)},'inference\\n');
  ${failInference ? "throw Error('inference close failed');" : ''}
}};}`);
  const transportModule = pathToFileURL(join(directory, 'transport.mjs')).href;
  if (fixtureTransport) await writeFile(join(directory, 'transport.mjs'), `import {appendFile,readFile} from 'node:fs/promises';
const pool=setInterval(()=>{},1000);
export async function closeLocalTransport(){
  const calls=await readFile(${JSON.stringify(calls)},'utf8');
  if(!calls.endsWith('owner\\n'))throw Error('The application must close before its fixture transport');
  await appendFile(${JSON.stringify(calls)},'transport\\n');clearInterval(pool);
}`);
  const source = nativeTestPeerSource({ evidenceBase64: 'AA==', browserPublicKey: BROWSER, networkQualification, ...(fixtureTransport ? { transportModule } : {}) });
  await writeFile(join(directory, 'peer.mjs'), orphan ? `import {createInterface} from 'node:readline';
setInterval(() => {},1000);console.log(JSON.stringify({ready:true}));
for await (const line of createInterface({input:process.stdin})) {
  const request=JSON.parse(line);console.log(JSON.stringify({id:request.id,closed:true}));
}` : source);
  const child = spawn(process.execPath, [join(directory, 'peer.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const ended = once(child, 'close'), ready = Promise.withResolvers(), waiting = new Map(), forced = [];
  const kill = child.kill.bind(child);
  child.kill = signal => { forced.push(signal); return kill(signal); };
  let sequence = 0, stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line);
    if (value.ready) { ready.resolve(value); return; }
    const held = waiting.get(value.id);
    if (!held) return;
    waiting.delete(value.id); clearTimeout(held.timer);
    if (value.error) held.reject(Error(value.error)); else held.resolve('result' in value ? value.result : value);
  });
  child.once('close', code => {
    const error = Error(`Fixture peer closed (${code}): ${stderr}`);
    ready.reject(error);
    for (const held of waiting.values()) { clearTimeout(held.timer); held.reject(error); }
    waiting.clear();
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { await ended; } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const hello = await ready.promise;
  const peer = { child, hello, request(action, input = {}, timeoutMs = 3_000) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(Error('Fixture reply deadline')); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...input, id, action }) + '\n');
    });
  } };
  const lines = async file => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { peer, forced, source, calls: () => lines(calls), commands: () => lines(commands), sent: () => lines(sent) };
}

test('generated first-app peer closes the whole owner once and exits naturally before qualification', { timeout: 5_000 }, async t => {
  const f = await participant(t);
  const result = await closeTestPeer(f.peer);
  assert.deepEqual(result, { exitCode: 0, signal: null });
  assert.deepEqual(await f.calls(), ['inference', 'owner']);
  assert.deepEqual(f.forced, []);
  assert.equal(await closeTestPeer(f.peer), result);
  assert.deepEqual(await f.calls(), ['inference', 'owner']);
});

test('inference cleanup failure still closes the owned participant and fails qualification', { timeout: 5_000 }, async t => {
  const f = await participant(t, { failInference: true });
  await assert.rejects(closeTestPeer(f.peer), /Native test participant cleanup failed/);
  assert.deepEqual(await f.calls(), ['inference', 'owner']);
});

test('owner cleanup failure still drains the fixture transport and fails qualification', { timeout: 5_000 }, async t => {
  const f = await participant(t, { failOwner: true, fixtureTransport: true });
  await assert.rejects(closeTestPeer(f.peer), /Native test participant cleanup failed.*owner close failed/);
  assert.deepEqual(await f.calls(), ['inference', 'owner', 'transport']);
});

test('fixture transport drains after the owned application and permits natural child exit', { timeout: 5_000 }, async t => {
  const f = await participant(t, { fixtureTransport: true });
  await closeTestPeer(f.peer);
  assert.deepEqual(await f.calls(), ['inference', 'owner', 'transport']);
  assert.deepEqual(f.forced, []);
});

test('an acknowledged but orphaned child is terminated as failure, never counted as clean shutdown', { timeout: 5_000 }, async t => {
  const f = await participant(t, { orphan: true });
  await assert.rejects(closeTestPeer(f.peer, { timeoutMs: 150 }), /did not exit after owned cleanup/);
  assert.ok(f.forced.includes('SIGTERM'));
  assert.notEqual(f.peer.child.signalCode, null);
});

test('the generated peer reports its public-key identity and models only the current session API', { timeout: 5_000 }, async t => {
  const f = await participant(t);
  assert.equal(f.peer.hello.publicKey, 'fixture-key');
  assert.equal(f.peer.hello.ownerInstanceId, 'fixture-owner');
  assert.equal('deviceId' in f.peer.hello, false);
  // Removed generation, pairing, recovery and ordering-pause vocabulary must not return.
  assert.doesNotMatch(f.source, /orderingPause|ordering-pause|processPairings|pairing|watchSetup|superviseParticipant|\.applied\(|basedOn|deviceId|setup-ready|\.deviceId/i);
  for (const action of ['ordering-pause', 'pairing-process', 'setup-ready']) await assert.rejects(f.peer.request(action), /Unknown test action/);
  assert.deepEqual(await f.peer.request('query'), { applicationId: 'f'.repeat(64), revision: { digest: 'd', view: 'local' }, value: ['notes', null] });
  await closeTestPeer(f.peer);
});

test('a command is stored and locally materialized without waiting for retention or finality', { timeout: 5_000 }, async t => {
  const f = await participant(t);
  const result = await f.peer.request('command', { text: 'hello', operationId: 'operation-1' });
  assert.deepEqual(await f.commands(), [JSON.stringify({ name: 'putNote', input: { noteId: 'operation-1', text: 'hello' }, options: { operationId: 'operation-1' } })],
    'one direct session.command with the caller operation ID, no basedOn and no second queue');
  assert.equal(result.stored, true);
  assert.equal(result.proposalId, PROPOSAL);
  assert.equal(result.materialized.outcome, 'accepted');
  assert.deepEqual(result.retainedBy, ['remote-peer'], 'retention is reported as its own fact');
  assert.equal(result.finalized, false, 'unfinalized local authoring is a normal result');
  const inspected = await f.peer.request('operation-facts', { proposalId: PROPOSAL });
  assert.deepEqual(inspected, result);
  assert.equal(await f.peer.request('operation-facts', { proposalId: 'c'.repeat(64) }), null);
  const retried = await f.peer.request('operation-retry', { proposalId: PROPOSAL });
  assert.equal(retried.proposalId, PROPOSAL);
  assert.equal((await f.commands()).at(-1), 'retry:' + PROPOSAL, 'retry re-offers the original operation; it is not a new command');
  await closeTestPeer(f.peer);
});

test('local readiness and diagnostics use local status only and expose separate participation', { timeout: 5_000 }, async t => {
  const f = await participant(t);
  const ready = await f.peer.request('local-ready');
  assert.equal(ready.before.ready, true);
  assert.equal(ready.after.ready, true, 'no connected peer or finalizer is needed');
  const diagnostics = await f.peer.request('diagnostics');
  assert.equal(diagnostics.status.canAuthor, true);
  assert.equal(diagnostics.participation.phase, 'closed');
  assert.equal(diagnostics.readiness.ready, true);
  assert.equal(diagnostics.signalRequests.state, 'running');
  assert.equal('pairing' in diagnostics || 'setupReadiness' in diagnostics || 'lifecycleLog' in diagnostics, false);
  const log = await f.peer.request('participation-log');
  assert.deepEqual(log.current, { phase: 'closed', peers: [] });
  await closeTestPeer(f.peer);
});

test('signal state and burst diagnostics are preserved through the public signal surface', { timeout: 5_000 }, async t => {
  const f = await participant(t);
  assert.deepEqual(await f.peer.request('signal-state', { count: 3, intervalMs: 1 }), { sent: 3 });
  const burst = await f.peer.request('signal-burst', { topic: 'soak', id: 'reply', pieces: 4, bytes: 10 });
  assert.equal(burst.sent, 4);
  assert.deepEqual(burst.failures, []);
  assert.equal(burst.retries, 4);
  assert.equal(burst.pieceMs.length, 4);
  assert.equal(typeof burst.eventLoopLagMaxMs, 'number');
  const sent = (await f.sent()).map(line => JSON.parse(line));
  assert.deepEqual(sent.filter(item => item.topic === 'state').map(item => item.payload.index), [0, 1, 2]);
  assert.equal(sent.filter(item => item.burst === 'soak').length, 4);
  await closeTestPeer(f.peer);
});

test('network qualification actions are present only when requested', { timeout: 5_000 }, async t => {
  const plain = await participant(t);
  await assert.rejects(plain.peer.request('transport-snapshot'), /Unknown test action/);
  await closeTestPeer(plain.peer);
  const lab = await participant(t, { networkQualification: true });
  const snapshot = await lab.peer.request('transport-snapshot');
  assert.deepEqual(snapshot, { connectionRevision: 0, browserLinks: 0, otherLinks: 0, kind: 'unknown' });
  await closeTestPeer(lab.peer);
});
