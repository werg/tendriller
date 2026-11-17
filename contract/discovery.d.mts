/** Directory values are routing hints, never signed authority or proof of retained data. */
export type PeerRoute = { readonly kind: 'https'; readonly url: string } | { readonly kind: 'rendezvous'; readonly channel: string }
  | { readonly kind: 'invitation'; readonly peerId: string };
export interface PeerAdvertisement {
  readonly peerId: string;
  /** Peers sharing one storage owner do not constitute independent retained copies. */
  readonly storageId: string;
  readonly routes: readonly PeerRoute[];
}
export interface PeerAdvertisementLease { readonly advertisement: PeerAdvertisement; readonly expiresAt: number; readonly refreshAfter: number }
export interface PeerDirectory { readonly applicationId: string; readonly peers: readonly PeerAdvertisementLease[] }
export declare const PEER_DIRECTORY_LIMITS: Readonly<{ peers: number; peersPerPrincipal: number; routes: number; defaultTtlMs: number; minTtlMs: number; maxTtlMs: number; advertisementBytes: number }>;
export declare class PeerDiscoveryError extends Error { readonly code: string; constructor(code: string, message: string) }
export declare function validatePeerId(value: unknown): string;
export declare function validatePeerRoute(value: unknown): PeerRoute;
export declare function validatePeerAdvertisement(value: unknown): PeerAdvertisement;
export declare function validatePeerTtl(value?: unknown): number;
export declare function validatePeerAdvertisementLease(value: unknown): PeerAdvertisementLease;
export declare function validatePeerDirectory(value: unknown): PeerDirectory;
