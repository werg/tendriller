// Test-only loopback plumbing around the actual tutorial, never a replacement
// page, Worker, domain, session implementation, command bridge or SQL engine.
import { build, type Plugin } from 'esbuild';
import { mkdtemp, mkdir, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent, WebSocket, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { TUTORIAL_FILES } from '../../scripts/onboarding.mjs';
import { buildPage } from '../../docs/tutorial/sql/build.mjs';
import { client, localPageUrl, type Handle } from './local-helpers';

export async function prepareSqlTutorial(handle: Handle, consumer: string, engineDirectory: string) {
  const packageRoot = resolve(consumer, 'node_modules/@chronolog/peer-session');
  const sdkRoot = resolve('dist/sdk');
  const metadata = async (root: string) => JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const [sdk, sessionPackage] = await Promise.all([metadata(sdkRoot), metadata(packageRoot)]);
  const directory = await mkdtemp(join(tmpdir(), 'sql-tutorial-browser-')), project = join(directory, 'sql');
  function exported(root: string, pkg: any, name: string) {
    const key = name === pkg.name ? '.' : '.' + name.slice(pkg.name.length);
    const target = pkg.exports[key];
    const path = typeof target === 'string' ? target : target?.import;
    if (typeof path !== 'string') throw Error(`Required public import unavailable: ${name}`);
    return resolve(root, path);
  }
  const imports = (native: boolean): Plugin => ({ name: 'exact-public-graph', setup(builder) {
    builder.onResolve({ filter: /^@tendriller\/core(?:\/|$)/ }, ({ path }) => ({ path: exported(sdkRoot, sdk, path) }));
    builder.onResolve({ filter: /^@chronolog\/peer-session(?:\/|$)/ }, ({ path }) => ({
      path: exported(packageRoot, sessionPackage, path), external: native,
    }));
  } });
  // The SDK has an events-only workspace dependency. Every native and browser
  // session import must instead resolve to this job's combined SQL public graph.
  const load = (name: string) => import(pathToFileURL(exported(packageRoot, sessionPackage, name)).href);
  const previousDispatcher = getGlobalDispatcher(), previousWebSocket = globalThis.WebSocket;
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
  let owned: any;
  async function stop() { const current = owned; owned = undefined; await current?.close(); }
  async function cleanup() {
    try { await stop(); }
    finally {
      globalThis.WebSocket = previousWebSocket; setGlobalDispatcher(previousDispatcher);
      // The native supervisor and SQL close above must succeed. Dispose this
      // harness-owned loopback agent afterwards: workerd's external TCP Close
      // handshake is a separate first-app qualification (issue #8185).
      try { await dispatcher.destroy(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
  try {
    for (const path of TUTORIAL_FILES.filter(path => path.startsWith('sql/') || path.startsWith('helpers/'))) {
      const target = join(directory, path); await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve('docs/tutorial', path), target);
    }
    const privateDirectory = join(project, '.tendriller'); await mkdir(privateDirectory, { mode: 0o700 });
    await writeFile(join(privateDirectory, 'handle.json'), JSON.stringify({ ...handle, page_url: localPageUrl(handle) }), { mode: 0o600 });
    // Bundle tutorial source without changing it. Its import.meta.url continues
    // to identify this private copied project; optional native modules remain
    // at their installed public-package paths (including native binary assets).
    const nativeFile = join(project, 'native-fixture.mjs');
    await build({ stdin: { contents: `export { initializeProject, enrollBrowser } from './setup.mjs';
      export { openSession } from './session.mjs'; export { readPrivate } from './local.mjs';`, resolveDir: project },
      outfile: nativeFile, bundle: true, platform: 'node', format: 'esm', target: 'node24', plugins: [imports(true)] });
    const tutorial = await import(pathToFileURL(nativeFile).href);
    const log = await load('@chronolog/peer-session'), native = await load('@chronolog/peer-session/native');
    const browserSql = await load('@chronolog/peer-session/sql-browser');
    await tutorial.initializeProject();
    await mkdir(join(project, 'engine'));
    for (const name of ['manifest.json', 'sqlite3.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js'])
      await copyFile(resolve(engineDirectory, name), join(project, 'engine', name));
    await buildPage({ root: pathToFileURL(project + '/'), readPrivate: tutorial.readPrivate,
      verifyWasmBuild: browserSql.verifyWasmBuild,
      bundle: (options: any) => build({ ...options, plugins: [imports(false)] }) });

    const peers = client(handle).peers, authority = await peers.application();
    const verified = await log.verifyAuthorityBundle(authority, await tutorial.readPrivate('descriptor.json'));
    const descriptor = authority.descriptor.payload;
    const initial = await tutorial.readPrivate('initial-input.json');
    const device = await native.openNativeDevice({ path: join(privateDirectory, 'device.sqlite') });
    let publication: any;
    try {
      const files: any[] = [], assets = new Map();
      async function collect(directory: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) { await collect(path); continue; }
          const bytes = await readFile(path), hash = await log.bytesDigest(bytes);
          if (bytes.includes(Buffer.from(handle.token)) || bytes.includes(Buffer.from(initial.epochKey)))
            throw Error('Private tutorial setup credential entered the authored graph');
          const name = relative(join(project, 'page'), path).replaceAll('\\', '/');
          const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.json') ? 'application/json'
            : name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
          files.push({ path: name, type, hash, size: bytes.length });
          assets.set(hash, { hash, bytes: bytes.toString('base64') });
        }
      }
      await collect(join(project, 'page')); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      publication = await log.signPublicationManifest({ applicationId: handle.application.id, historyId: descriptor.historyId,
        profile: descriptor.profile, controlRevision: verified.control.payload.revision, author: device.identity.publicKey,
        operationId: 'sql-tutorial-ui-publication', revision: 0, previous: null,
        definitionDigest: descriptor.definitionDigest, executionManifestDigest: descriptor.executionManifestDigest,
        entry: 'index.html', files }, device.identity);
      await log.verifyPublicationManifest(publication, verified);
      const receipt = await peers.publish(publication, [...assets.values()]);
      if (receipt.publication.id !== publication.id) throw Error('Signed tutorial publication receipt mismatch');
      const served = await peers.publication();
      if (served?.publication.id !== publication.id) throw Error('Host did not retain the exact signed tutorial graph');
    } finally { await device.close(); }
    return {
      publication,
      sessionProvenance: JSON.parse(await readFile(join(packageRoot, 'provenance.json'), 'utf8')),
      async enroll(publicKey: string) { await tutorial.enrollBrowser(publicKey); },
      async start() {
        owned = await tutorial.openSession({ signal: new AbortController().signal });
        return owned.session;
      },
      stop, cleanup,
    };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'SQL tutorial preparation and cleanup failed'); }
    throw error;
  }
}
