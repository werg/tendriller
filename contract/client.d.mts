import type { CreateRequest, PublicEvent, SayRequest, StateOperation, ValidationIssue, PublicError, DeviceConfiguration, DeviceInfo, DeviceUpdate,
  FocusRequest, CreateTimer, DurableTimer, TimerWrite, TimerRun, SessionSummary, SessionWrite, SessionResult,
  PortableBundle, BundleStageResult, BundlePublish, RemixRequest, Decision, DecisionCreate, DecisionUpdate, ParticipantResponse } from "./index.mjs";
export interface PageHandle { id: string; api: string; token: string; page_url: string; name?: string }
export interface ClientOptions { fetch?: typeof globalThis.fetch }
export interface EventBatch { events: PublicEvent[]; cursor: number; next_poll?: string; [key: string]: unknown }
export interface AgentClient {
  request<T = unknown>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>;
  info(): Promise<Record<string, unknown>>;
  say(body: SayRequest): Promise<{ message_id: string; [key: string]: unknown }>;
  state(): Promise<{ state: Record<string, unknown>; rev: number }>;
  updateState(body: Record<string, unknown> | { ops: StateOperation[] }): Promise<{ rev: number }>;
  writeFiles(body: { files: Record<string, string | { base64: string; type?: string }>; replace?: boolean; delete?: string[]; message?: string }): Promise<{ version: number; [key: string]: unknown }>;
  devices(): Promise<DeviceConfiguration>;
  updateDevice(device: string, body: DeviceUpdate): Promise<DeviceInfo>;
  focus(body: FocusRequest): Promise<DeviceConfiguration>;
  timers(): Promise<{ timers: DurableTimer[]; execution: "server"; lifetime: "ad_hoc" | "resident"; expires_at: number | null }>;
  createTimer(body: CreateTimer): Promise<DurableTimer>;
  updateTimer(timer: string, body: TimerWrite): Promise<DurableTimer>;
  deleteTimer(timer: string): Promise<void>;
  timerHistory(): Promise<{ runs: TimerRun[] }>;
  session(): Promise<SessionSummary>;
  updateSession(body: SessionWrite): Promise<SessionResult>;
  exportBundle(options?: { includeData?: boolean }): Promise<PortableBundle>;
  stageBundle(body: PortableBundle): Promise<BundleStageResult>;
  publishBundle(body: BundlePublish): Promise<{ version: number; [key: string]: unknown }>;
  discardBundle(): Promise<void>;
  remix(body: RemixRequest): Promise<PageHandle & { remix: { staged: true; requires_receiver: true; publish_url: string; expected_version: number } }>;
  decisions(): Promise<{ decisions: Decision[] }>;
  createDecision(body: DecisionCreate): Promise<Decision>;
  updateDecision(decision: string, body: DecisionUpdate): Promise<Decision>;
  responses(): Promise<{ responses: ParticipantResponse[] }>;
  readEvents(options: { after: number; wait?: number; signal?: AbortSignal }): Promise<EventBatch>;
}
export class ApiError extends Error { status: number; code: string; details?: ValidationIssue[]; error?: Partial<PublicError>; constructor(status: number, error?: Partial<PublicError>) }
export function createClient(handle: Pick<PageHandle, "api" | "token">, options?: ClientOptions): AgentClient;
export function createPage(service: string, body: CreateRequest, options?: ClientOptions): Promise<PageHandle>;
