// Shared setup for isolated first-app harnesses (scripts/test-first-app.mjs and
// scripts/test-chaos.mjs): loopback-only networking, the packed host under
// Miniflare with synthetic account sessions, the agent program process and the
// synthetic owner claim. Nothing here is shipped; it consumes built public artifacts.
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { packedEngineModules } from './packed-engine-modules.mjs';
import { createAttestationKey } from './attestation-key.mjs';
import { once } from 'node:events';
import { connect as connectTls } from 'node:tls';
import { Agent } from 'undici';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from 'wrangler';
import { FIRST_APP_WEBSOCKET_PROXY_WORKER } from './first-app-websocket-host.mjs';

const require = createRequire(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export const DEFAULT_FIXTURE_PORT = 8790;
export const serviceOrigin = (port = DEFAULT_FIXTURE_PORT) => `https://service.localhost:${port}`;
export const FIXTURE_OWNER = Object.freeze({ account: 'e2e-owner', email: 'owner@example.test', token: 'tendriller-local-e2e-session' });

// Every request, including a followed redirect or literal IP, is restricted to
// loopback hosts. TLS relaxation never enters the tutorial, packages or page.
// The same test-only factory is copied into the child-process preload below,
// so it must stay self-contained (no closure over module state).
export function createLocalDispatcher() {
  class LocalAgent extends Agent {
    dispatch(options, handler) {
      const hostname = new URL(options.origin).hostname;
      if (!hostname.endsWith('.localhost') && hostname !== 'localhost' && hostname !== '127.0.0.1')
        throw Error('The first-app fixture refuses non-loopback network access.');
      return super.dispatch(options, handler);
    }
  }
  return new LocalAgent({ connect: { rejectUnauthorized: false,
    lookup(_hostname, options, callback) {
      if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    },
  } });
}

/** Write the child-process preload that installs the loopback-only dispatcher. */
export async function writeLocalNetworkPreload(path) {
  await writeFile(path, `import { Agent, setGlobalDispatcher, WebSocket } from ${JSON.stringify(pathToFileURL(require.resolve('undici')).href)};
${createLocalDispatcher.toString()}
const dispatcher = createLocalDispatcher();
setGlobalDispatcher(dispatcher);
const sockets = new Set();
globalThis.WebSocket = class extends WebSocket {
  constructor(url, protocols = []) {
    super(url, { protocols, dispatcher }); sockets.add(this);
    this.addEventListener('close', () => sockets.delete(this), {once:true});
  }
};
export async function closeLocalTransport() {
  // Never turn a leaked OPEN application socket into a successful owner close.
  if ([...sockets].some(socket => socket.readyState < 2)) throw Error('Native owner left an open fixture WebSocket');
  await Promise.all([...sockets].map(socket => new Promise((resolve, reject) => {
    const close = () => { clearTimeout(timer); socket.removeEventListener('close', close); resolve(); };
    const timer = setTimeout(() => {
      socket.removeEventListener('close', close);
      const url = new URL(socket.url), lane = url.searchParams.get('lane');
      reject(Error('Native WebSocket close handshake did not finish: ' + url.pathname +
        (['reliable','live'].includes(lane) ? ' lane=' + lane : '') + ' readyState=' + socket.readyState));
    }, 3000);
    socket.addEventListener('close', close, {once:true}); if (socket.readyState === 3) close();
  })));
  // This pool belongs to the loopback/TLS fixture, not to the public bootstrap.
  // Graceful close drains outstanding requests; it does not destroy live work.
  await dispatcher.close();
}
`);
  return path;
}

export async function localCertificatePin(port = DEFAULT_FIXTURE_PORT) {
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host: '127.0.0.1', port,
      servername: 'service.localhost', rejectUnauthorized: false });
    const finish = (error, value) => {
      clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(Error('Local fixture certificate was unavailable')), 5_000);
    socket.once('error', error => finish(error));
    socket.once('secureConnect', () => {
      try {
        const certificate = new X509Certificate(socket.getPeerCertificate().raw);
        finish(null, createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'));
      } catch (error) { finish(error); }
    });
  });
}

/** Chromium options that trust only this loopback fixture certificate and
 * route every *.localhost page origin to the fixture port. */
export function fixtureBrowserOptions({ certificatePin, port = DEFAULT_FIXTURE_PORT }) {
  return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--host-resolver-rules=MAP *.localhost:443 127.0.0.1:${port}, MAP *.localhost 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${certificatePin}`] };
}

/**
 * Start the unchanged packed engine Worker (behind the test-only WebSocket
 * forwarding Worker) with isolated persistent storage. On first start the
 * account migrations run and a synthetic owner session plus an MCP OAuth grant
 * are seeded. `restart()` disposes and reopens the same storage (same OAuth key).
 */
export async function startPackedHost({ root, engine, directory, kit, port = DEFAULT_FIXTURE_PORT, seed = true,
  // The isolated first-app qualifier supplies a bundle carrying the public authority publication
  // decoder (same selected authority archive); the default proxy is dependency-free and gate-inert.
  proxyScript = FIRST_APP_WEBSOCKET_PROXY_WORKER }) {
  const SERVICE = serviceOrigin(port);
  // Use the public runtime API directly: address-printing in the dev CLI needs
  // network-interface inspection that restricted execution hosts may disallow.
  const { workerOptions: sourceOptions } = unstable_getMiniflareWorkerOptions(join(root, 'server/wrangler.jsonc'));
  // The engine archive is already one bundled module; source-loader rules do
  // not apply to it (and are intentionally unsupported by the v5 converter).
  const { modulesRules: _sourceRules, ...workerOptions } = sourceOptions;
  // These credentials exist only in the isolated synthetic host. Exercise the
  // actual OAuth verifier, scope checks and MCP setup route without a provider.
  const oauthKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const oauthJwk = { ...await crypto.subtle.exportKey('jwk', oauthKey.privateKey), alg: 'ES256', kid: 'first-app-test' };
  const oauthConfiguration = { resource: SERVICE + '/mcp', clients: [{ id: 'first-app-test', name: 'First app test',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'], scopes: ['tendrils:create', 'tendrils:list'] }] };
  // Pages pin the host attestation key; restart() and golden-copy restarts keep the same identity with the same storage.
  const attestationKeyPath = join(directory, 'host-attestation-key.json');
  let attestationKey;
  try {
    attestationKey = await readFile(attestationKeyPath, 'utf8');
  } catch {
    attestationKey = JSON.stringify(createAttestationKey());
    await writeFile(attestationKeyPath, attestationKey, { mode: 0o600 });
  }
  const engineModules = await packedEngineModules(join(engine, 'package'));
  const options = () => ({ ...convertV4MiniflareOptions({
    host: '127.0.0.1', port, https: true, cf: false,
    workers: [
      { name: 'first-app-network', modules: true, script: proxyScript,
        compatibilityDate: workerOptions.compatibilityDate, serviceBindings: { PACKED_HOST: 'first-app-packed-host' } },
      { ...workerOptions, name: 'first-app-packed-host',
        ...engineModules,
        bindings: { ...workerOptions.bindings, PUBLIC_BASE: SERVICE, PAGE_BASE_DOMAIN: 'pages.localhost',
          OAUTH_SIGNING_JWK: JSON.stringify(oauthJwk), OAUTH_CONFIG_JSON: JSON.stringify(oauthConfiguration), HOST_ATTESTATION_KEY: attestationKey,
          ...(kit ? { SERVICE_SOURCE_COMMIT: kit.composition.core.source, SERVICE_COMPOSITION_ID: kit.composition.id } : {}) } },
    ],
  }), resourcePersistencePath: join(directory, 'host-state'), resourceTmpPath: join(directory, 'host-tmp'),
  enableDevRegistry: false, logRequests: false });
  const fixture = { service: SERVICE, port, oauthJwk, ownerToken: FIXTURE_OWNER.token, oauthToken: undefined,
    host: new Miniflare(options()), accounts: undefined,
    async restart() {
      await fixture.host.dispose();
      fixture.host = new Miniflare(options()); await fixture.host.ready;
      fixture.accounts = await fixture.host.getD1Database('ACCOUNTS', 'first-app-packed-host');
    },
    dispose() { return fixture.host.dispose(); } };
  await fixture.host.ready;
  const accounts = fixture.accounts = await fixture.host.getD1Database('ACCOUNTS', 'first-app-packed-host');
  if (!seed) return fixture;
  for (const migration of (await readdir(join(engine, 'package/migrations')))
    .filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort())
    for (const query of unstable_splitSqlQuery(await readFile(join(engine, 'package/migrations', migration), 'utf8')))
      await accounts.prepare(query).run();
  const now = Date.now(), ownerToken = FIXTURE_OWNER.token;
  const oauthGrant = crypto.randomUUID(), oauthJti = crypto.randomUUID();
  const jwtPart = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = jwtPart({ alg: 'ES256', typ: 'JWT', kid: oauthJwk.kid }) + '.' + jwtPart({
    iss: SERVICE, aud: SERVICE + '/mcp', sub: 'e2e-owner', client_id: 'first-app-test', sid: oauthGrant,
    jti: oauthJti, scope: 'tendrils:create tendrils:list', exp: Math.floor((now + 86_400_000) / 1000) });
  const oauthToken = fixture.oauthToken = signingInput + '.' + Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
    oauthKey.privateKey, new TextEncoder().encode(signingInput))).toString('base64url');
  await accounts.batch([
    accounts.prepare("UPDATE service_state SET mode = 'open' WHERE id = 1"),
    accounts.prepare('INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)').bind('e2e-owner', now, 'owner@example.test'),
    accounts.prepare('INSERT INTO identities (provider, subject, account_id, login, email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('github', 'e2e-subject', 'e2e-owner', 'e2e-owner', 'owner@example.test', now),
    accounts.prepare('INSERT INTO identity_emails (provider, subject, email) VALUES (?, ?, ?)').bind('github', 'e2e-subject', 'owner@example.test'),
    accounts.prepare('INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(sha256(ownerToken), 'e2e-owner', now, now + 86_400_000),
    // Each grant carries an X25519 wrap public key for opt-in hosted participants;
    // this synthetic grant never connects one, so a fresh valid key suffices.
    accounts.prepare('INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,wrap_public_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(oauthGrant, 'e2e-owner', 'first-app-test', SERVICE + '/mcp', 'tendrils:create tendrils:list', await syntheticWrapPublicKey(), now, now + 86_400_000),
    accounts.prepare('INSERT INTO integration_oauth_access(hash,grant_id,jti,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)')
      .bind(sha256(oauthToken), oauthGrant, oauthJti, 'tendrils:create tendrils:list', now, now + 86_400_000),
  ]);
  return fixture;
}

async function syntheticWrapPublicKey() {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
}

/**
 * Spawn `tendril agent run` in a workspace. Its JSON stdout lines are appended
 * to `events` (bounded by `maxEvents`); `waitFor` resolves on the first event
 * since this start that matches. `stderr()` keeps the last 6,000 characters.
 */
export function startAgentProgram({ cwd, preload, cli, env = {}, events, maxEvents = 2_000, stderrLimit = 6_000, onLine }) {
  const child = spawn(process.execPath, ['--import', preload, cli, 'agent', 'run'], { cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env } });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-stderrLimit); });
  // A refused signal (some container profiles deny kill) must fail the step, not crash the report.
  child.on('error', error => { stderr = (stderr + `\n[harness] ${error.code ?? error.message}`).slice(-stderrLimit); });
  const waiters = new Set();
  createInterface({ input: child.stdout }).on('line', line => {
    onLine?.(line);
    let value; try { value = JSON.parse(line); } catch { return; }
    if (events.length < maxEvents) events.push(value);
    for (const waiter of waiters) if (waiter.match(value)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(value); }
  });
  const exited = once(child, 'exit');
  const program = { child, exited, stderr: () => stderr,
    waitFor(match, label, timeoutMs = 60_000) {
      const seen = events.slice(program.from).find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(Error(`Agent program did not report ${label}: ${stderr}`)); }, timeoutMs) };
        waiters.add(waiter);
        exited.then(([code]) => { if (waiters.delete(waiter)) { clearTimeout(waiter.timer); reject(Error(`Agent program exited (${code}) before ${label}: ${stderr}`)); } });
      });
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      const [code, signal] = await exited; clearTimeout(timer);
      return { code, signal };
    } };
  program.from = events.length;
  return program;
}

/** Traverse the actual owner claim flow with the synthetic owner session cookie. */
export async function claimOwnerThroughPage({ pageUrl, ownerToken = FIXTURE_OWNER.token, port = DEFAULT_FIXTURE_PORT }) {
  const localPage = new URL(pageUrl); localPage.port = String(port);
  const initialClaim = await fetch(localPage, { redirect: 'manual' });
  await initialClaim.body?.cancel();
  if (initialClaim.status !== 302) throw Error(`Owner claim: expected 302 from the page, got ${initialClaim.status}`);
  const claim = await fetch(initialClaim.headers.get('Location'), { redirect: 'manual',
    headers: { Cookie: `__Host-tendriller=${ownerToken}` } });
  await claim.body?.cancel();
  if (claim.status !== 303) throw Error(`Synthetic owner must traverse the actual claim flow (got ${claim.status}).`);
  const redeemUrl = new URL(claim.headers.get('Location')); redeemUrl.port = String(port);
  const redeem = await fetch(redeemUrl, { redirect: 'manual' });
  await redeem.body?.cancel();
  if (redeem.status !== 303) throw Error(`Owner claim redeem: expected 303, got ${redeem.status}`);
}
