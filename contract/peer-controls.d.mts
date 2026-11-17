import type { AuthorityBundle, PeerGrant, HistoryPoint, SignedGeneration, SignedTransitionRequest, TransitionRequest } from './peer-authority.mjs';
export type { AuthorityBundle, PeerGrant, HistoryPoint, SignedGeneration, SignedTransitionRequest } from './peer-authority.mjs';
export interface PeerAccountBinding { readonly publicKey: string; readonly accountId: string }
/** Every device right is selected explicitly; an account binding adds no application privilege. */
export interface PeerApplicationMember { readonly grant: PeerGrant; readonly accountId?: string }
export interface PeerAccountBindingsContext {
  readonly kind: 'tendriller-account-bindings/v1';
  readonly accounts: readonly PeerAccountBinding[];
}
/** Canonical request context to hash with Chronolog peerDigest; no supplied bindings means null. */
export declare function peerAccountBindingsContext(accounts?: readonly PeerAccountBinding[]): PeerAccountBindingsContext | null;
/** Host scope and requester are pinned to its explicit control-only participant. */
export type PeerOwnerTransition = Pick<TransitionRequest, 'transitionId' | 'expectedGeneration' | 'coordinator' | 'controlRevision' | 'reason' | 'base'>;
export interface PeerApplicationConfiguration {
  readonly historyId: string;
  readonly executionManifestDigest: string;
  readonly definitionDigest: string;
  readonly schemaAdministrator: string;
  readonly schemaDigest?: string | null;
  readonly epoch: number;
  readonly keyDigest: string;
  /** Omitted accountId binds to the authenticated owner account. Grants remain separate from host login. */
  readonly members: readonly PeerApplicationMember[];
}
export interface PeerControlUpdate {
  readonly epoch: number;
  readonly keyDigest: string;
  /** Device-signed changes include the pinned host's exact control-only grant. */
  readonly grants: readonly PeerGrant[];
  readonly recoveryFloor: HistoryPoint | null;
  /** Explicit enrollment additions. A device's original account cannot be reassigned. */
  readonly accounts?: readonly PeerAccountBinding[];
}
export interface PeerControlsClient {
  /** Unverified transport evidence. Pin the descriptor and verify through Chronolog before using it. */
  application(): Promise<AuthorityBundle>;
  /** Creates durable control state; no browser or native process gains a permanent role. */
  configureApplication(configuration: PeerApplicationConfiguration): Promise<AuthorityBundle>;
  /** Exact transition retries preserve selection identity, including after a lost reply. */
  selectGeneration(request: SignedTransitionRequest, options?: { readonly control?: PeerControlUpdate }): Promise<SignedGeneration>;
  /** Owner account recovery without a creator device key. Candidate data and complete prefix come from a real peer. */
  administerGeneration(transition: PeerOwnerTransition, options?: { readonly control?: PeerControlUpdate }): Promise<SignedGeneration>;
}
export declare function createPeerControlsClient(request: (path: string, options?: { method?: 'PUT' | 'POST'; body?: unknown }) => Promise<unknown>): PeerControlsClient;
