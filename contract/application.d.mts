/** Host selection is independent of a database's membership and authority keys. */
export type ApplicationSelection = { readonly kind: 'cloudflare'; readonly id: string } | { readonly kind: 'peer'; readonly id: string };
export interface ApplicationSubmitOptions { readonly operationId: string }
export interface ApplicationOperation {
  readonly operationId: string;
  readonly proposalId: string;
  /** Lifecycle and acceptance are independent: a final result can be rejected. */
  readonly status: 'queued' | 'provisional' | 'final';
  readonly outcome?: 'accepted' | 'rejected';
  readonly error?: string;
  readonly message?: string;
  readonly revision?: string;
}
export interface ApplicationOperations {
  get(operationId: string): ApplicationOperation | null | Promise<ApplicationOperation | null>;
  subscribe(options: { readonly operationId: string; readonly signal?: AbortSignal }): AsyncIterable<ApplicationOperation>;
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
export interface ApplicationEvents<Submission = unknown> {
  publish(topic: string, payload: unknown, options: ApplicationSubmitOptions): Promise<Submission>;
  read(options?: ApplicationEventReadOptions): Promise<ApplicationEventBatch>;
  /** Pulling the next batch is explicit backpressure; delivery is at least once. */
  subscribe(options?: ApplicationEventReadOptions): AsyncIterable<ApplicationEventBatch>;
}
export interface ApplicationReadView<QueryResult = unknown, Parameter = unknown> {
  readonly view: 'local' | 'final';
  readonly revision: string;
  readonly finalRevision: string;
  query(query: string, parameters?: readonly Parameter[]): QueryResult | Promise<QueryResult>;
  readEvents(options?: ApplicationEventReadOptions): ApplicationEventBatch | Promise<ApplicationEventBatch>;
  release(): void | Promise<void>;
}
export interface ApplicationChange {
  readonly view: 'local' | 'final';
  readonly revision: string;
  readonly finalRevision: string;
}
export interface ApplicationChangeOptions {
  readonly view?: 'local' | 'final';
  readonly signal?: AbortSignal;
}
/**
 * Tendriller's live collaboration contract, with local and settled views. A future
 * asynchronous branch/merge API has no finality and is not modeled by this interface.
 * One selected backend owns persistence, proposal identity, retries and application
 * interpretation. The host neither queues a second copy nor interprets programs.
 * Query/program grammar is explicit in capabilities; a JSON backend does not claim SQL.
 */
export interface ApplicationBackend<Program = unknown, Submission = unknown, QueryResult = unknown, Parameter = unknown> {
  readonly id: string;
  readonly capabilities: readonly string[];
  submit(program: Program, options: ApplicationSubmitOptions): Promise<Submission>;
  /** Current revision, then coalesced invalidations. Capture readView for data; no durable replay cursor. */
  changes(options?: ApplicationChangeOptions): AsyncIterable<ApplicationChange>;
  readView(options?: { readonly view?: 'local' | 'final' }): ApplicationReadView<QueryResult, Parameter> | Promise<ApplicationReadView<QueryResult, Parameter>>;
  readonly events: ApplicationEvents<Submission>;
  readonly operations: ApplicationOperations;
}
export interface ApplicationBinding {
  readonly selection: ApplicationSelection;
  readonly backend: ApplicationBackend;
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
export interface CloudflareApplicationSubmission {
  readonly operationId: string;
  readonly proposalId: string;
  readonly status: 'queued' | 'final';
  readonly outcome?: 'accepted' | 'rejected';
  readonly revision?: string;
  readonly error?: string;
  readonly message?: string;
}
export declare const APPLICATION_LIMITS: Readonly<{ programBytes: number; steps: number; events: number; eventBytes: number; topicLength: number; batchTransactions: number; historyBytes: number; historyTransactions: number }>;
export declare class ApplicationError extends Error { readonly code: string; constructor(code: string, message: string) }
export declare function applicationSelection(value?: unknown, defaultId?: string): ApplicationSelection;
export declare function createApplicationBinding(selection: ApplicationSelection, backend?: ApplicationBackend): ApplicationBinding;
export declare function assertApplicationTopic(topic: unknown): string;
export declare function assertApplicationOperationId(id: unknown): string;
export declare function validateApplicationOperation(value: unknown, operationId: string, options?: { readonly terminal?: boolean }): ApplicationOperation;
export declare function validateCloudflareProgram(program: unknown): CloudflareApplicationProgram;
export declare function applicationFilter(topics?: readonly string[]): readonly string[] | null;
/** Conversation messages are ordinary durable events with stable caller-owned IDs. */
export declare function publishConversation<Submission>(events: ApplicationEvents<Submission>, message: { readonly messageId: string; readonly text: string; readonly inReplyTo?: string }, options: ApplicationSubmitOptions): Promise<Submission>;
export declare function createCloudflareApplicationBackend(options: {
  readonly id: string;
  readonly request: (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<any>;
  /** A browser supplies its one durable outbox. Native callers preserve the original program and operationId. */
  readonly submit?: (program: CloudflareApplicationProgram, options: ApplicationSubmitOptions) => Promise<CloudflareApplicationSubmission>;
  /** Reuse the browser's existing socket; non-browser callers use bounded revision polling. */
  readonly onChange?: (notify: () => void) => () => void;
}): ApplicationBackend<CloudflareApplicationProgram, CloudflareApplicationSubmission, unknown, unknown>;
