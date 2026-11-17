export interface PeerSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
/** Optional HTTPS introductions, never application relay routes or credentials. */
export interface PeerIntroductionEndpoint { readonly url: string }
export interface PeerBootstrap { readonly version: 2; readonly endpoints: readonly PeerIntroductionEndpoint[] }
export declare class PeerConnectionError extends Error { readonly code: string; constructor(code: string, message: string) }
/** Caller must authenticate application peers and grants independently of these transport hints. */
export declare function validatePeerBootstrap(value: unknown): PeerBootstrap;

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
export interface PeersClient extends PeerControlsClient {
  /** Closed Chronolog facet transport; unwanted application data is refused before HTTP. */
  exchange(request: import('./participant.mjs').ParticipantRequest, options?: import('./participant.mjs').ParticipantExchangeOptions): Promise<import('./participant.mjs').ParticipantResponse>;
  /** Immutable initial-page snapshot; reading it performs no host request. Null for clients without an injected snapshot. */
  readonly initialBootstrap: PeerBootstrap | null;
  /** Explicitly fetch current host configuration. Ordinary peer connection/recovery uses initialBootstrap. */
  bootstrap(): Promise<PeerBootstrap>;
  setBootstrap(hints: PeerBootstrap): Promise<PeerBootstrap>;
  /** Explicit lookup on join/reconnect. No background polling is installed. */
  discover(options?: { readonly signal?: AbortSignal }): Promise<PeerDirectory>;
  /** Coalesced availability hints. Peer authentication and authority are verified independently. */
  advertise(advertisement: PeerAdvertisement, options?: { readonly ttlMs?: number; readonly signal?: AbortSignal }): Promise<PeerAdvertisementLease>;
  withdraw(peerId: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  /** Hibernatable connection invitations; no heartbeat or application traffic. */
  listenInvitations(peerId: string, options?: PeerInvitationOptions): PeerInvitationListener;
  /** On-demand late-join/reconnect hint. Peer authentication remains independent. */
  invite(peerId: string, invitation: PeerInvitation, options?: { readonly signal?: AbortSignal }): Promise<void>;
  rendezvous(channel: string, peerId: string, options?: PeerRendezvousOptions): PeerRendezvous;
}
export declare const PEER_RENDEZVOUS_PROTOCOL: 'tendriller.rendezvous.v1';
export declare const PEER_RENDEZVOUS_LIMITS: Readonly<{ descriptionBytes: number; messageBytes: number; sessions: number; lifetimeMs: number }>;
export declare function validatePeerDescription(value: unknown): PeerDescription;
export declare function createPeerRendezvous(socket: PeerSocket, options?: PeerRendezvousOptions): PeerRendezvous;
export declare function createPeersClient(options: {
  readonly base: string;
  readonly applicationId?: string | (() => Promise<string>);
  readonly initialBootstrap?: PeerBootstrap;
  readonly request: (path: string, options?: { method?: 'PUT' | 'DELETE' | 'POST'; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
  readonly protocols?: readonly string[];
  readonly socket?: (url: string, protocols: readonly string[]) => PeerSocket;
}): PeersClient;
import type { PeerAdvertisement, PeerAdvertisementLease, PeerDirectory } from './discovery.mjs';
export * from './discovery.mjs';
import type { PeerControlsClient } from './peer-controls.mjs';
export * from './peer-controls.mjs';
export * from './peer-participant.mjs';
import type { PeerInvitation, PeerInvitationOptions, PeerInvitationListener } from './invitations.mjs';
export * from './invitations.mjs';

export { createPeerIntroductions } from './introductions.mjs';
