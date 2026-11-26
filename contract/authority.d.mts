export declare const AUTHORITY_PARTICIPANT_LIMITS: Readonly<{ pending: 4; perPrincipal: 2; recordBytes: number; requestBytes: number }>;
export interface AuthorityRecord { readonly record: string }
export interface HostAppConfig {
  readonly executionManifestDigest: string;
  readonly executionProfile: string;
  /** Canonical FinalityPolicy record; omitted means none. `browser-signed-frontier` requires the genesis root key as signer. */
  readonly requestedFinality?: AuthorityRecord | { readonly kind: 'browser-signed-frontier' };
  readonly publisherKeys: readonly string[];
  /** Explicit API/tool declarations; not database schema or grants. */
  readonly tools?: Readonly<Record<string, unknown>>;
}
export interface HostApplication {
  readonly selection: { readonly id: string };
  readonly configuration: HostAppConfig | null;
  readonly publicationAuthority: { readonly applicationId: string; readonly executionManifestDigest: string; readonly grantId: string; readonly publisherKeys: readonly string[] } | null;
  readonly authority: AuthorityRecord | null;
  /** The host's Ed25519 attestation public key (hex) that genesis pins as `admission.hostKey`; null when the host has none configured. */
  readonly hostAttestationKey: string | null;
  /** Account principals `initialize` requires in `admission.accounts`: `[<owner account ID>, email:<owner's verified address>]` once claimed, else `[email:<intended owner>]`. */
  readonly admissionAccounts: readonly string[];
}
/** Enrollment answers carry the signed host attestation (canonical SignedHostAttestation record). Evidence only, never membership. */
export interface HostEnrollment extends HostApplication { readonly attestation: AuthorityRecord }
export interface InviteRedemption { readonly inviteId: string; readonly secret: string }
export interface HostAdmissions {
  /** Fresh signed host attestations for keys that are not yet members. */
  readonly pending: readonly AuthorityRecord[];
  /** Highest epoch covered by a stored key wrap, per recipient public key. */
  readonly wrapped: Readonly<Record<string, number>>;
}
export interface EnrollmentChallenge { readonly applicationId: string; readonly publicKey: string; readonly challenge: string; readonly expiresAt: number }
export interface AuthorityRequestOptions { readonly signal?: AbortSignal }
export interface AuthorityClient {
  application(options?: AuthorityRequestOptions): Promise<HostApplication>;
  prepare(configuration: HostAppConfig): Promise<HostApplication>;
  challenge(publicKey: string): Promise<EnrollmentChallenge>;
  /** Signed-in browser: verify the challenge-bound key proof (and optional invite) and receive a host attestation. */
  enroll(proof: AuthorityRecord, invite?: InviteRedemption): Promise<HostEnrollment>;
  /** Granted agent: receive a host attestation for its registered signing and wrap keys. */
  enrollAgent(): Promise<HostEnrollment>;
  /** Store a member-signed genesis bundle once (root agent or owner browser). */
  initialize(bundle: AuthorityRecord): Promise<HostApplication>;
  /** Extend the stored chain by exactly one member-signed revision. */
  membership(bundle: AuthorityRecord): Promise<HostApplication>;
  admissions(): Promise<HostAdmissions>;
  /** Deliver a member-signed key wrap addressed to a reader member. */
  wrap(wrap: AuthorityRecord): Promise<{ readonly stored: true; readonly wrapped: Readonly<Record<string, number>> }>;
  wraps(recipient: string): Promise<{ readonly wraps: readonly AuthorityRecord[] }>;
  publication(id?: string): Promise<{ readonly publication: unknown; readonly version: number } | null>;
  publish(publication: unknown, assets: readonly { readonly hash: string; readonly bytes: string }[]): Promise<unknown>;
  participant(record: AuthorityRecord): Promise<AuthorityRecord>;
}
export declare function authorityRecord(bytes: Uint8Array): AuthorityRecord;
export declare function authorityRecordBytes(value: unknown, limit?: number): Uint8Array;
export declare function createAuthorityClient(request: (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<any>, options?: { readonly applicationId?: string }): AuthorityClient;
