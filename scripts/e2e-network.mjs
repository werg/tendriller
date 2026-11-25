import dns from 'node:dns';

export const LOCAL_WORKER_PORT = Number(process.env.TENDRILLER_E2E_PORT ?? 8790);
if (!Number.isSafeInteger(LOCAL_WORKER_PORT) || LOCAL_WORKER_PORT < 1 || LOCAL_WORKER_PORT > 65535) throw Error('TENDRILLER_E2E_PORT must be an integer port from 1 to 65535');
export const LOCAL_WORKER_SERVICE = `https://service.localhost:${LOCAL_WORKER_PORT}`;

// The browser and Playwright's Node health/API clients must reach the same
// isolated Worker while retaining the service and per-page HTTP/TLS origins.
// Container DNS is not required to resolve subdomains of localhost.
export const LOCAL_WORKER_HOST_RULES = 'MAP service.localhost 127.0.0.1, MAP pages.localhost 127.0.0.1, MAP *.pages.localhost 127.0.0.1';

function address(hostname) {
  if (typeof hostname !== 'string') return hostname;
  const host = hostname.toLowerCase();
  return host === 'service.localhost' || host === 'pages.localhost' || host.endsWith('.pages.localhost')
    ? '127.0.0.1' : hostname;
}

let installed = false;
export function installLocalWorkerDns() {
  if (installed) return;
  installed = true;
  const lookup = dns.lookup;
  const promiseLookup = dns.promises.lookup;
  dns.lookup = (hostname, ...options) => lookup.call(dns, address(hostname), ...options);
  dns.promises.lookup = (hostname, ...options) => promiseLookup.call(dns.promises, address(hostname), ...options);
}
