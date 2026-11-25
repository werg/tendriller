import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qualifyFirstAppPublication } from '../first-app-publication.mjs';
import {createSigningIdentity,signPublicationManifest} from '@chronolog/authority';
import {createAuthorityClient} from '../../contract/authority.mjs';
import {decodeFirstAppPublication} from '../first-app-publication-codec.mjs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import { createFirstAppPublicationGate,createFirstAppWebsocketProxyWorker,FIRST_APP_WEBSOCKET_PROXY_WORKER } from '../first-app-websocket-host.mjs';

const browserText = 'Browser work while the resident owner publishes';
const signer=await createSigningIdentity(),otherSigner=await createSigningIdentity();
const author=signer.publicKey,previous='b'.repeat(64),operationId='nativepub_scoped_fixture_identity';
const proofHash=createHash('sha256').update('attached-publication-proof\n'+'p'.repeat(900000)).digest('hex');
const intent={applicationId:'f'.repeat(64),membershipId:'e'.repeat(64),executionManifestDigest:'d'.repeat(64),author,previous,operationId,revision:1,entry:'index.html',
 files:[{path:'index.html',hash:'c'.repeat(64),size:22,type:'text/html'},{path:'resident-publication-proof.txt',hash:proofHash,size:900027,type:'text/plain'}]};
// Derive every positive request from the maintained public transport, not a
// hand-written fixture envelope that could agree with an incorrect gate.
const publishRequest=async(payload=intent)=>{
 let request;
 const client=createAuthorityClient(async(path,options)=>{request=new Request('https://fixture/api/agent/pages/page/'+path,{method:options.method,body:JSON.stringify(options.body)});return null;});
 await client.publish(await signPublicationManifest(payload,payload.author===author?signer:otherSigner),[]);
 return request;
};
const controlRequest = (action, id, extra = {}) => new Request('https://fixture/__first_app_publication', {
  method: 'POST', body: JSON.stringify({ action, id, author, previous, proofHash, ...extra }),
});
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  const end = Date.now() + 2_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < end, 'Fixture condition did not complete');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
// The fixture exercises the real helper, child-process detach, authored files and
// gate. Browser/CLI responses stop at a deliberate sentinel after its first pair;
// the packed-kit acceptance separately checks real browser and publication state.
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'publication-qualification-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pageDirectory = join(directory, 'page'), index = join(pageDirectory, 'index.html');
  const proof = join(pageDirectory, 'resident-publication-proof.txt');
  await mkdir(pageDirectory);
  await writeFile(index, '<!doctype html>original');
  const cli = join(directory, 'cli.mjs'), preload = join(directory, 'preload.mjs');
  await writeFile(preload, '');
  await writeFile(cli, `process.on('SIGTERM', () => process.exit(${options.consumerExit ?? 0}));
process.stdout.write(${JSON.stringify(JSON.stringify({ cursor: 'fixture', events: [{ payload: { text: browserText } }] }) + '\n')});
setInterval(() => {}, 1000);`);
  const gate = createFirstAppPublicationGate({ decodePublication:decodeFirstAppPublication, timeoutMs: options.timeoutMs ?? 2_000 });
  const state = { trace: [], cleaned: false, publisherSettled: false, browserSettled: false };
  const completed = Error('Reached the retained publication assertions');
  const control = async action => gate.control(controlRequest(action, state.id));
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const input = JSON.parse(request.body);
    state.trace.push(input.action);
    state.id = input.id;
    if (input.action === 'reset' && options.resetError) throw options.resetError;
    if (input.action === 'release' && options.releaseError) throw options.releaseError;
    return gate.control(new Request('https://fixture/__first_app_publication', request));
  });
  let publications = 0;
  const node = async args => {
    const command = args[3];
    // The attached CLI's current self response: the page's signing identity is its public key.
    if (command === 'self') return JSON.stringify({ mode: 'attach', page: 'notes', applicationId: 'f'.repeat(64), identity: { publicKey: author }, endpoint: { ownerInstanceId: 'owner' } });
    if (command === 'publication') {
      if (publications++) throw completed;
      return JSON.stringify({ publication: { id: previous } });
    }
    assert.equal(command, 'publish');
    const passed = gate.before(await publishRequest());
    try {
      if (options.publish) await options.publish({ state, passed, control });
      else {
        const rejected = await passed;
        if (rejected) throw Error('Publication request failed: ' + rejected.status);
      }
      return JSON.stringify({ publication: { id: 'c'.repeat(64), payload: intent } });
    } finally { state.publisherSettled = true; state.trace.push('publisher-settled'); }
  };
  const page = {
    locator(selector) { return { selector, inputValue: async () => 'browser',
      async fill() {
        try { if (options.browser) await options.browser({ state, control, index, proof }); }
        finally { state.browserSettled = true; state.trace.push('browser-settled'); }
      }, click: async () => {} }; },
    isClosed: () => false,
    async evaluate(fn) {
      if (fn.toString().includes('const publication =')) return 'held-document';
      state.cleaned = true; state.trace.push('hold-cleanup');
      if (options.cleanup) await options.cleanup({ state });
      if (options.holdError) throw options.holdError;
    },
  };
  const expect = target => ({ async toContainText() {
    assert.ok(['#operation-status', '#notes'].includes(target.selector), 'Unexpected assertion target ' + target.selector);
  } });
  expect.poll = callback => {
    const poll = check => until(async () => check(await callback()));
    return { toContain: value => poll(actual => actual.includes(value)),
      toBeGreaterThan: value => poll(actual => actual > value), toBe: value => poll(actual => actual === value) };
  };
  const peer = { async request(command) {
    return command === 'participation-log' ? { current: { peers: ['browser'] } }
      : command === 'self' ? { ownerInstanceId: 'owner' }
        // The qualification page's diagnostics action reports the session status and the separate participation status.
        : { status: { canAuthor: true, phase: 'ready', database: 'ready', connectionRevision: 1 },
          participation: { phase: 'connected', connectedPeers: ['browser'], connectionRevision: 1 } };
  } };
  const start = () => qualifyFirstAppPublication({ page, pageUrl: 'https://fixture/',
    publicationGateUrl: 'https://fixture/__first_app_publication', peer, expect,
    workspace: directory, slug: 'notes', pageDirectory, preload, cli, node }).then(value => ({ value }), error => ({ error }));
  return { state, start, completed, index, proof, control };
}

test('browser work completes at an observed pending signed publication, retaining its scoped identity', async t => {
  const f = await fixture(t, { browser: async ({ state, control }) => {
    assert.equal((await (await control('status')).json()).phase, 'held');
    assert.equal(state.publisherSettled, false);
  } });
  const { error } = await f.start();
  assert.equal(error, f.completed);
  assert.equal(error.publicationQualification.publicationProgress.browserCommandObservedWhileHeld, true);
  assert.equal(error.publicationQualification.publicationProgress.operationId, operationId);
  assert.equal(await readFile(f.index, 'utf8'), '<!doctype html>original');
  await assert.rejects(readFile(f.proof), { code: 'ENOENT' });
});

test('browser failure releases the gate and joins the publisher before restoring authored files', async t => {
  const primary = Error('browser command failed'), tail = Promise.withResolvers(), finish = Promise.withResolvers();
  const f = await fixture(t, { browser: async () => { throw primary; },
    publish: async ({ passed }) => { await passed; tail.resolve(); await finish.promise; },
    cleanup: ({ state }) => assert.equal(state.publisherSettled, true, 'Cleanup overtook the publisher') });
  const pending = f.start();
  await tail.promise;
  assert.equal(f.state.cleaned, false);
  assert.match(await readFile(f.index, 'utf8'), /resident-owner-publication-one/);
  finish.resolve();
  const { error } = await pending;
  assert.equal(error, primary);
  assert.ok(f.state.trace.indexOf('publisher-settled') < f.state.trace.indexOf('hold-cleanup'));
  assert.equal(await readFile(f.index, 'utf8'), '<!doctype html>original');
});

test('publisher failure still joins in-flight browser work before cleanup', async t => {
  const primary = Error('publisher disconnected'), browserStarted = Promise.withResolvers(), finish = Promise.withResolvers();
  const f = await fixture(t, { browser: async () => { browserStarted.resolve(); await finish.promise; },
    publish: async ({ passed }) => { void passed.then(() => {}); await browserStarted.promise; throw primary; },
    cleanup: ({ state }) => assert.equal(state.browserSettled, true, 'Cleanup overtook the browser') });
  const pending = f.start();
  await until(() => f.state.publisherSettled);
  assert.equal(f.state.cleaned, false);
  finish.resolve();
  const { error } = await pending;
  assert.equal(error.cause ?? error, primary);
  assert.ok(f.state.trace.indexOf('browser-settled') < f.state.trace.indexOf('hold-cleanup'));
});

test('serialized browser work behind a finished publication cannot satisfy progress evidence', async t => {
  const f = await fixture(t, { timeoutMs: 1_000,
    browser: async ({ state }) => until(() => state.publisherSettled) });
  const { error } = await f.start();
  assert.notEqual(error, f.completed);
  assert.equal(error.publicationQualification.publicationProgress.phase, 'expired');
  assert.notEqual(error.publicationQualification.publicationProgress.browserCommandObservedWhileHeld, true);
});

test('all cleanup is attempted and aggregated without losing primary publication evidence', async t => {
  const primary = Error('browser assertion'), resetError = Error('gate reset'), holdError = Error('hold release');
  const f = await fixture(t, { resetError, holdError, consumerExit: 7,
    browser: async ({ index, proof }) => {
      await rm(index); await mkdir(index); await rm(proof); await mkdir(proof);
      throw primary;
    } });
  const { error } = await f.start();
  assert.ok(error instanceof AggregateError);
  assert.equal(error.cause, primary);
  assert.equal(error.publicationQualification, primary.publicationQualification);
  assert.equal(error.publicationQualification.publicationProgress.phase, 'held');
  assert.deepEqual(error.errors.slice(0, 3), [primary, resetError, holdError]);
  assert.equal(error.errors.length, 6);
  assert.match(error.errors[3].message, /Event consumer must detach gracefully/);
  assert.equal(error.errors[4].code, 'EISDIR');
  assert.equal(error.errors[5].code, 'ERR_FS_EISDIR');
});

test('release failure remains bounded and keeps progress and primary diagnostics through cleanup', async t => {
  const primary = Error('gate release failed');
  const f = await fixture(t, { releaseError: primary, timeoutMs: 1_000 });
  const { error } = await f.start();
  assert.equal(error.cause ?? error, primary);
  assert.equal(error.publicationQualification.publicationProgress.browserCommandObservedWhileHeld, true);
  assert.equal(f.state.publisherSettled, true);
  assert.ok(f.state.trace.includes('reset'));
});

test('publication gate matches signed public intent, forwards original bytes only after release, and bounds reset', async () => {
  const gate = createFirstAppPublicationGate({ decodePublication:decodeFirstAppPublication, timeoutMs: 100 });
  const id = randomUUID();
  assert.equal((await gate.control(controlRequest('arm', id))).status, 200);
  for (const payload of [{...intent,author:otherSigner.publicKey}, { ...intent, previous: 'd'.repeat(64) },
    {...intent,files:[intent.files[0],{...intent.files[1],hash:'d'.repeat(64)}]}])
    assert.equal(await gate.before(await publishRequest(payload)), undefined);
  assert.equal(await gate.before(new Request('https://fixture/peers/publication', { method: 'POST', body: 'null' })), undefined);
  const request = await publishRequest(), expected = await request.clone().text();
  let forwarded = false;
  const pending = gate.before(request).then(async response => {
    if (response) return response;
    forwarded = true;
    return new Response(await request.text());
  });
  await until(async () => (await (await gate.control(controlRequest('status', id))).json()).phase === 'held');
  assert.equal(forwarded, false);
  assert.equal((await (await gate.control(controlRequest('status', id))).json()).operationId, operationId);
  await gate.control(controlRequest('release', id));
  assert.equal(await (await pending).text(), expected);
  assert.equal(forwarded, true);
  await gate.control(controlRequest('reset', id));
  await gate.control(controlRequest('arm', id));
  const rejected = gate.before(await publishRequest());
  await until(async () => (await (await gate.control(controlRequest('status', id))).json()).phase === 'held');
  await gate.control(controlRequest('reset', id));
  assert.equal((await rejected).status, 504);
  await turn();
});


test('raw proxy gate is inactive without an authority decoder; obsolete transport never matches',async()=>{
 const inert=createFirstAppPublicationGate(),id=randomUUID();
 assert.equal((await inert.control(controlRequest('arm',id))).status,503);
 assert.equal(await inert.before(await publishRequest()),undefined);
 assert.doesNotMatch(FIRST_APP_WEBSOCKET_PROXY_WORKER,/@chronolog|from ['"](?:node:|.*kernel)/u);
 let decoded=0;const gate=createFirstAppPublicationGate({decodePublication:async value=>{decoded++;return decodeFirstAppPublication(value);}});
 await gate.control(controlRequest('arm',id));
 const original=await publishRequest(),body=await original.text();
 assert.equal(await gate.before(new Request('https://fixture/peers/participant',{method:'POST',body})),undefined);
 assert.equal(decoded,0);
 assert.equal((await(await gate.control(controlRequest('status',id))).json()).phase,'armed');
});

test('gate rejects obsolete wrapped records, malformed signed JSON and invalid signatures without consuming the original request',async()=>{
 const gate=createFirstAppPublicationGate({decodePublication:decodeFirstAppPublication}),id=randomUUID();await gate.control(controlRequest('arm',id));
 const signed=await signPublicationManifest(intent,signer);
 const altered={...signed,signature:(signed.signature[0]==='0'?'1':'0')+signed.signature.slice(1)};
 for(const publication of [{record:'00'}, altered, {payload:intent}, null]){
  const request=new Request('https://fixture/peers/publication',{method:'POST',body:JSON.stringify({action:'publish',publication,assets:[]})});
  const expected=await request.clone().text();assert.equal(await gate.before(request),undefined);assert.equal(await request.text(),expected);
 }
 const state=await(await gate.control(controlRequest('status',id))).json();assert.equal(state.phase,'armed');assert.equal(state.matched,0);
});

test('bundled Workerd proxy holds actual createAuthorityClient.publish signed-JSON wire bytes and forwards them unchanged', {timeout:15000},async()=>{
 const entry=new URL('../first-app-publication-codec.mjs',import.meta.url).pathname;
 const bundle=await build({stdin:{contents:`import {createAuthorityClient} from '../../contract/authority.mjs';
import {decodeFirstAppPublication} from ${JSON.stringify(entry)};\n${createFirstAppWebsocketProxyWorker({decodePublicationExpression:'decodeFirstAppPublication'})}`,resolveDir:import.meta.dirname},write:false,bundle:true,format:'esm',platform:'browser',target:'es2022'});
 const mf=new Miniflare({...convertV4MiniflareOptions({workers:[{name:'network',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-11-01',serviceBindings:{PACKED_HOST:'echo'}},{name:'echo',modules:true,script:`export default{async fetch(request){return new Response(await request.arrayBuffer(),{headers:{'Content-Type':'application/json'}});}}`,compatibilityDate:'2026-11-01'}]}),logRequests:false});
 const id=randomUUID();let pending;
 const control=async action=>mf.dispatchFetch('https://fixture/__first_app_publication',{method:'POST',body:JSON.stringify({action,id,author,previous,proofHash})});
 try{
  assert.equal((await control('arm')).status,200);
  const signed=await signPublicationManifest(intent,signer),assets=[];let completed=false,expected;
  const client=createAuthorityClient(async(path,options)=>{
   assert.equal(path,'peers/publication');assert.equal(options.method,'POST');
   // Assert the real client's direct SignedPublication shape explicitly.
   assert.equal(options.body.publication,signed);assert.equal(Object.hasOwn(options.body.publication,'record'),false);
   expected=JSON.stringify(options.body);
   const response=await mf.dispatchFetch('https://fixture/api/agent/pages/page/'+path,{method:options.method,body:expected});
   return response.text();
  });
  pending=client.publish(signed,assets).then(value=>{completed=true;return value;});
  await until(async()=>(await(await control('status')).json()).phase==='held');
  const state=await(await control('status')).json();assert.equal(state.matched,1);assert.equal(state.operationId,operationId);assert.equal(completed,false);
  await control('release');assert.equal(await pending,expected);
  assert.deepEqual(JSON.parse(expected),{action:'publish',publication:signed,assets});
  assert.equal(completed,true);
 }finally{await control('reset').catch(()=>{});await pending?.catch(()=>{});await mf.dispose();}
});
