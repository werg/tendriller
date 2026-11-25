import type { ApplicationSession, FramedPeerConnection } from '@chronolog/peer-session';
import type { PeersClient, PeerRendezvous } from '../contract/peers.mjs';
export { PEER_TRANSPORT_POLICY } from '../contract/transport-policy.mjs';
export interface ApplicationParticipationStatus { readonly phase: 'connecting' | 'connected' | 'disconnected' | 'closed'; readonly connectedPeers: readonly string[]; readonly connectionRevision: number; readonly pendingConnections: number; readonly error: string | null }
export interface ApplicationParticipation {
  readonly status: ApplicationParticipationStatus;
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  onStatus(listener: (status: ApplicationParticipationStatus) => void): () => void;
  diagnostics(): Promise<readonly { readonly peerId: string; readonly kind: 'direct' | 'relay' | 'unknown'; readonly reason?: string }[]>;
  reconsiderConnections(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}
export interface ApplicationTransportOptions {
  readonly peers: PeersClient;
  readonly openDirectConnection: (options: { role: 'offerer' | 'answerer'; signaling: PeerRendezvous; signal: AbortSignal; configuration: RTCConfiguration; timeoutMs: number }) => Promise<FramedPeerConnection>;
  readonly configuration?: RTCConfiguration;
  readonly directTimeoutMs?: number;
  /** Minimum time between relay-to-direct promotion attempts per peer, triggered only by reconsiderConnections(). Defaults to 30 seconds. */
  readonly upgradeCooldownMs?: number;
  /** Called for every host page notification (for example admission requests or key wraps), so an admission controller can refresh promptly. */
  readonly onNotification?: (notification: Readonly<{ type: string }>) => void;
  readonly onTransport?: (event: Readonly<{ peerId: string; kind: 'direct' | 'relay'; reason?: 'direct_failed' | 'direct_timeout' }>) => void;
}
export declare function participateApplication(session: ApplicationSession, options: ApplicationTransportOptions): ApplicationParticipation;
