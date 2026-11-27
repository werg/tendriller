import type { ApplicationSession, FramedPeerConnection } from '@chronolog/peer-session';
import type { PeersClient, PeerRendezvous } from '../contract/peers.mjs';
export { PEER_TRANSPORT_POLICY } from '../contract/transport-policy.mjs';
export interface ApplicationParticipationStatus { readonly phase: 'connecting' | 'connected' | 'disconnected' | 'closed'; readonly connectedPeers: readonly string[]; readonly connectionRevision: number; readonly pendingConnections: number; readonly error: string | null }
/** One authenticated physical link. Counters are the session's measured framing; absent fields are unmeasured. */
export interface ApplicationLinkDiagnostics {
  readonly connectionId?: string;
  readonly peerId: string;
  readonly kind: 'direct' | 'relay' | 'unknown';
  readonly reason?: 'direct_failed' | 'direct_timeout';
  readonly sentReliableBytes?: number;
  readonly receivedReliableBytes?: number;
  readonly sentLiveBytes?: number;
  readonly receivedLiveBytes?: number;
  readonly signalRejections?: Readonly<Record<'total' | 'clockSkew' | 'expired' | 'unauthorized' | 'duplicate' | 'capacity', number>>;
}
export interface ApplicationParticipation {
  readonly status: ApplicationParticipationStatus;
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  onStatus(listener: (status: ApplicationParticipationStatus) => void): () => void;
  /** The session's per-link diagnostics, annotated with the route this controller selected.
   * While the controller runs, the owned session's own `diagnostics()` returns the same rows. */
  diagnostics(): Promise<readonly ApplicationLinkDiagnostics[]>;
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
  /** Minimum healthy link duration before reconnect retry backoff resets to zero. Defaults to 30 seconds. */
  readonly stableLinkMs?: number;
  /** Called for every host page notification (for example admission requests or key wraps), so an admission controller can refresh promptly. */
  readonly onNotification?: (notification: Readonly<{ type: string }>) => void;
  readonly onTransport?: (event: Readonly<{ peerId: string; kind: 'direct' | 'relay'; reason?: 'direct_failed' | 'direct_timeout' }>) => void;
}
export declare function participateApplication(session: ApplicationSession, options: ApplicationTransportOptions): ApplicationParticipation;
