// Test-only loopback plumbing around the actual starter workspace and its inventory
// template, never a replacement page, Worker, domain, session implementation,
// command bridge or SQL engine.
//
// A private workspace is assembled in a temporary folder: the starter files, plus a
// node_modules tree holding real copies (no symlinks, so every import resolves inside
// this one graph) of the built SDK and tools and of the job's combined SQL session
// consumer. The workspace's own tools register its agent with the workspace signer,
// the starter creates the inventory page, and the template's setup, build, enroll and
// agent modules run unchanged in this process through their page context.
import { build } from 'esbuild';
import { access, cp, mkdtemp, mkdir, copyFile, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { Agent, WebSocket, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { TUTORIAL_FILES } from '../../scripts/onboarding.mjs';
import { SERVICE, OWNER, localPageUrl, type PageHandle } from './local-helpers';

const SLUG = 'stock';

export async function prepareSqlTutorial(consumer: string, engineDirectory: string) {
  const directory = await mkdtemp(join(tmpdir(), 'sql-tutorial-browser-')), workspaceRoot = join(directory, 'workspace');
  const previousDispatcher = getGlobalDispatcher(), previousWebSocket = globalThis.WebSocket, previousFetch = globalThis.fetch;
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false, lookup(hostname, options, callback) {
    if (hostname !== 'localhost' && !hostname.endsWith('.localhost')) return callback(Error('Non-loopback SQL test request'), '', 4);
    if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  } } });
  // Reject external traffic, including redirects to literal IPs, before connect.
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
  // The local host rate-limits unauthenticated agent registration per client address.
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
      // The native supervisor and SQL close above must succeed. Dispose this
      // harness-owned loopback agent afterwards: workerd's external TCP Close
      // handshake is a separate first-app qualification (issue #8185).
      try { await dispatcher.destroy(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
  try {
    for (const path of TUTORIAL_FILES.filter(path => !path.startsWith('deploy/'))) {
      const target = join(workspaceRoot, path); await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve('docs/tutorial', path), target);
    }
    // Real copies of the public packages: the SDK and tools import the combined SQL
    // session from this workspace, never the checkout's events-only dependency.
    const modules = join(workspaceRoot, 'node_modules');
    await cp(resolve(consumer, 'node_modules'), modules, { recursive: true, dereference: true });
    await cp(resolve('dist/sdk'), join(modules, '@tendriller/core'), { recursive: true, dereference: true });
    await cp(resolve('dist/tools'), join(modules, '@tendriller/tools'), { recursive: true, dereference: true });
    const load = (path: string) => import(pathToFileURL(join(workspaceRoot, path)).href);
    const tools = await load('node_modules/@tendriller/tools/lib/workspace.mjs');
    const session = (key: string) => import(pathToFileURL(join(modules, '@chronolog/peer-session', exportPath(modules, '@chronolog/peer-session', key))).href);

    // The workspace tools register one unclaimed agent for the owner with the shared signer.
    await tools.initWorkspace(workspaceRoot, { service: SERVICE, owner: OWNER, name: 'sql-tutorial' });
    const starter = await load('setup.mjs');
    const created = await starter.createPage(SLUG, { template: 'inventory', name: 'Shared inventory' });
    // Loopback plumbing only: the local host serves page origins on port 8790, so the
    // private page record names that served origin (as the browser sees it).
    const recordPath = join(workspaceRoot, '.tendriller/pages', created.id, 'page.json');
    const saved = JSON.parse(await readFile(recordPath, 'utf8'));
    await writeFile(recordPath, JSON.stringify({ ...saved, page_url: localPageUrl(saved) }), { mode: 0o600 });
    const { pageContext } = await load('shared/local.mjs');
    const pageModule = (name: string) => load(`pages/${SLUG}/${name}`);
    const context = await pageContext(SLUG);
    const credential = JSON.parse(await readFile(join(workspaceRoot, '.tendriller/agent/credential.json'), 'utf8'));
    const handle: PageHandle = { id: created.id, page_url: created.page_url, api: `${SERVICE}/api/agent/pages/${created.id}`,
      token: credential.token, agent: credential.agent, application: saved.application };
    // Host preparation is metadata only: no page device, schema, data root or epoch key is created. It also places
    // the package's exact browser engine assets in pages/stock/engine/; they must be the verified ones under test.
    const prepared = await (await pageModule('setup.mjs')).initializePage(context);
    expect(prepared).toMatchObject({ prepared: true, initialized: false });
    const engineFiles = ['manifest.json', 'sqlite3.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js'];
    for (const name of engineFiles) {
      const installed = await readFile(join(context.page.source, 'engine', name)), verified = await readFile(resolve(engineDirectory, name));
      if (!installed.equals(verified)) throw Error(`Installed engine/${name} differs from the verified browser engine under test`);
    }
    const sqlBrowser = await session('./sql-browser');
    const built = await (await pageModule('build.mjs')).buildPage(context, { bundle: build,
      verifyWasmBuild: (bytes: Uint8Array, manifest: unknown) => sqlBrowser.verifyWasmBuild(bytes, manifest) });

    // The authored graph must not hold the workspace credential. Sign and publish it with the page's explicit
    // publisher grant and the shared agent key before claim, then read the exact graph back from the host.
    for (const file of await readdir(built, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const bytes = await readFile(join(file.parentPath, file.name));
      if (bytes.includes(Buffer.from(credential.token))) throw Error('Private workspace credential entered the authored graph');
    }
    const receipt = await (await pageModule('publish.mjs')).publishPage(context, { root: pathToFileURL(built.endsWith('/') ? built : built + '/') });
    const peers = context.host.peers, served = await peers.publication();
    if (served?.publication.id !== receipt.publicationId || served.version !== receipt.version || !Number.isSafeInteger(receipt.version))
      throw Error('Host did not retain the exact signed tutorial graph and host version mapping');
    const publication = served.publication, publicationVersion = served.version;

    const runStarter = async (action: string, value?: unknown) => {
      const file = value === undefined ? [] : [join(directory, `${action}-${randomUUID()}.json`)];
      if (file.length) await writeFile(file[0], JSON.stringify(value), { mode: 0o600 });
      return starter.run(action, [SLUG, ...file]);
    };
    const pageDirectory = context.page.directory, devicePath = context.devicePath;
    const materialized = context.privatePath('materialized.sqlite');
    async function exists(path: string) {
      try { await access(path); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    }
    // Keep a retired store's files for inspection; they are never reopened.
    async function setAside(path: string, suffix: string) {
      for (const name of await readdir(pageDirectory))
        if (join(pageDirectory, name) === path || name.startsWith(relative(pageDirectory, path) + '-'))
          await rename(join(pageDirectory, name), join(pageDirectory, name + suffix));
    }
    return {
      handle, publication, publicationVersion,
      sessionProvenance: JSON.parse(await readFile(join(modules, '@chronolog/peer-session/provenance.json'), 'utf8')),
      // The native participant is optional and never receives keys implicitly. These are the starter's explicit
      // commands for the page's shared signer: account-bound enrollment proof, a public provisioning request and
      // recipient-bound package import, each through the workspace's own `run(action, [slug, FILE])`.
      nativePublicKey: context.signer.publicKey as string,
      async signEnrollment(challenge: unknown) { return runStarter('sign-enrollment', challenge); },
      async provisioningRequest() { return runStarter('provisioning-request'); },
      async importProvisioning(value: unknown) {
        if (owned) throw Error('Stop the page owner before importing keys; it owns the page device.');
        return runStarter('import-provisioning', value);
      },
      // This page's part of the agent program: pages/stock/agent.mjs openPage(context).
      async start() {
        if (owned) throw Error('Stop the current page owner before starting it again.');
        ownedLifetime = new AbortController();
        owned = await (await pageModule('agent.mjs')).openPage(await pageContext(SLUG, { signal: ownedLifetime.signal }));
        return owned.session;
      },
      // The checkpoint CLI moves one standalone device store that holds its own signing
      // identity. A workspace page store is signed by the shared agent key and holds
      // none, so that move does not apply here. The derived SQL file is still
      // disposable: set it aside and let the reopened owner rebuild it from history.
      async discardMaterialization() {
        if (owned) throw Error('Stop the page owner before removing its derived SQL state.');
        if (!(await exists(materialized))) throw Error('SQL rebuild scenario requires an existing source materialization.');
        await setAside(materialized, '.source');
        return { sourceSetAside: !(await exists(materialized)), deviceKept: await exists(devicePath) };
      },
      materializationExists: () => exists(materialized),
      stop, cleanup,
    };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'SQL tutorial preparation and cleanup failed'); }
    throw error;
  }
}

function exportPath(modules: string, name: string, key: string) {
  // Resolved from the copied package's own exports map.
  const pkg = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'));
  const target = pkg.exports[key];
  const path = typeof target === 'string' ? target : target?.import ?? target?.default;
  if (typeof path !== 'string') throw Error(`Required public import unavailable: ${name}${key.slice(1)}`);
  return path;
}
