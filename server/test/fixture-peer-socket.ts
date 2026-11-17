/** Public test-fixture transport over real authenticated Worker upgrade requests. */
export interface TestHostTraffic {
  httpRequests: number;
  requestBodyBytes: number;
  rendezvousUpgrades: number;
  rendezvousSentBytes: number;
  rendezvousReceivedBytes: number;
  invitationUpgrades: number;
  invitationSentBytes: number;
  invitationReceivedBytes: number;
}
const bytes = (value: string | ArrayBuffer) => typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength;

/** Matches the public PeerSocket port, including cancellation before the upgrade resolves. */
export function testPeerSocket(upgrade: () => Promise<Response>, traffic: TestHostTraffic, kind: 'rendezvous' | 'invitation') {
  class Socket extends EventTarget {
    readyState = 0;
    private socket?: WebSocket;
    constructor() {
      super();
      void this.open();
    }
    private finish(code: number, reason: string) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
    }
    private async open() {
      try {
        const response = await upgrade(), socket = response.webSocket;
        if (response.status !== 101 || !socket) throw new Error(`Rendezvous upgrade failed: ${response.status} ${await response.text()}`);
        if (this.readyState === 3) { socket.accept(); socket.close(1000, 'Test client cancelled'); return; }
        this.socket = socket;
        socket.addEventListener('message', event => {
          traffic[kind === 'rendezvous' ? 'rendezvousReceivedBytes' : 'invitationReceivedBytes'] += bytes(event.data);
          this.dispatchEvent(new MessageEvent('message', { data: event.data }));
        });
        socket.addEventListener('close', event => this.finish(event.code, event.reason));
        socket.addEventListener('error', () => this.dispatchEvent(new Event('error')));
        this.readyState = 1; socket.accept(); this.dispatchEvent(new Event('open'));
      } catch (error) {
        if (this.readyState === 3) return;
        this.dispatchEvent(Object.assign(new Event('error'), { error }));
        this.finish(1011, error instanceof Error ? error.message : 'Rendezvous upgrade failed');
      }
    }
    send(data: string) {
      if (this.readyState !== 1 || !this.socket) throw new Error('Rendezvous socket is not open');
      this.socket.send(data); traffic[kind === 'rendezvous' ? 'rendezvousSentBytes' : 'invitationSentBytes'] += bytes(data);
    }
    close(code = 1000, reason = 'Test client closed') {
      if (this.readyState >= 2) return;
      if (!this.socket) { this.finish(code, reason); return; }
      this.readyState = 2; this.socket.close(code, reason);
    }
  }
  return new Socket();
}
