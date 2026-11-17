import type { PeerSocket } from './peers.mjs';
export interface PeerInvitation { readonly channel: string; readonly requesterPeerId: string }
export interface PeerInvitationOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly socket?: (url: string, protocols: readonly string[]) => PeerSocket }
export interface PeerInvitationListener {
  readonly ready: Promise<void>;
  readonly closed: Promise<Readonly<{ code: number; reason: string }>>;
  readonly invitations: AsyncIterable<PeerInvitation>;
  readonly stats: Readonly<{ receivedBytes: number; sentBytes: number; receivedInvitations: number; closed: boolean }>;
  close(): void;
}
export declare const PEER_INVITATION_PROTOCOL: 'tendriller.invitations.v1';
export declare const PEER_INVITATION_LIMITS: Readonly<{ listeners: number; listenersPerPrincipal: number; pending: number; invitationsPerMinute: number; messageBytes: number; openTimeoutMs: number }>;
export declare function validatePeerInvitation(value: unknown): PeerInvitation;
export declare function createPeerInvitationListener(socket: PeerSocket, peerId: string, options?: PeerInvitationOptions): PeerInvitationListener;
