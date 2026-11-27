// Isolated packed host for the benchmark: the unchanged packed engine under
// Miniflare (scripts/first-app-fixture.mjs startPackedHost), with
//  - raised rate limits (repeated page loads would otherwise hit PAGE_RATE), and
//  - a bench front Worker that wraps the first-app WebSocket forwarding Worker
//    and records every request (route, status, time-to-headers, Server-Timing)
//    plus an optional injected latency for --throttle.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFirstAppWebsocketProxyWorker } from '../first-app-websocket-host.mjs';

/** Front Worker source: request log + optional latency around the first-app proxy. */
export function benchProxyWorker() {
  const inner = createFirstAppWebsocketProxyWorker();
  if (!inner.includes('export default {')) throw Error('Unexpected first-app proxy shape');
  return inner.replace('export default {', 'const innerWorker = {') + `
const benchLog = []; let benchSeq = 0; const BENCH_MAX = 100000;
const benchConfig = { latencyMs: 0 };
const sleep = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : null;
// Normalize identifiers so requests aggregate per endpoint.
function benchRoute(url) {
  const page = /^[a-z2-7]{8,}\\.pages\\.localhost$/.test(url.hostname);
  const path = url.pathname
    .replace(/\\/[a-f0-9]{64}(?=\\/|$)/g, '/:hash')
    .replace(/\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\\/|$)/g, '/:uuid')
    .replace(/\\/[a-z2-7]{12,40}(?=\\/|$)/g, '/:id')
    .replace(/\\/\\d+(?=\\/|$)/g, '/:n');
  return (page ? 'page ' : 'service ') + path;
}
function delayedSocket(response) {
  // One-way latency of half the configured RTT on each WebSocket message, order preserved.
  const upstream = response.webSocket;
  const [client, server] = Object.values(new WebSocketPair());
  upstream.binaryType = server.binaryType = 'arraybuffer';
  const half = Math.round(benchConfig.latencyMs / 2);
  for (const [from, to] of [[upstream, server], [server, upstream]]) {
    from.addEventListener('message', event => { setTimeout(() => { try { to.send(event.data); } catch {} }, half); });
    from.addEventListener('close', event => {
      setTimeout(() => {
        try {
          if (event.code === 1005) to.close(); else if (event.code === 1006) to.close(1011, 'closed abnormally');
          else to.close(event.code, event.reason);
        } catch {}
      }, half);
    });
    from.addEventListener('error', () => { try { to.close(1011, 'failed'); } catch {} });
  }
  upstream.accept({ allowHalfOpen: true }); server.accept({ allowHalfOpen: true });
  return new Response(null, { status: 101, headers: response.headers, webSocket: client });
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__bench/requests') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return Response.json({ seq: benchSeq, dropped: Math.max(0, benchSeq - benchLog.length), items: benchLog.filter(item => item.seq > since) },
        { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/__bench/config') {
      if (request.method === 'POST') Object.assign(benchConfig, await request.json());
      return Response.json(benchConfig, { headers: { 'Cache-Control': 'no-store' } });
    }
    const websocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    const item = { seq: ++benchSeq, t: Date.now(), method: request.method, route: benchRoute(url), ws: websocket };
    if (benchLog.length === BENCH_MAX) benchLog.shift();
    benchLog.push(item);
    if (url.pathname.startsWith('/__first_app')) return innerWorker.fetch(request, env, ctx);
    await sleep(benchConfig.latencyMs);
    const started = Date.now();
    let response;
    try { response = await innerWorker.fetch(request, env, ctx); }
    catch (error) { item.error = String(error?.message ?? error).slice(0, 200); throw error; }
    item.ms = Date.now() - started;
    item.status = response.status;
    const timing = response.headers.get('Server-Timing'); if (timing) item.serverTiming = timing.slice(0, 600);
    const length = response.headers.get('Content-Length'); if (length) item.bytes = Number(length);
    const cache = response.headers.get('Cache-Control'); if (cache) item.cacheControl = cache.slice(0, 80);
    if (response.webSocket && benchConfig.latencyMs > 0) return delayedSocket(response);
    return response;
  },
};
`;
}

/**
 * Write a copy of server/wrangler.jsonc whose relative paths are absolute and
 * whose rate limits are raised, under `<directory>/bench-root/server/`, and
 * return that root for startPackedHost({ root }).
 */
export async function benchConfigRoot({ root, directory, rateLimit = 100_000 }) {
  const source = await readFile(join(root, 'server/wrangler.jsonc'), 'utf8');
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''));
  delete config.$schema;
  config.main = join(root, 'dist/engine/worker.mjs');
  config.assets = { ...config.assets, directory: join(root, 'server/public') };
  for (const database of config.d1_databases ?? []) database.migrations_dir = join(root, 'server/migrations');
  config.ratelimits = config.ratelimits.map(limit => ({ ...limit, simple: { ...limit.simple, limit: Math.max(limit.simple.limit, rateLimit) } }));
  const benchRoot = join(directory, 'bench-root');
  await mkdir(join(benchRoot, 'server'), { recursive: true });
  await writeFile(join(benchRoot, 'server/wrangler.jsonc'), JSON.stringify(config, null, 2));
  return benchRoot;
}

/** Host-side request log helpers (against the bench front Worker). */
export function hostLog(service) {
  return {
    async seq() { return (await (await fetch(service + '/__bench/requests?since=1e15', { cache: 'no-store' })).json()).seq; },
    async since(seq) { return (await (await fetch(service + '/__bench/requests?since=' + seq, { cache: 'no-store' })).json()).items; },
    async setLatency(latencyMs) {
      const response = await fetch(service + '/__bench/config', { method: 'POST', body: JSON.stringify({ latencyMs }) });
      if (!response.ok) throw Error('bench config failed');
    },
    async transport() {
      const response = await fetch(service + '/__first_app_transport', { cache: 'no-store' });
      if (!response.ok) return null;
      const { requestActivity: _omit, ...counters } = await response.json();
      return counters;
    },
  };
}
