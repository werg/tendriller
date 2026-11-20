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
    ...['sdk', 'runtime', 'engine', 'tools'].map(name => join(root, 'dist', `tendriller-${name}-${CORE_RELEASE}.tgz`))]);
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
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import { createClient, requireService, describeReadiness, requireCreationReady, requireServiceOrigin } from '@tendriller/core';
import { CONTRACT_VERSION, assertValid } from '@tendriller/core/contract';
import { createApplicationBinding } from '@tendriller/core/application';
import { onboardingDescriptor, ASSISTANT_GUIDES } from '@tendriller/core/onboarding';
import { createAssistantKey, createApplicationAgentKey, proposeApplicationAssistant,
  connectApplicationAssistant, forwardApplicationEvents } from '@tendriller/core/assistant';
import { createSignalBinding } from '@tendriller/core/signals';
import { createParticipantRequest, createParticipantResponse, createPeerIntroductions } from '@tendriller/core/peers';
import { startRuntime } from '@tendriller/runtime/kernel';
import { createVoice } from '@tendriller/runtime/voice';
import { pack } from '@tendriller/tools/pack';
import { withSession } from '@tendriller/tools/session';
import { startServer } from '@tendriller/tools/preview';
import schema from '@tendriller/core/schema' with {type: 'json'};
import manifest from '@tendriller/runtime/manifest' with {type: 'json'};
const application = { id: '12'.repeat(32) };
for (const api of [describeReadiness, requireCreationReady, requireServiceOrigin]) assert.equal(typeof api, 'function');
assert.equal(requireServiceOrigin('https://staging.example/'), 'https://staging.example');
assert.equal(onboardingDescriptor('https://staging.example').documentation.mcp, 'https://staging.example' + ASSISTANT_GUIDES.start);
assert.match(createAssistantKey(), /^td_a_[a-f0-9]{64}$/);
for (const api of [createApplicationAgentKey, proposeApplicationAssistant, connectApplicationAssistant,
  forwardApplicationEvents, pack, withSession, startServer]) assert.equal(typeof api, 'function');
const accounts = new DatabaseSync(':memory:');
accounts.exec(readFileSync(new URL(import.meta.resolve('@tendriller/engine/accounts-schema')), 'utf8'));
accounts.exec(readFileSync(new URL(import.meta.resolve('@tendriller/engine/integration-oauth-schema')), 'utf8'));
assert.equal(accounts.prepare("SELECT name FROM sqlite_master WHERE name='integration_oauth_management_sessions'").get().name,
  'integration_oauth_management_sessions');
accounts.exec(readFileSync(new URL(import.meta.resolve('@tendriller/engine/assistant-connections-schema')), 'utf8'));
assert.equal(accounts.prepare("SELECT COUNT(*) AS count FROM assistant_connections").get().count, 0);
accounts.close();
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
import {createClient, createPage, describeReadiness, requireCreationReady, requireServiceOrigin,
  type ServiceReadiness} from '@tendriller/core';
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
const origin: string = requireServiceOrigin('https://host.test');
const readiness: ServiceReadiness = await describeReadiness(origin, {signal:new AbortController().signal});
const ready: ServiceReadiness = requireCreationReady(readiness, {service:origin});
void ready;
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
  // Collaboration is an optional SDK surface with an explicit public companion.
  // Install its exact archive only after proving the basic host needs no hidden
  // Chronolog dependency; never resolve it through the repository's node_modules.
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json')));
  const sessionSource = packageJson.devDependencies['@chronolog/peer-session'];
  assert.ok(sessionSource.startsWith('file:'), 'Pin the qualified public Chronolog archive.');
  run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund',
    '--cache', join(directory, 'npm-cache'), resolve(root, sessionSource.slice(5))]);
  writeFileSync(join(directory, 'collaboration.mjs'), `
import assert from 'node:assert/strict';
import { createCollaborationDefinition, createCollaborationClient } from '@tendriller/core/collaboration';
import { openBrowserOwner, createBrowserIdentity } from '@tendriller/core/collaboration/browser';
import { serveBrowserOwner } from '@tendriller/core/collaboration/worker';
import { createNativeAttachmentKey, createNativeSessionSupervisor, attachNativeSession } from '@tendriller/core/collaboration/native';
import { diagnoseApplicationSession } from '@tendriller/core/collaboration/diagnostics';
import { createSetupIntent, setupRequest, completeSetupIntent, inspectTendrilSetup } from '@tendriller/core/setup';
import { createDevicePairingClient, signDevicePairingChallenge, validateDevicePairingChallenge } from '@tendriller/core/pairing';
import { openPeerApplication, createApplicationOwner } from '@chronolog/peer-session';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
for (const api of [createCollaborationDefinition, createCollaborationClient, openBrowserOwner,
  createBrowserIdentity, serveBrowserOwner, createNativeSessionSupervisor, attachNativeSession,
  diagnoseApplicationSession, openPeerApplication, createApplicationOwner,
  openNativeDevice, connectApplicationOwner, createSetupIntent, setupRequest, completeSetupIntent,
  inspectTendrilSetup, createDevicePairingClient, signDevicePairingChallenge, validateDevicePairingChallenge]) assert.equal(typeof api, 'function');
assert.match(createNativeAttachmentKey(), /^td_n_[a-f0-9]{64}$/);
`);
  run(process.execPath, ['collaboration.mjs']);
  writeFileSync(join(directory, 'collaboration.mts'), `
import { createApplicationAgentKey, proposeApplicationAssistant, connectApplicationAssistant,
  type AssistantParticipant, type AssistantCallerContext } from '@tendriller/core/assistant';
import { createCollaborationDefinition, createCollaborationClient, type CollaborationSession } from '@tendriller/core/collaboration';
import { openBrowserOwner, type BrowserOwnerOptions } from '@tendriller/core/collaboration/browser';
import { serveBrowserOwner, type BrowserOwnerConfiguration } from '@tendriller/core/collaboration/worker';
import { createNativeSessionSupervisor, attachNativeSession, type NativeSessionOwner } from '@tendriller/core/collaboration/native';
import { diagnoseApplicationSession, type DiagnosticReport } from '@tendriller/core/collaboration/diagnostics';
import { createSetupIntent, completeSetupIntent, type SetupIntent, type SetupResult } from '@tendriller/core/setup';
import { createDevicePairingClient, signDevicePairingChallenge, type DevicePairingChallenge } from '@tendriller/core/pairing';
declare const setupIntent: SetupIntent;
declare const setupResult: SetupResult;
declare const pairingChallenge: DevicePairingChallenge;
const restored = await completeSetupIntent(setupIntent, setupResult);
const pairingClient = createDevicePairingClient({url: restored.api + '/peers/pairing'});
void createSetupIntent; void pairingClient; void signDevicePairingChallenge; void pairingChallenge;
declare const session: CollaborationSession;
declare const owner: NativeSessionOwner;
declare const browser: BrowserOwnerOptions;
declare const worker: BrowserOwnerConfiguration;
const definition = createCollaborationDefinition({id:'consumer',version:'1'});
const client = createCollaborationClient({session});
const report: DiagnosticReport = await diagnoseApplicationSession(session);
const attached = await openBrowserOwner(browser);
await attached.detach();
const serving = serveBrowserOwner(worker);
const supervisor = await createNativeSessionSupervisor({directory:'/private',profileId:'consumer',openOwner:()=>owner});
const key: string = createApplicationAgentKey();
void proposeApplicationAssistant; void connectApplicationAssistant; void attachNativeSession;
void definition; void client; void report; void serving; void supervisor; void key;
declare const participant: AssistantParticipant;
declare const caller: AssistantCallerContext;
void participant; void caller;
`);
  run(process.execPath, [join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','es2022','--module','nodenext','--moduleResolution','nodenext','--lib','es2023,dom','collaboration.mts']);
  console.log('Independent SDK/runtime/engine/tools and pinned collaboration consumer passed runtime imports and strict declarations using only public artifacts.');
} catch(error) {
  if(error.stdout) process.stderr.write(error.stdout);
  if(error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {rmSync(directory,{recursive:true,force:true});}
