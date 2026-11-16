export declare const RECORD_LOG_FORMAT: "tendriller.record-log.v1";
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
