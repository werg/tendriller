import type { StreamAppend, StreamAppendResult, StreamBatch, StreamLatest, StreamTrim, StreamTrimResult, StreamCreate, StreamInfo, StreamReadOptions,
  Producer, ProducerCreate, ProducerResult } from "./streams.mjs";
export interface StreamsClient {
  streams: {
    list(): Promise<{ streams: StreamInfo[] }>;
    create(body: StreamCreate): Promise<StreamInfo>;
    info(stream: string): Promise<StreamInfo>;
    append(stream: string, body: StreamAppend): Promise<StreamAppendResult>;
    read(stream: string, options: StreamReadOptions): Promise<StreamBatch>;
    latest(stream: string, options?: { signal?: AbortSignal }): Promise<StreamLatest>;
    /** Agent only: discard retained records through an observed cursor, preserving newer appends and sequence numbers. */
    trim(stream: string, options: StreamTrim): Promise<StreamTrimResult>;
  };
  producers: {
    list(): Promise<{ producers: Producer[] }>;
    create(body: ProducerCreate): Promise<ProducerResult>;
    revoke(name: string): Promise<void>;
  };
}
export function streamReadQuery(options: StreamReadOptions): string;
export function createStreamsClient(request: (path: string, options?: Record<string, unknown>, responseSchema?: string) => Promise<unknown>): StreamsClient;
