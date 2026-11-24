import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, cp, symlink, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a renamed event domain initializes, builds and runs through the retained owner without a notes query', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'td-'));
  const app = pathToFileURL(directory + '/');
  let attached, reopened, peerRun;
  const stop = new AbortController();
  t.after(async () => {
    await attached?.detach();
    stop.abort(); await peerRun;
    await reopened?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await cp(join(root, 'docs/tutorial'), directory, { recursive: true });
  await mkdir(join(directory, 'p'), { mode: 0o700 });
  for (const [scope, name, source] of [['@tendriller', 'core', 'dist/sdk'], ['@chronolog', 'peer-session', 'node_modules/@chronolog/peer-session']]) {
    await mkdir(join(directory, 'node_modules', scope), { recursive: true });
    await symlink(join(root, source), join(directory, 'node_modules', scope, name));
  }
  await writeFile(new URL('domain.mjs', app), `
import { defineApplication, defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';
export const definition = defineApplication({
  id: 'field-observations', version: '7',
  commands: { record: defineCommand({ description: 'Record one observation',
    input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    prepare: ({text}) => program(emit('observation', {text})) }) },
  queries: { entries: defineQuery({ description: 'Read retained observations', input: {type:'null'},
    read: view => view.readEvents({topics:['observation']}).events.map(event => event.payload.text) }) },
});
`);
  // Only the host boundary is supplied by this fixture. The downloaded setup,
  // signed authority, native storage, build, supervisor and attachment are real.
  await writeFile(new URL('local.mjs', app), `
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as p from '@chronolog/peer-session';
export const privateDirectory = new URL('./p/', import.meta.url);
export const devicePath = fileURLToPath(new URL('device.sqlite', privateDirectory));
export const readPrivate = async (name, optional = false) => {
  try { return JSON.parse(await readFile(new URL(name, privateDirectory), 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
};
export const savePrivate = async (name, value) => {
  await writeFile(new URL(name, privateDirectory), JSON.stringify(value), {mode:0o600});
  return value;
};
export const readHostHandle = () => readPrivate('handle.json');
export const hostIdentity = async () => ({});
export const requireHostHandle = () => {};
export const requireFreshProject = async () => {};
const signer = await p.createPeerIdentity();
let registry;
const unavailable = () => { throw Error('Unexpected remote peer'); };
const wait = signal => {
  const done = Promise.withResolvers(), close = () => done.resolve();
  signal.addEventListener('abort', close, {once:true}); if (signal.aborted) close();
  return { ready: Promise.resolve(), close, done: done.promise };
};
const peers = {
  async configureApplication(configuration) {
    const handle = await readHostHandle();
    const descriptor = await p.signApplicationDescriptor({
      applicationId:handle.application.id, historyId:configuration.historyId,
      profile:'peer-generation-v1', policy:'eligible-members-v1', controlPublicKey:signer.publicKey,
      schemaAdministrator:configuration.schemaAdministrator,
      definitionDigest:await p.applicationDescriptionDigest(configuration.definition),
      executionManifestDigest:configuration.executionManifestDigest, schemaDigest:null,
    }, signer);
    const control = await p.signControlRevision({
      applicationId:handle.application.id, profile:descriptor.payload.profile, policy:descriptor.payload.policy,
      revision:0, previous:null, epoch:0, keyDigest:configuration.keyDigest, recoveryFloor:null,
      grants:configuration.members.map(member => member.grant),
    }, signer);
    registry = await p.createGenerationRegistry({store:new p.MemoryBytesStore(), descriptor, controls:[control], signer});
    return registry.read();
  },
  selectGeneration: request => registry.select(request),
  application: () => registry.read(),
  exchange: async request => p.createParticipantResponse(request,
    request.action === 'read' ? await registry.read() : unavailable()),
  discover:async()=>({peers:[]}), advertise:async()=>{}, withdraw:async()=>{},
  invite:unavailable, rendezvous:unavailable, relay:unavailable,
  watchDiscovery(_identity,{signal}) { const life=wait(signal);
    return {...life, notifications:{async *[Symbol.asyncIterator](){yield {type:'ready'};await life.done;}}}; },
  listenInvitations(_identity,{signal}) { const life=wait(signal);
    return {...life, invitations:{async *[Symbol.asyncIterator](){await life.done;}}}; },
};
export const project = async () => ({handle:await readHostHandle(), host:{peers}});
`);
  const configuration = await import(new URL('local.mjs', app));
  const handle = { id: 'abcdefghijkl', application: { id: '74'.repeat(32) },
    api: 'https://fixture.test/api/t/abcdefghijkl', page_url: 'https://abcdefghijkl.pages.test/s/test/',
    token: 'private-test-token-never-publish' };
  await configuration.savePrivate('handle.json', handle);
  const setup = await import(new URL('setup.mjs', app));
  const initialized = await setup.initializeProject();
  assert.equal(initialized.initialized, true);
  assert(initialized.revision, 'initialization returns a coherent applied revision');
  const { definition } = await import(new URL('domain.mjs', app));
  assert.equal(definition.queries.notes, undefined);
  const descriptor = await configuration.readPrivate('descriptor.json');
  const { buildPage } = await import(new URL('build.mjs', app));
  const options = { root: app, ...configuration, definition, bundle: build };
  await buildPage(options);
  const publicConfiguration = JSON.parse(await readFile(new URL('page/configuration.json', app)));
  assert.equal(publicConfiguration.definitionId, 'field-observations');
  assert.equal(publicConfiguration.definitionVersion, '7');
  assert.deepEqual(publicConfiguration.descriptor, descriptor);
  assert(!JSON.stringify(publicConfiguration).includes(handle.token));
  assert.deepEqual(Object.keys(publicConfiguration).sort(), ['applicationId', 'definitionId', 'definitionVersion',
    'descriptor', 'nativeDeviceId', 'pageId', 'page_url', 'serviceOrigin']);

  const { prepareAssistant } = await import(new URL('assistant.mjs', app));
  await assert.rejects(prepareAssistant(), /Review the explicit capability selection/);
  await assert.rejects(access(new URL('p/assistant-key.json', app)), { code: 'ENOENT' });

  // The notification channel has no remote service in this fixture. It never
  // supplies approval or replaces the actual owner, signer or session.
  await writeFile(new URL('setup-watch.mjs', app), `
export function watchApplicationSetup({signal}) {
  const done=Promise.withResolvers(), close=()=>done.resolve();
  signal.addEventListener('abort',close,{once:true});
  return {closed:done.promise,close};
}
`);
  const sessionUrl = new URL('session.mjs', app).href;
  // A separate bootstrap import keeps this isolated notification transport local
  // to the resident test, even though assistant preparation imported the bootstrap.
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === sessionUrl + '?resident-test' && specifier === '@tendriller/core/setup')
      return {url:new URL('setup-watch.mjs',app).href,shortCircuit:true};
    return next(specifier,context);
  } });
  let bootstrap;
  try { bootstrap = await import(sessionUrl + '?resident-test'); } finally { hooks.deregister(); }
  const reports = [], ready = Promise.withResolvers();
  peerRun = bootstrap.runPeer({ signal: stop.signal }, { report: value => {
    reports.push(value); if (value.running) ready.resolve();
  } }).then(() => null, error => error);
  await Promise.race([ready.promise, peerRun.then(error => { throw error ?? Error('Peer ended before ready'); })]);
  attached = await bootstrap.attachSession();
  assert.deepEqual((await attached.session.query('entries', null)).value, []);
  const operation = await attached.session.command('record', { text: 'Retained observation' }, { operationId: 'record-one' });
  await operation.applied();
  assert.deepEqual((await attached.session.query('entries', null)).value, ['Retained observation']);
  await flush(); await flush();
  assert(reports.some(value => value.change === 'applied' && value.revision));
  assert(!reports.some(value => Object.hasOwn(value, 'notes') || Object.hasOwn(value, 'stock')));
  const binding = await configuration.readPrivate('native-attachment-main.json');
  assert(binding.policy.capabilities.includes('publish'));
  assert(!binding.policy.capabilities.includes('ownerAdmin'));
  await attached.detach(); attached = undefined;
  stop.abort(); const stopped = await peerRun;
  assert(stopped === null || stopped.name === 'AbortError');
  reopened = await bootstrap.openSession();
  assert.deepEqual((await reopened.session.query('entries', null)).value, ['Retained observation']);
  assert.deepEqual(await configuration.readPrivate('native-attachment-main.json'), binding);
  await reopened.close(); reopened = undefined;

  await assert.rejects(buildPage({ ...options, definition: { ...definition, version: '8' } }), /retained initialized descriptor/);
  await assert.rejects(access(new URL('page/', app)), { code: 'ENOENT' });
  assert.deepEqual(await configuration.readPrivate('descriptor.json'), descriptor);
  assert.equal((await configuration.readPrivate('initialized.json')).deviceId, publicConfiguration.nativeDeviceId);

  await writeFile(new URL('warning.mjs', app), "process.emitWarning('fixture diagnostic remains on stderr');\n");
  const result = await run('npm', ['run', '--silent', 'init'], {cwd:directory,
    env:{...process.env, NODE_OPTIONS:'--import ' + fileURLToPath(new URL('warning.mjs', app))}});
  assert.equal(JSON.parse(result.stdout).initialized, true);
  assert.match(result.stderr, /fixture diagnostic remains on stderr/);
  await assert.rejects(run(process.execPath, ['setup.mjs', 'unknown'], {cwd:directory}),
    error => error.code !== 0 && /Use create, init/.test(error.stderr) && error.stdout === '');
});
