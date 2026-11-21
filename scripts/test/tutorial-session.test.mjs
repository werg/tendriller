import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('native tutorial routes explicitly granted owner recovery through its owned control participant', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 't'));
  let owned, ordinary, administrator;
  try {
    for (const name of ['session.mjs', 'domain.mjs', 'pairing-native.mjs']) await copyFile(join(root, 'docs/tutorial', name), join(directory, name));
    await mkdir(join(directory, 'helpers'));
    await copyFile(join(root, 'docs/tutorial/helpers/participant-lifecycle.mjs'), join(directory, 'helpers/participant-lifecycle.mjs'));
    await copyFile(join(root, 'docs/tutorial/helpers/cli-lifetime.mjs'), join(directory, 'helpers/cli-lifetime.mjs'));
    await mkdir(join(directory, 'p'), { mode: 0o700 });
    for (const [scope, name, source] of [['@tendriller', 'core', 'dist/sdk'], ['@chronolog', 'peer-session', 'node_modules/@chronolog/peer-session']]) {
      await mkdir(join(directory, 'node_modules', scope), { recursive: true });
      await symlink(resolve(root, source), join(directory, 'node_modules', scope, name));
    }
    // Local configuration/delivery is supplied by the fixture. The copied
    // bootstrap, native storage, owner and attachment are real public package
    // consumers. The owner port is exercised without SQL or external networking.
    await writeFile(join(directory, 'local.mjs'), `
import { fileURLToPath } from 'node:url';
import * as p from '@chronolog/peer-session';
import { openNativeDevice, openNativeApplication } from '@chronolog/peer-session/native';
import { definition } from './domain.mjs';
export const privateDirectory = new URL('./p/', import.meta.url);
export const devicePath = fileURLToPath(new URL('device.sqlite', privateDirectory));
const device = await openNativeDevice({ path: devicePath, create: true });
const signer = await p.createPeerIdentity(), key = crypto.getRandomValues(new Uint8Array(32));
const execution = await p.executionManifestArtifacts(await p.eventExecutionManifest());
const descriptor = await p.signApplicationDescriptor({ applicationId: '74'.repeat(32), historyId: 'tutorial-control-test',
  profile: 'peer-generation-v1', policy: 'eligible-members-v1', controlPublicKey: signer.publicKey,
  schemaAdministrator: device.identity.publicKey, definitionDigest: await p.applicationDefinitionDigest(definition),
  executionManifestDigest: p.bytesToHex(execution.executionManifestDigest), schemaDigest: null }, signer);
const control = await p.signControlRevision({ applicationId: descriptor.payload.applicationId,
  profile: descriptor.payload.profile, policy: descriptor.payload.policy, revision: 0, previous: null,
  epoch: 0, keyDigest: await p.bytesDigest(key), recoveryFloor: null,
  grants: [p.participantGrant(device.identity.publicKey, { administrator: true, publisher: true })] }, signer);
export const registry = await p.createGenerationRegistry({ store: new p.MemoryBytesStore(), descriptor, controls: [control], signer });
await registry.select(await p.signTransitionRequest({ applicationId: descriptor.payload.applicationId,
  profile: descriptor.payload.profile, policy: descriptor.payload.policy, transitionId: 'initial', expectedGeneration: null,
  coordinator: device.identity.publicKey, requester: device.identity.publicKey, controlRevision: 0, reason: 'create', base: null }, device.identity));
const initial = await openNativeApplication({ device, definition, authority: await registry.read(), epochKeys: new Map([[0, key]]) });
try { await initial.query('notes', null); } finally { await initial.close(); }
const records = new Map([['descriptor.json', descriptor], ['handle.json', { application: { id: descriptor.payload.applicationId },
  api: 'https://tendriller.test/api/tendrils/aaaaaaaaaaaa', page_url: 'https://aaaaaaaaaaaa.pages.test/s/test/', token: 'synthetic-test-token' }]]);
export const readPrivate = async name => structuredClone(records.get(name) ?? null);
export const readHostHandle = async () => readPrivate('handle.json');
export const savePrivate = async (name, value) => { records.set(name, structuredClone(value)); return value; };
const unused = () => { throw Error('The isolated fixture has no remote peers'); };
export const authorityOptions = [];
const peers = {
  async application(options) { authorityOptions.push(options); options?.signal?.throwIfAborted(); return registry.read(); },
  async exchange(request) {
    if (request.facet !== 'control') throw Error('Unexpected fixture request');
    const value = request.action === 'read' ? await registry.read()
      : request.action === 'select' ? await registry.select(request.payload.request) : unused();
    return p.createParticipantResponse(request, value);
  },
  discover: async () => ({ peers: [] }), advertise: async () => {}, withdraw: async () => {},
  invite: unused, rendezvous: unused, relay: unused,
  watchDiscovery(_identity, { signal }) {
    const ended = Promise.withResolvers();
    const close = () => { signal.removeEventListener('abort', close); ended.resolve(); };
    if (signal.aborted) close(); else signal.addEventListener('abort', close, { once: true });
    return { ready: Promise.resolve(), close, notifications: { async *[Symbol.asyncIterator]() { yield {type:'ready'}; await ended.promise; } } };
  },
  listenInvitations(_identity, { signal }) {
    const ended = Promise.withResolvers();
    const close = () => { signal.removeEventListener('abort', close); ended.resolve(); };
    if (signal.aborted) close(); else signal.addEventListener('abort', close, { once: true });
    return { ready: Promise.resolve(), close, invitations: { async *[Symbol.asyncIterator]() { await ended.promise; } } };
  },
};
export const project = async () => ({ handle: await readPrivate('handle.json'), host: { peers } });
`);
    const fixture = await import(pathToFileURL(join(directory, 'local.mjs')).href);
    const bootstrapUrl = pathToFileURL(join(directory, 'session.mjs')).href;
    const supervisorUrl = pathToFileURL(join(directory, 'supervisor.mjs')).href;
    await writeFile(join(directory, 'supervisor.mjs'), `
export { attachNativeSession, createNativeAttachmentKey } from ${JSON.stringify(pathToFileURL(join(root, 'dist/sdk/session/native.mjs')).href)};
export async function createNativeSessionSupervisor({ openOwner, ...options }) {
  const owner = await openOwner(options);
  return { owner, ownerInstanceId: owner.ownerInstanceId, close: () => owner.close() };
}
`);
    // Replace only the native socket/fence transport at this bootstrap's import
    // boundary. Its openOwner callback still constructs the real public owner;
    // existing supervisor tests cover authenticated Unix bindings and ownership.
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (context.parentURL === bootstrapUrl && specifier === '@tendriller/core/native-owner') {
        return { url: supervisorUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    } });
    let bootstrap;
    try { bootstrap = await import(bootstrapUrl); } finally { hooks.deregister(); }
    const { definition } = await import(pathToFileURL(join(directory, 'domain.mjs')).href);
    const { connectApplicationOwner } = await import('@chronolog/peer-session/browser');
    owned = await bootstrap.openSession();
    const stoppedPairing = new AbortController(), stoppedReason = Error('pairing window closed');
    stoppedPairing.abort(stoppedReason);
    await assert.rejects(owned.pairing.authority({ signal: stoppedPairing.signal }), error => error === stoppedReason);
    assert.equal(fixture.authorityOptions.at(-1).signal, stoppedPairing.signal,
      'the owned pairing callback retains its independent per-pass cancellation');
    const attach = async policy => {
      const endpoint = Object.assign(new EventTarget(), { postMessage(value) {
        endpoint.dispatchEvent(new MessageEvent('message', { data: value }));
      } });
      const detach = owned.supervisor.owner.attach(endpoint, policy);
      try {
        const session = await connectApplicationOwner(endpoint, { applicationId: owned.session.applicationId,
          definitionId: definition.id, definitionVersion: definition.version });
        return { session, async detach() { try { await session.detach(); } finally { detach(); } } };
      } catch (error) { detach(); throw error; }
    };
    let controlReads = 0;
    const application = owned.control.application.bind(owned.control);
    owned.control.application = (...args) => { controlReads++; return application(...args); };

    ordinary = await attach();
    await assert.rejects(ordinary.session.recovery.takeover({ transitionId: 'ordinary-denied' }), /APPLICATION_ATTACHMENT_FORBIDDEN/);
    assert.equal(controlReads, 0, 'an ordinary attachment never reaches privileged host control');

    administrator = await attach({ capabilities: ['ownerAdmin', 'diagnostics'] });
    assert.equal(await administrator.session.recovery.takeover({ transitionId: 'reviewed-recovery', signal: AbortSignal.timeout(5_000) }), null);
    assert.equal(controlReads, 1, 'the granted recovery uses the existing verified control participant');
    assert.equal((await fixture.registry.read()).generations.length, 1, 'the ready coordinator does not create a replacement generation');
    await administrator.detach(); administrator = undefined;
    assert.equal(owned.session.signal.aborted, false, 'detaching the administrator preserves the shared owner');
    assert.deepEqual((await ordinary.session.query('notes', null)).value, []);
  } finally {
    await Promise.allSettled([administrator?.detach(), ordinary?.detach()]);
    try { await owned?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
