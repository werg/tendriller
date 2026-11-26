export declare const BROADCAST_SCHEMA_VERSION: 1;
export declare const BROADCAST_SIGNING_DOMAIN: 'tendriller.broadcast.v1';

export type BroadcastKind = 'upgrade' | 'security' | 'maintenance' | 'deprecation' | 'announcement';
export type BroadcastSeverity = 'info' | 'recommended' | 'urgent' | 'critical';
export type BroadcastAudience = 'agents' | 'mcp' | 'page_owners' | 'page_all' | 'dashboard';
export type BroadcastActionKind = 'upgrade_dependencies' | 'republish_page' | 'reload_tabs' | 'read_advisory';

export declare const BROADCAST_KINDS: readonly BroadcastKind[];
export declare const BROADCAST_SEVERITIES: readonly BroadcastSeverity[];
export declare const BROADCAST_AUDIENCES: readonly BroadcastAudience[];
export declare const BROADCAST_ACTION_KINDS: readonly BroadcastActionKind[];
export declare const BROADCAST_ID_RE: RegExp;
export declare const BROADCAST_KEY_ID_RE: RegExp;
export declare const RUNTIME_ID_RE: RegExp;
export declare const BROADCAST_LIMITS: Readonly<{
  title: number;
  summary: number;
  body: number;
  docsUrl: number;
  packages: number;
  runtimeIds: number;
  listMax: number;
  clientVersionsBytes: number;
}>;

export interface BroadcastPublicJwk {
  kid: string;
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

export interface BroadcastPrivateJwk extends BroadcastPublicJwk {
  d: string;
}

export interface BroadcastAction {
  kind: BroadcastActionKind;
  packages?: Record<string, string>;
  release_manifest_url?: string;
  requires_republish?: boolean;
  requires_tab_reload?: boolean;
}

export interface BroadcastMatch {
  packages?: Record<string, string>;
  core_release?: string;
  runtime_ids?: string[];
  runtime_id_not_in?: string[];
  published_before?: number;
  agentless_only?: boolean;
}

export interface BroadcastPayload {
  schema_version: 1;
  id: string;
  seq: number;
  issuer: string;
  kind: BroadcastKind;
  severity: BroadcastSeverity;
  audiences: BroadcastAudience[];
  title: string;
  summary: string;
  body: string;
  docs_url: string | null;
  action: BroadcastAction | null;
  match: BroadcastMatch | null;
  dismissible: boolean;
  created_at: number;
  expires_at: number | null;
  superseded_by: string | null;
}

export interface BroadcastSignature {
  alg: 'Ed25519';
  kid: string;
  sig: string;
}

export interface SignedBroadcast {
  payload: BroadcastPayload;
  signature: BroadcastSignature;
}

export interface BroadcastInput {
  kind: BroadcastKind;
  severity: BroadcastSeverity;
  audiences: BroadcastAudience[];
  title: string;
  summary: string;
  body?: string;
  docs_url?: string | null;
  action?: BroadcastAction | null;
  match?: BroadcastMatch | null;
  dismissible?: boolean;
  expires_at?: number | string | null;
  superseded_by?: string | null;
}

export interface ClientVersions {
  core?: string;
  tools?: string;
  chronolog?: string;
  authority?: string;
  node?: string;
  kit?: string;
  packages?: Record<string, string>;
}

export interface BroadcastMatchContext {
  audience?: BroadcastAudience;
  audiences?: readonly BroadcastAudience[];
  versions?: ClientVersions;
  coreRelease?: string;
  runtimeId?: string | null;
  runtimeVersion?: string | null;
  publishedAt?: number | null;
  activeAgents?: number | null;
  now?: number;
}

export interface BroadcastMatchResult {
  matched: boolean;
  reasons: string[];
}

export interface BroadcastVerificationResult {
  valid: boolean;
  reason?: string;
  kid?: string;
}

export interface BroadcastFeedResult {
  notModified: boolean;
  etag: string | null;
  issuer: string;
  keys: BroadcastPublicJwk[];
  latest_seq: number;
  broadcasts: SignedBroadcast[];
  verified: SignedBroadcast[];
  rejected: Array<{ item: unknown; reason?: string }>;
}

export declare function canonicalizeBroadcastPayload(value: unknown): string;
export declare function broadcastSigningBytes(payload: BroadcastPayload): Uint8Array;
export declare function validateBroadcastKey(jwk: unknown): jwk is BroadcastPublicJwk;
export declare function publicJwkFromPrivate(privateJwk: BroadcastPrivateJwk): BroadcastPublicJwk;
export declare function generateBroadcastKeyPair(options?: { kid?: string }): Promise<{ kid: string; publicJwk: BroadcastPublicJwk; privateJwk: BroadcastPrivateJwk }>;
export declare function signBroadcastPayload(payload: BroadcastPayload, privateJwk: BroadcastPrivateJwk): Promise<SignedBroadcast>;
export declare function verifyBroadcastSignature(signed: unknown, publicKeys: readonly BroadcastPublicJwk[], options?: { issuer?: string }): Promise<BroadcastVerificationResult>;
export declare function validateBroadcastInput(input: unknown): Omit<BroadcastPayload, 'schema_version' | 'id' | 'seq' | 'issuer' | 'created_at'>;
export declare function validateClientVersions(input: unknown): ClientVersions;
export declare function compareSemver(a: string, b: string): -1 | 0 | 1 | null;
export declare function satisfiesVersionConstraint(version: string, constraint: string): boolean;
export declare function evaluateBroadcastMatch(payload: BroadcastPayload, context?: BroadcastMatchContext): BroadcastMatchResult;
export declare function matchesBroadcast(payload: BroadcastPayload, context?: BroadcastMatchContext): boolean;
export declare function fetchBroadcastKeys(serviceOrigin: string, options?: { fetch?: typeof globalThis.fetch; signal?: AbortSignal }): Promise<{ issuer: string; keys: BroadcastPublicJwk[] }>;
export interface ChangelogEntry {
  slug: string;
  date: string;
  category: 'feature' | 'deprecation' | 'breaking' | 'security';
  core_version: string;
  title: string;
  summary: string;
  body: string;
  docs_url: string;
  sunset_at: string | null;
  supersedes: string | null;
  broadcast_id: string | null;
  broadcast_severity: BroadcastSeverity | null;
}

export interface ChangelogResponse {
  schema_version: 1;
  issuer: string;
  core_release: string;
  latest_date: string | null;
  changelog_md_url: string;
  sunsetting_policy: Record<string, unknown>;
  entries: ChangelogEntry[];
}

export declare function fetchBroadcasts(serviceOrigin: string, options?: {
  audience?: BroadcastAudience;
  since?: number;
  verifyKeys?: readonly BroadcastPublicJwk[] | 'discover';
  etag?: string | null;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<BroadcastFeedResult>;
export declare function fetchChangelog(serviceOrigin: string, options?: {
  since?: string;
  sinceCore?: string;
  category?: 'feature' | 'deprecation' | 'breaking' | 'security';
  limit?: number;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<ChangelogResponse>;
