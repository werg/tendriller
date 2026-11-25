export type ServerlessBytes = Uint8Array | ArrayBuffer;
export interface TransactionalStorageBackend {
  get(key: string): Promise<ServerlessBytes | null | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Keys under an externally held owner lock, or a DO-style snapshot of byte rows. */
  list?(): Promise<readonly string[] | ReadonlyMap<string, ServerlessBytes>>;
}
export type ServerlessOwnerLock = <T>(applicationId: string, work: () => Promise<T>, options: {readonly signal: AbortSignal}) => Promise<T>;
/** The four independent operation facts. `stored` is the default and waits for nothing. */
export type ServerlessOperationFact = 'stored' | 'materialized' | 'retained' | 'finalized';
/** Subset of the session's operation inspection that the adapter reads. */
export interface ServerlessSessionInspection {
  readonly applicationId: string;
  readonly author: string;
  readonly authorTimestampMs: string | null;
  readonly proposalId: string;
  readonly operationId: string;
  readonly stored: boolean;
  readonly pending: 'body' | 'key' | 'authority' | 'materializer' | null;
  readonly materialized: {
    readonly outcome: 'accepted' | 'rejected';
    readonly rejectionCode: string | null;
    readonly failingStatementIndex: number | null;
    readonly revision: {readonly digest: string; readonly view: 'local' | 'final'; readonly executionManifestDigest: string; readonly policyDigest: string};
  } | null;
  readonly retained: readonly {readonly payload: {readonly peer: string; readonly storageId: string}}[];
  readonly finalized: boolean;
  readonly excluded: boolean;
}
/** The session's ApplicationOperation handle. It is never serialized by the adapter. */
export interface ServerlessOperationHandle {
  inspect(): ServerlessSessionInspection;
  materialized(options?: {readonly signal?: AbortSignal; readonly timeoutMs?: number}): Promise<unknown>;
  retained(options?: {readonly signal?: AbortSignal; readonly timeoutMs?: number}): Promise<unknown>;
  finalized(options?: {readonly signal?: AbortSignal; readonly timeoutMs?: number}): Promise<unknown>;
}
/** Plain-data operation facts returned over HTTP. */
export interface ServerlessOperationFacts {
  readonly applicationId: string | null;
  readonly author: string | null;
  readonly authorTimestampMs: string | null;
  readonly proposalId: string | null;
  readonly operationId: string | null;
  readonly stored: boolean;
  readonly pending: string | null;
  readonly materialized: {
    readonly outcome: string | null;
    readonly rejectionCode: string | null;
    readonly failingStatementIndex: number | null;
    readonly revision: {readonly digest: string | null; readonly view: string | null; readonly executionManifestDigest: string | null; readonly policyDigest: string | null} | null;
  } | null;
  readonly retained: readonly {readonly peer: string | null; readonly storageId: string | null}[];
  readonly finalized: boolean;
  readonly excluded: boolean;
}
/** `uncertain` means the command was attempted but its durable storage reply was not observed. Inspect the original ID. */
export type ServerlessSubmission = 'not_submitted' | 'uncertain' | 'stored';
export interface ServerlessCommandResult {
  readonly operationId: string;
  readonly command: string;
  readonly submission: ServerlessSubmission;
  readonly wait?: ServerlessOperationFact;
  readonly operation?: ServerlessOperationFacts;
}
export interface ServerlessOwnedSession {
  readonly session: {
    /** Canonical result: {applicationId, revision, value}. */
    query(name: string, input: unknown): Promise<{readonly applicationId: string; readonly revision: unknown; readonly value: unknown}>;
    /** Resolves when the signed intent is durable in the owned store. */
    command(name: string, input: unknown, options: {readonly operationId: string}): Promise<ServerlessOperationHandle>;
    readonly operations: {get(operationId: string): ServerlessOperationHandle | null | Promise<ServerlessOperationHandle | null>};
    /** Optional; `finalityPolicy.kind === 'none'` makes finalized waits unsupported before submission. */
    readonly authority?: {readonly descriptor: {readonly finalityPolicy: {readonly kind: string}}};
    close?(): Promise<void> | void;
  };
  flush?(): Promise<void> | void;
  close?(): Promise<void> | void;
}
export interface ServerlessHostAdapterOptions {
  readonly applicationId: string;
  readonly storage: TransactionalStorageBackend;
  /** Must cover all isolates/processes sharing these bytes; held through flush and close. */
  readonly withLock: ServerlessOwnerLock;
  readonly authorize: (request: Request) => boolean | Promise<boolean>;
  /** Register physical execution with the host lifetime (for example ctx.waitUntil), before work starts. */
  readonly retainTask: (task: Promise<void>) => void;
  readonly openSession: (options: {readonly store: ReturnType<typeof createTransactionalBytesStore>; readonly signal: AbortSignal}) => Promise<ServerlessOwnedSession>;
  /** Whole-request response deadline, 1..120000 ms; default 30000. */
  readonly timeoutMs?: number;
  /** UTF-8 body/input limit, 1..1048576 bytes; default 65536. */
  readonly maxBodyBytes?: number;
}
/** Raw store; callers hold their storage-owner lock during each complete method. */
export declare function createTransactionalBytesStore(backend: TransactionalStorageBackend): {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  entries(): Promise<readonly {readonly key: string; readonly value: Uint8Array}[]>;
};
export declare function createServerlessHostAdapter(options: ServerlessHostAdapterOptions): {
  readonly applicationId: string;
  /** Public IO, including complete enumeration, takes the supplied owner lock. */
  readonly store: ReturnType<typeof createTransactionalBytesStore>;
  withActiveSession<T>(signal: AbortSignal | undefined, run: (owned: ServerlessOwnedSession, signal: AbortSignal) => Promise<T>): Promise<T>;
  handleRequest(request: Request): Promise<Response>;
};
