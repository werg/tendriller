#!/usr/bin/env node
// A loopback-only, persistent host for one verified source release.
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { connect } from 'node:tls';
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareDevHostRelease } from './dev-host-release.mjs';
import { FIRST_APP_WEBSOCKET_PROXY_WORKER } from './first-app-websocket-host.mjs';

const require = createRequire(import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const usage = `Usage: npm run dev:host -- --release FULL_SOURCE_SHA [options]

  --state DIR       Retained local host and browser state (default .tendriller-dev-host/SHA)
  --port N          Loopback HTTPS port (default 8790)
  --open            Open an isolated Chromium profile with local DNS and certificate trust
  --headless        With --open, run Chromium without a window for automation
  --artifacts DIR   Read a complete manifest-bound release from DIR instead of GitHub

Requires a source release with a sealed deployment and storage schema 11.
Uses the release's packed Worker, public assets and first-app kit without a build.
No Cloudflare account or production credentials are needed. See docs/LOCAL_HOST.md.`;

async function availablePort(port) {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}

async function certificate(port) {
  return new Promise((done, reject) => {
    const socket = connect({ host: '127.0.0.1', port, servername: 'service.localhost', rejectUnauthorized: false });
    const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : done(value); };
    const timer = setTimeout(() => finish(Error('Local host certificate was unavailable.')), 5_000);
    socket.once('error', error => finish(error));
    socket.once('secureConnect', () => {
      try {
        const cert = new X509Certificate(socket.getPeerCertificate().raw);
        finish(null, { pem: cert.toString(), sha256: digest(cert.raw),
          spki: createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64') });
      } catch (error) { finish(error); }
    });
  });
}

/** This opt-in preload trusts only this local certificate and refuses remote requests. */
export function localNetworkSource({ port, cert, undiciUrl }) {
  return `import { Agent, setGlobalDispatcher } from ${JSON.stringify(undiciUrl)};
import { createHash } from 'node:crypto';
class LocalAgent extends Agent {
  dispatch(options, handler) {
    const url = new URL(options.origin);
    if (url.protocol !== 'https:' || !(url.hostname === 'service.localhost' || /^[a-z2-7]{12}\\.pages\\.localhost$/.test(url.hostname)) ||
        url.port && url.port !== ${JSON.stringify(String(port))}) throw Error('The dev-host preload only permits this loopback host.');
    url.port = ${JSON.stringify(String(port))};
    return super.dispatch({ ...options, origin: url.origin }, handler);
  }
}
setGlobalDispatcher(new LocalAgent({ connect: {
  ca: ${JSON.stringify(cert.pem)},
  checkServerIdentity(_hostname, peer) {
    if (createHash('sha256').update(peer.raw).digest('hex') !== ${JSON.stringify(cert.sha256)}) return Error('Local host certificate changed. Restart the native process with the current preload.');
  },
  lookup(_hostname, options, callback) {
    if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  },
} }));
`;
}

export async function startDevHost({ release, state, port = 8790, artifacts, signal, fetcher, openBrowser = false, headless = false }) {
  if (!/^[a-f0-9]{40}$/.test(release ?? '')) throw Error('--release requires a full 40-character source commit SHA.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('--port must be an integer between 1024 and 65535.');
  const directory = resolve(state ?? join('.tendriller-dev-host', release));
  const serviceOrigin = `https://service.localhost:${port}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'host.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('This state directory is locked. Stop its host first; after a crash, remove host.lock only after checking its recorded PID.');
    throw error;
  }
  let host, browser, closing, stage = 'release verification';
  const close = () => closing ??= (async () => {
    try { await browser?.close(); }
    finally { try { await host?.dispose(); } finally { await lock.close(); await rm(lockPath, { force: true }); } }
  })();
  try {
    let previous;
    try { previous = await json(join(directory, 'host.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && (previous.source !== release || previous.serviceOrigin !== serviceOrigin))
      throw Error('This state directory belongs to another release or origin. Resume it with the original options, or choose a new --state directory.');
    await availablePort(port);
    const selected = await prepareDevHostRelease({ release, directory, artifacts, signal, fetcher, manifestSha256: previous?.manifestSha256 });
    signal?.throwIfAborted();
    // Wrangler's import configures a process-wide proxy dispatcher. Its SQL
    // parser must not change the caller's networking or proxy loopback RPC.
    const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
    const { Agent, fetch, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
    const dispatcher = getGlobalDispatcher();
    const { unstable_splitSqlQuery } = await import('wrangler');
    setGlobalDispatcher(dispatcher);
    const { manifest, manifestSha256 } = selected, engine = join(selected.directory, 'dist/engine');
    const preload = join(directory, 'local-network.mjs');
    const info = { source: release, manifestSha256, version: manifest.version, compositionId: manifest.composition.id,
      serviceOrigin, owner: 'owner@example.test', kitDirectory: selected.kitDirectory, preload, state: directory };
    // Pin state before workerd can initialize storage, including failed starts.
    await writeFile(join(directory, 'host.json'), JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
    const accountId = 'test_' + digest('tendriller-dev-host:' + release).slice(0, 32);
    const owner = 'owner@example.test', token = randomBytes(32).toString('base64url');
    const now = Date.now(), expiresAt = now + 86_400_000;
    const { ratelimits } = await json(join(engine, 'testing-ratelimits.json'));
    const compatibilityDate = '2026-11-01';
    stage = 'runtime startup';
    host = new Miniflare({ ...convertV4MiniflareOptions({
      host: '127.0.0.1', port, https: true, cf: false,
      workers: [
        { name: 'dev-host-network', modules: true, script: FIRST_APP_WEBSOCKET_PROXY_WORKER,
          compatibilityDate, serviceBindings: { PACKED_HOST: 'dev-host-packed' } },
        { name: 'dev-host-packed', modules: true, scriptPath: join(engine, 'worker.mjs'), modulesRoot: engine,
          compatibilityDate, compatibilityFlags: ['nodejs_compat'],
          durableObjects: { TENDRIL: { className: 'Tendril', useSQLite: true }, ADMISSION: { className: 'Admission', useSQLite: true } },
          d1Databases: { ACCOUNTS: 'dev-host-accounts' }, r2Buckets: { FILES: 'dev-host-files' },
          ratelimits: Object.fromEntries(ratelimits.map(({ name, ...value }) => [name, value])),
          assets: { directory: join(selected.directory, 'server/public'), binding: 'ASSETS', run_worker_first: true,
            routerConfig: { has_user_worker: true } },
          bindings: { PUBLIC_BASE: serviceOrigin, PAGE_BASE_DOMAIN: 'pages.localhost', SERVICE_ENVIRONMENT: 'local',
            SERVICE_SOURCE_COMMIT: release, SERVICE_COMPOSITION_ID: manifest.composition.id,
            TEST_ACCESS_JSON: JSON.stringify({ accountId, tokenSha256: digest(token), expiresAt }) },
        },
      ],
    }), resourcePersistencePath: join(directory, 'storage'), resourceTmpPath: join(directory, 'tmp'),
    enableDevRegistry: false, logRequests: false });
    const listening = await host.ready;
    if (Number(listening.port) !== port) throw Error('The requested local port was unavailable.');
    stage = 'local database initialization';
    const accounts = await host.getD1Database('ACCOUNTS', 'dev-host-packed');
    const initialized = await accounts.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='service_state'").first();
    if (!initialized) {
      for (const file of (await readdir(join(engine, 'migrations'))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()) {
        const queries = unstable_splitSqlQuery(await readFile(join(engine, 'migrations', file), 'utf8'));
        await accounts.batch(queries.map(query => accounts.prepare(query)));
      }
    }
    await accounts.batch([
      accounts.prepare("UPDATE service_state SET mode='open' WHERE id=1"),
      accounts.prepare('INSERT OR IGNORE INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(accountId, now, owner),
      accounts.prepare('INSERT OR IGNORE INTO identities(provider,subject,account_id,login,email,created_at) VALUES(?,?,?,?,?,?)')
        .bind('test', accountId, accountId, 'local-owner', owner, now),
      accounts.prepare('INSERT OR IGNORE INTO identity_emails(provider,subject,email) VALUES(?,?,?)').bind('test', accountId, owner),
    ]);
    stage = 'local certificate setup';
    const cert = await certificate(port);
    stage = 'readiness verification';
    const local = new Agent({ connect: { ca: cert.pem,
      checkServerIdentity(_hostname, peer) { if (digest(peer.raw) !== cert.sha256) return Error('Local certificate changed.'); },
      lookup(_hostname, options, callback) { options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4); },
    } });
    try {
      // Probe the actual listening endpoint, including the forwarding Worker.
      const ready = await fetch(serviceOrigin + '/api/readiness', { dispatcher: local, redirect: 'error', signal: AbortSignal.timeout(5000) });
      const text = await ready.text();
      let readiness;
      try { readiness = JSON.parse(text); }
      catch { throw Error(`Local readiness returned HTTP ${ready.status} without JSON: ${text.slice(0, 200)}`); }
      if (!ready.ok || readiness.creation?.available !== true || readiness.build?.sourceCommit !== release ||
          readiness.build?.compositionId !== manifest.composition.id) throw Error('The local host did not advertise the verified release and open creation readiness.');
    } finally { await local.close(); }
    await writeFile(preload, localNetworkSource({ port, cert, undiciUrl: pathToFileURL(require.resolve('undici')).href }), { mode: 0o600 });
    const loginUrl = serviceOrigin + '/auth/test#token=' + token;
    if (openBrowser) {
      stage = 'browser startup';
      const { chromium } = await import('@playwright/test');
      browser = await chromium.launchPersistentContext(join(directory, 'browser'), {
        headless, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: [`--host-resolver-rules=MAP *.localhost:443 127.0.0.1:${port}, MAP *.localhost 127.0.0.1`,
          `--ignore-certificate-errors-spki-list=${cert.spki}`],
      });
      const page = browser.pages()[0] ?? await browser.newPage();
      await page.goto(loginUrl);
    }
    return { ...info, loginUrl, host, browser, close };
  } catch (error) { await close(); error.message = `Local host ${stage} failed: ${error.message}`; throw error; }
}

async function main() {
  const { values } = parseArgs({ options: { release: { type: 'string' }, state: { type: 'string' }, port: { type: 'string', default: '8790' },
    artifacts: { type: 'string' }, open: { type: 'boolean' }, headless: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(usage); return; }
  if (values.headless && !values.open) throw Error('--headless requires --open.');
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let running;
  try {
    console.log('Verifying the complete release before starting the local host…');
    running = await startDevHost({ release: values.release, state: values.state, port: Number(values.port), artifacts: values.artifacts,
      signal: lifetime.signal, openBrowser: values.open, headless: values.headless });
    console.log(JSON.stringify({ source: running.source, version: running.version, compositionId: running.compositionId,
      serviceOrigin: running.serviceOrigin, owner: running.owner, loginUrl: running.loginUrl,
      kitDirectory: running.kitDirectory, preload: running.preload, state: running.state }, null, 2));
    console.log('Local host ready. Keep this process running. Use the isolated Chromium window for owner sign-in and pairing; see docs/LOCAL_HOST.md.');
    if (!lifetime.signal.aborted) await new Promise(done => lifetime.signal.addEventListener('abort', done, { once: true }));
  } catch (error) { if (!lifetime.signal.aborted) throw error; }
  finally { await running?.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
