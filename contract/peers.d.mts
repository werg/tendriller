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
export interface PeerBootstrap { readonly version: 1; readonly endpoints: readonly PeerEndpointHint[] }
export declare const PEER_LIMITS: Readonly<{ frameBytes: number; signalBytes: number; queueBytes: number; relayBytesPerSecond: number; relaySessions: number; endpoints: number }>;
export declare class PeerConnectionError extends Error { readonly code: string; constructor(code: string, message: string) }
export declare function encodePeerFrame(frame: PeerFrame): Uint8Array;
export declare function decodePeerFrame(bytes: Uint8Array): PeerFrame;
/** Caller must authenticate application peers and grants independently of these transport hints. */
export declare function validatePeerBootstrap(value: unknown): PeerBootstrap;
export declare function createPeerConnection(socket: PeerSocket, options: { readonly route: 'direct' | 'relay'; readonly relayHandshake?: boolean; readonly queueBytes?: number }): PeerConnection;
export declare function connectPeer(endpoint: PeerEndpointHint, options?: { readonly protocols?: readonly string[]; readonly socket?: (url: string, protocols: readonly string[]) => PeerSocket; readonly relayHandshake?: boolean }): PeerConnection;
