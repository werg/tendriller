/** Host handle identity is independent from the application's data and publication grants. */
export interface ApplicationSelection { readonly id: string }
export interface ApplicationSubmitOptions { readonly operationId?: string; readonly authorTimestampMs?: bigint }
export interface ApplicationRevisionState {
  readonly digest: string;
  readonly view: 'local' | 'final';
  readonly executionManifestDigest: string;
  readonly policyDigest: string;
}
export interface MaterializedApplicationOperation {
  readonly proposalId: string;
  readonly revision: ApplicationRevisionState;
  readonly outcome: 'accepted' | 'rejected';
  readonly rejectionCode: string | null;
  readonly failingStatementIndex: number | null;
}
export interface ApplicationOperationInspection {
  readonly applicationId: string;
  readonly author: string;
  readonly authorTimestampMs: string | null;
  readonly proposalId: string;
  readonly operationId: string;
  readonly stored: boolean;
  readonly pending: 'body' | 'key' | 'authority' | 'materializer' | null;
  readonly materialized: MaterializedApplicationOperation | null;
  readonly retained: readonly unknown[];
  readonly finalized: boolean;
  readonly excluded: boolean;
}
export interface ApplicationWaitOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number }
export interface ApplicationOperation {
  readonly id: string;
  readonly operationId: string;
  readonly stored: true;
  inspect(): ApplicationOperationInspection | Promise<ApplicationOperationInspection>;
  materialized(options?: ApplicationWaitOptions): Promise<MaterializedApplicationOperation>;
  retained(options?: ApplicationWaitOptions): Promise<readonly unknown[]>;
  finalized(options?: ApplicationWaitOptions): Promise<MaterializedApplicationOperation>;
}
export interface ApplicationOperations {
  get(operationId: string): ApplicationOperation | null | Promise<ApplicationOperation | null>;
  /** Retry this original signer's retained signed proposal without minting or retimestamping work. */
  retry(operationId: string): Promise<ApplicationOperation>;
  subscribe(options: { readonly operationId: string; readonly signal?: AbortSignal }): AsyncIterable<ApplicationOperationInspection>;
}
export interface ApplicationEvent {
  readonly id: string;
  readonly proposalId: string;
  readonly operationId: string;
  readonly author: string;
  readonly authorTimestampMs: string;
  readonly topic: string;
  readonly payload: unknown;
}
/** Cursors are bound to the captured operation-set revision; changed projections require a fresh read. */
export interface ApplicationEventBatch { readonly revision: ApplicationRevisionState; readonly events: readonly ApplicationEvent[]; readonly cursor: string; readonly hasMore: boolean }
export interface ApplicationEventReadOptions { readonly cursor?: string; readonly topics?: readonly string[]; readonly limit?: number; readonly signal?: AbortSignal }
export interface ApplicationEvents {
  publish(topic: string, payload: unknown, options?: ApplicationSubmitOptions): Promise<ApplicationOperation>;
  read(options?: ApplicationEventReadOptions): Promise<ApplicationEventBatch>;
}
export type ApplicationView = 'local' | 'final';
export interface ApplicationReadView<QueryResult = unknown, Parameter = unknown> {
  readonly applicationId: string;
  readonly revision: ApplicationRevisionState;
  query(query: string, parameters?: readonly Parameter[]): QueryResult | Promise<QueryResult>;
  readEvents(options?: ApplicationEventReadOptions): ApplicationEventBatch | Promise<ApplicationEventBatch>;
  release(): void | Promise<void>;
}
export interface ApplicationChange {
  readonly kind: 'materialized' | 'finalized' | 'dependency';
  readonly revision: ApplicationRevisionState;
  readonly revisedProposalIds: readonly string[];
}
export interface ApplicationChangeOptions { readonly view?: ApplicationView; readonly signal?: AbortSignal }
export interface ApplicationStatus {
  readonly canAuthor: boolean;
  readonly phase: 'ready' | 'awaiting-keys' | 'closed';
  readonly database: 'idle' | 'opening' | 'ready' | 'failed' | 'closed';
  readonly connectedPeers: number;
  readonly pendingOperations: number;
  readonly materializationError: string | null;
}
/** Submission resolves only after the exact signed intent is durable locally, independent of network/finality. */
export interface ApplicationBackend<Program = unknown, QueryResult = unknown, Parameter = unknown> {
  readonly applicationId: string;
  readonly status: ApplicationStatus;
  readonly signal?: AbortSignal;
  onStatus(listener: (status: ApplicationStatus) => void): () => void;
  submit(input: ApplicationSubmitOptions & { readonly program: Program }): Promise<ApplicationOperation>;
  changes(options?: ApplicationChangeOptions): AsyncIterable<ApplicationChange>;
  readView(options?: { readonly view?: ApplicationView }): ApplicationReadView<QueryResult, Parameter> | Promise<ApplicationReadView<QueryResult, Parameter>>;
  readonly operations: ApplicationOperations;
}
export interface ApplicationBinding {
  readonly selection: ApplicationSelection;
  readonly backend: ApplicationBackend;
  readonly available: boolean;
  ready(): Promise<ApplicationBackend>;
  install(backend: ApplicationBackend): void;
}
export declare class ApplicationError extends Error { readonly code: string; constructor(code: string, message: string) }
export declare function applicationSelection(value: unknown): ApplicationSelection;
export declare function createApplicationBinding(selection: ApplicationSelection, backend?: ApplicationBackend): ApplicationBinding;
export declare function assertApplicationTopic(topic: unknown): string;
export declare function assertApplicationOperationId(id: unknown): string;
export declare function applicationFilter(topics?: readonly string[]): readonly string[] | null;
export declare function publishConversation(events: ApplicationEvents, message: { readonly messageId: string; readonly text: string; readonly inReplyTo?: string }, options?: ApplicationSubmitOptions): Promise<ApplicationOperation>;
