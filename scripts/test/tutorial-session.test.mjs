import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { provisionNativeMember } from './support/tutorial-cli-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('native tutorial owner opens its cached provisioned store and serves attachments only within their reviewed policy', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 't'));
  let owned, ordinary;
  try {
    for (const name of ['session.mjs', 'domain.mjs']) await copyFile(join(root, 'docs/tutorial', name), join(directory, name));
    await mkdir(join(directory, 'helpers'));
    for (const name of ['native-session.mjs', 'cli-lifetime.mjs']) await copyFile(join(root, 'docs/tutorial/helpers', name), join(directory, 'helpers', name));
    await mkdir(join(directory, 'p'), { mode: 0o700 });
    for (const [scope, name, source] of [['@tendriller', 'core', 'dist/sdk'], ['@chronolog', 'peer-session', 'node_modules/@chronolog/peer-session'], ['@chronolog', 'authority', 'node_modules/@chronolog/authority']]) {
      await mkdir(join(directory, 'node_modules', scope), { recursive: true });
      await symlink(resolve(root, source), join(directory, 'node_modules', scope, name));
    }
    // The native device is an explicitly provisioned member of a browser-owned application: it never creates
    // a root, membership or data key. The copied bootstrap, native storage and owner are real public consumers.
    const peer = await import('@chronolog/peer-session'), authority = await import('@chronolog/authority');
    const { openNativeDevice } = await import('@chronolog/peer-session/native');
    const { definition } = await import(pathToFileURL(join(directory, 'domain.mjs')).href);
    const device = await openNativeDevice({ path: join(directory, 'p/device.sqlite'), create: true });
    const seeded = await provisionNativeMember({ peer, authority, device, definition });
    const publicKey = device.identity.publicKey;
    await seeded.session.close();
    await writeFile(join(directory, 'local.mjs'), `
export const privateDirectory = new URL('./p/', import.meta.url);
const records = new Map([['handle.json', { application: { id: ${JSON.stringify(seeded.applicationId)} },
  api: 'https://tendriller.test/api/t/aaaaaaaaaaaa', page_url: 'https://aaaaaaaaaaaa.pages.test/s/test/', token: 'synthetic-test-token' }]]);
export const readPrivate = async (name, optional) => { if (records.has(name)) return structuredClone(records.get(name)); if (optional) return null; throw Object.assign(Error('missing ' + name), { code: 'ENOENT' }); };
export const readHostHandle = async () => readPrivate('handle.json');
export const savePrivate = async (name, value) => { records.set(name, structuredClone(value)); return value; };
const unused = () => { throw Error('The isolated fixture has no remote peers'); };
export const hostReads = [];
const peers = {
  async application(options) { hostReads.push('application'); options?.signal?.throwIfAborted(); return { selection: { id: ${JSON.stringify(seeded.applicationId)} }, authority: null, publicationAuthority: null }; },
  publication: async () => null,
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
    const bootstrapUrl = pathToFileURL(join(directory, 'helpers/native-session.mjs')).href;
    const entryUrl = pathToFileURL(join(directory, 'session.mjs')).href;
    const supervisorUrl = pathToFileURL(join(directory, 'supervisor.mjs')).href;
    await writeFile(join(directory, 'supervisor.mjs'), `
export { attachNativeSession, createNativeAttachmentKey } from ${JSON.stringify(pathToFileURL(join(root, 'dist/sdk/session/native.mjs')).href)};
export async function createNativeSessionSupervisor({ openOwner, ...options }) {
  const owner = await openOwner(options);
  return { owner, ownerInstanceId: owner.ownerInstanceId, close: () => owner.close() };
}
`);
    // Replace only the native socket/fence transport at the bootstrap's import boundary. Its openOwner callback
    // still constructs the real public owner; other tests cover authenticated Unix bindings and ownership.
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (context.parentURL === bootstrapUrl && specifier === '@tendriller/core/native-owner') return { url: supervisorUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    } });
    let bootstrap;
    try { bootstrap = await import(entryUrl); } finally { hooks.deregister(); }
    const { connectApplicationOwner } = await import('@chronolog/peer-session/browser');
    owned = await bootstrap.openSession();
    assert.equal(owned.session.identity.publicKey, publicKey);
    assert.equal(owned.session.status.canAuthor, true, 'cached authority and its granted key are enough to author locally');
    assert.equal(typeof owned.participation?.onStatus, 'function', 'participation is its own top-level controller');
    assert.equal(typeof owned.watchSetup, 'function');
    assert.equal(Object.hasOwn(owned.session, 'participation'), false, 'no participation alias is attached to the application session');
    assert.deepEqual(fixture.hostReads.filter(read => read !== 'application'), []);
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
    ordinary = await attach({ capabilities: ['queries', 'commands', 'operations'], queries: ['notes'], commands: ['putNote'] });
    const operation = await ordinary.session.command('putNote', { noteId: 'n1', text: 'local' }, { operationId: 'session-test-op' });
    assert.equal((await operation.materialized({ signal: AbortSignal.timeout(10_000) })).outcome, 'accepted');
    assert.deepEqual((await ordinary.session.query('notes', null)).value.map(note => note.text), ['local']);
    // A declared command outside the attachment's reviewed policy never reaches the owned signer.
    await assert.rejects(ordinary.session.command('deleteNote', { noteId: 'n1' }, { operationId: 'session-denied-op' }), /FORBIDDEN/);
    assert.deepEqual((await owned.session.query('notes', null)).value.map(note => note.text), ['local']);
    await ordinary.detach(); ordinary = undefined;
    assert.equal(owned.session.signal.aborted, false, 'detaching an attachment preserves the shared owner');
    assert.equal((await owned.session.query('notes', null)).value.length, 1);
  } finally {
    await Promise.allSettled([ordinary?.detach()]);
    try { await owned?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
