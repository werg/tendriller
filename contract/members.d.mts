/** Bytes in the host JSON API use canonical unpadded base64url. */
export interface MemberProgram { sql: boolean; topics: string[]; signals: string[]; forwarded?: boolean }
export interface MembershipConfiguration {
  executionManifestDigest: string;
  schemaAdministratorPublicKey: string;
  nativeAuthority: { url: string; historyId: string; publicKey: string };
  initialMembers?: { signingPublicKey: string; readerPublicKey: string; transportAuthor: string; writerProgram?: MemberProgram }[];
}
export interface MembershipDescriptor { genesis: string; groupRoute: string }
export interface MemberRequest {
  id: string; accountId: string; signingPublicKey: string; readerPublicKey: string; transportAuthor: string;
  requestId: string; requestedRoles: ('reader' | 'writer')[]; writerProgram?: MemberProgram;
  status: 'requested' | 'approving' | 'approved' | 'revoked'; createdAt: number;
  signedApproval?: string; capabilityIds: string[]; revokedCapabilityIds: string[];
}
export interface MembershipInfo {
  descriptor: MembershipDescriptor | null;
  identity: { accountId: string; requestPrefix: string; administrator: boolean };
  requests: MemberRequest[];
  /** verifiedThrough/root describe compact controls, independently of application receipt coverage. */
  progress: { verifiedThrough: number; root: string; receiptThrough: number; checkpointThrough: number; closedThroughMs: string } | null;
  pendingActions: number;
}
export interface MemberApproval {
  operationId: string; requestId: string; roles: ('reader' | 'writer')[];
  grantFullHistory: boolean;
  /** Required exactly when roles includes writer; rights are never inferred. */
  writerProgram?: MemberProgram;
}
export interface MembersClient {
  info(options?: { signal?: AbortSignal }): Promise<MembershipInfo>;
  configure(configuration: MembershipConfiguration, options?: { signal?: AbortSignal }): Promise<MembershipInfo>;
  sync(options?: { signal?: AbortSignal }): Promise<MembershipInfo>;
  requestEnrollment(signedRequest: string, options?: { signal?: AbortSignal }): Promise<MemberRequest>;
  requestStatus(requestId: string, options?: { signal?: AbortSignal }): Promise<MemberRequest>;
  approve(input: MemberApproval, options?: { signal?: AbortSignal }): Promise<MemberRequest>;
  revoke(input: { operationId: string; capabilityIds: string[] }, options?: { signal?: AbortSignal }): Promise<{ membershipRevision: string; epoch: string; frontier: string }>;
  /** Exact CBOR receipt entries, closure markers and certificate; verify with the portable Chronolog membership codec. */
  history(options: { after: number; limit?: number; signal?: AbortSignal }): Promise<Uint8Array>;
}
export declare function createMembersClient(options: {
  base: string; headers?: () => Record<string, string>; fetch?: typeof globalThis.fetch;
}): MembersClient;
