import type { ParticipantTransport } from './participant.mjs';
import type { AuthorityBundle, PeerGrant, HistoryPoint, SignedGeneration, SignedTransitionRequest, TransitionRequest,
  ApplicationDescription, SignedApplicationDescriptor, SignedApplicationSchema, SignedPublication } from './peer-authority.mjs';
export type { AuthorityBundle, PeerGrant, HistoryPoint, SignedGeneration, SignedTransitionRequest,
  ApplicationDescription, ApplicationInputSchema, SignedApplicationDescriptor, SignedApplicationSchema } from './peer-authority.mjs';
export interface PeerAccountBinding { readonly publicKey: string; readonly accountId: string }
/** The ordinary shared-application grant, or an explicit set of independent device rights. */
export type PeerApplicationMember = { readonly publicKey: string; readonly administrator?: boolean; readonly dataRole?: 'member' | 'admin' | null; readonly accountId?: string }
  | { readonly grant: PeerGrant; readonly accountId?: string };
/** Host scope and requester are pinned to its explicit control-only participant. */
export type PeerOwnerTransition = Pick<TransitionRequest, 'transitionId' | 'expectedGeneration' | 'coordinator' | 'controlRevision' | 'reason' | 'base'>;
export interface PeerApplicationPublication {
  readonly descriptor: SignedApplicationDescriptor;
  readonly definition: ApplicationDescription;
  readonly schema: SignedApplicationSchema | null;
}
export interface PeerApplicationConfiguration {
  readonly historyId: string;
  readonly executionManifestDigest: string;
  /** The host derives the bound digest using Chronolog's portable validator. */
  readonly definition: ApplicationDescription;
  readonly schemaAdministrator: string;
  /** The host verifies the signature and derives its descriptor commitment. */
  readonly schema?: SignedApplicationSchema | null;
  readonly epoch: number;
  readonly keyDigest: string;
  /** Omitted accountId binds to the authenticated owner account. Grants remain separate from host login. */
  readonly members: readonly PeerApplicationMember[];
}
export interface PeerControlUpdate {
  readonly epoch: number;
  readonly keyDigest: string;
  readonly grants: readonly PeerGrant[];
  readonly recoveryFloor: HistoryPoint | null;
  /** Explicit enrollment additions. A device's original account cannot be reassigned. */
  readonly accounts?: readonly PeerAccountBinding[];
}
export interface PeerControlsClient {
  /** Unverified transport evidence. Pin the descriptor and verify through Chronolog before using it. */
  application(): Promise<AuthorityBundle>;
  /** Immutable schemas and genesis envelope. Verify against the pinned descriptor using Chronolog. */
  definition(): Promise<PeerApplicationPublication>;
  /** Selected signed code release. The host's normal file retention and byte quotas still apply. */
  publication(options?: { readonly id?: string }): Promise<PeerPublicationReceipt | null>;
  publishPublication(publication: SignedPublication, assets: readonly PeerPublicationAsset[]): Promise<PeerPublicationReceipt>;
  /** Creates durable control state; no browser or native process gains a permanent role. */
  configureApplication(configuration: PeerApplicationConfiguration): Promise<AuthorityBundle>;
  /** Exact transition retries preserve selection identity, including after a lost reply. */
  selectGeneration(request: SignedTransitionRequest, options?: { readonly control?: PeerControlUpdate }): Promise<SignedGeneration>;
  /** Owner account recovery without a creator device key. Candidate data and complete prefix come from a real peer. */
  administerGeneration(transition: PeerOwnerTransition, options?: { readonly control?: PeerControlUpdate }): Promise<SignedGeneration>;
}
export interface PeerPublicationAsset { readonly hash: string; readonly bytes: string }
export interface PeerPublicationReceipt { readonly publication: SignedPublication; readonly version: number }
export declare function createPeerControlsClient(participant: () => ParticipantTransport): PeerControlsClient;
