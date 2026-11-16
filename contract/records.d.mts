export declare const RECORD_LOG_FORMAT: "record-log/v1";
export declare const RECORD_LOG_LIMITS: Readonly<{ recordBytes: number; readEntries: number; readBytes: number; totalBytes: number; records: number }>;
export declare class RecordLogError extends Error { readonly code: string; readonly status: number; constructor(code: string, message: string, status?: number); }
export interface RecordLogDescriptor { historyId: string; format: typeof RECORD_LOG_FORMAT; limits: typeof RECORD_LOG_LIMITS }
export interface RecordLogHead { historyId: string; position: number; root: string; bytes: number }
/** An immutable retained entry. `record` is canonical padded base64 of exact bytes. */
export interface RecordLogEntry { historyId: string; position: number; recordId: string; previousRoot: string; root: string; record: string }
export interface RecordLogInfo { descriptor: RecordLogDescriptor; head: RecordLogHead }
export interface RecordLogPage { historyId: string; after: number; cursor: number; entries: RecordLogEntry[]; head: RecordLogHead }
export declare function recordHistoryId(value: unknown): string;
export declare function recordPosition(value: unknown, name?: string): number;
export declare function recordBytes(value: unknown): Uint8Array<ArrayBuffer>;
export declare function encodeRecord(value: Uint8Array): string;
export declare function decodeRecord(value: unknown): Uint8Array<ArrayBuffer>;
export declare function recordId(bytes: Uint8Array): Promise<string>;
export declare function recordGenesisRoot(historyId: string): Promise<string>;
export declare function recordEntryRoot(historyId: string, position: number, previousRoot: string, id: string): Promise<string>;
export declare function validateRecordHead(value: unknown, historyId?: string): RecordLogHead;
export declare function verifyRecordEntry(value: unknown, previous?: RecordLogHead): Promise<Uint8Array<ArrayBuffer>>;
export interface RecordLogClient {
  provision(options?: { signal?: AbortSignal }): Promise<RecordLogInfo>;
  info(options?: { historyId?: string; signal?: AbortSignal }): Promise<RecordLogInfo>;
  /** Persists exact bytes. An uncertain response is retried with the same bytes and history. */
  append(bytes: Uint8Array, options: { historyId: string; signal?: AbortSignal }): Promise<RecordLogEntry>;
  read(options: { historyId: string; after: number; limit?: number; previous?: RecordLogHead; signal?: AbortSignal }): Promise<RecordLogPage>;
  /** Wake-up hints only: read retained entries and maintain your own durable applied cursor. */
  watch(options: { historyId: string; after: number; signal?: AbortSignal; pollIntervalMs?: number; onError?: (error: Error) => void }, listener: (head: RecordLogHead) => void): () => void;
}
export interface RecordLogClientOptions {
  base: string; headers?: () => Record<string, string>; fetch?: typeof globalThis.fetch;
  /** Existing connection notifications, including reconnect. The payload is only a hint. */
  subscribeHints?: (listener: () => void) => (() => void);
}
export declare function createRecordLogClient(options: RecordLogClientOptions): RecordLogClient;
