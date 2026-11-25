export declare const AUTHORITY_PARTICIPANT_LIMITS: Readonly<{ pending: 4; perPrincipal: 2; recordBytes: number; requestBytes: number }>;
export interface AuthorityRecord { readonly record: string }
export interface HostAppConfig {
  readonly executionManifestDigest: string;
  readonly executionProfile: string;
  /** Canonical FinalityPolicy record; omitted means none. A browser policy resolves signer at first enrollment. */
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
  readonly provisioningRequired?: boolean;
}
export interface EnrollmentChallenge { readonly applicationId: string; readonly publicKey: string; readonly challenge: string; readonly expiresAt: number }
export interface AuthorityRequestOptions { readonly signal?: AbortSignal }
export interface AuthorityClient {
  application(options?: AuthorityRequestOptions): Promise<HostApplication>;
  prepare(configuration: HostAppConfig): Promise<HostApplication>;
  challenge(publicKey: string): Promise<EnrollmentChallenge>;
  enroll(proof: AuthorityRecord): Promise<HostApplication>;
  grant(input: { readonly requestId: string; readonly expectedMembershipId: string; readonly authorTimeAfterMs: string; readonly grant: { readonly publicKey: string; readonly reader: boolean; readonly writer: boolean; readonly administrator: boolean; readonly publisher: boolean; readonly finalizer: boolean } }): Promise<HostApplication>;
  membership(bundle: AuthorityRecord): Promise<HostApplication>;
  publication(id?: string): Promise<{ readonly publication: unknown; readonly version: number } | null>;
  publish(publication: unknown, assets: readonly { readonly hash: string; readonly bytes: string }[]): Promise<unknown>;
  participant(record: AuthorityRecord): Promise<AuthorityRecord>;
}
export declare function authorityRecord(bytes: Uint8Array): AuthorityRecord;
export declare function authorityRecordBytes(value: unknown, limit?: number): Uint8Array;
export declare function createAuthorityClient(request: (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<any>, options?: { readonly applicationId?: string }): AuthorityClient;
