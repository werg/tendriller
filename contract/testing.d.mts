export interface TestMigration { name: string; queries: string[] }
export type TestWorkflowCall = (module: string, operation: string, data?: unknown, guards?: Record<string, string>, cid?: string) => Promise<Response>;
export interface TestPeerSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: string): void;
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
}
/** Initialize fresh test storage in the Cloudflare Vitest pool. Never a production API. */
export declare function initializeTestService(migrations: TestMigration[]): Promise<void>;
export declare function createTestPage(options?: { application?: { kind: 'cloudflare' | 'peer'; id: string }; lifetime?: 'ad_hoc' | 'resident' }): Promise<{
  owner: TestWorkflowCall;
  agent: TestWorkflowCall;
  api(method: string, path: string, body?: unknown): Promise<Response>;
  ownerApi(method: string, path: string, body?: unknown): Promise<Response>;
  /** Real Worker HTTP and SDP frame traffic through this fixture; excludes synthetic setup. */
  readonly hostTraffic: TestHostTraffic;
  rendezvousSocket(channel: string, peerId: string): TestPeerSocket;
  ownerRendezvousSocket(channel: string, peerId: string): TestPeerSocket;
  invitationSocket(peerId: string): TestPeerSocket;
  ownerInvitationSocket(peerId: string): TestPeerSocket;
  participant(): Promise<{ account: string; call: TestWorkflowCall; api(method: string, path: string, body?: unknown): Promise<Response>;
    rendezvousSocket(channel: string, peerId: string): TestPeerSocket; invitationSocket(peerId: string): TestPeerSocket }>;
  display(): Promise<TestWorkflowCall>;
  advance(milliseconds: number): Promise<void>;
  /** Restarts the real Durable Object after a forced abort, retaining its persistent store. */
  restart(): Promise<void>;
}>;
