export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ValidationIssue { path: string; message: string }
export interface PublicError { code: string; message: string; details?: ValidationIssue[]; [key: string]: unknown }
export interface ErrorResponse { error: PublicError }
export type Role = "owner" | "guest" | "display";
export type DevicePurpose = "general" | "camera" | "controller" | "display" | "speaker";
export type Path = string | (string | number)[];
export type StateOperation = { op: "set"; path: Path; value: unknown } | { op: "delete"; path: Path };
export interface CreateRequest { owner: string; name?: string; lifetime?: "ad_hoc" }
export interface SayRequest { text: string; speak?: boolean; in_reply_to?: number; device?: string; speak_on?: string }
/** Per-device delivery can speak without presenting a second visible message. */
export interface SayMessage extends SayRequest { t?: "say"; message_id?: string; ts?: number; present?: boolean }
export interface BlobReference { id: string; url: string; retention?: { keep: boolean; expires_at: number | null; reason?: "pinned" | "page_default" | "agent_asset" | "icon" } }
export type SendResult = { status: "accepted"; queued: false; seq: number }
  | { status: "queued"; queued: true }
  | { status: "rejected"; queued: false; error: string; message?: string };
export interface CaptureOptions { name?: string; data: Record<string, unknown>; dataPath?: string[]; keep?: boolean; wake?: boolean }
export type CaptureResult = ({ status: "accepted"; queued: false; seq: number; blob: BlobReference }
  | { status: "queued"; queued: true }
  | { status: "rejected"; queued: false; error: string; message?: string }) & { capture_id: string };
export interface PendingCapture { capture_id: string; name?: string; data: Record<string, unknown>; status: "queued" | "rejected"; blob?: BlobReference; error?: string; message?: string }
export interface PublicEvent<T = unknown> { seq: number; ts: number; type: string; role?: Role | null; device?: string | null; by?: string | null; data: T; wake?: boolean; withheld?: boolean }
export interface InstructionEvent extends PublicEvent<{ text: string; via: "text" | "voice" }> { type: "instruction"; role: "owner" }
export interface Device { id: string; role: Role; name: string; pending: boolean; purpose?: DevicePurpose; pairCode?: string }
export interface DeviceInfo { id: string; role: Role; name: string | null; pending: boolean; purpose: DevicePurpose; connected: boolean; primary: boolean; last_seen: number | null; ua: string | null; link: string | null }
export interface DeviceUpdate { id?: string; name?: string | null; purpose?: DevicePurpose }
export interface Focus { device: string; expires_at: number }
export interface FocusRequest { device: string | null; ttl_seconds?: number }
export interface DeviceConfiguration { devices: DeviceInfo[]; focus: Focus | null }
/** Guest/display broadcasts expose only each device's identity and presentation. */
export interface DevicePresentation { id: string; purpose: DevicePurpose }
export interface DeviceConfigMessage { t?: "device_config"; devices: (DeviceInfo | DevicePresentation)[]; focus: Focus | null }
export interface Presence { state: "listening" | "working" | "done" | "scheduled" | "not_responding" | "away" | "no_agent"; text: string; last_seen: number | null; schedule_minutes: number | null; withheld: number; wake: "long_poll" | "webhook" | "schedule" | "none" }
export interface TranscriptEntry { ts: number; from: "agent" | "user"; text: string; message_id?: string; in_reply_to?: number }
export interface StateApi<T = Record<string, unknown>> {
  get(): T; get(path: Path): unknown;
  set(path: Path, value: unknown): void; delete(path: Path): void;
  patch(mergePatch: object): void; mine(): unknown;
  on(fn: (state: T, ops: StateOperation[], by: string) => void): () => void;
}
export type InterfaceBlockType = "message" | "status" | "choice" | "text" | "slider" | "button" | "photo" | "location" | "file" | "drawing" | "hardware";
export interface InterfaceBlock { id: string; type: InterfaceBlockType; connector?: string; label?: string; text?: string; options?: string[]; min?: number; max?: number; value?: number }
export interface InterfaceState { title?: string; description?: string; blocks: InterfaceBlock[] }
export interface SessionBrief { purpose: string; current_task: string; completed: string[]; decisions: string[]; open_questions: string[]; last_handled_seq: number; source?: string }
export type SessionWrite = Partial<SessionBrief> & { expected_revision?: number };
export interface SessionResult { session: SessionBrief; revision: number }
export interface SessionSummary extends SessionResult {
  version: number; staged_remix: boolean;
  pending_inputs: { after: number; count: number; earliest_available_seq: number | null; history_gap: boolean };
  timers: DurableTimer[]; devices: DeviceInfo[]; recent_activity: { ts: number; kind: string; summary: string }[];
}
export type TimerRepeat = { every_minutes: number } | { at: string; days?: number[] };
export interface DurableTimer { id: string; title: string; due_at: number; timezone: string; repeat?: TimerRepeat; missed: "fire_once" | "skip"; device?: string; notify: boolean; state: "scheduled" | "cancelled" | "completed"; created_at: number; updated_at: number }
export interface TimerWrite { title?: string; due_at?: number; timezone?: string; repeat?: TimerRepeat | null; missed?: "fire_once" | "skip"; device?: string | null; notify?: boolean; state?: DurableTimer["state"] }
export type CreateTimer = TimerWrite & { title: string };
export interface TimerRun { id: string; timer_id: string; scheduled_at: number; fired_at: number; status: "fired" | "skipped"; event_seq: number | null; notification: string | null }
export interface PortableBundle { format: "tendriller-bundle"; version: 1; name: string; files: { path: string; type: string; base64: string }[]; state?: Record<string, unknown>; session?: SessionBrief; media: { id: string; type: string; name: string | null; base64: string }[] }
export interface BundleStageResult { staged: true; files: number; media: number; expected_version: number; requires_publication: true }
export interface BundlePublish { expected_version: number }
export interface RemixRequest { owner: string; name?: string; include_data?: boolean }
export type RemixPageRequest = Omit<RemixRequest, "owner">;
export type DecisionStatus = "pending" | "approved" | "rejected" | "revision_requested" | "working" | "completed" | "failed";
export interface Decision {
  id: string; title: string; summary: string; version: number; proposal?: unknown; expires_at: number | null; status: DecisionStatus;
  created_at: number; updated_at: number; responded_at?: number; event_seq?: number; note?: string; result?: string;
}
export interface DecisionCreate { title: string; summary: string; proposal?: unknown; expires_at?: number | null; status?: "pending" }
export interface DecisionUpdate { expected_version: number; title?: string; summary?: string; proposal?: unknown; expires_at?: number | null; status?: "pending" | "working" | "completed" | "failed"; result?: string }
export interface DecisionResponse { expected_version: number; decision: "approve" | "reject" | "revise"; note?: string }
export interface ParticipantResponse { id: string; participant: string; prompt_id: string; answer: string; revision: number; created_at: number; updated_at: number }
export interface ParticipantResponseWrite { prompt_id: string; answer: string; expected_revision?: number }
export interface RuntimeEventMap {
  connect: void; disconnect: void; role: Pick<Device, "role" | "pending">; presence: Presence;
  say: SayMessage; transcript: TranscriptEntry | null;
  upload_event: CaptureResult; error: { code?: string; message?: string };
  send_result: SendResult & { cid: string; data: unknown };
  capture_queue: PendingCapture[]; capabilities: CapabilityReport; tts: SpeechStatus;
  device_config: DeviceConfigMessage; decisions_changed: { t?: "decisions_changed" };
  reload: { version: number }; [key: string]: unknown;
}
export interface SpeechStatus { enabled: boolean; state: "idle" | "loading" | "ready" | "error"; message: string }
export interface SpeechOutput {
  readonly status: SpeechStatus;
  stop(): void; enable(): Promise<void>; disable(): void; speak(text: string): void;
}
export interface Capability { available: boolean; permission: "granted" | "prompt" | "denied" | "unknown"; needs_user_tap: boolean; active: boolean | null; note?: string }
export interface CapabilityReport { captured_at: number; secure: boolean; device: string; capabilities: Record<string, Capability> }
export interface RuntimeApi<T = Record<string, unknown>> {
  send(data: unknown, opts?: { wake?: boolean }): Promise<SendResult>;
  upload(blob: Blob, opts?: { name?: string; keep?: boolean }): Promise<BlobReference>;
  uploadEvent(blob: Blob, options: CaptureOptions): Promise<CaptureResult>;
  captures(): PendingCapture[]; retryCapture(captureId: string): Promise<CaptureResult>; discardCapture(captureId: string): Promise<void>;
  setBlobRetention(id: string, options: { keep: boolean }): Promise<BlobReference>;
  state: StateApi<T>;
  on<K extends keyof RuntimeEventMap & string>(type: K, fn: (payload: RuntimeEventMap[K]) => void): () => void;
  ready: (() => void) & { manual(): void };
  speak(text: string): void; tts: SpeechOutput;
  capabilities(): Promise<CapabilityReport>; deviceHeaders(): Record<string, string>;
  device: Device; readonly version: number; readonly connected: boolean; readonly presence: Presence | null;
  control: { hide(): void; show(): void; position(p: "bottom-right" | "bottom-left" | "top-right" | "top-left"): void };
}
export interface Contracts {
  error: PublicError; errorResponse: ErrorResponse; create: CreateRequest; say: SayRequest; sayMessage: SayMessage;
  stateOperation: StateOperation; stateOperations: StateOperation[]; stateUpdate: Record<string, unknown> | { ops: StateOperation[] };
  interface: InterfaceState; sendResult: SendResult; blobReference: BlobReference; captureOptions: CaptureOptions; captureResult: CaptureResult;
  event: PublicEvent; device: Device; deviceInfo: DeviceInfo; deviceUpdate: DeviceUpdate; deviceConfiguration: DeviceConfiguration;
  focus: Focus; focusRequest: FocusRequest; session: SessionBrief; sessionWrite: SessionWrite; sessionSummary: SessionSummary;
  timer: DurableTimer; timerRepeat: TimerRepeat; timerWrite: TimerWrite; timerCreate: CreateTimer; timerRun: TimerRun;
  bundle: PortableBundle; bundlePublish: BundlePublish; remix: RemixRequest; remixPage: RemixPageRequest;
  decision: Decision; decisionCreate: DecisionCreate; decisionUpdate: DecisionUpdate; decisionResponse: DecisionResponse;
  participantResponse: ParticipantResponse; participantResponseWrite: ParticipantResponseWrite;
}
export const CONTRACT_VERSION: 1;
export const ROLES: readonly Role[];
export const DEVICE_PURPOSES: readonly DevicePurpose[];
export const schemas: Readonly<Record<keyof Contracts, Record<string, any>>>;
export const schemaDocument: Readonly<{ $schema: string; $id: string; title: string; $defs: typeof schemas }>;
export function validateSchema(schema: Record<string, any>, value: unknown, path?: string): ValidationIssue[];
export function validate<K extends keyof Contracts>(name: K, value: unknown): ValidationIssue[];
export function assertValid<K extends keyof Contracts>(name: K, value: unknown): Contracts[K];
export class ContractError extends TypeError { code: "bad_request"; issues: ValidationIssue[]; constructor(issues: ValidationIssue[]) }
