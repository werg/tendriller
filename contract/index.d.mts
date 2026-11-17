import type { WireContracts } from "./wire.mjs";
import type { BrowserStreams, StreamRecord, StreamHistory } from "./streams.mjs";
import type { RecordLogClient, RecordLogHead } from "./records.mjs";
export type { WireContracts } from "./wire.mjs";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ValidationIssue { path: string; message: string }
export type PublicError = WireContracts["error"];
export type ErrorResponse = WireContracts["errorResponse"];
export type Role = DeviceInfo["role"];
export type DevicePurpose = DeviceInfo["purpose"];
export type Path = string | (string | number)[];
export type StateOperation = WireContracts["stateOperation"];
export type NormalizedStateOperation = StateOperation & { path: string[] };
export type StateCondition = { path: Path; equals: unknown; exists?: never } | { path: Path; exists: boolean; equals?: never };
export interface StateChecks { conditions?: StateCondition[]; expected_revision?: number }
export interface StateWriteOptions extends OperationOptions, StateChecks {}
export interface StateConflict { kind: "revision" | "condition" | "path"; condition?: number; path?: string[] }
export interface StateSnapshot<T = Record<string, unknown>> { state: T; rev: number; scopes: ScopeDescriptor[] }
export interface PendingStateCommand extends StateWriteOptions {
  cid: string; ops: NormalizedStateOperation[]; expected_generations: Record<string, string>; status: "queued";
}
export type CreateRequest = WireContracts["create"];
export type SayRequest = WireContracts["say"];
/** Per-device delivery can speak without presenting a second visible message. */
export interface SayMessage extends SayRequest { t?: "say"; message_id: string; ts: number; present?: boolean }
export type BlobReference = WireContracts["blobMetadata"];
export type BlobUploadStart = WireContracts["uploadStart"];
export type BlobUploadSession = WireContracts["uploadSession"];
export type BlobUploadCompletion = WireContracts["uploadCompletion"];
export type SharedFileHead = WireContracts["fileHead"];
export type SharedFileSnapshot = WireContracts["fileSnapshot"];
export type SharedFileWrite = WireContracts["fileWrite"];
export type SharedFileDelete = WireContracts["fileDelete"];
export type PagePublicationWrite = WireContracts["publicationWrite"];
export type PagePublicationRollback = WireContracts["publicationRollback"];
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
export interface Presence { state: "listening" | "working" | "done" | "scheduled" | "not_responding" | "away" | "no_agent"; text: string; last_seen: number | null; schedule_minutes: number | null; withheld: number; wake: "socket" | "webhook" | "schedule" | "none" }
export interface TranscriptEntry { ts: number; from: "agent" | "user"; text: string; message_id?: string; in_reply_to?: number; cid?: string; device?: string; status?: "queued" | "accepted" | "rejected"; error?: string; message?: string }
export type ConversationResult = { cid: string } & ({ status: "queued" } | { status: "accepted"; seq?: number } | { status: "rejected"; error: string; message: string });
export interface StateApi<T = Record<string, unknown>> {
  readonly revision: number;
  get(): T; get(path: Path): unknown;
  /** Read a coherent server snapshot while connected; does not flush pending writes or replace the local view. */
  snapshot(): Promise<StateSnapshot<T>>;
  /** Detached commands already admitted to this device's durable outbox. */
  pending(): PendingStateCommand[];
  apply(ops: StateOperation[], options?: StateWriteOptions): Promise<StateResult>;
  set(path: Path, value: unknown, options?: StateWriteOptions): Promise<StateResult>;
  delete(path: Path, options?: StateWriteOptions): Promise<StateResult>;
  patch(mergePatch: object, options?: StateWriteOptions): Promise<StateResult>;
  on(fn: (state: T, ops: StateOperation[], by: string) => void): () => void;
}
export type SessionBrief = WireContracts["session"];
export type SessionWrite = WireContracts["sessionWrite"];
export type SessionResult = WireContracts["sessionResult"];
export type SessionSummary = WireContracts["sessionSummary"];
export type TimerRepeat = WireContracts["timerRepeat"];
export type DurableTimer = WireContracts["timer"];
export type TimerWrite = WireContracts["timerWrite"];
export type CreateTimer = WireContracts["timerCreate"];
export type TimerDelete = WireContracts["timerDelete"];
export type TimerDeleted = WireContracts["timerDeleted"];
export type TimerRun = WireContracts["timerRun"];
/** Browser authors supply timer settings; the runtime owns command identity. */
export type TimerSettings = Omit<CreateTimer, "cid" | "scope" | "expected_generations">;
export type TimerChanges = Omit<TimerWrite, "cid" | "scope" | "expected_generations" | "expected_revision">;
export type TimerRevisionOptions = OperationOptions & { expected_revision: number };
export type TimerMutationResult<T = DurableTimer | TimerDeleted> = { cid: string } & (
  { status: "queued" } | { status: "accepted"; value: T }
  | { status: "rejected"; error: string; message: string; details?: PublicError }
);
/** The exact original command, including the guards captured before persistence. */
export type TimerIntent = { operation: "create"; command: CreateTimer }
  | { operation: "update"; id: string; command: TimerWrite }
  | { operation: "remove"; id: string; command: TimerDelete };
export type PendingTimerCommand = TimerIntent & { cid: string; status: "queued" };
export type TimerResultEvent = (Extract<TimerIntent, { operation: "create" | "update" }> & TimerMutationResult<DurableTimer>)
  | (Extract<TimerIntent, { operation: "remove" }> & TimerMutationResult<TimerDeleted>);
export interface BrowserTimers {
  list(): Promise<WireContracts["timerList"]>;
  history(): Promise<WireContracts["timerHistory"]>;
  create(settings: TimerSettings, context?: OperationOptions): Promise<TimerMutationResult<DurableTimer>>;
  update(id: string, changes: TimerChanges, context: TimerRevisionOptions): Promise<TimerMutationResult<DurableTimer>>;
  remove(id: string, context: TimerRevisionOptions): Promise<TimerMutationResult<TimerDeleted>>;
  /** Local commands still awaiting a durable terminal receipt; never a server timer list. */
  pending(): PendingTimerCommand[];
}
export type PortableBundle = WireContracts["bundle"];
export type BundleStageResult = WireContracts["bundleStage"];
export type BundlePublish = WireContracts["bundlePublish"];
export type BundleReceipt = WireContracts["bundleReceipt"];
export type RemixRequest = WireContracts["remix"];
export type RemixPageRequest = WireContracts["remixPage"];
/** Platform concurrency metadata never belongs inside application data. */
export interface OperationOptions { scope?: string; expected_generations?: Record<string, string> }
export interface ScopeDescriptor { id: string; generation: string; paths: string[][]; operations: string[] }
export type StateResult = { status: "accepted"; cid: string; rev: number }
  | { status: "queued"; cid: string }
  | { status: "rejected"; cid?: string; error: string; message?: string; rev?: number; conflict?: StateConflict }
  | { status: "unchanged"; rev: number };
export type StateResultEvent = Exclude<StateResult, { status: "unchanged" }> & StateWriteOptions & { cid: string; ops: NormalizedStateOperation[] };
export type ServiceDescriptor = WireContracts["serviceDescriptor"];
export interface PublicationAsset { path: string; sha256: string; type: string }
export interface RuntimeArtifactFeatures {
  speech: { model: string; url: string; sha256: string; engine: { script: string; wasm: string; wasm_sha256: string } } | null;
}
export interface PublicationManifest {
  id: string; base: string;
  /** Canonical authored root entry, identical for every document in this publication. */
  entry: string;
  runtime: { version: string; id?: string; base: string; assets?: PublicationAsset[]; features?: RuntimeArtifactFeatures };
  assets: PublicationAsset[];
}
export type RuntimeConfiguration = {
  id: string; base: string; version: number; ws: string;
  features: RuntimeArtifactFeatures & { push: boolean; vapid: string | null; shared_by: string };
  preview?: boolean;
  application?: import("./application.mjs").ApplicationSelection;
  /** Public resident introduction addresses supplied with the initial page. */
  peerBootstrap?: import("./peers.mjs").PeerBootstrap;
  /** Signed code selection is independent of the application's recoverable data history. */
  peerRelease?: import('./releases.mjs').ReleaseBootstrap;
} & (
  /** Decoded logical path of this document, independently of the publication's root entry. */
  { publication: PublicationManifest; documentPath: string }
  | { publication?: undefined; documentPath: null }
);
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
export interface RuntimeLocalEventMap {
  ready: void; application_ready: void;
  capabilities: CapabilityReport;
  sensors: SensorStatus; sensors_stopped: { count: number };
}
export interface RuntimeEventMap extends RuntimeLocalEventMap {
  connect: void; disconnect: void; role: Pick<Device, "role" | "pending">; presence: Presence;
  say: SayMessage; transcript: TranscriptEntry | null;
  upload: Omit<BlobReference, "name"> & { cid: string; name: string | null };
  upload_event: CaptureResult; error: { code?: string; message?: string };
  send_result: SendResult & OperationOptions & { cid: string; data: unknown };
  capture_queue: PendingCapture[]; capabilities: CapabilityReport;
  conversation_result: ConversationResult & { text: string };
  reply: SayMessage; sensors: SensorStatus; sensors_stopped: { count: number };
  device_config: DeviceConfigMessage;
  scopes: ScopeDescriptor[];
  workflow: { module: string; topic: string; [key: string]: unknown };
  state_result: StateResultEvent;
  state_queue: PendingStateCommand[];
  timer_result: TimerResultEvent; timer_queue: PendingTimerCommand[];
  reload: { version: number }; [key: string]: unknown;
  stream_record: StreamRecord;
  record_log_head: RecordLogHead;
  application_operation: import("./application.mjs").ApplicationOperation;
  application_revision: { revision: string };
  stream_gap: { stream: string; history: StreamHistory };
  stream_error: { stream: string; error: Error & { code?: string } };
}
export type SensorKind = "camera" | "microphone" | "screen" | "location" | "motion";
export interface SensorStatus {
  /** Observed live resources, registered watches/listeners, or a recent location fix. */
  active: SensorKind[];
  /** Wrapped media acquisitions and one-shot location reads awaiting a native result. */
  pending: SensorKind[];
}
export interface NotificationStatus { permission: NotificationPermission | "unsupported"; subscribed: boolean; registered: boolean; reason?: string }
export interface NotificationsApi {
  readonly available: boolean; readonly reason?: string;
  status(): Promise<NotificationStatus>;
  /** Call from a user gesture. Permission is owned by this browser device. */
  subscribe(): Promise<boolean>; unsubscribe(): Promise<void>;
  test(): Promise<{ sent: number; failed: number; status?: number | null; reason?: string }>;
}
export interface Capability { available: boolean; permission: "granted" | "prompt" | "denied" | "unknown"; needs_user_tap: boolean; active: boolean | null; note?: string }
export interface CapabilityReport { captured_at: number; secure: boolean; device: string; capabilities: Record<string, Capability> }
/** Explicit hosted operations. Constructing these services starts no connection or request. */
export interface HostServices {
  readonly members: import("./members.mjs").MembersClient;
  readonly peers: import("./peers.mjs").PeersClient;
  request<T = unknown>(path: string, options?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal }): Promise<T>;
  blobUrl(id: string): string;
  /** Authentication for the page host; these headers do not grant application authority. */
  deviceHeaders(): Record<string, string>;
}
export interface RuntimeServices {
  readonly host: HostServices;
  readonly signals: import("./signals.mjs").SignalBinding;
  readonly application: import("./application.mjs").ApplicationBinding;
  on<K extends keyof RuntimeLocalEventMap>(type: K, fn: (payload: RuntimeLocalEventMap[K]) => void): () => void;
  /** Page UI readiness, independent of application synchronization. */
  ready(): void;
  capabilities(): Promise<CapabilityReport>;
  readonly device: Readonly<Pick<Device, "id" | "name">>;
  readonly version: number;
  readonly identity: Readonly<{ page: string; version: number; publication: string | null; base: string; managementUrl: string }>;
  /** Resolve an explicit runtime dependency against the publication-pinned runtime. */
  assetUrl(path: string): string;
  /** Resolves only after the exact required publication graph is saved by its service worker. */
  publication: { saveOffline(): Promise<{ id: string; status: "ready" }> };
  sensors: { status(): SensorStatus; on(listener: (status: SensorStatus) => void): () => void; stopAll(): number };
}
/** Application state, readiness, operations and authorization belong to the installed peer session. */
export interface PeerRuntimeApi extends RuntimeServices {
  readonly kind: "peer";
}
/** Hosted application services exist only when this backend was selected. */
export interface HostedRuntimeApi<T = Record<string, unknown>> extends RuntimeServices {
  readonly kind: "cloudflare";
  send(data: unknown, opts?: OperationOptions & { wake?: boolean }): Promise<SendResult>;
  scopes: { list(): ScopeDescriptor[]; capture(scope: string): OperationOptions };
  timers: BrowserTimers;
  readonly service: ServiceDescriptor | null;
  conversation: {
    entries(): TranscriptEntry[];
    send(text: string, options?: { via?: "text" | "voice" }): Promise<ConversationResult>;
    /** Reports presentation by the application, never a human read receipt. */
    presented(messageId: string): void;
  };
  upload(blob: Blob, opts?: OperationOptions & { name?: string; keep?: boolean }): Promise<BlobReference>;
  uploadEvent(blob: Blob, options: CaptureOptions): Promise<CaptureResult>;
  /** Durable local work retained until its acknowledgement. */
  pendingWork(): { events: number; state: number; captures: number; timers: number };
  captures(): PendingCapture[]; retryCapture(captureId: string): Promise<CaptureResult>; discardCapture(captureId: string): Promise<void>;
  setBlobRetention(id: string, options: OperationOptions & { keep: boolean }): Promise<BlobReference>;
  state: StateApi<T>;
  streams: BrowserStreams;
  records: RecordLogClient;
  on<K extends keyof RuntimeLocalEventMap>(type: K, fn: (payload: RuntimeLocalEventMap[K]) => void): () => void;
  on<K extends keyof RuntimeEventMap & string>(type: K, fn: (payload: RuntimeEventMap[K]) => void): () => void;
  ready: (() => void) & { manual(): void };
  readonly device: Readonly<Device>; readonly connected: boolean; readonly presence: Presence | null;
  notifications: NotificationsApi;
}
export type RuntimeApi<T = Record<string, unknown>> = PeerRuntimeApi | HostedRuntimeApi<T>;
export type { EventConsumer, ConsumerClaim, ConsumerLease, ConsumerRenew, ConsumerAck, ConsumerBatch, TimerDelivery } from "./durability.mjs";
export type { StreamInfo, StreamCreate, StreamInput, StreamAppend, StreamRecord, StreamBatch, StreamLatest, StreamTrim, StreamTrimResult, StreamHistory,
  StreamAppendResult, StreamReadOptions, StreamSubscribeOptions, BrowserStreams, Producer, ProducerCreate, ProducerResult } from "./streams.mjs";
export { STREAM_RECORD_BYTES, STREAM_SNAPSHOT_RECORD_BYTES } from "./streams.mjs";
export type Contracts = WireContracts;
export const CONTRACT_VERSION: 3;
export const CORE_RELEASE: "0.3.0-rc.9";
export { RESOURCE_LIMITS, STREAM_LIMITS, streamRecordLimit } from "./limits.mjs";
export { assertFilePath, assertAttachments, assertPublicationEntries } from "./blobs.mjs";
export const ROLES: readonly Role[];
export const DEVICE_PURPOSES: readonly DevicePurpose[];
export const schemas: Readonly<Record<keyof Contracts, Record<string, any>>>;
export const schemaDocument: Readonly<{ $schema: string; $id: string; title: string; $defs: typeof schemas }>;
export function validateSchema(schema: Record<string, any>, value: unknown, path?: string): ValidationIssue[];
export function validate<K extends keyof Contracts>(name: K, value: unknown): ValidationIssue[];
export function assertValid<K extends keyof Contracts>(name: K, value: unknown): Contracts[K];
export class ContractError extends TypeError { code: "bad_request"; issues: ValidationIssue[]; constructor(issues: ValidationIssue[]) }
