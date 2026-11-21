export interface TransactionalStorageBackend {
  get(key: string): Promise<Uint8Array | null | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  list?(): Promise<readonly string[]>;
}
export interface ServerlessHostAdapterOptions {
  readonly applicationId: string;
  readonly storage: TransactionalStorageBackend;
  readonly withLock?: <T>(applicationId: string, work: () => Promise<T>) => Promise<T>;
  readonly openSession: (options: { readonly store: ReturnType<typeof createTransactionalBytesStore>; readonly signal?: AbortSignal }) => Promise<{
    readonly session: {
      query(name: string, input: unknown): Promise<unknown>;
      command(name: string, input: unknown, options: { readonly operationId: string; readonly basedOn?: unknown }): Promise<{
        get(): Promise<unknown>;
        applied(options?: { readonly signal?: AbortSignal }): Promise<{ readonly outcome: 'accepted' | 'rejected' }>;
      }>;
      readonly operations: { get(operationId: string): Promise<unknown> };
      close?(): Promise<void> | void;
    };
    flush?(): Promise<void> | void;
    close?(): Promise<void> | void;
  }>;
  readonly authorize?: (request: Request) => boolean | Promise<boolean>;
}
export declare function createTransactionalBytesStore(backend: TransactionalStorageBackend): {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  entries(): Promise<readonly { readonly key: string; readonly value: Uint8Array }[]>;
};
export declare function createServerlessHostAdapter(options: ServerlessHostAdapterOptions): {
  readonly applicationId: string;
  readonly store: ReturnType<typeof createTransactionalBytesStore>;
  withActiveSession<T>(signal: AbortSignal | undefined, run: (owned: unknown) => Promise<T>): Promise<T>;
  handleRequest(request: Request): Promise<Response>;
};
