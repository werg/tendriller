import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIntegration } from './integration.mjs';

/** A loopback HTTP listener intended to sit behind the configured HTTPS proxy. */
export async function startHttpService(config) {
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 15000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 60000)
    throw Object.assign(Error('Configure a shutdown deadline of 1 to 60000 milliseconds'), { code: 'SHUTDOWN_CONFIGURATION_INVALID' });
  const integration = await createIntegration(config);
  const origin = new URL(config.resource).origin;
  const active = new Set(); let draining = false;
  const server = createServer({ requestTimeout: 30000, headersTimeout: 10000, keepAliveTimeout: 5000 }, (incoming, outgoing) => {
    if (draining) { outgoing.writeHead(503, { Connection: 'close' }); outgoing.end(); return; }
    const cancelled = new AbortController();
    incoming.once('aborted', () => cancelled.abort());
    outgoing.once('close', () => { if (!outgoing.writableEnded) cancelled.abort(); });
    const pending = { cancelled, task: null };
    active.add(pending);
    pending.task = (async () => { try {
      const port = server.address()?.port;
      const validHosts = new Set([new URL(config.resource).host, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      if (!validHosts.has(incoming.headers.host)) { outgoing.writeHead(421); outgoing.end(); return; }
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
      const request = new Request(new URL(incoming.url, origin), { method: incoming.method, headers, signal: cancelled.signal,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }) });
      const response = await integration.handler(request);
      cancelled.signal.throwIfAborted();
      const responseHeaders = Object.fromEntries(response.headers), cookies = response.headers.getSetCookie();
      delete responseHeaders['set-cookie'];
      if (cookies.length) responseHeaders['set-cookie'] = cookies;
      outgoing.writeHead(response.status, responseHeaders);
      if (!response.body) outgoing.end();
      else await pipeline(Readable.fromWeb(response.body), outgoing, { signal: cancelled.signal });
    } catch {
      if (cancelled.signal.aborted || outgoing.destroyed) { outgoing.destroy(); return; }
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end('{"error":"integration_unavailable"}');
    } finally { active.delete(pending); } })();
  });
  server.maxConnections = 256;
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(config.port ?? 8788, config.host ?? '127.0.0.1', () => { server.off('error', reject); accept(); }); });
    integration.start();
  } catch (error) { await integration.close(); throw error; }
  let closing;
  return { integration, address: server.address(), close() {
    closing ??= (async () => {
      draining = true;
      const stopped = new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
      const deadline = setTimeout(() => {
        for (const request of active) request.cancelled.abort(new DOMException('HTTP shutdown deadline reached', 'AbortError'));
        server.closeAllConnections();
        // Abort blocked native controls too, while retaining the metadata store
        // until the admitted handlers have settled their durable identities.
        void integration.stop();
      }, shutdownTimeoutMs);
      try {
        server.closeIdleConnections(); await stopped;
        // Cancellation-aware adapters settle before their shared store/native
        // dependencies close. An already-saved operation can retain its receipt.
        await Promise.allSettled([...active].map(request => request.task));
      } finally { clearTimeout(deadline); await integration.close(); }
    })(); return closing;
  } };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node integrations/chatgpt/run.mjs --config /private/integration.config.mjs\nThe configuration supplies OAuth, current account access, consent management and an enrolled application session.'); return;
  }
  if (args.length !== 2 || args[0] !== '--config') throw Object.assign(Error('A private configuration module is required'), { code: 'CONFIGURATION_REQUIRED' });
  const config = (await import(pathToFileURL(resolve(args[1])).href)).default;
  const service = await startHttpService({ ...config, onError: details => console.error(JSON.stringify(details)) });
  console.log(JSON.stringify({ service: 'tendriller-assistant', listening: service.address, resource: config.resource, liveChatGptVerified: false }));
  const stop = async () => { try { await service.close(); } catch { process.exitCode = 1; } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(JSON.stringify({ error: error.code ?? error.name, message: 'Integration startup failed; check the private configuration and deployment guide.' })); process.exitCode = 1; });
