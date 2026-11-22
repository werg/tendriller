export type ServerlessBytes = Uint8Array | ArrayBuffer;
export interface TransactionalStorageBackend {
  get(key: string): Promise<ServerlessBytes | null | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Keys under an externally held owner lock, or a DO-style snapshot of byte rows. */
  list?(): Promise<readonly string[] | ReadonlyMap<string, ServerlessBytes>>;
}
export type ServerlessOwnerLock = <T>(applicationId: string, work: () => Promise<T>, options: {readonly signal: AbortSignal}) => Promise<T>;
export interface ServerlessOperationState {
  readonly status?: 'saved' | 'applied' | 'abandoned' | 'needsReapply';
  readonly outcome?: 'accepted' | 'rejected';
}
export type ServerlessOperationLifecycle = 'not_submitted' | 'unknown' | 'recorded' | 'applied' | 'rejected' | 'abandoned' | 'needsReapply';
export interface ServerlessOwnedSession {
  readonly session: {
    query(name: string, input: unknown): Promise<unknown>;
    command(name: string, input: unknown, options: {readonly operationId: string; readonly basedOn?: unknown}): Promise<{
      get(): Promise<ServerlessOperationState>;
      applied(options?: {readonly signal?: AbortSignal}): Promise<ServerlessOperationState>;
    }>;
    readonly operations: {get(operationId: string): Promise<ServerlessOperationState | null>};
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
