/** Application identity is independent from the page host and membership keys. */
export interface ApplicationSelection { readonly id: string }
export interface ApplicationSubmitOptions {
  readonly operationId: string;
  /** Captured applied revision used as an ordering barrier. */
  readonly basedOn?: string;
}
export interface ApplicationOperationIdentity { readonly operationId: string }
export interface ApplicationAttemptIdentity extends ApplicationOperationIdentity {
  readonly attemptId: string;
  readonly generation: string;
}
export interface AppliedApplicationOperation extends ApplicationAttemptIdentity {
  readonly status: 'applied';
  readonly author: string;
  readonly sequence: number;
  readonly outcome: 'accepted' | 'rejected';
  readonly rejectionCode: string | null;
}
/** Applied outcomes remain conditional on selected ancestry; sharing is separate retention evidence. */
export type ApplicationOperation =
  | (ApplicationAttemptIdentity & { readonly status: 'saved' })
  | AppliedApplicationOperation
  | (ApplicationAttemptIdentity & { readonly status: 'abandoned' | 'needsReapply'; readonly selectedGeneration: string; readonly previous: AppliedApplicationOperation | null });
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
export type ApplicationView = 'applied';
export interface ApplicationRevisionState { readonly view: 'applied'; readonly revision: string; readonly generation: string }
export type ApplicationReadView<QueryResult = unknown, Parameter = unknown> = ApplicationRevisionState & {
  query(query: string, parameters?: readonly Parameter[]): QueryResult | Promise<QueryResult>;
  readEvents(options?: ApplicationEventReadOptions): ApplicationEventBatch | Promise<ApplicationEventBatch>;
  release(): void | Promise<void>;
};
export interface ApplicationRecoveryNotice {
  readonly previousGeneration: string;
  readonly generation: string;
  readonly adopted: { readonly generation: string; readonly sequence: number; readonly root: string } | null;
  readonly revision: string;
  readonly abandoned: readonly ApplicationOperation[];
  readonly unknownLoss: boolean;
}
export type ApplicationChange = ApplicationRevisionState & {
  readonly kind?: 'update' | 'recovery';
  readonly recovery?: ApplicationRecoveryNotice;
};
export interface ApplicationChangeOptions { readonly view?: ApplicationView; readonly signal?: AbortSignal }
/** One application session owns commands, coherent applied views, operations and explicit recovery. */
export interface ApplicationBackend<Program = unknown, Submission extends ApplicationOperation = ApplicationOperation, QueryResult = unknown, Parameter = unknown> {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly status: ApplicationStatus;
  /** Reports current state once, then actual session changes; installs no polling. */
  onStatus(listener: (status: ApplicationStatus) => void): () => void;
  onRecovery(listener: (notice: ApplicationRecoveryNotice) => void): () => void;
  inspectRecovery(): Promise<readonly ApplicationRecoveryNotice[]>;
  submit(program: Program, options: ApplicationSubmitOptions): Promise<Submission>;
  /** Coalesced invalidations; capture readView for data. Recovery resets are explicit. */
  changes(options?: ApplicationChangeOptions): AsyncIterable<ApplicationChange>;
  readView(options?: { readonly view?: ApplicationView }): ApplicationReadView<QueryResult, Parameter> | Promise<ApplicationReadView<QueryResult, Parameter>>;
  readonly events: ApplicationEvents<Submission>;
  readonly operations: ApplicationOperations<Submission>;
}
export interface ApplicationStatus {
  readonly phase: 'ready' | 'waiting' | 'recovering' | 'awaiting-keys' | 'closed';
  /** Durable data lifecycle; protocol traffic and backend installation stay available while idle. */
  readonly database: 'idle' | 'opening' | 'ready' | 'failed' | 'closed';
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
  /** A page installs exactly one matching backend. There is no runtime failover. */
  install(backend: ApplicationBackend): void;
}
export declare class ApplicationError extends Error { readonly code: string; constructor(code: string, message: string) }
export declare function applicationSelection(value: unknown): ApplicationSelection;
export declare function createApplicationBinding(selection: ApplicationSelection, backend?: ApplicationBackend): ApplicationBinding;
export declare function assertApplicationTopic(topic: unknown): string;
export declare function assertApplicationOperationId(id: unknown): string;
export declare function applicationFilter(topics?: readonly string[]): readonly string[] | null;
/** Conversation messages are ordinary durable events with stable caller-owned IDs. */
export declare function publishConversation<Submission extends ApplicationOperation>(events: ApplicationEvents<Submission>, message: { readonly messageId: string; readonly text: string; readonly inReplyTo?: string }, options: ApplicationSubmitOptions): Promise<Submission>;
