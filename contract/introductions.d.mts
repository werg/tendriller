import type { PeersClient, PeerRendezvous, PeerRoute, PeerInvitation } from './peers.mjs';

/** A structural adapter to the one session-owned participation controller. No lifecycle policy runs here. */
export declare function createPeerIntroductions<Connection extends { close(): void | Promise<void> }>(options: {
  readonly peers: Pick<PeersClient, 'discover' | 'advertise' | 'withdraw' | 'listenInvitations' | 'invite' | 'rendezvous'>;
  readonly identity: string;
  /** Native openWebRtcConnection or the browser's owned Worker opener. */
  readonly openConnection: (options: {
    readonly role: 'offerer' | 'answerer';
    readonly signaling: PeerRendezvous;
    readonly signal: AbortSignal;
  }) => Promise<Connection>;
}): Readonly<{
  discovery: Readonly<{
    read(options: { readonly signal: AbortSignal }): Promise<readonly { readonly identity: string; readonly route: PeerRoute }[]>;
    /** Only routing identity and storage ownership are published; session evidence stays within Chronolog. */
    advertise(value: { readonly identity: string; readonly storageId: string }, options: { readonly ttlMs: number; readonly signal: AbortSignal }): Promise<void>;
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
