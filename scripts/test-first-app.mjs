// Exercise the downloaded first-app source as an independent public-package consumer.
// The local host has synthetic account sessions; no OAuth provider or live service is used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { setGlobalDispatcher } from 'undici';
import { chromium, expect } from '@playwright/test';
import { expectConnectionInspector } from './first-app-connections.mjs';
import { TUTORIAL_FILES } from './onboarding.mjs';
import { readBrowserRtcEvidence, hasNonTurnTraffic } from './first-app-rtc-evidence.mjs';
import { createFirstAppWebsocketProxyWorker } from './first-app-websocket-host.mjs';
import { createLocalDispatcher, localCertificatePin, startPackedHost, writeLocalNetworkPreload,
  fixtureBrowserOptions } from './first-app-fixture.mjs';
import { verifyFirstAppComposition } from './first-app-composition.mjs';
import { FIRST_APP_PROFILES } from './release-composition.mjs';
import {prepareWorkspaceQualification,qualifyFirstAppWorkspace,qualifyFirstAppSqlWorkspace} from './first-app-workspace.mjs';
import { CONTRACT_VERSION } from '../contract/index.mjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const { values } = parseArgs({ options: {
  'session-archive': { type: 'string' }, 'authority-archive': { type: 'string' }, 'first-app-archive': { type: 'string' },
  profile: { type: 'string' }, 'ux-second-pass': { type: 'boolean' }, 'browser-finalizer': { type: 'boolean' }, diagnostic: { type: 'boolean' },
  'native-workspace':{type:'boolean'},'native-only':{type:'boolean'},'sql-native-only':{type:'boolean'},'feedback-qualification':{type:'boolean'},'network-lab-profile':{type:'string'},
  report: { type: 'string' }, keep: { type: 'boolean' }, transport: { type: 'string', default: 'direct' },
} });
if (!values['session-archive'] && !values['first-app-archive']) throw Error('Use --first-app-archive FILE or explicit --session-archive FILE --authority-archive FILE. Explicit source qualification may select --profile events|sql; exact kits select their own profile.');
if (values['session-archive'] && values['first-app-archive']) throw Error('Do not override the session in an immutable first-app kit');
if (values['session-archive'] && !values['authority-archive']) throw Error('An explicitly selected session also needs its matching public --authority-archive');
if (!['direct','relay'].includes(values.transport)) throw Error('Choose --transport direct or relay');
if (values['first-app-archive'] && values.profile) throw Error('An immutable kit selects first-app-profile.json; do not override its profile');
const selectedKitProfile = values['first-app-archive'] ? JSON.parse((await execute('tar', ['-xOf', resolve(values['first-app-archive']), 'first-app-profile.json'], { maxBuffer: 16 * 1024 })).stdout) : null;
const selectedProfile = selectedKitProfile?.profile ?? values.profile ?? 'events';
const profileSpec = FIRST_APP_PROFILES[selectedProfile];
assert.ok(profileSpec, 'Select the supported events or sql profile');
if (selectedKitProfile) assert.deepEqual(selectedKitProfile, { profile: selectedProfile, ...profileSpec }, 'The kit profile must name the exact selected package roles');
const sqlBrowser = selectedProfile === 'sql';
const feedbackQualification=Boolean(values['feedback-qualification']),networkLab=values['network-lab-profile'];
const nativeWorkspace=Boolean(values['native-workspace']||values['native-only']||values['sql-native-only']||feedbackQualification||networkLab);
if(values['native-only']&&sqlBrowser||values['sql-native-only']&&!sqlBrowser)throw Error('Choose native-only for events or sql-native-only with the exact full SQL composition');
if(nativeWorkspace&&sqlBrowser&&values['first-app-archive'])throw Error('Native SQL qualification needs the explicit clean full SQL archive; the immutable browser SQL kit deliberately omits native capability');
if((feedbackQualification||networkLab)&&sqlBrowser)throw Error('Feedback/network qualification requires the events notes profile');
if(networkLab&&(process.env.TENDRILLER_NETWORK_LAB!=='1'||values.transport!=='direct'||!values['first-app-archive']))throw Error('Network lab requires an isolated container, real RTC and an immutable first-app kit');
let sessionArchive = values['session-archive'] ? resolve(values['session-archive']) : undefined;
const reportPath = resolve(values.report ?? join(root, `.results/${sqlBrowser ? 'first-app-sql-browser' : 'first-app'}.json`));
const directory = await mkdtemp(join(tmpdir(), 'tfa-'));
const app = join(directory, 'application');
const npmCache = process.env.FIRST_APP_NPM_CACHE ? resolve(process.env.FIRST_APP_NPM_CACHE) : join(directory, 'npm-cache');
const portInput = process.env.FIRST_APP_PORT ?? '8790';
if (!/^[0-9]{1,5}$/.test(portInput) || Number(portInput) < 1 || Number(portInput) > 65535) throw Error('FIRST_APP_PORT must be an integer from 1 through 65535');
const PORT = Number(portInput), SERVICE = `https://service.localhost:${PORT}`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));
const report = { status: 'running', qualification: sqlBrowser ? 'isolated-browser-first-sql' : 'isolated-browser-first-events',
  native_checks: 'not-required', browser_checks: 'not-run', qualified: false,
  limits: ['Synthetic local owner sessions; no live OAuth provider tested.',
    'Two separate Chromium profiles, real browser RTC/forced relay; no Internet NAT or physical mobile qualification.',
    'Scripted desktop/320px tutorial; not an unaided fresh-agent usability result.',
    nativeWorkspace?'Optional native workspace is explicitly qualified after the complete browser-first baseline; physical inputs/external providers remain unqualified.':'Optional agent/inference and native process features are not exercised by this browser-first journey.',
    ...(values.diagnostic ? ['DIRTY DIAGNOSTIC ONLY: not release or finality qualification.'] : []),
    'A test-only WebSocket forwarding boundary isolates workerd close-handshake behavior; packed host code is unchanged.'], steps: [] };
if(values['ux-second-pass'])report.ux_second_pass={freshProfiles:true,viewports:[1280,320],checks:[],limits:[sqlBrowser?'SQL has no photo workflow; local file preview/consent/removal is exercised in the separate events UX run.':'Local file-picker preview/removal is tested; no physical camera/microphone or real inference provider.']};
const uxPassed=text=>{report.ux_second_pass.checks.push(text);passed('SECOND UX: '+text);};
let host, browser, labBrowser, page, stage = 'preflight';
const browserProfiles=[], browserNetwork=[];
const noteNetwork=value=>{if(browserNetwork.length===96)browserNetwork.shift();browserNetwork.push(value);};

// Every request is restricted to loopback hosts (scripts/first-app-fixture.mjs);
// the same factory is copied into the child-process preload below.
const dispatcher = createLocalDispatcher();
setGlobalDispatcher(dispatcher);

async function run(command, args, options = {}) {
  const result = await execute(command, args, { cwd: app, timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024, ...options });
  return result.stdout;
}
async function transportCounters() {
  const response = await fetch(SERVICE + '/__first_app_transport', {cache:'no-store'});
  if (!response.ok) throw Error('TRANSPORT_MEASUREMENT_UNAVAILABLE');
  return response.json();
}
function checkpoint(name) { stage = name; console.log(`First app: ${name}`); }
function passed(name) { report.steps.push(name); }
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
async function packDependency(name) {
  const path = dirname(require.resolve(`${name}/package.json`));
  const result = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--offline', '--json',
    '--cache', npmCache, '--pack-destination', directory, path]));
  return join(directory, result[0].filename);
}

try {
  await mkdir(app);
  await mkdir(dirname(reportPath), { recursive: true });
  const version = (await jsonFile(join(root, 'package.json'))).version;
  const proof = await jsonFile(join(root, 'dist/provenance.json'));
  const toolsProof = await jsonFile(join(root, 'dist/tools-manifest.json'));
  const archives = Object.fromEntries(['sdk', 'tools', 'engine', 'runtime'].map(name =>
    [name, join(root, 'dist', `tendriller-${name}-${version}.tgz`)]));
  if (values['authority-archive']) archives.authority = resolve(values['authority-archive']);
  if (sessionArchive) archives[profileSpec.session] = sessionArchive;
  if (!values.diagnostic) assert.equal(proof.dirty, false, 'A release qualification requires clean core artifacts');
  for (const artifact of [...proof.artifacts, ...toolsProof.artifacts]) {
    assert.equal(sha256(await readFile(join(root, 'dist', artifact.file))), artifact.sha256, `Archive changed: ${artifact.file}`);
  }
  report.core = { source: proof.source, dirty: proof.dirty, version,
    artifacts: Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, sha256(await readFile(path))]))) };
  let kit;
  if (values['first-app-archive']) {
    const archive = resolve(values['first-app-archive']);
    const release = await jsonFile(join(root, 'dist/manifest.json'));
    const manifestKit = sqlBrowser ? release.first_apps?.sql : release.first_app;
    const kitRole = sqlBrowser ? 'first-app-sql' : 'first-app';
    const record = release.artifacts.find(item => item.role === kitRole && item.file === manifestKit?.file);
    assert.ok(record, 'The release manifest must bind the selected first-app profile archive');
    assert.equal(manifestKit.profile, selectedProfile); assert.deepEqual(manifestKit.packages, profileSpec.packages);
    assert.equal(sha256(await readFile(archive)), record.sha256, 'The selected first-app archive must match the release manifest');
    const composition = JSON.parse(await run('tar', ['-xOf', archive, 'composition.json']));
    assert.deepEqual(composition.profiles?.[selectedProfile], profileSpec);
    const selectedPackages = join(directory, 'selected-packages'); await mkdir(selectedPackages);
    for (const role of profileSpec.packages) {
      const matches = composition.components.filter(item => item.role === role); assert.equal(matches.length, 1, `Exactly one ${role} package`);
      const item = matches[0]; assert.equal(item.file, basename(item.file)); assert.ok(Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 32 * 1024 * 1024);
      const extracted = await execute('tar', ['-xOf', archive, 'packages/' + item.file], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      assert.equal(extracted.stdout.length, item.size); assert.equal(sha256(extracted.stdout), item.sha256);
      if (archives[role]) assert.equal(sha256(await readFile(archives[role])), item.sha256, `The selected kit ${role} must match the local qualification graph`);
      const path = join(selectedPackages, item.file); await writeFile(path, extracted.stdout); archives[role] = path;
      if (role === profileSpec.session) sessionArchive = path;
    }
    await verifyFirstAppComposition({ release, composition, coreProof: proof, toolsProof, archives, version, contract: CONTRACT_VERSION, profile: selectedProfile });
    kit = { archive, release, composition, record, profile: selectedProfile };
    passed('complete exact-kit SDK/runtime/engine/tools identities before isolated host startup');
  }
  const engine = join(directory, 'engine'); await mkdir(engine);
  await run('tar', ['-xzf', archives.engine, '-C', engine]);
  const engineProof = await jsonFile(join(engine, 'package/provenance.json'));
  if (kit) {
    assert.equal(engineProof.dirty, false);
    assert.equal(engineProof.source, kit.composition.core.source, 'The packed host must have the exact composition source.');
    assert.equal(engineProof.sourceTree, kit.composition.core.sourceTree, 'The packed host must have the exact composition tree.');
  }
  for (const [path, hash] of Object.entries(engineProof.files))
    assert.equal(sha256(await readFile(join(engine, 'package', path))), hash, `Packed engine changed: ${path}`);

  // Decode only the actual canonical publication envelope in this private
  // qualifier. Bundle the exact selected PUBLIC authority archive, not host or
  // kernel sources. The raw/dev proxy remains dependency-free and gate-inert.
  const gateCodecRoot=join(directory,'publication-gate-authority');await mkdir(gateCodecRoot);
  await run('tar',['-xzf',archives.authority,'-C',gateCodecRoot]);
  const gatePackage=await jsonFile(join(gateCodecRoot,'package/package.json'));
  assert.equal(gatePackage.name,'@chronolog/authority');assert.equal(gatePackage.exports?.['.']?.import,'./index.mjs');
  const {build:bundleProxy}=await import('esbuild');
  const proxyBundle=await bundleProxy({stdin:{contents:`import {decodeFirstAppPublication} from ${JSON.stringify(join(root,'scripts/first-app-publication-codec.mjs'))};\n${createFirstAppWebsocketProxyWorker({decodePublicationExpression:'decodeFirstAppPublication'})}`,resolveDir:root,sourcefile:'first-app-publication-proxy.mjs'},absWorkingDir:root,bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',alias:{'@chronolog/authority':join(gateCodecRoot,'package/index.mjs')}});
  const qualificationProxy=proxyBundle.outputFiles[0].text;
  checkpoint('start isolated packed host');
  let existing;
  try { existing = await fetch(`${SERVICE}/health`, { signal: AbortSignal.timeout(1_000) }); } catch {}
  if (existing) { await existing.body?.cancel(); throw Error(`Port ${PORT} already serves a host. Choose an unused FIRST_APP_PORT for this isolated test; do not stop another session’s process.`); }
  host = await startPackedHost({ root, engine, directory, kit, port: PORT, proxyScript: qualificationProxy });
  const { ownerToken, oauthToken } = host;
  if (kit) {
    const readiness = await (await fetch(SERVICE + '/api/readiness')).json();
    assert.equal(readiness.serviceOrigin, SERVICE);
    assert.equal(readiness.build.sourceCommit, kit.composition.core.source);
    assert.equal(readiness.build.compositionId, kit.composition.id);
    assert.equal(readiness.creation.available, true);
    passed('actual isolated service readiness advertises the same source and composition');
  }
  passed('packed host with isolated storage');

  checkpoint('download first-app source and install exact public packages');
  const source = await fetch(`${SERVICE}/downloads/tendriller-first-app.tgz`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(source.status, 200, 'The domain must serve the first-app archive.');
  const sourceBytes = new Uint8Array(await source.arrayBuffer());
  report.tutorial_sha256 = sha256(sourceBytes);
  const sourceArchive = join(directory, 'first-app.tgz'); await writeFile(sourceArchive, sourceBytes);
  if (kit) {
    const { archive: firstAppArchive, composition, record } = kit;
    assert.equal(sha256(await readFile(firstAppArchive)), record.sha256, 'The first-app archive changed after preflight.');
    await run('tar', ['-xzf', firstAppArchive, '-C', app]);
    assert.deepEqual(await jsonFile(join(app, 'composition.json')), composition, 'Extracted first-app identity changed after preflight.');
    assert.equal(composition.components.find(item => item.role === 'starter')?.sha256, report.tutorial_sha256,
      'The isolated host must serve the starter bound by the release composition.');
    // Compare every extracted source file with the actual served archive, then
    // install the archives carried by the release kit, not checkout dependencies.
    for (const file of TUTORIAL_FILES) {
      const original = await execute('tar', ['-xOf', sourceArchive, file], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
      assert.equal(sha256(await readFile(join(app, file))), sha256(original.stdout), `First-app source changed: ${file}`);
    }
    for (const item of composition.components.filter(item => profileSpec.packages.includes(item.role))) {
      const path = join(app, 'packages', item.file);
      assert.equal(sha256(await readFile(path)), item.sha256, `First-app package changed: ${item.role}`);
      if (item.role === profileSpec.session) { sessionArchive = path; archives[item.role] = path; }
      else {
        if (archives[item.role]) assert.equal(sha256(await readFile(archives[item.role])), item.sha256);
        archives[item.role] = path;
      }
    }
    assert.ok(sessionArchive, 'The first-app archive must carry its pinned session package.');
    report.composition = { id: composition.id, first_app_sha256: record.sha256 };
  } else await run('tar', ['-xzf', sourceArchive, '-C', app]);
  const buildDependencies = [await packDependency('esbuild'),
    await packDependency(`@esbuild/${process.platform}-${process.arch}`)];
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', npmCache, archives.sdk, archives.tools, archives.authority, sessionArchive, ...buildDependencies]);
  const sessionProof = await jsonFile(join(app, 'node_modules/@chronolog/peer-session/provenance.json'));
  if (!values.diagnostic) assert.equal(sessionProof.dirty, false, 'Use a clean, explicitly selected public Chronolog archive.');
  const authorityProof = await jsonFile(join(app, 'node_modules/@chronolog/authority/provenance.json'));
  if (!values.diagnostic) assert.equal(authorityProof.dirty, false, 'Use matching clean public authority artifacts');
  assert.equal(authorityProof.source, sessionProof.source, 'Authority and session must share a source checkpoint');
  assert.equal(authorityProof.sourceTree, sessionProof.sourceTree, 'Authority and session must share a source tree');
  report.chronolog = { source: sessionProof.source, dirty: sessionProof.dirty, sha256: sha256(await readFile(sessionArchive)) };
  report.profile = selectedProfile;
  if (sqlBrowser) { if(nativeWorkspace){assert.ok(sessionProof.sqlEngines?.includes('native')&&sessionProof.sqlEngines.includes('browser'),'Explicit native SQL qualification requires the full native+browser archive');}else assert.deepEqual(sessionProof.sqlEngines,['browser'],'The SQL kit is a portable browser profile, not a native SQL install'); assert.ok(sessionProof.wasmEngine); report.chronolog.wasmEngine = sessionProof.wasmEngine; }


  const preload = await writeLocalNetworkPreload(join(directory, 'local-network.mjs'));
  const slug=sqlBrowser?'stock':'notes',project=join(app,'pages',slug);
  const node=async(args,options={})=>run(process.execPath,['--import',preload,...args],{cwd:app,...options});
  const cli=join(app,'node_modules/@tendriller/tools/bin/tendril.mjs');
  const tendril=async(args,options)=>JSON.parse(await node([cli,...args],options));
  const setup=async args=>JSON.parse(await node([join(app,'setup.mjs'),...args]));
  passed('domain-served workspace templates/shared helpers and independently installed exact public packages');
  checkpoint('register one workspace agent, grant pages, prepare and publish before browser roots or native agent');
  const enrolled=await tendril(['workspace','init','--service',SERVICE,'--owner','owner@example.test','--handle','first-app']);
  const workspaceFile=await jsonFile(join(app,'tendriller.json')),credential=await jsonFile(join(app,'.tendriller/agent/credential.json'));
  assert.match(credential.token,/^ta_[a-z2-7]{32}$/);assert.equal(JSON.stringify(enrolled).includes(credential.token),false);assert.equal(JSON.stringify(workspaceFile).includes(credential.token),false);
  const created=await setup(['new',slug,'--template',sqlBrowser?'inventory':'notes','--name',sqlBrowser?'SQL browser qualification':'Browser qualification']);
  const resumed=await setup(['new',slug,'--template',sqlBrowser?'inventory':'notes']);assert.equal(resumed.id,created.id);
  const journal=await setup(['new','journal','--template','notes','--name','Second explicitly granted workspace page']);
  const journalInit=await setup(['init','journal']);assert.equal(journalInit.creator,'agent');const journalPublication=await setup(['deploy','journal']);assert.match(journalPublication.publicationId,/^[a-f0-9]{64}$/);
  const pageRecord=await jsonFile(join(app,'.tendriller/pages',created.id,'page.json'));
  const handle={id:pageRecord.id,application:pageRecord.application,page_url:pageRecord.page_url};
  const requestHost=async(path,init={})=>{const response=await fetch(SERVICE+'/api/agent/pages/'+handle.id+'/'+path,{...init,headers:{Authorization:'Bearer '+credential.token,...init.headers}});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  if(nativeWorkspace&&!sqlBrowser)await prepareWorkspaceQualification({app,slug,feedback:feedbackQualification,network:networkLab});
  // The browser baseline lets the owner's first browser create the page data; the journal page is agent-first.
  await setup(['init',slug,'--browser-first',...(values['browser-finalizer']?['--browser-finalizer']:[])]);
  assert.equal((await requestHost('application')).authority,null,'A browser-first page has no data until its first browser creates it');
  const prepared=await jsonFile(join(app,'.tendriller/pages',created.id,'prepared.json')),secondPrepared=await jsonFile(join(app,'.tendriller/pages',journal.id,'prepared.json'));
  assert.equal(prepared.publisherKey,secondPrepared.publisherKey,'Every page uses the SAME registered workspace signer, never per-page signing keys');
  const publication=await setup(['deploy',slug]);assert.match(publication.publicationId,/^[a-f0-9]{64}$/);
  assert.equal((await requestHost('application')).authority,null,'Publication precedes the first browser-created data key');
  assert.equal((await setup(['deploy',slug])).publicationId,publication.publicationId,'Lost/uncertain publication replies reuse the original signed graph');
  for(const path of await files(join(project,'dist')))assert.doesNotMatch(path,/\.tendriller|device\.sqlite|identity\.sqlite|publisher\.json/);
  report.workspace={agentId:workspaceFile.agent.id,pages:[created.id,journal.id],oneSharedPublisher:true,nativeProcessBeforeBrowser:false};
  passed('one account-agent credential, explicit page grants, shared opaque signer and signed pages without running native agent');
  // Independently qualify the current linked-account registration route, never
  // fall back to removed per-page credentials or copy an OAuth token into assets.
  const linked=join(directory,'linked-workspace');await mkdir(linked);
  const key=await tendril(['workspace','key','--service',SERVICE,'--handle','linked-agent'],{cwd:linked});
  const response=await fetch(SERVICE+'/mcp',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+oauthToken,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'register_agent',arguments:key.register_agent}})});
  assert.equal(response.status,200);const reply=await response.json();assert.ok(reply.result&&!reply.result.isError);const registered=reply.result.structuredContent;
  const record=join(linked,'registration.json');await writeFile(record,JSON.stringify(registered),{mode:0o600,flag:'wx',flush:true});
  await tendril(['workspace','adopt','--service',SERVICE,'--credential',record],{cwd:linked});
  passed('account-linked register_agent and private workspace adoption preserve the selected service and shared signer');
  report.publication_id = publication.publicationId; passed('independent signed code publication and exact retry before first data root');

  checkpoint('launch real fresh browser profiles with no native data process');
  const certificatePin = await localCertificatePin(PORT);
  const browserOptions = fixtureBrowserOptions({ certificatePin, port: PORT });
  if(networkLab){const{launchNetworkBrowser}=await import('../test/e2e/network-qualification/browser-launch.mjs');labBrowser=await launchNetworkBrowser(browserOptions);browser=labBrowser.browser;}else browser=await chromium.launch(browserOptions);
  report.browser = browser.version(); report.browser_checks = 'running'; report.screenshots = {};
  async function profile(viewport) {
    const context=labBrowser&&browserProfiles.length===0?labBrowser.context:await browser.newContext({viewport});
    await context.addCookies([{ name: '__Host-tendriller', value: ownerToken, domain: 'service.localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await context.addInitScript(({ relay }) => {
      const Native = globalThis.RTCPeerConnection; globalThis.__firstAppRtcPeers = [];
      globalThis.RTCPeerConnection = class extends Native { constructor(...args) { if (relay) throw Error('QUALIFICATION_RTC_UNAVAILABLE'); super(...args); globalThis.__firstAppRtcPeers.push(this); } };
    }, { relay: values.transport === 'relay' });
    if (process.env.FIRST_APP_NO_SHARED_WORKER === '1') await context.addInitScript(() => { delete globalThis.SharedWorker; });
    const label=browserProfiles.length?'second':'first';
    context.on('response',response=>{const url=new URL(response.url());if(response.status()>=400&&url.pathname.includes('/peers/'))noteNetwork({profile:label,type:'http',route:url.pathname.split('/peers/').at(-1).split('/').slice(0,2).join('/'),status:response.status()});});
    context.on('requestfailed',request=>{const url=new URL(request.url());if(url.pathname.includes('/peers/'))noteNetwork({profile:label,type:'failed',route:url.pathname.split('/peers/').at(-1).split('/').slice(0,2).join('/'),error:request.failure()?.errorText?.slice(0,160)});});
    context.on('console',message=>{if(message.type()==='warning'||message.type()==='error')noteNetwork({profile:label,type:'console',message:message.text().slice(0,240)});});
    const target = await context.newPage();
    await target.setViewportSize(viewport);
    target.on('pageerror', error => { report.browser_errors ??= []; if (report.browser_errors.length < 12) report.browser_errors.push(error.message.slice(0, 300)); });
    browserProfiles.push({label,page:target});
    await target.goto(handle.page_url); return { context, page: target };
  }
  const first = await profile({ width: 1280, height: 960 }); page = first.page;
  const saveButton = target => target.locator(sqlBrowser ? '#initialize' : '#submit');
  await expect(saveButton(page)).toBeEnabled({ timeout: 60_000 });
  const firstKey = await page.locator('#public-key').inputValue(); assert.match(firstKey, /^[a-f0-9]{64}$/);
  report.owner_route = process.env.FIRST_APP_NO_SHARED_WORKER === '1' || sqlBrowser ? 'elected' : 'shared-or-elected';
  const screenshot = async (target, label) => { const file = `first-app-${sqlBrowser ? 'sql-' : ''}${label}.png`; await target.screenshot({ path: join(dirname(reportPath), file), fullPage: true }); report.screenshots[label] = file; };
  await screenshot(page, 'desktop-before');
  async function selectDomainWithoutNavigation(selector) {
    const beforeHash = new URL(page.url()).hash;
    const identity = await page.evaluate(() => {
      window.__firstAppDomainDocument = crypto.randomUUID();
      return { marker: window.__firstAppDomainDocument, timeOrigin: performance.timeOrigin };
    });
    const sameDocument = async () => {
      assert.deepEqual(await page.evaluate(() => ({ marker: window.__firstAppDomainDocument ?? null, timeOrigin: performance.timeOrigin })), identity,
        'Domain selection and browser history must not reload or replace the document under the publication base URL');
      assert.equal(await page.evaluate(() => Boolean(window.tendril.application.backend)), true, 'The installed local backend survives fragment navigation');
    };
    if(values['ux-second-pass']){await page.locator(selector).first().focus();await page.keyboard.press('Enter');}else await page.locator(selector).first().click();
    await expect.poll(() => new URL(page.url()).hash).not.toBe(beforeHash);
    const selectedHash = new URL(page.url()).hash; await sameDocument();
    await page.goBack(); await expect.poll(() => new URL(page.url()).hash).toBe(beforeHash); await sameDocument();
    await page.goForward(); await expect.poll(() => new URL(page.url()).hash).toBe(selectedHash); await sameDocument();
    passed('domain selection, Back and Forward preserve document identity, performance.timeOrigin and the installed backend');
    return selectedHash;
  }
  let originalOperation;
  if (sqlBrowser) {
    await page.locator('#author-time').fill('1000'); await page.locator('#initialize').click();
    await expect(page.locator('#stock tr')).toHaveCount(2, { timeout: 60_000 });
    originalOperation = await page.locator('#op-id').inputValue();
    await selectDomainWithoutNavigation('#stock a');
    await page.locator('#from').fill('source'); await page.locator('#to').fill('destination'); await page.locator('#units').fill('2');
    await page.locator('#review-balances').click();
    await page.locator('#bin-id').fill('unsent-bin-draft');
    await page.locator('#author-time').fill('0'); await page.locator('#initialize').click();
    await page.locator('#op-id').fill(originalOperation); await page.locator('#inspect').click();
    await expect(page.locator('#result')).toContainText('rejected', { timeout: 60_000 });
    await expect(page.locator('#bin-id')).toHaveValue('unsent-bin-draft');
    await page.locator('#author-time').fill('2000'); await page.locator('#add-labels').click();
    await expect(page.locator('#label-editor')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#schema')).toContainText('label');
    await page.locator('#author-time').fill('');
    passed('ordinary late earlier DDL revises a previous SQL outcome, invalidates catalog/forms and preserves draft');
  } else {
    await page.locator('#note').fill('first durable note'); await page.locator('#submit').click();
    await expect(page.locator('#notes')).toContainText('first durable note', { timeout: 30_000 });
    originalOperation = await page.locator('#operation-id').inputValue();
    await expect(page.locator('#operation-status')).toContainText('Stored locally: yes');
    const selectedLink = await selectDomainWithoutNavigation('#notes a');
    await page.locator('#note').fill('unsent draft survives earlier operation');
    if(values['ux-second-pass']){await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');}
    const selectedCaret=values['ux-second-pass']?await page.locator('#note').evaluate(node=>[node.selectionStart,node.selectionEnd]):null;
    await page.evaluate(async () => {
      const operation = await window.tendril.application.backend.submit({ operationId: 'late-earlier-note', authorTimestampMs: 0n,
        program: { version: 3, steps: [{ op: 'emit', topic: 'note.put', payload: { noteId: 'earlier-stable-id', text: 'late earlier note' } }] } });
      await operation.materialized();
    });
    await expect(page.locator('#notes li')).toHaveCount(2);
    await expect(page.locator('#notes a').first()).toHaveText('late earlier note');
    await expect(page.locator('#note')).toHaveValue('unsent draft survives earlier operation');
    assert.equal(new URL(page.url()).hash, selectedLink);
    if(values['ux-second-pass']){await expect(page.locator('#note')).toBeFocused();assert.deepEqual(await page.locator('#note').evaluate(node=>[node.selectionStart,node.selectionEnd]),selectedCaret);uxPassed('desktop keyboard selection, Back/deep link and caret/focus survive earlier incoming work');}
    passed('late earlier authored operation reorders the domain without replacing draft or deep link');
  }
  if(values['ux-second-pass']){
    await screenshot(page,'ux-desktop-before');
    if(sqlBrowser){
      const id='long-bin-'+ 'b'.repeat(40),label='Long label '+ 'L'.repeat(100);
      await page.locator('#bin-id').fill(id);await page.locator('#bin-units').fill('4');await page.locator('#bin-label').fill(label);
      await page.locator('#bin-form button[value=add]').click();await expect(page.locator('#stock')).toContainText(id);await page.getByRole('button',{name:'Store label edit',exact:true}).click();await expect(page.locator('#stock')).toContainText(label);
      await page.locator('#stock a').filter({hasText:id}).focus();await page.keyboard.press('Enter');await expect(page.locator('#bin-detail')).toContainText(id);
      await page.locator('#bin-id').fill('unsent-bin-draft');
    }else{
      const max=await page.locator('#note').evaluate(node=>node.maxLength),text=('Long allowed note '+ 'Unbroken'.repeat(300)).slice(0,max>0?Math.min(max,2000):1800);
      await page.locator('#new').click();await page.locator('#note').fill(text);await page.keyboard.press('Tab');await expect(page.locator('#submit')).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(page.locator('#note')).toBeFocused();
      await page.locator('#submit').click();await expect(page.locator('#notes')).toContainText('Long allowed note');
      await page.locator('#notes a').filter({hasText:'Long allowed note'}).focus();await page.keyboard.press('Enter');await expect(page.locator('#detail-text')).toHaveText(text);
      await page.locator('#note').fill('unsent draft survives earlier operation');
      await page.locator('#operation-id').fill('ux-unavailable-original');await page.locator('#inspect').click();await expect(page.locator('#operation-status')).toContainText(/No.*(?:operation|proposal)|not.*found|unavailable/i);
      await expect(page.locator('#note')).toHaveValue('unsent draft survives earlier operation');await expect(page.locator('#submit')).toBeEnabled();
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Desktop long content must wrap without page overflow');
    uxPassed(sqlBrowser?'desktop long SQL bin/label content and keyboard domain selection':'desktop long allowed note, keyboard activation and retained draft after an unavailable inspector action');
    await screenshot(page,'ux-desktop-after');
  }
  await screenshot(page, 'desktop-after');
  checkpoint('save complete graph, disconnect and reload before offline CRUD');
  await page.locator(sqlBrowser ? '#offline' : '#save-offline').click();
  await expect(page.locator('#offline-status')).toContainText('Offline ready:', { timeout: 60_000 });
  await first.context.setOffline(true); await page.reload();
  await expect(saveButton(page)).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#public-key')).toHaveValue(firstKey);
  if (sqlBrowser) {
    await expect(page.locator('#stock tr')).toHaveCount(values['ux-second-pass']?3:2, { timeout: 60_000 });
    await expect(page.locator('#bin-id')).toHaveValue('unsent-bin-draft');
    await page.locator('#bin-id').fill('offline-bin'); await page.locator('#bin-units').fill('3');
    await page.locator('#bin-form button[value=add]').click();
    await expect(page.locator('#stock')).toContainText('offline-bin', { timeout: 60_000 });
  } else {
    await expect(page.locator('#note')).toHaveValue('unsent draft survives earlier operation');
    await page.locator('#new').click(); await page.locator('#note').fill('offline durable note'); await page.locator('#submit').click();
    await expect(page.locator('#notes')).toContainText('offline durable note', { timeout: 30_000 });
  }
  await page.reload(); await expect(saveButton(page)).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator(sqlBrowser ? '#stock' : '#notes')).toContainText(sqlBrowser ? 'offline-bin' : 'offline durable note', { timeout: 60_000 });
  passed('complete immutable graph acknowledgment, offline local CRUD and reload with the same signing identity');
  await first.context.setOffline(false);

  checkpoint('second profile signs in and is admitted automatically by the first browser');
  const second = await profile({ width: 320, height: 800 });
  await expect(second.page.locator('#public-key')).toHaveValue(/^[a-f0-9]{64}$/, { timeout: 60_000 });
  const secondKey = await second.page.locator('#public-key').inputValue(); assert.notEqual(secondKey, firstKey);
  await screenshot(second.page, 'phone-before-admission');
  // Plain sign-in only: the online first browser verifies the host attestation against the pinned key
  // and owner account, signs the admission and wraps the keys. No code, request or package is copied.
  await expect(saveButton(second.page)).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#devices')).toContainText('New device signed in', { timeout: 30_000 });
  await expect(page.locator('#devices')).toContainText(`${secondKey.slice(0, 8)}…${secondKey.slice(-4)}`);
  await expect(second.page.locator(sqlBrowser ? '#stock' : '#notes')).toContainText(sqlBrowser ? 'offline-bin' : 'offline durable note', { timeout: 60_000 });
  // Both replicas list both devices from the signed membership; the phone marks itself.
  for (const target of [page, second.page]) for (const key of [firstKey, secondKey]) await expect(target.locator('#devices .admission-members')).toContainText(`key ${key.slice(0, 8)}…${key.slice(-4)}`, { timeout: 30_000 });
  await expect(second.page.locator('#devices .admission-members')).toContainText('(this device)');
  report.second_device = { admission: 'attested', copiedArtifacts: 0 };
  let uxDeniedOperation;
  if (sqlBrowser) {
    if(values['ux-second-pass']){
      await second.page.locator('#bin-id').fill('source');await second.page.locator('#bin-units').fill('11');await second.page.locator('#bin-expected').fill('10');await second.page.locator('#bin-form button[value=edit]').click();
      await expect(second.page.locator('#result')).toContainText('rejected');await expect(second.page.locator('#bin-id')).toHaveValue('source');uxDeniedOperation=await second.page.locator('#op-id').inputValue();await expect(saveButton(second.page)).toBeEnabled();
      uxPassed("phone crypto writer without SQL grants stores a visibly rejected update to a different author’s bin without losing its draft or disabling unrelated authoring");
      await page.locator('#bin-id').fill('ux peer-arrival draft');await page.locator('#bin-id').focus();
    }
    const previousGrantSelection=await page.locator('#op-id').inputValue();
    await page.locator('#sql-grantee').fill(secondKey); await page.locator('#sql-grant').click();
    await expect(page.locator('#op-id')).not.toHaveValue(previousGrantSelection);
    const grantOperation=await page.locator('#op-id').inputValue();
    await expect(page.locator('#result')).toContainText(grantOperation,{timeout:30000});
    await expect(page.locator('#result')).toContainText('accepted', { timeout: 30_000 });
    if(values['ux-second-pass'])report.ux_second_pass.sql_grant=await page.evaluate(async id=>{const value=await(await window.tendril.application.backend.operations.get(id)).inspect();return{operationId:value.operationId,proposalId:value.proposalId,authorTimestampMs:value.authorTimestampMs,materialized:value.materialized?.outcome};},grantOperation);
    if(values['ux-second-pass']){
      const before=await second.page.evaluate(async id=>(await(await window.tendril.application.backend.operations.get(id)).inspect()),uxDeniedOperation);
      await second.page.locator('#retry').click();await expect(second.page.locator('#result')).toContainText('rejected');
      const after=await second.page.evaluate(async id=>(await(await window.tendril.application.backend.operations.get(id)).inspect()),uxDeniedOperation);assert.equal(after.proposalId,before.proposalId);assert.equal(after.authorTimestampMs,before.authorTimestampMs);report.ux_second_pass.sql_original_retry={original:{operationId:before.operationId,proposalId:before.proposalId,authorTimestampMs:before.authorTimestampMs,outcome:before.materialized?.outcome},retried:{operationId:after.operationId,proposalId:after.proposalId,authorTimestampMs:after.authorTimestampMs,outcome:after.materialized?.outcome}};await expect(second.page.locator('#bin-id')).toHaveValue('source');
      uxPassed('retry retains the exact rejected proposal/time/ID and reviewed draft after a later SQL grant; no silent retimestamp');
    }
    await second.page.locator('#from').fill('source'); await second.page.locator('#to').fill('destination'); await second.page.locator('#units').fill('2');
    await second.page.locator('#review-balances').click(); if(values['ux-second-pass'])await page.locator('#bin-id').focus(); await second.page.locator('#transfer button[type=submit],#transfer button:not([type])').click();
    await expect(second.page.locator('#result')).toContainText('accepted', { timeout: 60_000 });
    await expect(page.locator('#receipts')).toContainText('2 units', { timeout: 60_000 });
    if(values['ux-second-pass']){await expect(page.locator('#bin-id')).toBeFocused();await expect(page.locator('#bin-id')).toHaveValue('ux peer-arrival draft');uxPassed('SQL peer transfer invalidates rows/receipts without replacing focused local draft');}
    passed('separate ordinary SQL column/insert grants, browser-to-browser guarded transfer and materialized remote read');
  } else {
    if(values['ux-second-pass']){await page.locator('#note').fill('ux peer-arrival draft');await page.locator('#note').focus();}
    await second.page.locator('#note').fill('second-profile note'); await second.page.locator('#submit').click();
    await expect(page.locator('#notes')).toContainText('second-profile note', { timeout: 60_000 });
    const note = second.page.locator('#notes a').filter({ hasText: 'second-profile note' }); await note.click(); await second.page.locator('#edit').click();
    await second.page.locator('#note').fill('second-profile edited'); await second.page.locator('#submit').click();
    await expect(page.locator('#notes')).toContainText('second-profile edited', { timeout: 60_000 });
    await second.page.locator('#delete').click(); await expect(page.locator('#notes')).not.toContainText('second-profile edited', { timeout: 60_000 });
    if(values['ux-second-pass']){await expect(page.locator('#note')).toBeFocused();await expect(page.locator('#note')).toHaveValue('ux peer-arrival draft');uxPassed('phone create/edit/delete converges while the desktop focused draft survives incoming work');}
    passed('two automatically admitted browser authors converge across create/edit/delete without native process');
  }
  if(values['ux-second-pass']){
    checkpoint('separate second UX pass: phone long content, selected facts and optional local media');
    await screenshot(second.page,'ux-phone-before');
    const phoneField=second.page.locator(sqlBrowser?'#units':'#note');await phoneField.focus();await second.page.keyboard.press('Tab');await expect(second.page.locator(sqlBrowser?'#expected-source':'#submit')).toBeFocused();await second.page.keyboard.press('Shift+Tab');await expect(phoneField).toBeFocused();
    const phoneLong=second.page.locator(sqlBrowser?'#stock a':'#notes a').filter({hasText:sqlBrowser?'long-bin-':'Long allowed note'});
    const phoneDocument=await second.page.evaluate(()=>performance.timeOrigin);await phoneLong.focus();await second.page.keyboard.press('Enter');assert.equal(await second.page.evaluate(()=>performance.timeOrigin),phoneDocument);await expect(second.page.locator(sqlBrowser?'#bin-detail':'#detail-text')).toContainText(sqlBrowser?'long-bin-':'Long allowed note');
    uxPassed('320px keyboard Tab/Shift+Tab, Enter deep link and long domain detail remain in the same document');
    if(!sqlBrowser){
      const observer=page;
      await observer.evaluate(()=>{window.__uxSignals=[];window.__uxSignalStop=new AbortController();window.__uxSignalTask=(async()=>{try{for await(const value of window.tendril.signals.subscribe({mode:'all',signal:window.__uxSignalStop.signal}))window.__uxSignals.push(value.topic);}catch(error){if(!window.__uxSignalStop.signal.aborted)throw error;}})();});
      await expect.poll(async()=>{await second.page.evaluate(()=>window.tendril.signals.send('ux/media-boundary-probe',{ready:true}));return observer.evaluate(()=>window.__uxSignals.includes('ux/media-boundary-probe'));},{timeout:15000}).toBe(true);
      const eventCount=async()=>second.page.evaluate(async()=>{const view=await window.tendril.application.backend.readView();try{return(await view.readEvents()).events.length;}finally{await view.release();}});
      const before=await eventCount();await second.page.locator('#note').fill('UX media cancellation draft');
      await second.page.getByText('Optional agent, media and finality',{exact:true}).click();
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64');
      await second.page.locator('#photo').setInputFiles({name:'ux-local-a.png',mimeType:'image/png',buffer:png});await expect(second.page.locator('#photo-preview')).toBeVisible();await expect(second.page.locator('#analysis-consent')).not.toBeChecked();
      assert.match(await second.page.locator('#photo-preview').getAttribute('src'),/^blob:/);await second.page.locator('#analysis-consent').check();
      await second.page.locator('#photo').setInputFiles({name:'ux-local-b.png',mimeType:'image/png',buffer:png});await expect(second.page.locator('#analysis-consent')).not.toBeChecked();
      await second.page.locator('#photo').setInputFiles([]);await expect(second.page.locator('#photo-preview')).toBeHidden();await expect(second.page.locator('#analysis-consent')).not.toBeChecked();
      await expect(second.page.locator('#note')).toHaveValue('UX media cancellation draft');await expect(saveButton(second.page)).toBeEnabled();assert.equal(await eventCount(),before,'A local preview/consent/removal cannot silently create durable media operations');
      await second.page.evaluate(()=>window.tendril.signals.send('ux/media-boundary-probe',{finished:true}));
      await observer.evaluate(async()=>{window.__uxSignalStop.abort();await window.__uxSignalTask;});
      assert.deepEqual(await observer.evaluate(()=>window.__uxSignals.filter(topic=>!topic.startsWith('ux/'))),[],'No photo or inference signal may be shared implicitly');
      uxPassed('phone local image preview is blob-local; each replacement resets consent, removal/cancellation retains draft, no durable operation or peer media signal appears');
    }
    const operationId=await second.page.locator(sqlBrowser?'#op-id':'#operation-id').inputValue();
    await expect.poll(()=>second.page.evaluate(async id=>(await(await window.tendril.application.backend.operations.get(id)).inspect()).retained.length,operationId),{timeout:30000}).toBeGreaterThan(0);
    const actual=await second.page.evaluate(async id=>(await(await window.tendril.application.backend.operations.get(id)).inspect()),operationId),visible=await second.page.locator(sqlBrowser?'#result':'#operation-status').innerText();
    report.ux_second_pass.selected_operation={operationId,actual:{authorTimestampMs:actual.authorTimestampMs,proposalId:actual.proposalId,stored:actual.stored,materialized:actual.materialized?.outcome,retained:actual.retained.length,finalized:actual.finalized,excluded:actual.excluded},visible};
    if(sqlBrowser){report.ux_second_pass.sql_new_transfer={operationId:actual.operationId,proposalId:actual.proposalId,authorTimestampMs:actual.authorTimestampMs,outcome:actual.materialized?.outcome};assert(BigInt(actual.authorTimestampMs)>=BigInt(report.ux_second_pass.sql_grant.authorTimestampMs),'The genuinely new transfer is authored after the actual grant; the original retry keeps its earlier time');}
    await screenshot(second.page,'ux-phone-facts-before');
    for(const evidence of actual.retained.filter(row=>row.signer!==secondKey))await expect(second.page.locator(sqlBrowser?'#result':'#operation-status')).toContainText(evidence.signer,{timeout:3000});
    await expect(second.page.locator(sqlBrowser?'#result':'#operation-status')).toContainText(actual.materialized.outcome);
    assert.equal(await second.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Phone long content must not horizontally overflow');
    uxPassed('selected operation visible independent facts agree with its actual authenticated peer retention without pressing Inspect');
    await screenshot(second.page,'ux-phone-after');
  }
  const actualCounters = await transportCounters(); report.transport = actualCounters;
  if (values.transport === 'relay') assert.ok(actualCounters.relayBinaryBytes > 0, 'Forced fallback must carry actual opaque application frames');
  else { const evidence = await page.evaluate(readBrowserRtcEvidence); report.rtc = evidence; assert.ok(hasNonTurnTraffic(evidence), 'Direct qualification needs actual RTC data evidence'); assert.equal(actualCounters.relayBinaryBytes, 0, 'Direct application data must bypass hosted relay'); }
  // The built-in inspector names each browser as the owner's other device, with the real route and data.
  report.connection_inspector = {
    desktop: await expectConnectionInspector(page, { expect, name: 'Your other device', transport: values.transport, screenshot, label: 'connections-desktop' }),
    phone: await expectConnectionInspector(second.page, { expect, name: 'Your other device (created this page)', transport: values.transport, screenshot, label: 'connections-phone' }),
  };
  passed('Application connections names the other browser as the owner\'s device, with its actual route and non-zero received data');
  await expect.poll(() => page.evaluate(async ({ id, peer }) => {
    const operation = await window.tendril.application.backend.operations.get(id);
    return operation ? (await operation.inspect()).retained.some(evidence => evidence.signer === peer) : false;
  }, { id: originalOperation, peer: secondKey }), { timeout: 30_000 }).toBe(true);
  const selectedOperation = await page.evaluate(async id => { const operation = await window.tendril.application.backend.operations.get(id); return operation ? operation.inspect() : null; }, originalOperation);
  assert.ok(selectedOperation?.stored); report.operation_facts = { stored: selectedOperation.stored, materialized: selectedOperation.materialized?.outcome, retained: selectedOperation.retained.length, finalized: selectedOperation.finalized, excluded: selectedOperation.excluded };
  if (!values['browser-finalizer']) {
    assert.equal(selectedOperation.finalized, false);
    const code = await page.evaluate(async id => { try { await (await window.tendril.application.backend.operations.get(id)).finalized({ timeoutMs: 100 }); return 'unexpected-success'; } catch (error) { return error.message; } }, originalOperation);
    assert.match(code, /FINALITY_UNSUPPORTED/); passed('no-finality final wait explicitly unsupported, not fake success');
  } else {
    checkpoint('exercise the actual optional browser finalizer, with no native process');
    const controls = page.locator('[data-finality=close]');
    await controls.evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
    const through = String(Date.now());
    await page.locator('[data-finality=through]').fill(through); await page.locator('[data-finality=consent]').check(); await controls.click();
    await expect(page.locator('[data-finality=status]')).toContainText('Verified local provider returned', { timeout: 30_000 });
    await expect.poll(() => page.evaluate(async id => (await (await window.tendril.application.backend.operations.get(id)).inspect()).finalized, originalOperation), { timeout: 30_000 }).toBe(true);
    const excluded = await page.evaluate(async timestamp => {
      const operation = await window.tendril.application.backend.submit({ operationId: 'explicit-late-behind-frontier', authorTimestampMs: BigInt(timestamp),
        program: { version: 3, steps: [{ op: 'emit', topic: 'late.excluded', payload: { explanation: 'keep this original signed intent' } }] } });
      return { proposalId: operation.id, operationId: operation.operationId };
    }, through);
    await expect.poll(() => page.evaluate(async id => (await (await window.tendril.application.backend.operations.get(id)).inspect()).excluded, excluded.operationId), { timeout: 30_000 }).toBe(true);
    const original = await page.evaluate(async id => (await (await window.tendril.application.backend.operations.get(id)).inspect()), excluded.operationId);
    assert.equal(original.stored, true); assert.equal(original.authorTimestampMs, through); assert.equal(original.proposalId, excluded.proposalId);
    const retried = await page.evaluate(async id => (await window.tendril.application.backend.operations.retry(id)).inspect(), excluded.operationId);
    assert.equal(retried.proposalId, excluded.proposalId); assert.equal(retried.authorTimestampMs, through); assert.equal(retried.excluded, true);
    const finalRevision = await page.evaluate(async () => { const view = await window.tendril.application.backend.readView({ view: 'final' }); try { return view.revision; } finally { await view.release(); } });
    assert.equal(finalRevision.view, 'final');
    await page.locator('#operation-id').fill(excluded.operationId);await page.locator('#inspect').click();await expect(page.locator('#operation-status')).toContainText('Excluded: yes');await expect(page.locator('#operation-status')).toContainText('not executed — excluded');await expect(page.locator('#operation-status')).toContainText(excluded.proposalId);
    await expect(second.page.locator('#operation-status')).toContainText('Finalized: yes',{timeout:30000});
    await screenshot(page,'desktop-finality-excluded');report.finality_transport=await transportCounters();
    report.browser_finality = { provider: 'owner-browser', nativeProcess: false, closedThroughMs: through, finalizedOriginal: true, excludedOriginalRetained: true, excludedVisibleInInspector:true, secondBrowserFinalityVisible:true, excludedOperation:{operationId:excluded.operationId,proposalId:excluded.proposalId,authorTimestampMs:original.authorTimestampMs}, qualifiedComposition: !values.diagnostic };
    passed('actual browser closure/proofs, final read and explicit late exclusion with unchanged original bytes/time/ID');
  }
  await screenshot(second.page, 'phone-after');
  assert.equal(await second.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '320px must not horizontally scroll');
  await second.page.reload(); await expect(saveButton(second.page)).toBeEnabled({ timeout: 60_000 }); await expect(second.page.locator('#public-key')).toHaveValue(secondKey);
  passed('fresh desktop/320px profiles, long-lived identity and materialized state after second-device reload');
  if(nativeWorkspace){
    const primary={...handle,application:pageRecord.application};
    const common={app,slug,primary,journal,publicKey:prepared.publisherKey,first,second,profile,setup,tendril,node,cli,preload,expect,report,screenshot,service:SERVICE,transportCounters,transport:values.transport,feedback:feedbackQualification,network:networkLab,checkpoint,passed,sha256};
    if(sqlBrowser)await qualifyFirstAppSqlWorkspace(common);else await qualifyFirstAppWorkspace(common);
  }
  report.native_checks = nativeWorkspace?'passed':'not-required'; report.browser_checks = 'passed'; report.status = values.diagnostic ? 'diagnostic-passed' : 'passed'; report.qualified = !values.diagnostic;
  console.log(nativeWorkspace?'Browser-first baseline plus explicitly requested optional workspace qualification completed. Exact evidence and process lifetimes are recorded.':'Browser-first journey completed without a native data process. Exact evidence and explicit limits are in the report.');
} catch (error) {
  report.status = 'failed'; report.failed_stage = stage; report.error = error.message;
  if (report.browser_checks === 'running') report.browser_checks = 'failed';
  report.browser_network=browserNetwork;
  report.host_transport=await transportCounters().catch(error=>({error:error.message}));
  report.browser_profiles=[];
  for(const profile of browserProfiles){
    if(profile.page.isClosed())continue;
    const details=await Promise.race([profile.page.evaluate(async()=>{
      const text=Object.fromEntries(['connection-status','session-status','submission-status','result','operation-status','view-error','provision-status'].map(id=>[id,document.getElementById(id)?.textContent??null]));
      let owner,transport,endpoints;try{const backend=window.tendril.application.backend;owner={applicationId:backend.applicationId,status:backend.status};const id=document.getElementById('op-id')?.value??document.getElementById('operation-id')?.value;if(id){const op=await backend.operations.get(id);if(op)owner.selectedOperation=await op.inspect();}}catch(error){owner={error:error.message};}
      try{transport=await window.tendril.transport.refresh();}catch(error){transport={error:error.message};}
      return{text,owner,transport};
    }).catch(error=>({error:error.message})),new Promise(resolve=>setTimeout(()=>resolve({error:'DIAGNOSTICS_DEADLINE'}),6000))]);
    report.browser_profiles.push({profile:profile.label,...details});
    try{const file=`first-app-${profile.label}-failure.png`;await profile.page.screenshot({path:join(dirname(reportPath),file),fullPage:true,timeout:10000});report.screenshots??={};report.screenshots[profile.label+'-failure']=file;}catch{}
  }
  if (page && !page.isClosed()) {
    report.browser_diagnostics = await page.evaluate(() => Object.fromEntries(['connection-status','session-status','submission-status','result','operation-status','view-error'].map(id => [id,document.getElementById(id)?.textContent ?? null]))).catch(() => null);
    try { await page.screenshot({ path: join(dirname(reportPath), 'first-app-failure.png'), fullPage: true, timeout: 10_000 }); report.screenshots ??= {}; report.screenshots.failure = 'first-app-failure.png'; } catch {}
  }
  if (error.stdout) process.stderr.write(error.stdout); if (error.stderr) process.stderr.write(error.stderr); throw error;
} finally {
  await (labBrowser?labBrowser.close():browser?.close())?.catch(() => {}); await host?.dispose().catch(() => {}); await dispatcher.close().catch(() => {});
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (values.keep) console.log(`Private test directory retained: ${directory}`); else await rm(directory, { recursive: true, force: true });
}
