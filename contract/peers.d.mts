export type PeerDomain = 'records' | 'signals' | 'control';
export interface PeerFrame { readonly domain: PeerDomain; readonly payload: Uint8Array }
export interface PeerSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  binaryType?: string;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}
export interface PeerConnection {
  readonly route: 'direct' | 'relay';
  readonly ready: Promise<void>;
  readonly frames: AsyncIterable<PeerFrame>;
  readonly stats: Readonly<{ sentBytes: number; receivedBytes: number; queuedBytes: number; openedAt: number | null }>;
  send(frame: PeerFrame, options?: { readonly signal?: AbortSignal }): Promise<void>;
  close(): void;
}
export interface PeerEndpointHint { readonly url: string; readonly route: 'direct' | 'relay' }
/** Resident HTTPS introductions, never application relay routes or credentials. */
export interface PeerIntroductionEndpoint { readonly url: string }
export interface PeerBootstrap { readonly version: 2; readonly endpoints: readonly PeerIntroductionEndpoint[] }
export declare const PEER_LIMITS: Readonly<{ frameBytes: number; signalBytes: number; queueBytes: number; endpoints: number }>;
export declare class PeerConnectionError extends Error { readonly code: string; constructor(code: string, message: string) }
export declare function encodePeerFrame(frame: PeerFrame): Uint8Array;
export declare function decodePeerFrame(bytes: Uint8Array): PeerFrame;
/** Caller must authenticate application peers and grants independently of these transport hints. */
export declare function validatePeerBootstrap(value: unknown): PeerBootstrap;
export declare function createPeerConnection(socket: PeerSocket, options: { readonly route: 'direct' | 'relay'; readonly queueBytes?: number }): PeerConnection;
export declare function connectPeer(endpoint: PeerEndpointHint, options?: { readonly protocols?: readonly string[]; readonly socket?: (url: string, protocols: readonly string[]) => PeerSocket }): PeerConnection;

export interface PeerDescription { readonly type: 'offer' | 'answer'; readonly sdp: string }
export interface PeerRendezvousOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly socket?: (url: string, protocols: readonly string[]) => PeerSocket;
}
export interface PeerRendezvous {
  readonly ready: Promise<Readonly<{ session: string; role: 'offerer' | 'answerer' }>>;
  readonly messages: AsyncIterable<PeerDescription>;
  readonly stats: Readonly<{ sentBytes: number; receivedBytes: number; sentDescriptions: number; receivedDescriptions: number; closed: boolean }>;
  send(description: PeerDescription): Promise<void>;
  close(): void;
}
export interface PeersClient {
  /** Immutable initial-page snapshot; reading it performs no host request. Null for clients without an injected snapshot. */
  readonly initialBootstrap: PeerBootstrap | null;
  /** Explicitly fetch current host configuration. Ordinary peer connection/recovery uses initialBootstrap. */
  bootstrap(): Promise<PeerBootstrap>;
  setBootstrap(hints: PeerBootstrap): Promise<PeerBootstrap>;
  rendezvous(channel: string, peerId: string, options?: PeerRendezvousOptions): PeerRendezvous;
}
export declare const PEER_RENDEZVOUS_PROTOCOL: 'tendriller.rendezvous.v1';
export declare const PEER_RENDEZVOUS_LIMITS: Readonly<{ descriptionBytes: number; messageBytes: number; sessions: number; lifetimeMs: number }>;
export declare function validatePeerDescription(value: unknown): PeerDescription;
export declare function createPeerRendezvous(socket: PeerSocket, options?: PeerRendezvousOptions): PeerRendezvous;
export declare function createPeersClient(options: {
  readonly base: string;
  readonly initialBootstrap?: PeerBootstrap;
  readonly request: (path: string, options?: { method?: 'PUT'; body?: unknown }) => Promise<unknown>;
  readonly protocols?: readonly string[];
  readonly socket?: (url: string, protocols: readonly string[]) => PeerSocket;
}): PeersClient;
