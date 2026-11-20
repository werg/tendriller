import type { PeerSocket } from './peers.mjs';
export type PeerDiscoveryNotification = Readonly<{ type: 'ready' | 'changed' }>;
export interface PeerDiscoveryWatchOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
  /** Optional failure-only authenticated self check; reject with HTTP status on refusal. Never called while healthy. */
  readonly probeAccess?: (options: { readonly signal: AbortSignal }) => Promise<unknown>;
  readonly socket?: (url: string, protocols: readonly string[]) => PeerSocket;
}
export interface PeerDiscoveryWatcher {
  /** Resolves only after the first server ready frame, never just WebSocket open. */
  readonly ready: Promise<void>;
  /** Each reconnection emits ready again; changed frames are coalesced invalidations. */
  readonly notifications: AsyncIterable<PeerDiscoveryNotification>;
  readonly closed: Promise<Readonly<{ code: number; reason: string }>>;
  close(): void;
}
export declare const PEER_DISCOVERY_PROTOCOL: 'tendriller.discovery.v1';
export declare const PEER_DISCOVERY_WATCH_LIMITS: Readonly<{ messageBytes: number; openTimeoutMs: number; retryMs: number; maxRetryMs: number }>;
export declare function validatePeerDiscoveryNotification(value: unknown): PeerDiscoveryNotification;
export declare function validatePeerDiscoveryWatchOptions(options?: PeerDiscoveryWatchOptions): { timeoutMs: number; retryMs: number; maxRetryMs: number };
export declare function createPeerDiscoveryWatcher(openSocket: () => PeerSocket, options?: PeerDiscoveryWatchOptions): PeerDiscoveryWatcher;
