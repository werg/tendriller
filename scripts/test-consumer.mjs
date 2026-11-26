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
  const peerProof = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/engine/authority-provenance.json')));
  assert.equal(peerProof.dirty, false); assert.equal(peerProof.profile, 'chronolog-crdt-v1');
  assert.ok(peerProof.inputs.every(input => !/(?:materializer|peer-session|transport-ssb|node-core\/src\/node\.ts|node:)/.test(input)));
  assert.equal(existsSync(join(directory, 'node_modules/@chronolog')), false, 'The engine embeds its portable participant dependency');
  for (const key of ['./records', './members', './scopes', './host', './assistant']) assert.equal(core.exports[key], undefined);
  assert.equal(runtime.exports['./preview-support'], undefined);
  writeFileSync(join(directory, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import * as core from '@tendriller/core';
import { createAgentClient, registerAgent, requireService, describeReadiness, requireCreationReady, requireServiceOrigin } from '@tendriller/core';
import { CONTRACT_VERSION, assertValid } from '@tendriller/core/contract';
import { createApplicationBinding } from '@tendriller/core/application';
import { onboardingDescriptor, ASSISTANT_GUIDES } from '@tendriller/core/onboarding';
assert.equal(onboardingDescriptor('https://example.test').firstApp.release.manifest,
  'https://github.com/werg/tendriller/releases/download/source-${hostProof.source}/manifest.json');
import { createSignalBinding } from '@tendriller/core/signals';
import { authorityRecord, authorityRecordBytes, createAuthorityClient } from '@tendriller/core/authority';
import { createPeerIntroductions } from '@tendriller/core/peers';
import { generateBroadcastKeyPair, signBroadcastPayload, verifyBroadcastSignature, evaluateBroadcastMatch } from '@tendriller/core/broadcasts';
import { attachPage } from '@tendriller/tools/workspace';
import { startRuntime } from '@tendriller/runtime/kernel';
import { createVoice, mountVoiceControls, SPEECH_DOWNLOAD_BYTES } from '@tendriller/runtime/voice';
import { pack } from '@tendriller/tools/pack';
import { withSession } from '@tendriller/tools/session';
import { startServer } from '@tendriller/tools/preview';
import schema from '@tendriller/core/schema' with {type: 'json'};
import manifest from '@tendriller/runtime/manifest' with {type: 'json'};
const application = { id: '12'.repeat(32) };
for (const api of [describeReadiness, requireCreationReady, requireServiceOrigin]) assert.equal(typeof api, 'function');
assert.equal(requireServiceOrigin('https://staging.example/'), 'https://staging.example');
for (const removed of ['createClient', 'createPage']) assert.equal(core[removed], undefined, 'The per-page token client was replaced by createAgentClient().page');
for (const api of [createAgentClient, registerAgent, attachPage]) assert.equal(typeof api, 'function');
assert.equal(onboardingDescriptor('https://staging.example').documentation.mcp, 'https://staging.example' + ASSISTANT_GUIDES.start);
for (const api of [pack, withSession, startServer]) assert.equal(typeof api, 'function');
const accounts = new DatabaseSync(':memory:');
accounts.exec(readFileSync(new URL(import.meta.resolve('@tendriller/engine/accounts-schema')), 'utf8'));
accounts.exec(readFileSync(new URL(import.meta.resolve('@tendriller/engine/agents-schema')), 'utf8'));
accounts.exec(readFileSync(new URL(import.meta.resolve('@tendriller/engine/broadcasts-schema')), 'utf8'));
accounts.exec(readFileSync(new URL(import.meta.resolve('@tendriller/engine/limits-schema')), 'utf8'));
accounts.exec(readFileSync(new URL(import.meta.resolve('@tendriller/engine/billing-schema')), 'utf8'));
for (const table of ['subscriptions', 'billing_events', 'usage_periods', 'active_relay_leases'])
  assert.equal(accounts.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)?.name, table);
assert.equal(accounts.prepare("SELECT name FROM sqlite_master WHERE name='system_broadcasts'").get().name, 'system_broadcasts');
for (const api of [generateBroadcastKeyPair, signBroadcastPayload, verifyBroadcastSignature, evaluateBroadcastMatch]) assert.equal(typeof api, 'function');
assert.equal(accounts.prepare("SELECT name FROM sqlite_master WHERE name='integration_oauth_grants'").get().name,
  'integration_oauth_grants');
assert.equal(accounts.prepare("SELECT COUNT(*) AS count FROM mcp_connections").get().count, 0);
for (const table of ['agents', 'agent_grants', 'agent_join_codes'])
  assert.equal(accounts.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)?.name, table);
assert.equal(accounts.prepare('SELECT COUNT(*) AS count FROM agents').get().count, 0);
accounts.close();
assert.equal(CONTRACT_VERSION, 3); assert.equal(typeof startRuntime, 'function'); assert.equal(typeof createVoice, 'function');
assert.equal(typeof mountVoiceControls, 'function'); assert.equal(SPEECH_DOWNLOAD_BYTES, 18224260);
assert.equal(schema.$defs.stateUpdate, undefined); assert.equal(schema.$defs.create, undefined); assert.equal(schema.$defs.pageHandle, undefined);
assert.ok(manifest.assets.some(file => file.path === 'tendril.js'));
assert.ok(manifest.assets.some(file => file.path === 'voice-pcm-worklet.js'));
assert.ok(manifest.assets.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
assertValid('agentRegistration', {owner:'owner@example.test', handle:'laptop', publicKey:'A'.repeat(43), wrapKey:'c'.repeat(64)});
assert.throws(() => assertValid('agentRegistration', {owner:'owner@example.test', handle:'laptop', publicKey:'A'.repeat(43)}), {name:'ContractError'}, 'registration requires the agent key-wrap key');
assertValid('agentPageCreate', {name:'Notes'});
assertValid('agentPageCreate', {name:'Board', mode:'dashboard', application});
assert.throws(() => assertValid('agentPageCreate', {name:'Board', mode:'legacy'}), {name:'ContractError'});
assert.throws(() => assertValid('create', {owner:'owner@example.test', application}));
assert.throws(() => requireService({contract:2,core_release:'old',limits:{}}), /contract/);
let requests = 0; const urls = [];
const agent = createAgentClient({service:'https://host.test',token:'ta_'+'a'.repeat(32)}, {fetch: async (url, init) => {
  requests++; urls.push(String(url)); return Response.json({ record: JSON.parse(init.body).record });
}});
const client = agent.page('aaaaaaaaaaaa', {applicationId: application.id});
assert.deepEqual(Object.keys(client).sort(), ['base', 'fetch', 'id', 'info', 'peers', 'request', 'service', 'socket']);
assert.equal(client.base, 'https://host.test/api/agent/pages/aaaaaaaaaaaa');
assert.equal(requests, 0);
const introductions = createPeerIntroductions({ peers: client.peers, identity: '34'.repeat(32),
  openDirectConnection: async () => ({ close() {} }), openRelayConnection: async () => ({ close() {} }) });
assert.equal(typeof introductions.discovery.invitations, 'function');
assert.equal(typeof introductions.transport.open, 'function');
assert.equal(requests, 0);
const request = authorityRecord(Uint8Array.of(0));
assert.deepEqual(authorityRecordBytes(await client.peers.participant(request)), Uint8Array.of(0));
assert.equal(typeof createAuthorityClient, 'function');
assert.equal(requests, 1);
assert.equal(urls[0], 'https://host.test/api/agent/pages/aaaaaaaaaaaa/peers/participant');
assert.equal(client.peers.exchange, undefined, 'No old facet transport remains');
assert.throws(() => authorityRecordBytes({record:'zz'}), {code:'authority_record_invalid'});
assert.equal(requests, 1);
const selection = createApplicationBinding(application);
assert.throws(() => selection.backend, {code:'backend_unavailable'});
const signals = createSignalBinding();
await assert.rejects(signals.send('typing', null), {code:'signal_unavailable'});
`);
  run(process.execPath, ['consumer.mjs']);
  writeFileSync(join(directory, 'consumer.mts'), `
import {createAgentClient, registerAgent, describeReadiness, requireCreationReady, requireServiceOrigin,
  type ServiceReadiness} from '@tendriller/core';
import type {RuntimeApi, RuntimeConfiguration} from '@tendriller/core/contract';
import type {ApplicationBackend, ApplicationOperation} from '@tendriller/core/application';
import {createApplicationBinding} from '@tendriller/core/application';
import {startRuntime} from '@tendriller/runtime/kernel';
import {createVoice, mountVoiceControls, type WakeState, type VoiceConsent} from '@tendriller/runtime/voice';
import {createPeerIntroductions} from '@tendriller/core/peers';
import type {AuthorityRecord} from '@tendriller/core/authority';
declare const application: ApplicationBackend;
declare const runtime: RuntimeApi;
const voice = createVoice(runtime, { consent(request: Readonly<VoiceConsent>) { return request.purpose === 'wake'; }, transcript(text: string) {} });
const modelStart: Promise<boolean> = voice.startWake({ phrase: 'Hey Tendril', mode: 'model' });
const wakeState: WakeState = voice.wakeStatus.state;
const microphone: boolean = voice.microphoneActive;
voice.stopWake();
const controls = mountVoiceControls(runtime, { transcript: async text => { const reviewed: string = text; void reviewed; } });
controls.dispose(); void modelStart; void wakeState; void microphone;
const cfg: RuntimeConfiguration = {id:'page',base:'/p/',version:0,documentPath:null,application:{id:'12'.repeat(32)},features:{speech:null,shared_by:'Owner'}};
const page = startRuntime(cfg, {application});
const installState:'installed'|'available'|'manual'|'unavailable'=page.installation.status().state;
const installChoice:'accepted'|'dismissed'|'unavailable'=await page.installation.prompt();
const offInstallation:()=>void=page.installation.on(status => { const platform:'ios'|'android'|'desktop'=status.platform; void platform; });
void installState; void installChoice; offInstallation();
const binding = createApplicationBinding(cfg.application, application);
const operation: ApplicationOperation = await binding.backend.submit({program:{},operationId:'exact-id'});
const inspection = await operation.inspect();
const stored:boolean=inspection.stored;
if (inspection.materialized) { const outcome:'accepted'|'rejected'=inspection.materialized.outcome; void outcome; }
const view = await binding.backend.readView();
const viewKind:'local'|'final'=view.revision.view;
await view.query('items'); await view.readEvents(); await view.release();
application.onStatus(status => { const canAuthor:boolean=status.canAuthor; const peers:number=status.connectedPeers; void canAuthor; void peers; });
const finalView=await application.readView({view:'final'}); await finalView.release();
void application.operations.get(operation.operationId); void stored;
const agent = createAgentClient({service:'https://host.test',token:'ta_'});
const client = agent.page('aaaaaaaaaaaa', {applicationId: cfg.application.id});
void agent.pages.create({name:'Notes'}); void agent.hub.events(event => void event.kind);
// @ts-expect-error The per-page token client was removed; pages are reached through the agent.
void import('@tendriller/core').then(core => core.createClient);
const origin: string = requireServiceOrigin('https://host.test');
const readiness: ServiceReadiness = await describeReadiness(origin, {signal:new AbortController().signal});
const ready: ServiceReadiness = requireCreationReady(readiness, {service:origin});
void ready;
void client.peers.application(); void client.peers.publication();
void client.peers.application({ signal: new AbortController().signal });
const introductions = createPeerIntroductions({ peers: client.peers, identity: '34'.repeat(32),
  openDirectConnection: async options => { const role:'offerer'|'answerer'=options.role; void role; return { kind:'raw' as const, close() {} }; },
  openRelayConnection: async options => { await options.relay.ready; return { kind:'raw' as const, close() {} }; } });
const raw = await introductions.transport.open({ peer: { identity:'56'.repeat(32), route:{kind:'invitation',peerId:'56'.repeat(32)} } }, { signal: new AbortController().signal });
const kind:'raw'=raw.kind; void kind;

void registerAgent('https://host.test', {owner:'owner@example.test',handle:'laptop',publicKey:'A'.repeat(43),wrapKey:'c'.repeat(64)});
declare const message: AuthorityRecord;
void client.peers.participant(message);
void createVoice(page, {consent:async()=>true,transcript:()=>{},status:()=>{}});
// @ts-expect-error There is no parallel runtime profile.
runtime.kind;
// @ts-expect-error Host state is not an application backend.
runtime.state;
// @ts-expect-error No ordering-recovery API exists.
application.inspectRecovery();
// @ts-expect-error Durable storage does not expose an ambiguous applied alias.
operation.applied();
void viewKind;
`);
  writeFileSync(join(directory, 'worker.mts'), `
import worker, {Admission, Tendril, AgentHub} from '@tendriller/engine';
void AgentHub;
import {initializeTestService, createTestPage} from '@tendriller/engine/testing';
void initializeTestService([{name:'empty.sql',queries:[]}]);
async function test() {
  const page = await createTestPage({application:{id:'12'.repeat(32)}});
  await page.exchange({record:'00'}); await page.asset('page.mjs'); await page.restart();
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
  // The native RTC dependency is pinned by the session archive and installed by npm.
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', join(directory, 'npm-cache'), resolve(root, sessionSource.slice(5))]);
  writeFileSync(join(directory, 'collaboration.mjs'), `
import assert from 'node:assert/strict';
import { createCollaborationDefinition, createCollaborationClient } from '@tendriller/core/collaboration';
import { openBrowserOwner, createBrowserIdentity } from '@tendriller/core/browser-owner';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { createNativeAttachmentKey, createNativeSessionSupervisor, createNativeWorkspaceSupervisor, attachNativeSession } from '@tendriller/core/native-owner';
import { diagnoseApplicationSession } from '@tendriller/core/diagnostics';
import { createTransportDiagnostics, readTransportDiagnostics } from '@tendriller/core/transport-diagnostics';
import { watchApplicationSetup } from '@tendriller/core/setup';
import { createAuthorityClient, authorityRecord, authorityRecordBytes } from '@tendriller/core/authority';
import { createApplicationSession, createLiveView, createScopedApplicationTools, createViewStore } from '@chronolog/peer-session';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { operationReference } from '@tendriller/core/collaboration';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { connectApplicationOwner, createLiveView as createBrowserLiveView } from '@chronolog/peer-session/browser';
for (const api of [createCollaborationDefinition, createCollaborationClient, openBrowserOwner,
  createBrowserIdentity, serveBrowserOwner, createNativeSessionSupervisor, attachNativeSession,
  diagnoseApplicationSession, createLiveView, createBrowserLiveView, createScopedApplicationTools,
  createViewStore, operationReference, createTransportDiagnostics, readTransportDiagnostics, createApplicationSession, createApplicationOwner,
  openNativeDevice, connectApplicationOwner, watchApplicationSetup, createNativeWorkspaceSupervisor, createAuthorityClient, authorityRecord, authorityRecordBytes]) assert.equal(typeof api, 'function');
const collaboration = createCollaborationDefinition({id:'consumer', version:'1'});
assert.equal(collaboration.definition.schema, undefined);
assert.equal(collaboration.definition.commands['collab.rebind'], undefined);
assert.ok(collaboration.initializationProgram.steps.some(step => typeof step.sql === 'string' && step.sql.startsWith('CREATE TABLE')));
const reference = operationReference({applicationId:'a'.repeat(64),identity:{publicKey:'b'.repeat(64)}},'exact-handle');
assert.equal(reference.proposalId,undefined);
assert.equal('generation' in reference,false);
assert.match(createNativeAttachmentKey(), /^td_n_[a-f0-9]{64}$/);
`);
  run(process.execPath, ['collaboration.mjs']);
  writeFileSync(join(directory, 'collaboration.mts'), `
import type {} from '@tendriller/core/browser';
import { createCollaborationDefinition, createCollaborationClient, type VerifiedOperationReference } from '@tendriller/core/collaboration';
import { openBrowserOwner, type BrowserOwnerOptions } from '@tendriller/core/browser-owner';
import { serveBrowserOwner, type BrowserOwnerConfiguration } from '@tendriller/core/worker-owner';
import { createNativeSessionSupervisor, attachNativeSession, type NativeSessionOwner } from '@tendriller/core/native-owner';
import { diagnoseApplicationSession, type DiagnosticReport } from '@tendriller/core/diagnostics';
import { createTransportDiagnostics, readTransportDiagnostics, type TransportDiagnosticReport } from '@tendriller/core/transport-diagnostics';
import { defineApplication, defineQuery, createApplicationSession, createLiveView, createScopedApplicationTools,
  type LiveView, type ApplicationSession, type MaterializedRevision, type OperationInspection,
  type SignedKeyWrap, createWrapKeyPair, importWrapPrivateKey } from '@chronolog/peer-session';
import type { WorkerApplicationSession } from '@chronolog/peer-session/browser';
import type { ApplicationDevice } from '@chronolog/peer-session';
import { createAuthorityClient, type EnrollmentChallenge } from '@tendriller/core/authority';
import { createAgentClient } from '@tendriller/core';
import { watchApplicationSetup } from '@tendriller/core/setup';
import { createAdmission, deviceWrapKey, type PageAdmission, type AdmissionState } from '@tendriller/core/admission';
const agentPage = createAgentClient({service:'https://service.example',token:'ta_'}).page('aaaaaaaaaaaa');
const setupWatch = watchApplicationSetup({page:agentPage,onChange(){}});
const authorityClient = createAuthorityClient(async (path, options) => ({path, options}));
declare const enrollment: EnrollmentChallenge;
const enrolledApplicationId: string = enrollment.applicationId;
void setupWatch.close; void authorityClient; void enrolledApplicationId;
declare const owner: NativeSessionOwner;
declare const browser: BrowserOwnerOptions;
declare const worker: BrowserOwnerConfiguration;
const collaboration = createCollaborationDefinition({id:'consumer',version:'1',members:['a'.repeat(64)]});
declare const nativeSession: ApplicationSession;
declare const browserSession: WorkerApplicationSession;
const client = createCollaborationClient({session:nativeSession});
const browserClient = createCollaborationClient({session:browserSession});
const report: DiagnosticReport = await diagnoseApplicationSession(nativeSession);
const attached = await openBrowserOwner(browser);
const browserView = createLiveView(attached.session, async view => {
  const rows = await view.query('SELECT title FROM notes');
  return rows.rows.map(row => String(row[0]));
});
const viewDefinition = defineApplication({id:'views',version:'1',commands:{},queries:{notes:defineQuery({description:'Read notes',input:{type:'null'},read:()=>['typed']})}});
declare const device: ApplicationDevice;
const opened = await createApplicationSession({device,definition:viewDefinition,applicationId:'a'.repeat(64)});
const initialized = await nativeSession.submit({program:collaboration.initializationProgram,operationId:'root-initialization',authorTimestampMs:1n});
const stored: boolean = initialized.stored;
const inspected: OperationInspection = await initialized.inspect();
const originalProposal: string = inspected.proposalId;
const pendingMaterializer: 'body'|'key'|'authority'|'materializer'|null = inspected.pending;
const projected = await initialized.materialized();
const projectionRevision: MaterializedRevision = projected.revision;
const peerEvidence = await initialized.retained({timeoutMs:1000});
const finalResult = await initialized.finalized({timeoutMs:1000});
const localOnly: boolean = stored && !inspected.finalized;
void originalProposal; void pendingMaterializer; void projectionRevision; void peerEvidence; void finalResult; void localOnly;
// @ts-expect-error Storage, projection and retention have independent APIs.
initialized.applied();
// @ts-expect-error There is no ambiguous shared acknowledgement.
initialized.shared();
// @ts-expect-error Schema is ordinary authorized DDL, not immutable setup metadata.
collaboration.definition.schema;
// The one admission mechanism: a member wraps the current keys to an admitted recipient's X25519 wrap key.
const recipientWrap = await createWrapKeyPair();
const keyWrap: SignedKeyWrap = await nativeSession.provisioning.wrapKeys('b'.repeat(64));
const installedEpochs: readonly number[] = await nativeSession.provisioning.unwrapKeys(keyWrap, await importWrapPrivateKey(recipientWrap.privateKey));
const admissionState: unknown = await browserSession.extensions.call('admission.state');
void installedEpochs; void admissionState;
const consumerAdmission: PageAdmission = createAdmission(nativeSession, { peers: authorityClient, wrapKey: await deviceWrapKey(device.store), subject: 'agent' });
const consumerPhase: AdmissionState['phase'] = consumerAdmission.state.phase;
void consumerPhase; consumerAdmission.close();
// @ts-expect-error Copy-paste provisioning requests no longer exist.
nativeSession.provisioning.createProvisioningRequest();
await browserSession.mergeAuthority(nativeSession.authority.bundle());
const inspector=createTransportDiagnostics(browserSession);
const transportReport:TransportDiagnosticReport=await inspector.refresh();
const oneShot:TransportDiagnosticReport=await readTransportDiagnostics(nativeSession);
window.tendril.transport.install(browserSession);
void transportReport;void oneShot;inspector.close();
const typedView: LiveView<readonly string[]> = createLiveView(opened, async view => {
  const rows = await view.query('SELECT title FROM notes');
  const applicationId: string = view.applicationId;
  void applicationId;
  return rows.rows.map(row => String(row[0]));
});
const coherent = await typedView.ready({timeoutMs:30000});
const digest: string = coherent.revision.digest;
const viewKind: 'local'|'final' = coherent.revision.view;
const values: readonly string[] = coherent.value;
// @ts-expect-error Typed derivation does not degrade its values to any.
const wrongValues: readonly number[] = coherent.value;
// @ts-expect-error Revisions are operation-set digests, not selected ordering heads.
coherent.revision.generation;
const captured = await browserClient.capture();
const tasks = await captured.tasks({limit:8});
const provenance: VerifiedOperationReference|undefined = tasks.value.tasks[0]?.operation;
const signedActor: string|undefined = provenance?.author;
const stableProposal: string|undefined = provenance?.proposalId;
void digest; void viewKind; void values; void wrongValues; void signedActor; void stableProposal;
await captured.close(); browserView.close(); typedView.close();
await attached.detach();
const serving = serveBrowserOwner(worker);
const supervisor = await createNativeSessionSupervisor({directory:'/private',profileId:'consumer',openOwner:()=>owner});
void attachNativeSession;
void collaboration; void client; void report; void serving; void supervisor;
`);
  run(process.execPath, [join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','es2022','--module','nodenext','--moduleResolution','nodenext','--lib','es2023,dom','collaboration.mts']);
  console.log('Independent SDK/runtime/engine/tools and pinned collaboration consumer passed runtime imports and strict declarations using only public artifacts.');
} catch(error) {
  if(error.stdout) process.stderr.write(error.stdout);
  if(error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {rmSync(directory,{recursive:true,force:true});}
