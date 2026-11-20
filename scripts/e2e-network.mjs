import dns from 'node:dns';

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
