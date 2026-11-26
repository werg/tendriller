// Test-only loopback plumbing around the actual starter workspace and its inventory
// template, never a replacement page, Worker, domain, session implementation,
// command bridge or SQL engine.
import { build } from 'esbuild';
import { access, cp, mkdtemp, mkdir, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import { Agent, WebSocket, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { TUTORIAL_FILES } from '../../scripts/onboarding.mjs';
import { SERVICE, OWNER, localPageUrl, type PageHandle } from './local-helpers';

const SLUG = 'stock';

export async function prepareSqlTutorial(consumer?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'sql-tutorial-browser-')), workspaceRoot = join(directory, 'workspace');
  const previousDispatcher = getGlobalDispatcher(), previousWebSocket = globalThis.WebSocket, previousFetch = globalThis.fetch;
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false, lookup(hostname, options, callback) {
    if (hostname !== 'localhost' && !hostname.endsWith('.localhost')) return callback(Error('Non-loopback SQL test request'), '', 4);
    if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  } } });
  const dispatch = dispatcher.dispatch.bind(dispatcher);
  dispatcher.dispatch = (options, handler) => {
    const hostname = new URL(String(options.origin)).hostname;
    if (hostname !== 'localhost' && !hostname.endsWith('.localhost')) throw Error('Non-loopback SQL test origin');
    return dispatch(options, handler);
  };
  setGlobalDispatcher(dispatcher);
  globalThis.WebSocket = class extends WebSocket {
    constructor(url: string | URL, protocols: string | string[] = []) {
      super(url, { protocols, dispatcher });
    }
  } as typeof globalThis.WebSocket;
  const clientAddress = `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  globalThis.fetch = ((input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.origin !== SERVICE) return previousFetch(input, init);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('CF-Connecting-IP', clientAddress);
    return previousFetch(input, { ...init, headers });
  }) as typeof fetch;
  let owned: any, ownedLifetime: AbortController | undefined;
  async function stop() {
    const current = owned; owned = undefined;
    try { await current?.close(); } finally { ownedLifetime?.abort(); ownedLifetime = undefined; }
  }
  async function cleanup() {
    try { await stop(); }
    finally {
      globalThis.WebSocket = previousWebSocket; globalThis.fetch = previousFetch; setGlobalDispatcher(previousDispatcher);
      try { await dispatcher.destroy(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
  try {
    for (const path of TUTORIAL_FILES.filter(path => !path.startsWith('deploy/'))) {
      const target = join(workspaceRoot, path); await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve('docs/tutorial', path), target);
    }
    const modules = join(workspaceRoot, 'node_modules');
    if (consumer) {
      await cp(resolve(consumer, 'node_modules'), modules, { recursive: true, dereference: true });
    } else {
      await cp(resolve('node_modules/@chronolog/peer-session'), join(modules, '@chronolog/peer-session'), { recursive: true, dereference: true });
      await cp(resolve('node_modules/quickjs-emscripten-core'), join(modules, 'quickjs-emscripten-core'), { recursive: true, dereference: true });
      await cp(resolve('node_modules/@jitl'), join(modules, '@jitl'), { recursive: true, dereference: true });
    }
    await cp(resolve('dist/sdk'), join(modules, '@tendriller/core'), { recursive: true, dereference: true });
    await cp(resolve('dist/tools'), join(modules, '@tendriller/tools'), { recursive: true, dereference: true });
    await cp(resolve('node_modules/@chronolog/authority'), join(modules, '@chronolog/authority'), { recursive: true, dereference: true });
    const load = (path: string) => import(pathToFileURL(join(workspaceRoot, path)).href);
    const tools = await load('node_modules/@tendriller/tools/lib/workspace.mjs');

    await tools.initWorkspace(workspaceRoot, { service: SERVICE, owner: OWNER, handle: 'sql-tutorial' });
    const starter = await load('setup.mjs');
    const created = await starter.createPage(SLUG, { template: 'inventory', name: 'Shared inventory' });
    const recordPath = join(workspaceRoot, '.tendriller/pages', created.id, 'page.json');
    const saved = JSON.parse(await readFile(recordPath, 'utf8'));
    await writeFile(recordPath, JSON.stringify({ ...saved, page_url: localPageUrl(saved) }), { mode: 0o600 });
    const { pageContext } = await load('shared/local.mjs');
    const pageModule = (name: string) => load(`pages/${SLUG}/${name}`);
    const context = await pageContext(SLUG);
    const credential = JSON.parse(await readFile(join(workspaceRoot, '.tendriller/agent/credential.json'), 'utf8'));
    const handle: PageHandle = { id: created.id, page_url: created.page_url, api: `${SERVICE}/api/agent/pages/${created.id}`,
      token: credential.token, agent: credential.agent, application: saved.application };

    const prepared = await (await pageModule('setup.mjs')).initializePage(context, { browserFirst: true });
    expect(prepared).toMatchObject({ prepared: true, creator: 'browser', dataInitialized: false });
    const built = await (await pageModule('build.mjs')).buildPage(context, { bundle: build });

    for (const file of await readdir(built, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const bytes = await readFile(join(file.parentPath, file.name));
      if (bytes.includes(Buffer.from(credential.token))) throw Error('Private workspace credential entered the authored graph');
    }
    const receipt = await (await pageModule('publish.mjs')).publishPage(context, { root: pathToFileURL(built.endsWith('/') ? built : built + '/') });
    const peers = context.host.peers, served = await peers.publication();
    if (!served || served.version !== receipt.version || !Number.isSafeInteger(receipt.version))
      throw Error('Host did not retain the exact signed tutorial graph and host version mapping');
    const publication = served, publicationVersion = served.version;
    const devicePath = context.devicePath;
    async function exists(path: string) {
      try { await access(path); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    }
    return {
      handle, publication, publicationVersion,
      sessionProvenance: JSON.parse(await readFile(join(modules, '@chronolog/peer-session/provenance.json'), 'utf8')),
      nativePublicKey: context.signer.publicKey as string,
      async start() {
        if (owned) throw Error('Stop the current page owner before starting it again.');
        ownedLifetime = new AbortController();
        owned = await (await pageModule('agent.mjs')).openPage(await pageContext(SLUG, { signal: ownedLifetime.signal }));
        return owned.session;
      },
      deviceExists: () => exists(devicePath),
      stop, cleanup,
    };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'SQL tutorial preparation and cleanup failed'); }
    throw error;
  }
}
