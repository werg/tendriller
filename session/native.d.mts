export interface NativeAttachmentPolicy {
  capabilities?: readonly ('commands' | 'queries' | 'events' | 'content' | 'signals' | 'operations' | 'diagnostics' | 'ownerAdmin' | 'publish')[];
  commands?: readonly string[];
  queries?: readonly string[];
  identity?: { principalId?: string; agentBindingId?: string; deviceProfileId?: string };
  context?: { viewId?: string; documentPath?: string; publicationId?: string; runId?: string };
  contextEvidence?: 'caller-asserted' | 'owner-validated';
  maxRequests?: number; maxStreams?: number; maxViews?: number;
  preserveOperationId?: boolean;
}
export interface NativeEndpoint {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(value: unknown, transfer?: Transferable[]): void;
  start?(): void;
}
export interface NativeControlProxy {
  definition(): Promise<unknown>;
  publication(): Promise<unknown>;
  publicationOperation(operationId: string): Promise<unknown>;
  preparePublication(input: unknown): Promise<unknown>;
  publish(publication: unknown, assets: readonly { hash: string; bytes: string }[]): Promise<unknown>;
}
export interface NativeSessionOwner {
  readonly ownerInstanceId: string;
  readonly session: { readonly applicationId: string; readonly deviceId: string; readonly signal?: AbortSignal; describe(): { id: string; version: string } };
  readonly control?: NativeControlProxy;
  attach(endpoint: NativeEndpoint, policy?: NativeAttachmentPolicy): () => void;
  endpoints(): readonly unknown[];
  close(): Promise<void>;
}
export interface NativeBinding { id: string; revision: number; active: boolean; policy: NativeAttachmentPolicy }
export interface NativeSessionSupervisor {
  readonly profile: { version: 1; profileId: string; applicationId: string; deviceId: string; definitionId: string; definitionVersion: string };
  readonly ownerInstanceId: string;
  readonly socketPath: string;
  readonly endpoint?: { readonly version: 1; readonly transport: 'unix-socket' | 'windows-named-pipe' | 'loopback-tcp'; readonly address?: string; readonly host?: '127.0.0.1'; readonly port?: number };
  readonly activeClients: number;
  close(): Promise<void>;
  endpoints(): readonly unknown[];
  bindings(): NativeBinding[];
  createBinding(options?: { id?: string; policy?: NativeAttachmentPolicy }): Promise<{ id: string; token: string; revision: number }>;
  rotateBinding(id: string, token?: string): Promise<{ id: string; token: string; revision: number }>;
  revokeBinding(id: string): Promise<void>;
}
export function createNativeAttachmentKey(): string;
export function createNativeSessionSupervisor(options: {
  directory: string; profileId: string;
  openOwner(options: { signal?: AbortSignal; profileId: string }): NativeSessionOwner | Promise<NativeSessionOwner>;
  bindings?: readonly { id: string; token: string; policy?: NativeAttachmentPolicy }[];
  maxClients?: number; maxClientsPerBinding?: number; maxBindings?: number; handshakeTimeoutMs?: number;
  preferredTransport?: 'auto' | 'loopback-tcp'; signal?: AbortSignal;
}): Promise<NativeSessionSupervisor>;
export interface NativeWorkspaceSupervisor extends Omit<NativeSessionSupervisor, 'profile' | 'ownerInstanceId' | 'endpoints'> {
  readonly workspaceId: string;
  /** Admit an opened page owner; its profile pins signer, application and definition. */
  addPage(pageId: string, owner: NativeSessionOwner): Promise<NativeSessionSupervisor['profile']>;
  removePage(pageId: string): Promise<boolean>;
  pages(): { page: string; profile: NativeSessionSupervisor['profile']; ownerInstanceId: string }[];
  endpoints(pageId: string): readonly unknown[];
}
/** One local attach socket for every page an agent workspace owns; clients name a page. */
export function createNativeWorkspaceSupervisor(options: {
  directory: string; workspaceId: string;
  bindings?: readonly { id: string; token: string; policy?: NativeAttachmentPolicy }[];
  maxClients?: number; maxClientsPerBinding?: number; maxBindings?: number; handshakeTimeoutMs?: number;
  preferredTransport?: 'auto' | 'loopback-tcp'; signal?: AbortSignal;
}): Promise<NativeWorkspaceSupervisor>;
export interface NativeAttachedSession { readonly signal: AbortSignal; detach(): Promise<void> }
/** Stable authenticated binding namespace; the supervisor separately enforces it. */
export interface NativeOperationScope { readonly scopeOperationId:(localOperationId:string)=>string }
export function attachNativeSession<Session extends NativeAttachedSession>(options: {
  directory: string; token: string;
  connect(endpoint: NativeEndpoint, options: { applicationId: string; definitionId: string; definitionVersion: string;
    context?: NativeAttachmentPolicy['context']; timeoutMs?: number; signal?: AbortSignal }): Promise<Session>;
  applicationId: string; definitionId: string; definitionVersion: string;
  /** Required for a workspace supervisor; omitted for a single-profile supervisor. */
  page?: string;
  context?: NativeAttachmentPolicy['context']; preserveOperationId?: boolean; timeoutMs?: number; signal?: AbortSignal;
}): Promise<{ session: Session&NativeOperationScope; control: NativeControlProxy; mode: 'attach'; transport: string; detach(): Promise<void> }>;
export function connectOrStartNativeSession<Session extends NativeAttachedSession>(options: {
  directory: string; profileId: string;
  openOwner(options: { signal?: AbortSignal; profileId: string }): NativeSessionOwner | Promise<NativeSessionOwner>;
  connect(endpoint: NativeEndpoint, options: { applicationId: string; definitionId: string; definitionVersion: string;
    context?: NativeAttachmentPolicy['context']; timeoutMs?: number; signal?: AbortSignal }): Promise<Session>;
  applicationId: string; definitionId: string; definitionVersion: string;
  bounded?: boolean; preferredTransport?: 'auto' | 'loopback-tcp';
  context?: NativeAttachmentPolicy['context']; timeoutMs?: number; signal?: AbortSignal;
}): Promise<{ session: Session; mode: 'attach' | 'shared-owner' | 'bounded'; startedSupervisor?: boolean; supervisor?: NativeSessionSupervisor; detach(): Promise<void>; close(): Promise<void> }>;

export interface NativeEffectRecord {
  effectId: string; payload: string; fence: unknown;
  status: 'dispatching' | 'outcomeUnknown' | 'completed';
  idempotencyKey?: string; receipt?: unknown; reason?: string;
}
export interface NativeEffectJournal {
  readonly applicationId: string; readonly providerId: string;
  idempotencyKey(effectId: string): string;
  transact<Value>(effectId: string, update: (previous: NativeEffectRecord | undefined) => { record: NativeEffectRecord; value: Value }): Promise<Value>;
  inspect(effectId: string): Promise<(NativeEffectRecord & { journalRevision: number; createdAt: number; updatedAt: number }) | null>;
  list(options?: { after?: string; limit?: number; status?: NativeEffectRecord['status'] }): Promise<{ records: NativeEffectRecord[]; next: string; hasMore: boolean }>;
  close(): Promise<void>;
}
export function createSqliteEffectJournal(options: {
  path: string; applicationId: string; providerId: string; maxRecords?: number; maxRecordBytes?: number;
}): Promise<NativeEffectJournal>;
