import type { PeerSocket } from './peers.mjs';
export declare const PEER_RELAY_PROTOCOL: 'tendriller.relay.v1';
export declare const PEER_RELAY_LIMITS: Readonly<{ packetBytes: number; pendingPackets: number; pendingBytes: number;
  liveBufferedBytes: number; livePendingPackets: number; liveQueueBytes: number; sessions: number; sessionsPerPrincipal: number; pairingMs: number; progressMs: number;
  authorizationMs: number; lifetimeMs: number; reliablePacketsPerSecond: number; livePacketsPerSecond: number }>;
export interface PeerRelaySocket extends PeerSocket {
  binaryType: 'arraybuffer';
  readonly bufferedAmount: number;
  readonly stats: Readonly<{ sentBytes: number; receivedBytes: number; pendingPackets: number; queuedPackets: number; bufferedAmount: number }>;
}
export interface PeerRelay {
  readonly reliable: PeerRelaySocket;
  readonly live: PeerRelaySocket;
  readonly ready: Promise<Readonly<{ session: string }>>;
  readonly signal: AbortSignal;
  close(): void;
}
export interface PeerRelayOptions {
  readonly remotePeerId: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly socket?: (url: string, protocols: readonly string[]) => PeerSocket;
}
/** Attach the framed connection synchronously before awaiting relay.ready. */
export declare function createPeerRelay(sockets: { readonly reliable: PeerSocket; readonly live: PeerSocket },
  options: { readonly peerId: string; readonly remotePeerId: string; readonly signal?: AbortSignal; readonly timeoutMs?: number }): PeerRelay;
