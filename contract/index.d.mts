import type { WireContracts } from "./wire.mjs";
import type { BrowserStreams, StreamRecord, StreamHistory } from "./streams.mjs";
export type { WireContracts } from "./wire.mjs";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ValidationIssue { path: string; message: string }
export type PublicError = WireContracts["error"];
export type ErrorResponse = WireContracts["errorResponse"];
export type Role = DeviceInfo["role"];
export type DevicePurpose = DeviceInfo["purpose"];
export type Path = string | (string | number)[];
export type StateOperation = WireContracts["stateOperation"];
export type CreateRequest = WireContracts["create"];
export type SayRequest = WireContracts["say"];
/** Per-device delivery can speak without presenting a second visible message. */
export interface SayMessage extends SayRequest { t?: "say"; message_id?: string; ts?: number; present?: boolean }
export type BlobReference = WireContracts["blobReference"];
export type SendResult = WireContracts["sendResult"];
export type CaptureOptions = WireContracts["captureOptions"] & OperationOptions;
export type CaptureResult = WireContracts["captureResult"];
export interface PendingCapture extends OperationOptions { capture_id: string; name?: string; data: Record<string, unknown>; status: "queued" | "rejected"; blob?: BlobReference; error?: string; message?: string }
export type PublicEvent<T = unknown> = WireContracts["event"] & { data: T };
export type DeliveryProbe = WireContracts["deliveryProbe"];
export interface InstructionEvent extends PublicEvent<{ text: string; via: "text" | "voice" }> { type: "instruction"; role: "owner" }
export interface Device { id: string; role: Role; name: string; pending: boolean; purpose?: DevicePurpose; pairCode?: string }
export type DeviceInfo = WireContracts["deviceInfo"];
export type DeviceUpdate = WireContracts["deviceUpdate"];
export type Focus = WireContracts["focus"];
export type FocusRequest = WireContracts["focusRequest"];
export type DeviceConfiguration = WireContracts["deviceConfiguration"];
/** Guest/display broadcasts expose only each device's identity and presentation. */
export interface DevicePresentation { id: string; purpose: DevicePurpose }
export interface DeviceConfigMessage { t?: "device_config"; devices: (DeviceInfo | DevicePresentation)[]; focus: Focus | null }
export interface Presence { state: "listening" | "working" | "done" | "scheduled" | "not_responding" | "away" | "no_agent"; text: string; last_seen: number | null; schedule_minutes: number | null; withheld: number; wake: "long_poll" | "webhook" | "schedule" | "none" }
export interface TranscriptEntry { ts: number; from: "agent" | "user"; text: string; message_id?: string; in_reply_to?: number }
export interface StateApi<T = Record<string, unknown>> {
  readonly revision: number;
  get(): T; get(path: Path): unknown;
  set(path: Path, value: unknown, options?: OperationOptions): Promise<StateResult>;
  delete(path: Path, options?: OperationOptions): Promise<StateResult>;
  patch(mergePatch: object, options?: OperationOptions): Promise<StateResult>;
  on(fn: (state: T, ops: StateOperation[], by: string) => void): () => void;
}
/** Core presentation settings for this browser device and page, separate from shared application state. */
export interface RuntimePreferences {
  audio: boolean; language: string | null; voice: "browser" | "neural";
  textSize: "normal" | "large" | "x-large"; contrast: "normal" | "high"; mode: "interactive" | "display";
}
export interface PreferencesApi {
  get(): RuntimePreferences;
  update(patch: Partial<RuntimePreferences>): void;
  on(listener: (preferences: RuntimePreferences) => void): () => void;
}
export type SessionBrief = WireContracts["session"];
export type SessionWrite = WireContracts["sessionWrite"];
export type SessionResult = WireContracts["sessionResult"];
export type SessionSummary = WireContracts["sessionSummary"];
export type TimerRepeat = WireContracts["timerRepeat"];
export type DurableTimer = WireContracts["timer"];
export type TimerWrite = WireContracts["timerWrite"];
export type CreateTimer = WireContracts["timerCreate"];
export type TimerRun = WireContracts["timerRun"];
export type PortableBundle = WireContracts["bundle"];
export type BundleStageResult = WireContracts["bundleStage"];
export type BundlePublish = WireContracts["bundlePublish"];
export type RemixRequest = WireContracts["remix"];
export type RemixPageRequest = WireContracts["remixPage"];
/** Platform concurrency metadata never belongs inside application data. */
export interface OperationOptions { scope?: string; expected_generations?: Record<string, string> }
export interface ScopeDescriptor { id: string; generation: string; paths: string[][]; operations: string[] }
export type StateResult = { status: "accepted"; rev: number }
  | { status: "queued" }
  | { status: "rejected"; error: string; message?: string };
export type ServiceDescriptor = WireContracts["serviceDescriptor"];
export interface PublicationAsset { path: string; sha256: string; type: string }
export interface RuntimeArtifactFeatures {
  speech: { model: string; url: string; sha256: string; engine: { script: string; wasm: string; wasm_sha256: string } } | null;
}
export interface PublicationManifest {
  id: string; base: string; entry?: string;
  runtime: { version: string; id?: string; base: string; assets?: PublicationAsset[]; features?: RuntimeArtifactFeatures };
  assets: PublicationAsset[];
}
export interface RuntimeFrame { t: string; [key: string]: unknown }
/** Deliberately small transport interface; fixtures use the production runtime. */
export interface RuntimeSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void; close(code?: number, reason?: string): void;
}
export interface FixtureTransport {
  socket(url?: string): RuntimeSocket;
  receive(frame: RuntimeFrame): void;
  emit(event: string, data: unknown): void;
  onSend(listener: (frame: RuntimeFrame, reply: (frame: RuntimeFrame) => void) => void): () => void;
  disconnect(): void;
}
export interface RuntimeEventMap {
  connect: void; disconnect: void; role: Pick<Device, "role" | "pending">; presence: Presence;
  say: SayMessage; transcript: TranscriptEntry | null;
  upload_event: CaptureResult; error: { code?: string; message?: string };
  send_result: SendResult & OperationOptions & { cid: string; data: unknown };
  capture_queue: PendingCapture[]; capabilities: CapabilityReport; tts: SpeechStatus;
  device_config: DeviceConfigMessage;
  scopes: ScopeDescriptor[];
  workflow: { module: string; topic: string; [key: string]: unknown };
  preferences: RuntimePreferences;
  state_result: StateResult & OperationOptions & { cid: string };
  reload: { version: number }; [key: string]: unknown;
  stream_record: StreamRecord;
  stream_gap: { stream: string; history: StreamHistory };
  stream_error: { stream: string; error: Error & { code?: string } };
}
export interface SpeechStatus { enabled: boolean; state: "idle" | "loading" | "ready" | "error"; message: string }
export interface SpeechOutput {
  readonly status: SpeechStatus;
  stop(): void; enable(): Promise<void>; disable(): void; speak(text: string): void;
}
export interface Capability { available: boolean; permission: "granted" | "prompt" | "denied" | "unknown"; needs_user_tap: boolean; active: boolean | null; note?: string }
export interface CapabilityReport { captured_at: number; secure: boolean; device: string; capabilities: Record<string, Capability> }
export interface RuntimeApi<T = Record<string, unknown>> {
  send(data: unknown, opts?: OperationOptions & { wake?: boolean }): Promise<SendResult>;
  request<T = unknown>(path: string, options?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }): Promise<T>;
  scopes: { list(): ScopeDescriptor[]; capture(scope: string): OperationOptions };
  readonly service: ServiceDescriptor | null;
  conversation: { entries(): TranscriptEntry[]; send(text: string, options?: { via?: "text" | "voice" }): Promise<{ status: "accepted" | "queued"; cid: string }> };
  blobUrl(id: string): string;
  upload(blob: Blob, opts?: { name?: string; keep?: boolean }): Promise<BlobReference>;
  uploadEvent(blob: Blob, options: CaptureOptions): Promise<CaptureResult>;
  /** Durable local work retained until its acknowledgement. */
  pendingWork(): { events: number; state: number; captures: number };
  captures(): PendingCapture[]; retryCapture(captureId: string): Promise<CaptureResult>; discardCapture(captureId: string): Promise<void>;
  setBlobRetention(id: string, options: { keep: boolean }): Promise<BlobReference>;
  state: StateApi<T>;
  preferences: PreferencesApi;
  streams: BrowserStreams;
  on<K extends keyof RuntimeEventMap & string>(type: K, fn: (payload: RuntimeEventMap[K]) => void): () => void;
  ready: (() => void) & { manual(): void };
  speak(text: string): void; tts: SpeechOutput;
  capabilities(): Promise<CapabilityReport>; deviceHeaders(): Record<string, string>;
  device: Device; readonly version: number; readonly connected: boolean; readonly presence: Presence | null;
  control: { hide(): void; show(): void; position(p: "bottom-right" | "bottom-left" | "top-right" | "top-left"): void };
}
export type { EventConsumer, ConsumerClaim, ConsumerLease, ConsumerRenew, ConsumerAck, ConsumerBatch, TimerDelivery } from "./durability.mjs";
export type { StreamInfo, StreamCreate, StreamInput, StreamAppend, StreamRecord, StreamBatch, StreamLatest, StreamTrim, StreamTrimResult, StreamHistory,
  StreamAppendResult, StreamReadOptions, StreamSubscribeOptions, BrowserStreams, Producer, ProducerCreate, ProducerResult } from "./streams.mjs";
export { STREAM_RECORD_BYTES, STREAM_SNAPSHOT_RECORD_BYTES } from "./streams.mjs";
export type Contracts = WireContracts;
export const CONTRACT_VERSION: 2;
export const CORE_RELEASE: "0.2.0-rc.2";
export { RESOURCE_LIMITS, STREAM_LIMITS, streamRecordLimit } from "./limits.mjs";
export const ROLES: readonly Role[];
export const DEVICE_PURPOSES: readonly DevicePurpose[];
export const schemas: Readonly<Record<keyof Contracts, Record<string, any>>>;
export const schemaDocument: Readonly<{ $schema: string; $id: string; title: string; $defs: typeof schemas }>;
export function validateSchema(schema: Record<string, any>, value: unknown, path?: string): ValidationIssue[];
export function validate<K extends keyof Contracts>(name: K, value: unknown): ValidationIssue[];
export function assertValid<K extends keyof Contracts>(name: K, value: unknown): Contracts[K];
export class ContractError extends TypeError { code: "bad_request"; issues: ValidationIssue[]; constructor(issues: ValidationIssue[]) }
