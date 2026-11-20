export interface TestMigration { name: string; queries: string[] }
export interface TestPeerSocket {
  readonly readyState: number;
  binaryType: string;
  readonly bufferedAmount: number;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}
export interface TestHostTraffic {
  readonly httpRequests: number;
  readonly requestBodyBytes: number;
  readonly rendezvousUpgrades: number;
  readonly rendezvousSentBytes: number;
  readonly rendezvousReceivedBytes: number;
  readonly invitationUpgrades: number;
  readonly invitationSentBytes: number;
  readonly invitationReceivedBytes: number;
  readonly discoveryUpgrades: number;
  readonly discoverySentBytes: number;
  readonly discoveryReceivedBytes: number;
  readonly relayUpgrades: number;
  readonly relaySentBytes: number;
  readonly relayReceivedBytes: number;
}
/** Initialize fresh test storage in the Cloudflare Vitest pool. Never a production API. */
export declare function initializeTestService(migrations: TestMigration[]): Promise<void>;
export declare function createTestPage(options?: { application?: { id: string }; lifetime?: 'ad_hoc' | 'resident' }): Promise<{
  api(method: string, path: string, body?: unknown): Promise<Response>;
  ownerApi(method: string, path: string, body?: unknown): Promise<Response>;
  exchange(operation: string, payload?: unknown): Promise<Response>;
  ownerExchange(operation: string, payload?: unknown): Promise<Response>;
  asset(path?: string): Promise<Response>;
  /** Real Worker HTTP and SDP frame traffic through this fixture; excludes synthetic setup. */
  readonly hostTraffic: TestHostTraffic;
  rendezvousSocket(channel: string, peerId: string): TestPeerSocket;
  ownerRendezvousSocket(channel: string, peerId: string): TestPeerSocket;
  discoverySocket(peerId: string): TestPeerSocket;
  invitationSocket(peerId: string): TestPeerSocket;
  ownerDiscoverySocket(peerId: string): TestPeerSocket;
  ownerInvitationSocket(peerId: string): TestPeerSocket;
  relaySocket(channel: string, peerId: string, remotePeerId: string, lane: 'reliable' | 'live'): TestPeerSocket;
  ownerRelaySocket(channel: string, peerId: string, remotePeerId: string, lane: 'reliable' | 'live'): TestPeerSocket;
  participant(): Promise<{ account: string; api(method: string, path: string, body?: unknown): Promise<Response>;
    exchange(operation: string, payload?: unknown): Promise<Response>;
    discoverySocket(peerId: string): TestPeerSocket;
    rendezvousSocket(channel: string, peerId: string): TestPeerSocket; invitationSocket(peerId: string): TestPeerSocket;
    relaySocket(channel: string, peerId: string, remotePeerId: string, lane: 'reliable' | 'live'): TestPeerSocket }>;
  advance(milliseconds: number): Promise<void>;
  /** Restarts the real Durable Object after a forced abort, retaining its persistent store. */
  restart(): Promise<void>;
}>;
