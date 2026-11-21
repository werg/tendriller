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
export const FIRST_APP_WEBSOCKET_PROXY_WORKER = `
const traffic = { instance: null, httpRequests: 0, relayUpgrades: 0,
  relayBinaryFrames: 0, relayBinaryBytes: 0 };
export default {
  async fetch(request, env) {
    traffic.instance ??= crypto.randomUUID();
    if (new URL(request.url).pathname === '/__first_app_transport')
      return Response.json(traffic, { headers: { 'Cache-Control': 'no-store' } });
    traffic.httpRequests++;
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
