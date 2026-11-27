import type {
  ApplicationSession, ApplicationDevice, SigningIdentity, ApplicationOwnerExtensions,
  LogGenesis, SessionCasNode, ScheduledFinalityEntry, LogTopicSeed,
} from '@chronolog/peer-session';
import type { AuthorityClient } from '../contract/authority.mjs';

export type BytesStore = ApplicationDevice['store'];
export interface DeviceWrapKey { readonly publicKey: string; readonly privateKey: CryptoKey }
export declare function deviceWrapKey(store: BytesStore): Promise<DeviceWrapKey>;
export interface OwnerGrant { readonly reader: boolean; readonly writer: boolean; readonly administrator: boolean }
export declare const DEFAULT_OWNER_GRANT: OwnerGrant;

export interface CreatedPageGenesis {
  readonly logId: string;
  readonly genesis: LogGenesis;
  readonly genesisBytes: Uint8Array;
  readonly casNodes: readonly SessionCasNode[];
  readonly epoch0Key?: Uint8Array;
}

export type PageAuthorityConfig =
  | { readonly mode: 'attested' }
  | { readonly mode: 'multisig'; readonly signers?: readonly string[]; readonly threshold?: number }
  | { readonly mode: 'open'; readonly openRead?: boolean; readonly openWrite?: boolean };

export declare function createPageGenesis(options: {
  readonly identity: SigningIdentity;
  readonly wrapKey: string;
  readonly hostKey?: string;
  readonly accounts?: readonly string[];
  readonly mode?: 'attested' | 'strict';
  readonly ownerGrant?: OwnerGrant | 'reader' | 'writer' | 'admin';
  readonly authority?: PageAuthorityConfig;
  readonly admission?: null;
  readonly privateLog?: boolean;
  readonly imports?: Readonly<Record<string, string>>;
  readonly topics?: Readonly<Record<string, LogTopicSeed>>;
  readonly finalitySchedule?: readonly ScheduledFinalityEntry[];
  readonly frozenReducers?: boolean;
  readonly salt?: Uint8Array;
}): Promise<CreatedPageGenesis>;

export declare function openPageGenesis(options: {
  readonly store?: BytesStore;
  readonly identity: SigningIdentity;
  readonly wrapKey: DeviceWrapKey;
  readonly peers: AuthorityClient;
  readonly applicationId?: string;
  readonly create?: boolean;
  readonly ownerGrant?: OwnerGrant | 'reader' | 'writer' | 'admin';
  readonly authority?: PageAuthorityConfig;
  readonly imports?: Readonly<Record<string, string>>;
  readonly topics?: Readonly<Record<string, LogTopicSeed>>;
  readonly privateLog?: boolean;
  readonly finalitySchedule?: readonly ScheduledFinalityEntry[];
  readonly signal?: AbortSignal;
}): Promise<CreatedPageGenesis & { readonly publicOps: readonly Uint8Array[]; readonly created: boolean }>;

export type AdmissionPhase = 'admitted' | 'waiting-admission' | 'waiting-approval' | 'waiting-keys' | 'removed' | 'closed';
export interface AdmissionMember {
  readonly publicKey: string;
  readonly self: boolean;
  readonly reader: boolean;
  readonly writer: boolean;
  readonly administrator: boolean;
  readonly publisher: boolean;
  readonly finalizer: boolean;
  readonly wrapKey?: string;
}
export interface AdmissionPending {
  readonly publicKey: string;
  readonly subject: 'device' | 'agent';
  readonly label: string;
  readonly accountId: string;
  readonly email: string | null;
  readonly inviteId: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly reason: string | null;
}
export interface AdmissionNotice {
  readonly id: string;
  readonly at: number;
  readonly kind: string;
  readonly publicKey: string;
  readonly [key: string]: unknown;
}
export interface AdmissionState {
  readonly phase: AdmissionPhase;
  readonly publicKey: string;
  readonly wrapKey: string;
  readonly subject: 'device' | 'agent';
  readonly mode: 'attested' | 'strict';
  readonly accounts: readonly string[];
  readonly ownerGrant: OwnerGrant;
  readonly epoch: number;
  readonly administrator: boolean;
  readonly canAdmit: boolean;
  readonly members: readonly AdmissionMember[];
  readonly pending: readonly AdmissionPending[];
  readonly invites: readonly Record<string, unknown>[];
  readonly notices: readonly AdmissionNotice[];
  readonly attestationExpiresAt: number | null;
  readonly error: string | null;
}
export interface PageAdmission {
  readonly state: AdmissionState;
  subscribe(listener: (state: AdmissionState) => void): () => void;
  refresh(): Promise<AdmissionState>;
  readonly extensions: ApplicationOwnerExtensions;
  call(name: string, ...args: unknown[]): Promise<unknown>;
  close(): void;
}
export declare function createAdmission(session: ApplicationSession, options: {
  readonly peers: AuthorityClient;
  readonly wrapKey: DeviceWrapKey;
  readonly store?: BytesStore;
  readonly subject?: 'device' | 'agent';
  readonly now?: () => number;
  readonly memberIntervalMs?: number;
  readonly waitingIntervalMs?: number;
  readonly onEvent?: (notice: AdmissionNotice) => void;
  readonly onEpochRotated?: (info: { epoch: number; reason: string; publicKey: string }) => void | Promise<void>;
}): PageAdmission;
export declare function composeOwnerExtensions(...extensions: readonly ApplicationOwnerExtensions[]): ApplicationOwnerExtensions;
