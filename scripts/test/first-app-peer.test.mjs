import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { closeTestPeer, nativeTestPeerSource } from '../first-app-peer.mjs';

async function participant(t, { failInference = false, failPairing = false, orphan = false, fixtureTransport = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'peer-close-'));
  const calls = join(directory, 'cleanup-calls');
  await mkdir(join(directory, 'media'));
  await mkdir(join(directory, 'helpers'));
  await copyFile(new URL('../../docs/tutorial/helpers/participant-lifecycle.mjs', import.meta.url),join(directory,'helpers/participant-lifecycle.mjs'));
  await writeFile(join(directory, 'session.mjs'), `import {appendFile} from 'node:fs/promises';
export async function openSession() {
  const resource = setInterval(() => {}, 1000);
  const watched=Promise.withResolvers();
  return {
    watchSetup(){return {closed:watched.promise,async close(){
      await appendFile(${JSON.stringify(calls)},'pairing\\n');watched.resolve();
      ${failPairing ? "throw Error('setup close failed');" : ''}
    }};},
    session:{deviceId:'fixture-device',participation:{status:{phase:'closed',connectedPeers:[]},onStatus(){return()=>{};}},close(){throw Error('Must close the entire owned bootstrap');}},
    supervisor:{ownerInstanceId:'fixture-owner'},
    async close(){await appendFile(${JSON.stringify(calls)},'owner\\n');clearInterval(resource);}};
}`);
  await writeFile(join(directory, 'helpers/signal-request.mjs'), 'export function serveSignalRequests(){return Promise.resolve();}');
  await writeFile(join(directory, 'media/inference-service.mjs'), `import {appendFile} from 'node:fs/promises';
export function servePeerInference(){return {snapshot(){return {};},async close(){
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
  await writeFile(join(directory, 'peer.mjs'), orphan ? `import {createInterface} from 'node:readline';
setInterval(() => {},1000);console.log(JSON.stringify({ready:true}));
for await (const line of createInterface({input:process.stdin})) {
  const request=JSON.parse(line);console.log(JSON.stringify({id:request.id,closed:true}));
}` : nativeTestPeerSource({ evidenceBase64: 'AA==', browserDeviceId: 'a'.repeat(64), ...(fixtureTransport ? { transportModule } : {}) }));
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
    if (value.error) held.reject(Error(value.error)); else held.resolve(value);
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
  await ready.promise;
  const peer = { child, request(action, _input, timeoutMs) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(Error('Fixture reply deadline')); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, action }) + '\n');
    });
  } };
  return { peer, forced, calls: async () => (await readFile(calls, 'utf8')).trim().split('\n') };
}

test('generated first-app peer closes the whole owner once and exits naturally before qualification', { timeout: 5_000 }, async t => {
  const f = await participant(t);
  const result = await closeTestPeer(f.peer);
  assert.deepEqual(result, { exitCode: 0, signal: null });
  assert.deepEqual(await f.calls(), ['pairing', 'inference', 'owner']);
  assert.deepEqual(f.forced, []);
  assert.equal(await closeTestPeer(f.peer), result);
  assert.deepEqual(await f.calls(), ['pairing', 'inference', 'owner']);
});

test('inference cleanup failure still closes the owned participant and fails qualification', { timeout: 5_000 }, async t => {
  const f = await participant(t, { failInference: true });
  await assert.rejects(closeTestPeer(f.peer), /Native test participant cleanup failed/);
  assert.deepEqual(await f.calls(), ['pairing', 'inference', 'owner']);
});

test('pairing cleanup failure still closes inference and the owner and fails qualification', { timeout: 5_000 }, async t => {
  const f = await participant(t, { failPairing: true });
  await assert.rejects(closeTestPeer(f.peer), /Native test participant cleanup failed/);
  assert.deepEqual(await f.calls(), ['pairing', 'inference', 'owner']);
});

test('fixture transport drains after the owned application and permits natural child exit', { timeout: 5_000 }, async t => {
  const f = await participant(t, { fixtureTransport: true });
  await closeTestPeer(f.peer);
  assert.deepEqual(await f.calls(), ['pairing', 'inference', 'owner', 'transport']);
  assert.deepEqual(f.forced, []);
});

test('an acknowledged but orphaned child is terminated as failure, never counted as clean shutdown', { timeout: 5_000 }, async t => {
  const f = await participant(t, { orphan: true });
  await assert.rejects(closeTestPeer(f.peer, { timeoutMs: 150 }), /did not exit after owned cleanup/);
  assert.ok(f.forced.includes('SIGTERM'));
  assert.notEqual(f.peer.child.signalCode, null);
});
