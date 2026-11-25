/**
 * Network boundary for the isolated first-app test host, never deployed code.
 *
 * workerd 1.20261110.1 can exchange both Close frames on a cold hibernatable
 * socket without finishing its external TCP connection. Keeping that object
 * active can retain the connection indefinitely. The packed host and its
 * hibernating Durable Objects still run unchanged behind this ordinary Worker
 * WebSocket endpoint. This forwards actual messages and Close frames; it never
 * adds application traffic, resets an object, or terminates a client transport.
 *
 * The qualifier must still require raw client sockets to reach CLOSED and the
 * native owner process to exit naturally. Passing this adapter's regression is
 * not evidence that the upstream runtime's direct TCP close bug has been fixed.
 *
 * https://github.com/cloudflare/workerd/issues/8185
 * https://github.com/cloudflare/workerd/issues/7566
 *
 * Install as the first Miniflare Worker with PACKED_HOST bound to the unchanged
 * packed Worker. Bindings such as ACCOUNTS remain on that named packed Worker.
 */
// Only fixed labels and receipt metadata leave this test boundary. The URL is
// parsed transiently; no path, query, headers, body, or caller identifiers survive.
export function createFirstAppRequestActivity() {
  const items = [];
  let sequence = 0;
  const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
  function category(path) {
    // One agent program's multiplexed control connection for all of its pages.
    if (path === '/api/agent/hub') return 'agent-hub';
    if (path.endsWith('/peers/discovery/watch')) return 'discovery-watch';
    if (path.endsWith('/peers/rendezvous')) return 'rendezvous';
    if (path.endsWith('/peers/invitations')) return 'invitations';
    if (path.endsWith('/peers/relay')) return 'relay';
    if (path.endsWith('/setup/watch')) return 'setup-watch';
    if (path.endsWith('/publication-ready')) return 'publication-watch';
    // Directory read/advertise/withdraw and invitation sends are facets of
    // this same POST endpoint. Path-only evidence cannot distinguish actions.
    if (path.endsWith('/peers/participant')) return 'peer-participant';
    if (path.endsWith('/peers/bootstrap')) return 'peer-bootstrap';
    if (path.endsWith('/peers/pairing')) return 'peer-pairing';
    if (path.endsWith('/self')) return 'access-probe';
    if (path.endsWith('/application')) return 'application-control';
    if (path.endsWith('/_tendril/sw.js')) return 'service-worker';
    if (path.endsWith('/favicon.ico')) return 'favicon';
    if (path.includes('/_tendril/runtime/')) return 'runtime-asset';
    if (path.includes('/_publications/')) return 'publication-asset';
    if (/\.(mjs|js|css|wasm|png|svg|ico)$/.test(path)) return 'asset';
    if (/^\/s\/[^/]+\/?$/.test(path)) return 'page';
    if (path.startsWith('/api/')) return 'api-control';
    return 'other';
  }
  return {
    record(request) {
      const item = { sequence: ++sequence, receivedAt: Date.now(),
        method: methods.has(request.method) ? request.method : 'OTHER',
        category: category(new URL(request.url).pathname) };
      if (items.length === 256) items.shift();
      items.push(item);
    },
    snapshot() {
      return { items: items.map(item => ({ ...item })), dropped: sequence - items.length,
        scope: 'host-request-receipt; no HTTP body bytes or response completion timing' };
    },
  };
}

/** Test-only pause at the real publication request, before the packed host receives it. */
export function createFirstAppPublicationGate({ timeoutMs = 40_000 } = {}) {
  let current;
  const snapshot = () => current ? { id: current.id, phase: current.phase, matched: current.matched,
    operationId: current.operationId ?? null }
    : { phase: 'idle', matched: 0 };
  return {
    async control(request) {
      if (request.method !== 'POST') return new Response('POST required', { status: 405 });
      const input = await request.json();
      if (input.action === 'arm') {
        if (current && ['armed', 'held'].includes(current.phase)) return new Response('Gate already active', { status: 409 });
        if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) ||
          ![input.author, input.previous, input.proofHash].every(value => /^[a-f0-9]{64}$/.test(value ?? '')))
          return new Response('Invalid publication gate', { status: 400 });
        current = { id: input.id, author: input.author, previous: input.previous,
          proofHash: input.proofHash, phase: 'armed', matched: 0 };
      } else {
        if (!current || current.id !== input.id) return new Response('Unknown publication gate', { status: 409 });
        if (input.action === 'release') {
          if (current.phase === 'held') current.finish('released');
          else if (current.phase === 'armed') current.phase = 'released';
        } else if (input.action === 'reset') {
          if (current.phase === 'held') current.finish('reset');
          current = undefined;
        } else if (input.action !== 'status') return new Response('Unknown gate action', { status: 400 });
      }
      return Response.json(snapshot(), { headers: { 'Cache-Control': 'no-store' } });
    },
    async before(request) {
      const gate = current;
      if (!gate || gate.phase !== 'armed' || request.method !== 'POST' ||
        !new URL(request.url).pathname.endsWith('/peers/participant')) return;
      let message;
      try { message = await request.clone().json(); } catch { return; }
      const publication = message?.payload?.publication?.payload;
      if (current !== gate || gate.phase !== 'armed' || message?.protocol !== 'chronolog-participant-v1' ||
        message.facet !== 'publication' || message.action !== 'publish' ||
        publication?.author !== gate.author || publication.previous !== gate.previous ||
        !Array.isArray(publication.files) || !publication.files.some(file =>
          file?.path === 'resident-publication-proof.txt' && file.hash === gate.proofHash)) return;
      // Observe the scoped signed identity; do not reconstruct private attachment namespaces.
      gate.operationId = publication.operationId;
      gate.phase = 'held'; gate.matched++;
      const outcome = await new Promise(resolve => {
        const timer = setTimeout(() => gate.finish('expired'), timeoutMs);
        gate.finish = phase => {
          if (gate.phase !== 'held') return;
          clearTimeout(timer); gate.phase = phase; resolve(phase);
        };
      });
      if (outcome !== 'released') return new Response('Publication fixture gate ' + outcome, { status: 504 });
    },
  };
}

export const FIRST_APP_WEBSOCKET_PROXY_WORKER = `
const requests = (${createFirstAppRequestActivity.toString()})();
const publicationGate = (${createFirstAppPublicationGate.toString()})();
const traffic = { instance: null, httpRequests: 0, relayUpgrades: 0,
  relayBinaryFrames: 0, relayBinaryBytes: 0 };
export default {
  async fetch(request, env) {
    traffic.instance ??= crypto.randomUUID();
    if (new URL(request.url).pathname === '/__first_app_transport')
      return Response.json({ ...traffic, requestActivity: requests.snapshot() }, { headers: { 'Cache-Control': 'no-store' } });
    if (new URL(request.url).pathname === '/__first_app_publication') return publicationGate.control(request);
    traffic.httpRequests++;
    requests.record(request);
    const held = await publicationGate.before(request);
    if (held) return held;
    const relay = new URL(request.url).pathname.endsWith('/peers/relay');
    const response = await env.PACKED_HOST.fetch(request);
    if (!response.webSocket) return response;

    if (relay) traffic.relayUpgrades++;
    const upstream = response.webSocket;
    const [client, server] = Object.values(new WebSocketPair());
    upstream.binaryType = server.binaryType = 'arraybuffer';
    for (const [from, to] of [[upstream, server], [server, upstream]]) {
      from.addEventListener('message', event => {
        if (relay && typeof event.data !== 'string') {
          traffic.relayBinaryFrames++; traffic.relayBinaryBytes += event.data.byteLength;
        }
        to.send(event.data);
      });
      from.addEventListener('close', event => {
        if (event.code === 1005) to.close();
        else if (event.code === 1006) to.close(1011, 'Test host WebSocket closed abnormally');
        else to.close(event.code, event.reason);
      });
      from.addEventListener('error', () => to.close(1011, 'Test host WebSocket failed'));
    }
    // A Close from one side must wait for the other side's acknowledgment.
    // Default auto-replies would hide a retained upstream half-open socket.
    upstream.accept({ allowHalfOpen: true });
    server.accept({ allowHalfOpen: true });
    return new Response(null, { status: 101, headers: response.headers, webSocket: client });
  },
};
`;
