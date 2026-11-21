// Compact, non-intrusive capability and independent transport probe (W5 + W6).
// Inspects only ordinary user-facing interfaces; untested items remain explicitly "unknown".
import { freemem, platform, arch, tmpdir, totalmem } from 'node:os';
import { openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

export const EXIT_CODES = Object.freeze({
  READY: 0,
  CAPABILITY_MISSING: 2,
  INTEGRITY_FAILURE: 3,
  LOCK_CONFLICT: 4,
});

export function detectProxyEnvironment(env = process.env) {
  const read = key => env[key] || env[key.toLowerCase()] || null;
  const httpProxy = read('HTTP_PROXY');
  const httpsProxy = read('HTTPS_PROXY');
  const noProxy = read('NO_PROXY');
  const extraCaCerts = env.NODE_EXTRA_CA_CERTS || null;
  return Object.freeze({
    configured: Boolean(httpProxy || httpsProxy),
    httpProxy: httpProxy ? '[configured]' : null,
    httpsProxy: httpsProxy ? '[configured]' : null,
    noProxy: noProxy ?? null,
    customCaConfigured: Boolean(extraCaCerts),
  });
}

function detectLibc() {
  if (platform() !== 'linux') return null;
  try {
    const report = process.report?.getReport?.();
    const header = typeof report === 'object' && report !== null ? report.header : null;
    if (header?.glibcVersionRuntime) return `glibc-${header.glibcVersionRuntime}`;
    return 'musl-or-unknown';
  } catch {
    return 'unknown';
  }
}

async function probeStorage(projectPath) {
  const root = resolve(projectPath ?? process.cwd());
  const result = {
    projectPath: root,
    writableProjectPath: false,
    atomicRenameAndLock: false,
    disposableTempDir: false,
    sameSessionSaveReopen: false,
    postReplacementSurvival: 'unknown',
  };
  try {
    mkdirSync(root, { recursive: true });
    const markerA = join(root, `.tendriller-probe-${randomUUID()}.tmp`);
    const markerB = join(root, `.tendriller-probe-${randomUUID()}.ok`);
    const fd = openSync(markerA, 'wx', 0o600);
    try { writeFileSync(fd, 'tendriller-probe'); } finally { closeSync(fd); }
    result.writableProjectPath = true;
    renameSync(markerA, markerB);
    const readback = readFileSync(markerB, 'utf8');
    unlinkSync(markerB);
    result.atomicRenameAndLock = true;
    result.sameSessionSaveReopen = readback === 'tendriller-probe';
  } catch {
    // Keep explicit false values.
  }
  try {
    const scratch = join(tmpdir(), `tendriller-probe-${randomUUID()}`);
    mkdirSync(scratch, { recursive: true });
    const file = join(scratch, 'check');
    writeFileSync(file, 'ok');
    result.disposableTempDir = readFileSync(file, 'utf8') === 'ok';
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    result.disposableTempDir = false;
  }
  return Object.freeze(result);
}

async function probeLocalIpc() {
  if (platform() === 'win32') {
    return Object.freeze({ transport: 'windows-named-pipe', available: true, loopbackFallback: true });
  }
  const socketPath = join(tmpdir(), `tp-${randomUUID().slice(0, 12)}.sock`);
  const unixOk = await new Promise(resolvePromise => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen(socketPath, () => {
      server.close(() => {
        try { unlinkSync(socketPath); } catch {}
        resolvePromise(true);
      });
    });
  });
  const loopbackOk = await new Promise(resolvePromise => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolvePromise(true));
    });
  });
  return Object.freeze({
    transport: unixOk ? 'unix-socket' : loopbackOk ? 'loopback-tcp' : 'none',
    available: unixOk || loopbackOk,
    unixSocket: unixOk,
    loopbackFallback: loopbackOk,
  });
}

async function probeHttpEndpoint(url, { fetcher = globalThis.fetch, timeoutMs = 4000, signal } = {}) {
  if (!url) return 'unknown';
  const start = Date.now();
  try {
    const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const response = await fetcher(url, { method: 'GET', redirect: 'manual', signal: abort });
    await response.body?.cancel();
    return { reachable: response.status >= 200 && response.status < 500, status: response.status, latencyMs: Date.now() - start };
  } catch (error) {
    return { reachable: false, error: error?.code ?? error?.name ?? 'network_error', latencyMs: Date.now() - start };
  }
}

async function probeWebSocketEndpoint(wsUrl, { timeoutMs = 4000 } = {}) {
  if (!wsUrl) return 'unknown';
  if (typeof globalThis.WebSocket !== 'function') return { reachable: false, error: 'websocket_unsupported' };
  const start = Date.now();
  return new Promise(resolvePromise => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(value); } };
    const timer = setTimeout(() => { try { socket.close(); } catch {} finish({ reachable: false, error: 'timeout', latencyMs: Date.now() - start }); }, timeoutMs);
    let socket;
    try { socket = new WebSocket(wsUrl); }
    catch (error) { finish({ reachable: false, error: error?.name ?? 'websocket_error', latencyMs: Date.now() - start }); return; }
    socket.addEventListener('open', () => { try { socket.close(); } catch {} finish({ reachable: true, latencyMs: Date.now() - start }); });
    socket.addEventListener('error', () => { finish({ reachable: false, error: 'websocket_failed', latencyMs: Date.now() - start }); });
  });
}

/**
 * Probe HTTPS, WebSocket (wss://), and WebRTC capabilities independently.
 * Never infers WebSocket or WebRTC availability from a passing HTTPS check.
 */
export async function probeTransports({ serviceOrigin, npmRegistryUrl, releaseAssetsUrl, fetcher = globalThis.fetch, timeoutMs = 4000, signal } = {}) {
  const origin = serviceOrigin ? serviceOrigin.replace(/\/+$/u, '') : null;
  const httpsCheck = origin ? await probeHttpEndpoint(`${origin}/api/readiness`, { fetcher, timeoutMs, signal }) : 'unknown';
  const gatewayCheck = origin ? await probeHttpEndpoint(`${origin}/.well-known/oauth-protected-resource/mcp`, { fetcher, timeoutMs, signal }) : 'unknown';
  const npmCheck = npmRegistryUrl ? await probeHttpEndpoint(npmRegistryUrl, { fetcher, timeoutMs, signal }) : 'unknown';
  const releaseCheck = releaseAssetsUrl ? await probeHttpEndpoint(releaseAssetsUrl, { fetcher, timeoutMs, signal }) : 'unknown';
  const wsUrl = origin ? origin.replace(/^http/u, 'ws') + '/api/service' : null;
  const wssCheck = wsUrl ? await probeWebSocketEndpoint(wsUrl, { timeoutMs }) : 'unknown';
  const webrtcGlobal = typeof globalThis.RTCPeerConnection === 'function';
  return Object.freeze({
    proxy: detectProxyEnvironment(),
    https443: httpsCheck,
    httpsGateway: gatewayCheck,
    wssRelay443: wssCheck,
    webrtcDirect: webrtcGlobal ? 'runtime-available' : 'unknown',
    npmRegistry: npmCheck,
    releaseAssets: releaseCheck,
  });
}

/**
 * Run the compact, non-intrusive Tendriller capability probe (`tendril probe --json`).
 */
export async function probeCapabilities({
  product = 'local',
  executionSurface = 'shell',
  plan = 'unknown',
  projectPath = process.cwd(),
  serviceOrigin,
  checkNetwork = false,
  fetcher = globalThis.fetch,
  timeoutMs = 4000,
  signal,
} = {}) {
  let sqliteAvailable = false;
  try { await import('node:sqlite'); sqliteAvailable = true; } catch { sqliteAvailable = false; }
  const wasmSupported = typeof WebAssembly === 'object' && typeof WebAssembly.compile === 'function';
  const runtimeName = typeof globalThis.Bun !== 'undefined' ? 'bun' : typeof globalThis.Deno !== 'undefined' ? 'deno' : 'node';
  const runtimeVersion = runtimeName === 'bun' ? globalThis.Bun.version : runtimeName === 'deno' ? globalThis.Deno.version.deno : process.versions.node;

  const [storage, ipc, networking] = await Promise.all([
    probeStorage(projectPath),
    probeLocalIpc(),
    checkNetwork ? probeTransports({ serviceOrigin, fetcher, timeoutMs, signal }) : Promise.resolve({
      proxy: detectProxyEnvironment(),
      https443: 'unknown',
      httpsGateway: 'unknown',
      wssRelay443: 'unknown',
      webrtcDirect: typeof globalThis.RTCPeerConnection === 'function' ? 'runtime-available' : 'unknown',
      npmRegistry: 'unknown',
      releaseAssets: 'unknown',
    }),
  ]);

  const totalMemMb = Math.round(totalmem() / (1024 * 1024));
  const freeMemMb = Math.round(freemem() / (1024 * 1024));
  const recommendedRoutes = [];

  if (storage.writableProjectPath && storage.atomicRenameAndLock) {
    if (ipc.available) {
      recommendedRoutes.push({ route: 'shared-local-participant', available: true, reason: `Writable storage + ${ipc.transport} IPC available.` });
    }
    recommendedRoutes.push({ route: 'bounded-local-participant', available: true, reason: 'Writable project storage with atomic lockfiles available.' });
  } else {
    recommendedRoutes.push({ route: 'bounded-local-participant', available: false, reason: 'Project path is not writable or lacks atomic rename.' });
  }
  recommendedRoutes.push({
    route: 'remote-https-mcp-connector',
    available: networking.https443 === 'unknown' ? 'unknown' : Boolean(networking.https443?.reachable),
    reason: networking.https443 === 'unknown' ? 'Network probe not executed; supply --server with --check-network.' : networking.https443?.reachable ? 'HTTPS 443 service origin reachable.' : 'HTTPS 443 service origin unreachable.',
  });
  recommendedRoutes.push({
    route: 'browser-participant',
    available: 'unknown',
    reason: 'Browser capabilities are observed inside the page diagnostics surface (#tendriller-diagnostics).',
  });
  recommendedRoutes.push({
    route: 'external-or-serverless-host',
    available: true,
    reason: 'Use standalone Node process, container, OS service, or ServerlessHostAdapter for post-exit availability.',
  });

  // The WebAssembly global proves no SQL module can load or execute. Engine
  // qualification belongs to an actual matching public engine session.
  const sqlRecommendedEngine = wasmSupported ? 'unknown' : 'unavailable';

  return Object.freeze({
    schemaVersion: 1,
    context: {
      product,
      executionSurface,
      plan,
      observedAt: new Date().toISOString(),
      os: platform(),
      arch: arch(),
      libc: detectLibc(),
    },
    runtime: {
      name: runtimeName,
      version: runtimeVersion,
      nodeSqlite: sqliteAvailable,
      wasm: wasmSupported,
      nativeAddonSupport: runtimeName === 'node' || runtimeName === 'bun',
      sqlDefaultEngine: sqlRecommendedEngine,
      sqlEngineValidated: false,
      totalMemoryMb: totalMemMb,
      freeMemoryMb: freeMemMb,
      fitsConstrainedSandboxBudget: totalMemMb >= 512,
    },
    storage,
    networking,
    lifecycle: {
      ipc,
      backgroundProcessPersistence: 'unknown',
      browserSurface: 'unknown',
      connectorSurface: 'unknown',
    },
    recommendedRoutes,
  });
}
