import { readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';

/** Evaluator-only observation of actual relay sockets. No payloads, URLs,
 * authorization protocols, or application code are copied to the evidence. */
export function observeRelaySockets(Base, { api, deviceId, remoteDeviceId, record, processIdentity = {} }) {
  const endpoint = new URL(api), path = /^\/api\/t\/([a-z2-7]{12})$/.exec(endpoint.pathname);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !path ||
      ![deviceId, remoteDeviceId].every(id => /^[a-f0-9]{64}$/.test(id)) || deviceId === remoteDeviceId)
    throw Error('Use the exact owned API and two measured signing identities');
  endpoint.protocol = 'wss:'; endpoint.pathname += '/peers/relay';
  const channels = new Map();
  function publish() {
    const pairs = [...channels.values()].map(lanes => [...lanes.values()].map(({ socket, ...state }) => ({ ...state,
      open: socket.readyState === 1 })));
    const selected = pairs.some(lanes => lanes.length === 2 && lanes.every(l => l.open && l.paired && !l.closed) &&
      lanes[0].session === lanes[1].session && lanes.some(l => l.lane === 'reliable' && l.sent > 0 && l.received > 0));
    record({ protocol: 'tendriller-relay-observation-v1', observedAt: new Date().toISOString(), ...processIdentity,
      pageId: path[1], deviceId, remoteDeviceId, transport: selected ? 'websocket-relay' : null, pairs });
  }
  return class ObservedWebSocket extends Base {
    constructor(url, protocols) {
      super(url, protocols);
      let route; try { route = new URL(url); } catch { return; }
      if (route.origin !== endpoint.origin || route.pathname !== endpoint.pathname || route.username || route.password || route.hash ||
          route.searchParams.get('peerId') !== deviceId || route.searchParams.get('remotePeerId') !== remoteDeviceId) return;
      const lane = route.searchParams.get('lane'), channel = route.searchParams.get('channel');
      if (!['reliable', 'live'].includes(lane) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(channel ?? '')) return;
      if (!channels.has(channel)) { if (channels.size >= 16) channels.delete(channels.keys().next().value); channels.set(channel, new Map()); }
      const state = { socket: this, lane, paired: false, closed: false, sent: 0, received: 0, session: null };
      channels.get(channel).set(lane, state);
      const update = () => { try { publish(); } catch {} };
      this.addEventListener('message', event => {
        if (typeof event.data === 'string') {
          if (event.data.length > 512) return;
          let message; try { message = JSON.parse(event.data); } catch { return; }
          if (message?.t === 'ready' && Object.keys(message).length === 6 && message.version === 1 && message.lane === lane &&
              message.peerId === deviceId && message.remotePeerId === remoteDeviceId && /^[a-f0-9-]{36}$/.test(message.session ?? '')) {
            state.paired = true; state.session = message.session; update();
          }
        } else if (state.paired) { state.received++; update(); }
      });
      for (const event of ['close', 'error']) this.addEventListener(event, () => { state.closed = true; update(); });
      const send = this.send;
      this.send = function(data) { const result = send.call(this, data); if (typeof data !== 'string' && state.paired) { state.sent++; update(); } return result; };
      update();
    }
  };
}

// Explicit opt-in on the evaluator's same-store native restart, never on the
// fresh model or unrelated applications. Config and evidence remain private.
if (process.env.TENDRILLER_ACCEPTANCE_TRANSPORT_CONFIG) {
  const path = realpathSync(process.env.TENDRILLER_ACCEPTANCE_TRANSPORT_CONFIG), cwd = realpathSync(process.cwd());
  const rel = relative(cwd, path);
  if (!rel.startsWith('../') && rel !== '..') throw Error('Keep evaluator transport configuration outside the native project');
  const config = JSON.parse(readFileSync(path, 'utf8')), output = resolve(config.output);
  if (!output.startsWith(resolve(config.runDirectory) + '/')) throw Error('Transport output must be inside the explicit private run');
  const fields = readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ');
  globalThis.WebSocket = observeRelaySockets(globalThis.WebSocket, { ...config,
    processIdentity: { pid: process.pid, birth: fields[19] },
    record: value => { const temporary = output + '.tmp'; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, output); } });
}
