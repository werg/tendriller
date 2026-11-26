import type { ApplicationSession, AuthorityProvider, AuthorityBundle, ApplicationDevice, SigningIdentity, ApplicationOwnerExtensions, InviteBinding, InviteRole, PageInvite } from '@chronolog/peer-session';
import type { AuthorityClient, HostAppConfig } from '../contract/authority.mjs';

/** The device store an `openApplicationDevice` result carries. */
export type BytesStore = ApplicationDevice['store'];
export interface DeviceWrapKey { readonly publicKey: string; readonly privateKey: CryptoKey }
/** The device's long-lived X25519 key-wrap key, created on first use and kept in its device store. */
export declare function deviceWrapKey(store: BytesStore): Promise<DeviceWrapKey>;
/** Exact signed grant for owner-account devices admitted by host attestation. */
export interface OwnerGrant { readonly reader: boolean; readonly writer: boolean; readonly administrator: boolean }
/** `{reader: true, writer: true, administrator: true}`: attested owner-account devices are administrators by default. */
export declare const DEFAULT_OWNER_GRANT: OwnerGrant;
/** Sign the descriptor and genesis membership as the page creator (root, descriptor authority, administrator). `ownerGrant` defaults to `DEFAULT_OWNER_GRANT`. */
export declare function createPageGenesis(options: { readonly applicationId: string; readonly identity: SigningIdentity; readonly wrapKey: string; readonly configuration: HostAppConfig; readonly hostKey: string; readonly accounts: readonly string[]; readonly mode?: 'attested' | 'strict'; readonly ownerGrant?: OwnerGrant | 'reader' | 'writer' | 'admin' }): Promise<{ readonly bundle: AuthorityBundle; readonly epochKey: Uint8Array }>;
/** Open cached authority, create the page (when `create` and uninitialized), or pin the host's authority to request admission. */
export declare function openPageAuthority(options: { readonly store: BytesStore; readonly identity: SigningIdentity; readonly wrapKey: DeviceWrapKey; readonly peers: AuthorityClient; readonly applicationId: string; readonly executionManifestDigest: string; readonly create?: boolean; readonly ownerGrant?: OwnerGrant | 'reader' | 'writer' | 'admin'; readonly signal?: AbortSignal }): Promise<{ readonly authority: AuthorityProvider; readonly created: boolean }>;

export type AdmissionPhase = 'admitted' | 'waiting-admission' | 'waiting-approval' | 'waiting-keys' | 'removed' | 'closed';
export interface AdmissionMember { readonly publicKey: string; readonly self: boolean; readonly reader: boolean; readonly writer: boolean; readonly administrator: boolean; readonly wrapKey: string | null; readonly via: 'creator' | 'attested' | 'invited' | 'approved' | 'administrator'; readonly subject: 'creator' | 'device' | 'agent' | 'key'; readonly label: string; readonly accountId?: string; readonly email?: string | null; readonly inviteId?: string | null; readonly admittedBy?: string; readonly revision?: number }
export interface AdmissionPending { readonly publicKey: string; readonly subject: 'device' | 'agent'; readonly label: string; readonly accountId: string; readonly email: string | null; readonly inviteId: string | null; readonly issuedAt: bigint; readonly expiresAt: bigint; readonly reason: 'strict_mode' | 'account_not_authorized' | 'invite_invalid' | 'invite_already_redeemed' | 'previously_removed' }
export interface AdmissionNotice { readonly id: string; readonly at: number; readonly kind: 'new-device' | 'pending' | 'removed'; readonly publicKey: string; readonly label?: string; readonly subject?: string; readonly accountId?: string | null; readonly via?: string; readonly reason?: string; readonly self?: boolean }
export interface AdmissionInvite extends PageInvite { readonly redemptions: number; readonly capacity: number | null; readonly expired: boolean }
export interface AdmissionState {
  readonly phase: AdmissionPhase; readonly publicKey: string; readonly wrapKey: string; readonly subject: 'device' | 'agent';
  readonly mode: 'attested' | 'strict'; readonly accounts: readonly string[]; readonly ownerGrant: OwnerGrant; readonly epoch: number; readonly revision: number;
  readonly administrator: boolean; readonly canAdmit: boolean;
  readonly members: readonly AdmissionMember[]; readonly pending: readonly AdmissionPending[]; readonly invites: readonly AdmissionInvite[];
  readonly notices: readonly AdmissionNotice[]; readonly attestationExpiresAt: bigint | null; readonly error: string | null;
}
export interface CreatedInvite { readonly inviteId: string; readonly role: InviteRole; readonly binding: InviteBinding; readonly expiresAt: bigint; readonly fragment: string }
/** Owner extension action names and their arguments (call through `session.extensions.call(name, args)`). */
export interface AdmissionActions {
  'admission.state'(): Promise<AdmissionState>;
  'admission.refresh'(): Promise<AdmissionState>;
  'admission.approve'(publicKey: string, flags?: { readonly writer?: boolean; readonly administrator?: boolean }): Promise<{ readonly approved: string }>;
  'admission.remove'(publicKey: string): Promise<{ readonly removed: string; readonly epoch: number }>;
  'admission.mode'(mode: 'attested' | 'strict'): Promise<{ readonly mode: 'attested' | 'strict' }>;
  'admission.ownerGrant'(grant: OwnerGrant | 'reader' | 'writer' | 'admin'): Promise<{ readonly ownerGrant: OwnerGrant }>;
  'admission.grant'(publicKey: string, flags: { readonly writer?: boolean; readonly administrator?: boolean }): Promise<{ readonly publicKey: string; readonly writer: boolean; readonly administrator: boolean }>;
  'admission.pinHostKey'(): Promise<{ readonly hostKey: string }>;
  'admission.addKey'(publicKey: string, wrapKey?: string | null, flags?: { readonly writer?: boolean }): Promise<{ readonly publicKey: string }>;
  'admission.invite'(input: { readonly binding: InviteBinding; readonly role?: InviteRole; readonly expiresInMs?: number }): Promise<CreatedInvite>;
  'admission.revokeInvite'(inviteId: string): Promise<{ readonly revoked: string }>;
  'admission.redeem'(fragment: string): Promise<AdmissionState>;
}
export interface PageAdmission {
  readonly state: AdmissionState;
  subscribe(listener: (state: AdmissionState) => void): () => void;
  refresh(): Promise<AdmissionState>;
  /** Pass as `createApplicationOwner(session, { extensions })`; notices are `{ topic: 'admission', state }`. */
  readonly extensions: ApplicationOwnerExtensions;
  call<K extends keyof AdmissionActions>(name: K, ...args: Parameters<AdmissionActions[K]>): ReturnType<AdmissionActions[K]>;
  close(): void;
}
/** The single admission mechanism for one open session (browser device or native agent). */
export declare function createAdmission(session: ApplicationSession, options: { readonly peers: AuthorityClient; readonly wrapKey: DeviceWrapKey; readonly store?: BytesStore; readonly subject?: 'device' | 'agent'; readonly label?: string; readonly now?: () => number; readonly memberIntervalMs?: number; readonly waitingIntervalMs?: number; readonly onEvent?: (notice: AdmissionNotice) => void }): PageAdmission;
/** Route owner extension calls by name across several extensions. */
export declare function composeOwnerExtensions(...extensions: readonly ApplicationOwnerExtensions[]): ApplicationOwnerExtensions;
