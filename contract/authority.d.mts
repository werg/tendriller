export declare const AUTHORITY_PARTICIPANT_LIMITS: Readonly<{ pending: 4; perPrincipal: 2; recordBytes: number; requestBytes: number }>;
export interface AuthorityRecord { readonly record: string }
export interface PublicCasNodePayload { readonly hash: string; readonly bytes: string }

export interface HostAppConfig {
  readonly executionProfile?: string;
  readonly requestedFinality?: AuthorityRecord | { readonly kind: 'browser-signed-frontier' };
  readonly publisherKeys?: readonly string[];
  /** Explicit API/tool declarations; not database schema or grants. */
  readonly tools?: Readonly<Record<string, unknown>>;
}

export interface HostApplication {
  readonly selection: { readonly id: string };
  readonly configuration: HostAppConfig | null;
  /** Canonical Chronolog v2 LogGenesis record, or null before initialization. */
  readonly genesis: AuthorityRecord | null;
  /** Latest blind-host materialized public-control stateRoot, or null before initialization. */
  readonly stateRoot: string | null;
  readonly historyDigest: string | null;
  readonly currentEpoch: number;
  readonly closedThroughMs: string | null;
  /** The host's Ed25519 attestation public key (hex) pinned in `$permissions.admission.hostKey`. */
  readonly hostAttestationKey: string | null;
  readonly admissionAccounts: readonly string[];
}

export interface HostControlSyncInput {
  readonly publicOps?: readonly AuthorityRecord[];
  readonly casNodes?: readonly PublicCasNodePayload[];
  readonly checkpoints?: readonly AuthorityRecord[];
  readonly knownOpIds?: readonly string[];
  readonly knownCasHashes?: readonly string[];
}

export interface HostControlSyncResponse extends HostApplication {
  readonly genesis: AuthorityRecord;
  readonly publicOps: readonly AuthorityRecord[];
  readonly casNodes: readonly PublicCasNodePayload[];
  readonly checkpoints: readonly AuthorityRecord[];
  readonly addedOps: number;
  readonly addedCasNodes: number;
  readonly addedCheckpoints: number;
}

export interface HostEnrollment extends HostApplication { readonly attestation: AuthorityRecord }
export interface InviteRedemption { readonly inviteId: string; readonly secret: string }
export interface HostAdmissions {
  /** Fresh signed host attestations (`signHostAttestationV2`) for keys not yet in `$permissions.members`. */
  readonly pending: readonly AuthorityRecord[];
}
export interface EnrollmentChallenge { readonly applicationId: string; readonly publicKey: string; readonly challenge: string; readonly expiresAt: number }
export interface AuthorityRequestOptions { readonly signal?: AbortSignal }

export interface AuthorityClient {
  application(options?: AuthorityRequestOptions): Promise<HostApplication>;
  prepare(configuration: HostAppConfig): Promise<HostApplication>;
  challenge(publicKey: string): Promise<EnrollmentChallenge>;
  enroll(proof: AuthorityRecord, invite?: InviteRedemption): Promise<HostEnrollment>;
  enrollAgent(): Promise<HostEnrollment>;
  initialize(input: { readonly genesis: AuthorityRecord; readonly casNodes?: readonly PublicCasNodePayload[]; readonly publicOps?: readonly AuthorityRecord[] }): Promise<HostApplication>;
  syncControl(input?: HostControlSyncInput, options?: AuthorityRequestOptions): Promise<HostControlSyncResponse>;
  admissions(options?: AuthorityRequestOptions): Promise<HostAdmissions>;
  publication(id?: string): Promise<{ readonly opId: string; readonly revision: number; readonly version: number; readonly release: unknown; readonly finalized: boolean } | null>;
  publish(op: AuthorityRecord, assets: readonly { readonly hash: string; readonly bytes: string }[]): Promise<unknown>;
  groups?(options?: AuthorityRequestOptions): Promise<{ readonly policy: unknown; readonly group_attestations: readonly unknown[]; readonly departures: readonly unknown[] }>;
  setGroupPolicy?(policy: unknown, options?: AuthorityRequestOptions): Promise<{ readonly policy: unknown }>;
  ackDeparture?(publicKey: string, options?: AuthorityRequestOptions): Promise<{ readonly cleared: boolean }>;
  participant(record: AuthorityRecord): Promise<AuthorityRecord>;
}

export declare function authorityRecord(bytes: Uint8Array): AuthorityRecord;
export declare function authorityRecordBytes(value: unknown, limit?: number): Uint8Array;
export declare function createAuthorityClient(request: (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<any>, options?: { readonly applicationId?: string }): AuthorityClient;
