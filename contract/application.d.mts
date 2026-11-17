/** Host selection is independent of a database's membership and authority keys. */
export type ApplicationSelection = { readonly kind: 'cloudflare'; readonly id: string } | { readonly kind: 'peer'; readonly id: string };
export interface ApplicationSubmitOptions {
  readonly operationId: string;
  /** Profile-supported ordering barrier. Unsupported profiles reject it; they never silently ignore it. */
  readonly basedOn?: string;
}
export interface ApplicationOperationIdentity { readonly operationId: string }
export interface FinalityOperationIdentity extends ApplicationOperationIdentity {
  readonly proposalId: string;
  readonly revision?: string;
}
/** Lifecycle and acceptance are independent; every executed result has an outcome. */
export type FinalityApplicationOperation = FinalityOperationIdentity & (
  | { readonly status: 'queued'; readonly outcome?: never; readonly error?: never; readonly message?: never }
  | { readonly status: 'provisional'; readonly outcome: 'accepted' | 'rejected'; readonly error?: string; readonly message?: string }
  | { readonly status: 'final'; readonly outcome: 'accepted' | 'rejected'; readonly error?: string; readonly message?: string }
);
export interface PeerOperationIdentity extends ApplicationOperationIdentity {
  readonly attemptId: string;
  readonly generation: string;
}
export interface AppliedApplicationOperation extends PeerOperationIdentity {
  readonly status: 'applied';
  readonly author: string;
  readonly sequence: number;
  readonly outcome: 'accepted' | 'rejected';
  readonly rejectionCode: string | null;
}
/** Applied outcomes remain conditional on selected ancestry; sharing is separate retention evidence. */
export type PeerGenerationApplicationOperation =
  | (PeerOperationIdentity & { readonly status: 'saved' })
  | AppliedApplicationOperation
  | (PeerOperationIdentity & { readonly status: 'abandoned' | 'needsReapply'; readonly selectedGeneration: string; readonly previous: AppliedApplicationOperation | null });
export type ApplicationOperation = FinalityApplicationOperation | PeerGenerationApplicationOperation;
export interface ApplicationOperations<Operation extends ApplicationOperation = ApplicationOperation> {
  get(operationId: string): Operation | null | Promise<Operation | null>;
  subscribe(options: { readonly operationId: string; readonly signal?: AbortSignal }): AsyncIterable<Operation>;
}
/** Backend-authenticated provenance, never copied from an application payload. */
export interface ApplicationEventOrigin {
  readonly kind: string;
  readonly authorId: string;
  readonly operationId: string;
}
export interface HostedApplicationEventOrigin extends ApplicationEventOrigin {
  readonly kind: 'hosted';
  readonly applicationId: string;
  readonly role: 'owner' | 'agent';
}
export interface ApplicationEvent {
  readonly id: string;
  readonly proposalId: string;
  readonly eventOrdinal: number;
  readonly topic: string;
  readonly payload: unknown;
  readonly origin: ApplicationEventOrigin;
}
export interface ApplicationEventTransaction { readonly proposalId: string; readonly events: readonly ApplicationEvent[] }
export interface ApplicationEventBatch {
  readonly transactions: readonly ApplicationEventTransaction[];
  /** Delivery progress. The consumer atomically commits its own state and processed cursor. */
  readonly scannedThrough: string;
  readonly hasMore: boolean;
  readonly revision: string;
}
export interface ApplicationEventReadOptions {
  readonly cursor?: string;
  readonly topics?: readonly string[];
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
export interface ApplicationEvents<Submission extends ApplicationOperation = ApplicationOperation> {
  publish(topic: string, payload: unknown, options: ApplicationSubmitOptions): Promise<Submission>;
  read(options?: ApplicationEventReadOptions): Promise<ApplicationEventBatch>;
  /** Pulling the next batch is explicit backpressure; delivery is at least once. */
  subscribe(options?: ApplicationEventReadOptions): AsyncIterable<ApplicationEventBatch>;
}
export type ApplicationView = 'local' | 'final' | 'applied';
export type ApplicationRevisionState =
  | { readonly view: 'local' | 'final'; readonly revision: string; readonly finalRevision: string }
  | { readonly view: 'applied'; readonly revision: string; readonly generation: string };
export type ApplicationReadView<QueryResult = unknown, Parameter = unknown> = ApplicationRevisionState & {
  query(query: string, parameters?: readonly Parameter[]): QueryResult | Promise<QueryResult>;
  readEvents(options?: ApplicationEventReadOptions): ApplicationEventBatch | Promise<ApplicationEventBatch>;
  release(): void | Promise<void>;
};
export type AppliedApplicationReadView<QueryResult = unknown, Parameter = unknown> = Extract<ApplicationReadView<QueryResult, Parameter>, { readonly view: 'applied' }>;
export interface ApplicationRecoveryNotice {
  readonly previousGeneration: string;
  readonly generation: string;
  readonly adopted: { readonly generation: string; readonly sequence: number; readonly root: string } | null;
  readonly revision: string;
  readonly abandoned: readonly PeerGenerationApplicationOperation[];
  readonly unknownLoss: boolean;
}
export type ApplicationChange = ApplicationRevisionState & {
  readonly kind?: 'update' | 'recovery';
  readonly recovery?: ApplicationRecoveryNotice;
};
export interface ApplicationChangeOptions { readonly view?: ApplicationView; readonly signal?: AbortSignal }
/**
 * One selected backend owns persistence, operation identity, retries and interpretation.
 * The installed adapter determines supported views and guarantees. The current
 * peer-generation-v1 binding exposes applied views without finalRevision; its results
 * can become abandoned at explicit recovery. Completion names alone do not promise
 * an immutable prefix or add view aliases to this interface.
 */
export interface ApplicationBackend<Program = unknown, Submission extends ApplicationOperation = ApplicationOperation, QueryResult = unknown, Parameter = unknown> {
  readonly id: string;
  readonly profile?: string;
  readonly capabilities: readonly string[];
  submit(program: Program, options: ApplicationSubmitOptions): Promise<Submission>;
  /** Coalesced invalidations; capture readView for data. Recovery resets are explicit. */
  changes(options?: ApplicationChangeOptions): AsyncIterable<ApplicationChange>;
  readView(options?: { readonly view?: ApplicationView }): ApplicationReadView<QueryResult, Parameter> | Promise<ApplicationReadView<QueryResult, Parameter>>;
  readonly events: ApplicationEvents<Submission>;
  readonly operations: ApplicationOperations<Submission>;
}
export interface PeerGenerationApplicationBackend<Program = unknown, QueryResult = unknown, Parameter = unknown>
  extends ApplicationBackend<Program, PeerGenerationApplicationOperation, QueryResult, Parameter> {
  readonly profile: 'peer-generation-v1';
  readonly status: PeerApplicationStatus;
  /** Reports current state once, then actual session changes; installs no polling. */
  onStatus(listener: (status: PeerApplicationStatus) => void): () => void;
  readonly operations: ApplicationOperations<PeerGenerationApplicationOperation>;
  readView(options?: { readonly view?: ApplicationView }): AppliedApplicationReadView<QueryResult, Parameter> | Promise<AppliedApplicationReadView<QueryResult, Parameter>>;
  onRecovery(listener: (notice: ApplicationRecoveryNotice) => void): () => void;
  inspectRecovery(): Promise<readonly ApplicationRecoveryNotice[]>;
}
export interface PeerApplicationStatus {
  readonly phase: 'ready' | 'waiting' | 'recovering' | 'awaiting-keys' | 'closed';
  readonly role: 'coordinator' | 'follower';
  readonly generation: string;
  readonly coordinator: string;
  readonly connectedPeers: number;
}
export interface ApplicationBinding {
  readonly selection: ApplicationSelection;
  readonly backend: ApplicationBackend;
  /** Installation availability only; this does not claim synchronization or coordinator reachability. */
  readonly available: boolean;
  ready(): Promise<ApplicationBackend>;
  /** A peer page installs exactly one matching backend. There is no runtime failover. */
  install(backend: ApplicationBackend): void;
}
export type ApplicationJson = null | boolean | number | string | ApplicationJson[] | { [key: string]: ApplicationJson };
export type CloudflareApplicationStep = { readonly kind: 'state'; readonly ops: readonly import('./index.mjs').StateOperation[]; readonly conditions?: readonly import('./index.mjs').StateCondition[]; readonly expected_revision?: number }
  | { readonly kind: 'emit'; readonly topic: string; readonly payload: ApplicationJson };
export interface CloudflareApplicationProgram {
  readonly version: 1;
  readonly steps: readonly CloudflareApplicationStep[];
  readonly scope?: string;
  readonly expected_generations: Readonly<Record<string, string>>;
}
export type CloudflareApplicationSubmission = Exclude<FinalityApplicationOperation, { readonly status: 'provisional' }>;
export declare const APPLICATION_LIMITS: Readonly<{ programBytes: number; steps: number; events: number; eventBytes: number; topicLength: number; batchTransactions: number; historyBytes: number; historyTransactions: number }>;
export declare class ApplicationError extends Error { readonly code: string; constructor(code: string, message: string) }
export declare function applicationSelection(value?: unknown, defaultId?: string): ApplicationSelection;
export declare function createApplicationBinding(selection: ApplicationSelection, backend?: ApplicationBackend): ApplicationBinding;
export declare function assertApplicationTopic(topic: unknown): string;
export declare function assertApplicationOperationId(id: unknown): string;
export declare function validateApplicationOperation(value: unknown, operationId: string, options?: { readonly terminal?: boolean }): FinalityApplicationOperation;
export declare function validateCloudflareProgram(program: unknown): CloudflareApplicationProgram;
export declare function applicationFilter(topics?: readonly string[]): readonly string[] | null;
/** Conversation messages are ordinary durable events with stable caller-owned IDs. */
export declare function publishConversation<Submission extends ApplicationOperation>(events: ApplicationEvents<Submission>, message: { readonly messageId: string; readonly text: string; readonly inReplyTo?: string }, options: ApplicationSubmitOptions): Promise<Submission>;
export declare function createCloudflareApplicationBackend(options: {
  readonly id: string;
  readonly request: (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<any>;
  /** A browser supplies its one durable outbox. Native callers preserve the original program and operationId. */
  readonly submit?: (program: CloudflareApplicationProgram, options: ApplicationSubmitOptions) => Promise<CloudflareApplicationSubmission>;
  /** Reuse the browser's existing socket; non-browser callers use bounded revision polling. */
  readonly onChange?: (notify: () => void) => () => void;
}): ApplicationBackend<CloudflareApplicationProgram, CloudflareApplicationSubmission, unknown, unknown>;
