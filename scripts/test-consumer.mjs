// Verify that only public release artifacts are needed in a clean consumer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CORE_RELEASE } from '../contract/index.mjs';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
// A sibling of the source tree cannot silently resolve undeclared dependencies
// through the checkout's node_modules. All consumer inputs are packed artifacts.
const directory = mkdtempSync(join(tmpdir(), 'tendriller-consumer-'));
const run = (command, args) => execFileSync(command, args, {cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000});
try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({private: true, type: 'module'}));
  // Include the engine's declared type dependency as an exact local archive so
  // this check needs no registry access, even with an empty npm cache.
  const workersTypes = JSON.parse(readFileSync(join(root, 'node_modules/@cloudflare/workers-types/package.json')));
  const [typesArchive] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--offline', '--json',
    '--cache', join(directory, 'npm-cache'), '--pack-destination', directory, join(root, 'node_modules/@cloudflare/workers-types')]));
  run('npm', ['install', '--ignore-scripts', '--offline', '--omit=dev', '--no-audit', '--no-fund',
    '--cache', join(directory, 'npm-cache'), join(directory, typesArchive.filename),
    ...['sdk', 'runtime', 'engine'].map(name => join(root, 'dist', `tendriller-${name}-${CORE_RELEASE}.tgz`))]);
  const core = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/core/package.json')));
  const runtime = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/runtime/package.json')));
  const engine = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/engine/package.json')));
  assert.equal(core.dependencies, undefined); assert.equal(runtime.dependencies, undefined);
  assert.deepEqual(engine.dependencies, { '@cloudflare/workers-types': workersTypes.version });
  assert.deepEqual(engine.peerDependencies, { '@tendriller/core': CORE_RELEASE });
  const hostProof = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/engine/provenance.json')));
  const packagesProof = JSON.parse(readFileSync(join(root, 'dist/provenance.json')));
  assert.equal(hostProof.repository, 'werg/tendriller');
  assert.match(hostProof.source, /^[a-f0-9]{40}$/); assert.match(hostProof.sourceTree, /^[a-f0-9]{40}$/);
  assert.equal(typeof hostProof.dirty, 'boolean');
  for (const key of ['repository', 'source', 'sourceTree', 'dirty']) assert.equal(packagesProof[key], hostProof[key]);
  for (const [file, hash] of Object.entries(hostProof.files))
    assert.equal(createHash('sha256').update(readFileSync(join(directory, 'node_modules/@tendriller/engine', file))).digest('hex'), hash);
  const testBindings = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/engine/testing-ratelimits.json'))).ratelimits;
  assert.deepEqual(testBindings.filter(binding => ['PAGE_RATE', 'ACCOUNT_RATE'].includes(binding.name)).map(binding => binding.name),
    ['PAGE_RATE', 'ACCOUNT_RATE']);
  assert.deepEqual(packagesProof.artifacts.map(item => item.name), ['@tendriller/core', '@tendriller/runtime', '@tendriller/engine']);
  for (const artifact of packagesProof.artifacts)
    assert.equal(createHash('sha256').update(readFileSync(join(root, 'dist', artifact.file))).digest('hex'), artifact.sha256);
  const peerProof = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/engine/peer-generation-provenance.json')));
  assert.equal(peerProof.dirty, false); assert.equal(peerProof.profile, 'peer-generation-v1');
  assert.ok(peerProof.inputs.every(input => !/(?:materializer|peer-session|transport-ssb|node-core\/src\/node\.ts|node:)/.test(input)));
  assert.equal(existsSync(join(directory, 'node_modules/@chronolog')), false, 'The engine embeds its portable participant dependency');
  for (const key of ['./records', './members', './scopes', './host']) assert.equal(core.exports[key], undefined);
  assert.equal(runtime.exports['./preview-support'], undefined);
  writeFileSync(join(directory, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createClient, requireService } from '@tendriller/core';
import { CONTRACT_VERSION, assertValid } from '@tendriller/core/contract';
import { createApplicationBinding } from '@tendriller/core/application';
import { createSignalBinding } from '@tendriller/core/signals';
import { createParticipantRequest, createParticipantResponse, createPeerIntroductions } from '@tendriller/core/peers';
import { startRuntime } from '@tendriller/runtime/kernel';
import { createVoice } from '@tendriller/runtime/voice';
import schema from '@tendriller/core/schema' with {type: 'json'};
import manifest from '@tendriller/runtime/manifest' with {type: 'json'};
const application = { id: '12'.repeat(32) };
assert.equal(CONTRACT_VERSION, 3); assert.equal(typeof startRuntime, 'function'); assert.equal(typeof createVoice, 'function');
assert.equal(schema.$defs.stateUpdate, undefined); assert.equal(schema.$defs.create.properties.application.properties.kind, undefined);
assert.ok(manifest.assets.some(file => file.path === 'tendril.js'));
assert.ok(manifest.assets.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
assertValid('create', {owner:'owner@example.test', application});
assert.throws(() => requireService({contract:2,core_release:'old',limits:{}}), /contract/);
let requests = 0;
const client = createClient({api:'https://host.test/api/t/test',token:'private'}, {applicationId: application.id, fetch: async (_url, init) => {
  requests++; return Response.json(createParticipantResponse(JSON.parse(init.body), null));
}});
assert.deepEqual(Object.keys(client).sort(), ['info', 'peers', 'request', 'service']);
assert.equal(requests, 0);
const introductions = createPeerIntroductions({ peers: client.peers, identity: '34'.repeat(32),
  openDirectConnection: async () => ({ close() {} }), openRelayConnection: async () => ({ close() {} }) });
assert.equal(typeof introductions.discovery.invitations, 'function');
assert.equal(typeof introductions.transport.open, 'function');
assert.equal(requests, 0);
const request = createParticipantRequest({applicationId: application.id, facet:'publication', action:'read', payload:{}});
assert.equal((await client.peers.exchange(request)).payload, null);
assert.equal(requests, 1);
await assert.rejects(client.peers.exchange({...request, facet:'database', action:'submit'}), {code:'PEER_PARTICIPANT_FACET_FORBIDDEN'});
assert.equal(requests, 1);
const selection = createApplicationBinding(application);
assert.throws(() => selection.backend, {code:'backend_unavailable'});
const signals = createSignalBinding();
await assert.rejects(signals.send('typing', null), {code:'signal_unavailable'});
`);
  run(process.execPath, ['consumer.mjs']);
  writeFileSync(join(directory, 'consumer.mts'), `
import {createClient, createPage} from '@tendriller/core';
import type {RuntimeApi, RuntimeConfiguration} from '@tendriller/core/contract';
import type {ApplicationBackend, ApplicationOperation} from '@tendriller/core/application';
import {createApplicationBinding} from '@tendriller/core/application';
import {startRuntime} from '@tendriller/runtime/kernel';
import {createVoice} from '@tendriller/runtime/voice';
import {createPeerIntroductions, type ParticipantRequest} from '@tendriller/core/peers';
declare const application: ApplicationBackend;
declare const runtime: RuntimeApi;
const cfg: RuntimeConfiguration = {id:'page',base:'/p/',version:0,documentPath:null,application:{id:'12'.repeat(32)},features:{speech:null,shared_by:'Owner'}};
const page = startRuntime(cfg, {application});
const installState:'installed'|'available'|'manual'|'unavailable'=page.installation.status().state;
const installChoice:'accepted'|'dismissed'|'unavailable'=await page.installation.prompt();
const offInstallation:()=>void=page.installation.on(status => { const platform:'ios'|'android'|'desktop'=status.platform; void platform; });
void installState; void installChoice; offInstallation();
const binding = createApplicationBinding(cfg.application, application);
const operation: ApplicationOperation = await binding.backend.submit({}, {operationId:'exact-id'});
if (operation.status === 'applied') { const outcome:'accepted'|'rejected'=operation.outcome; void outcome; }
const view = await binding.backend.readView();
const applied:'applied'=view.view;
await view.query('items'); await view.readEvents(); await view.release();
application.onRecovery(notice => { const loss:boolean=notice.unknownLoss; void loss; });
application.onStatus(status => { const peers:number=status.connectedPeers; void peers; });
await application.inspectRecovery();
const client = createClient({api:'https://host.test',token:'private'}, {applicationId: cfg.application.id});
void client.peers.application(); void client.peers.publication();
const introductions = createPeerIntroductions({ peers: client.peers, identity: '34'.repeat(32),
  openDirectConnection: async options => { const role:'offerer'|'answerer'=options.role; void role; return { kind:'raw' as const, close() {} }; },
  openRelayConnection: async options => { await options.relay.ready; return { kind:'raw' as const, close() {} }; } });
const raw = await introductions.transport.open({ peer: { identity:'56'.repeat(32), route:{kind:'invitation',peerId:'56'.repeat(32)} } }, { signal: new AbortController().signal });
const kind:'raw'=raw.kind; void kind;

void createPage('https://host.test', {owner:'owner@example.test',application:cfg.application});
declare const message: ParticipantRequest;
void client.peers.exchange(message);
void createVoice(page, {consent:async()=>true,transcript:()=>{},status:()=>{}});
// @ts-expect-error There is no parallel runtime profile.
runtime.kind;
// @ts-expect-error Host state is not an application backend.
runtime.state;
// @ts-expect-error No alternate finality view.
application.readView({view:'final'});
void applied;
`);
  writeFileSync(join(directory, 'worker.mts'), `
import worker, {Admission, Tendril} from '@tendriller/engine';
import {initializeTestService, createTestPage} from '@tendriller/engine/testing';
void initializeTestService([{name:'empty.sql',queries:[]}]);
async function test() {
  const page = await createTestPage({application:{id:'12'.repeat(32)}});
  await page.exchange('control/read'); await page.asset('page.mjs'); await page.restart();
}
void test;
export {Admission, Tendril};
export default {
  fetch(request, env, context) { return worker.fetch(request, env, context); },
  scheduled(event, env, context) { return worker.scheduled(event, env, context); },
} satisfies typeof worker;
`);
  run(process.execPath, [join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','es2022','--module','nodenext','--moduleResolution','nodenext','--lib','es2023,dom','consumer.mts','worker.mts']);
  console.log('Independent SDK/runtime/engine consumer passed with strict declarations and only public artifacts.');
} catch(error) {
  if(error.stdout) process.stderr.write(error.stdout);
  if(error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {rmSync(directory,{recursive:true,force:true});}
