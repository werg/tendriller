/** In-memory hub endpoint speaking the tendriller.hub.v1 JSON frames. */
export function fakeHub() {
  const connections = [];
  class HubSocket extends EventTarget {
    readyState = 0; sent = [];
    constructor(url, protocols) {
      super(); this.url = url; this.protocols = protocols; connections.push(this);
    }
    accept() { this.readyState = 1; this.dispatchEvent(new Event('open')); return this; }
    send(text) { this.sent.push(JSON.parse(text)); }
    frames(type) { return this.sent.filter(frame => frame.t === type); }
    push(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
    drop(code = 1006) { this.close(code); }
  }
  return { WebSocket: HubSocket, connections, get last() { return connections.at(-1); } };
}
export const TOKEN = 'ta_' + 'a'.repeat(32);
export const PAGE = 'aaaaaaaaaaaa';
