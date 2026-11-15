import type { WireContracts } from "./wire.mjs";
export const STREAM_RECORD_BYTES: 65536;
export const STREAM_SNAPSHOT_RECORD_BYTES: 196608;
export type StreamInfo = WireContracts["streamInfo"];
export type StreamCreate = WireContracts["streamCreate"];
export type StreamInput = WireContracts["streamInput"];
export type StreamAppend = WireContracts["streamAppend"];
export type StreamRecord = WireContracts["streamRecord"];
export type StreamBatch = WireContracts["streamBatch"];
export type StreamLatest = WireContracts["streamLatest"];
export type StreamTrim = WireContracts["streamTrim"];
export type StreamTrimResult = WireContracts["streamTrimResult"];
export type StreamHistory = WireContracts["streamHistory"];
export type StreamAppendResult = WireContracts["streamAppendResult"];
export type Producer = WireContracts["producer"];
export type ProducerCreate = WireContracts["producerCreate"];
export type ProducerResult = WireContracts["producerResult"];
export interface StreamReadOptions { after: number; limit?: number; signal?: AbortSignal }
export interface StreamSubscribeOptions {
  /** Omit for live updates only. Durable streams resume in memory on reconnect. */
  after?: number;
  /** Retention gaps are surfaced before the available records are delivered. */
  onGap?: (history: StreamHistory) => void;
  onError?: (error: Error & { code?: string }) => void;
}
export interface BrowserStreams {
  list(): Promise<{ streams: StreamInfo[] }>;
  info(stream: string): Promise<StreamInfo>;
  read(stream: string, options: StreamReadOptions): Promise<StreamBatch>;
  /** Latest retained snapshot and a high-water cursor for subsequent subscription. */
  latest(stream: string, options?: { signal?: AbortSignal }): Promise<StreamLatest>;
  /** Callbacks run synchronously; this is a delivery cursor, not a handled checkpoint. */
  subscribe(stream: string, handler: (record: StreamRecord) => void, options?: StreamSubscribeOptions): () => void;
  /** Requires a connected page; never silently queues stream records offline. */
  publish(stream: string, body: StreamAppend): Promise<StreamAppendResult>;
}
export const streamSchemas: Readonly<Record<string, Record<string, any>>>;
