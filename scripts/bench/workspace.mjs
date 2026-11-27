// Benchmark world: packed host + downloaded first-app workspace with published
// notes pages, following the non-kit path of scripts/test-first-app.mjs
// (explicit --session-archive/--authority-archive): the starter is downloaded
// from the isolated host itself, the public archives from dist/ are installed,
// one workspace agent is registered, and every page is created, prepared
// browser-first and published before any browser opens it.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { startPackedHost, writeLocalNetworkPreload } from '../first-app-fixture.mjs';
import { benchConfigRoot, benchProxyWorker } from './host.mjs';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));

/** The Chronolog archives that match the repository's installed (engine-bundled) packages. */
export async function selectChronologArchives(root) {
  const archives = {};
  for (const [role, name] of [['session', 'peer-session'], ['authority', 'authority']]) {
    const proof = await jsonFile(join(root, 'node_modules/@chronolog', name, 'provenance.json'));
    const candidates = [join(root, 'test/artifacts', `chronolog-${name}-${proof.source.slice(0, 8)}.tgz`),
      join(root, 'dist', `chronolog-${name}-${proof.source}.tgz`)];
    for (const path of candidates) if (await stat(path).then(() => true, () => false)) { archives[role] = path; break; }
    if (!archives[role]) throw Error(`No archive for installed @chronolog/${name} ${proof.source} (looked in ${candidates.join(', ')})`);
  }
  return archives;
}

/** Engine identity and build time of the dist/ artifacts this run measures. */
export async function buildIdentity(root) {
  const version = (await jsonFile(join(root, 'package.json'))).version;
  const engineArchive = join(root, 'dist', `tendriller-engine-${version}.tgz`);
  const worker = join(root, 'dist/engine/worker.mjs');
  const proof = await jsonFile(join(root, 'dist/engine/provenance.json')).catch(() => null);
  return { version, engineArchive, engineSha256: sha256(await readFile(engineArchive)),
    workerBuiltAt: (await stat(worker)).mtime.toISOString(), engineArchiveBuiltAt: (await stat(engineArchive)).mtime.toISOString(),
    source: proof?.source ?? null, dirty: proof?.dirty ?? null };
}

export async function prepareWorld({ root, directory, port, pages, log = console.log, rateLimit }) {
  const version = (await jsonFile(join(root, 'package.json'))).version;
  const archive = name => join(root, 'dist', `tendriller-${name}-${version}.tgz`);
  const chronolog = await selectChronologArchives(root);
  const app = join(directory, 'application'), engine = join(directory, 'engine');
  await mkdir(app, { recursive: true }); await mkdir(engine, { recursive: true });
  const run = async (command, args, options = {}) =>
    (await execute(command, args, { cwd: app, timeout: 300_000, maxBuffer: 64 * 1024 * 1024, ...options })).stdout;

  // Snapshot the engine now: later rebuilds by other processes do not change this run.
  await run('tar', ['-xzf', archive('engine'), '-C', engine]);
  log('bench: start isolated packed host');
  const host = await startPackedHost({ root: await benchConfigRoot({ root, directory, rateLimit }), engine, directory, port,
    proxyScript: benchProxyWorker() });
  try {
    const SERVICE = host.service;
    const readiness = await (await fetch(SERVICE + '/api/readiness')).json();
    if (readiness.creation?.available !== true) throw Error('Isolated host does not allow creation: ' + JSON.stringify(readiness).slice(0, 300));

    log('bench: download starter workspace and install public archives');
    const source = await fetch(`${SERVICE}/downloads/tendriller-first-app.tgz`);
    if (source.status !== 200) throw Error(`Starter download failed: HTTP ${source.status}`);
    const starter = join(directory, 'first-app.tgz');
    await writeFile(starter, new Uint8Array(await source.arrayBuffer()));
    await run('tar', ['-xzf', starter, '-C', app]);
    const npmCache = process.env.BENCH_NPM_CACHE;
    const cacheArgs = npmCache ? ['--cache', npmCache] : [];
    const pack = async name => {
      const path = dirname(require.resolve(`${name}/package.json`));
      const result = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--offline', '--json', ...cacheArgs, '--pack-destination', directory, path]));
      return join(directory, result[0].filename);
    };
    const esbuild = [await pack('esbuild'), await pack(`@esbuild/${process.platform}-${process.arch}`)];
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', ...cacheArgs,
      archive('sdk'), archive('tools'), chronolog.authority, chronolog.session, ...esbuild]);

    const preload = await writeLocalNetworkPreload(join(directory, 'local-network.mjs'));
    const cli = join(app, 'node_modules/@tendriller/tools/bin/tendril.mjs');
    const node = args => run(process.execPath, ['--import', preload, ...args]);
    const tendril = async args => JSON.parse(await node([cli, ...args]));
    const setup = async args => JSON.parse(await node([join(app, 'setup.mjs'), ...args]));

    log('bench: register workspace agent');
    await tendril(['workspace', 'init', '--service', SERVICE, '--owner', 'owner@example.test', '--handle', 'bench']);
    const created = {};
    for (const slug of pages) {
      log(`bench: create, prepare (browser-first) and publish page ${slug}`);
      const page = await setup(['new', slug, '--template', 'notes', '--name', `Bench ${slug}`, '--icon', '📝']);
      await setup(['init', slug, '--browser-first']);
      const publication = await setup(['deploy', slug]);
      const record = await jsonFile(join(app, '.tendriller/pages', page.id, 'page.json'));
      created[slug] = { slug, id: page.id, page_url: record.page_url, publicationId: publication.publicationId };
    }
    const distFiles = [];
    for (const slug of pages) for (const entry of await readdir(join(app, 'pages', slug, 'dist'), { recursive: true }))
      distFiles.push(`${slug}/${entry}`);
    return { host, service: SERVICE, app, preload, cli, tendril, pages: created, chronolog, distFiles };
  } catch (error) { await host.dispose().catch(() => {}); throw error; }
}
