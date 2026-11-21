import type { PeersClient, PeerRendezvous, PeerRelay, PeerRoute, PeerInvitation, PeerDiscoveryNotification } from './peers.mjs';

/** A structural adapter to the one session-owned participation controller. No lifecycle policy runs here. */
export declare function createPeerIntroductions<Connection extends { close(): void | Promise<void> }>(options: {
  readonly peers: Pick<PeersClient, 'watchDiscovery' | 'discover' | 'advertise' | 'withdraw' | 'listenInvitations' | 'invite' | 'rendezvous' | 'relay'>;
  readonly identity: string;
  /** Native openWebRtcConnection or the browser's owned Worker opener. */
  readonly openDirectConnection: (options: {
    readonly role: 'offerer' | 'answerer';
    readonly signaling: PeerRendezvous;
    readonly signal: AbortSignal;
  }) => Promise<Connection>;
  /** Constructs the binary framing synchronously, then awaits its readiness. Same application protocol above both transports. */
  readonly openRelayConnection: (options: { readonly relay: PeerRelay; readonly signal: AbortSignal }) => Promise<Connection>;
  /** Budget for one direct attempt before the relay; the session owns the overall attempt and retries. Default 5000ms. */
  readonly directTimeoutMs?: number;
  /** Raw transport selection before peer authentication; never includes payloads or addresses. */
  readonly onTransport?: (event: Readonly<{peerId:string;kind:'direct'|'relay';reason?:'direct_failed'|'direct_timeout'}>) => void;
}): Readonly<{
  discovery: Readonly<{
    /** Required session invalidations: ready triggers advertise + read; changed triggers only read. */
    notifications(options: { readonly signal: AbortSignal }): AsyncIterable<PeerDiscoveryNotification>;
    read(options: { readonly signal: AbortSignal }): Promise<readonly { readonly identity: string; readonly route: PeerRoute }[]>;
    /** Only routing identity and storage ownership are published; session evidence stays within Chronolog. */
    advertise(value: { readonly identity: string; readonly storageId: string }, options: { readonly signal: AbortSignal }): Promise<void>;
    withdraw(options: { readonly signal: AbortSignal }): Promise<void>;
    invitations(options: { readonly signal: AbortSignal }): AsyncIterable<{
      readonly peer: { readonly identity: string; readonly route: PeerRoute }; readonly token: PeerInvitation;
    }>;
  }>;
  transport: Readonly<{
    open(input: { readonly peer: { readonly identity: string; readonly route: unknown }; readonly invitation?: unknown },
      options: { readonly signal: AbortSignal }): Promise<Connection>;
  }>;
}>;
