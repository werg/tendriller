import type { DurabilityClient } from "./durability-client.mjs";
import type { StreamsClient } from "./streams-client.mjs";
import type { CreateRequest, PublicEvent, DeliveryProbe, SayRequest, StateOperation, ValidationIssue, PublicError, DeviceConfiguration, DeviceInfo, DeviceUpdate,
  FocusRequest, CreateTimer, DurableTimer, TimerWrite, TimerRun, SessionSummary, SessionWrite, SessionResult,
  PortableBundle, BundleStageResult, BundlePublish, RemixRequest, ScopeDescriptor } from "./index.mjs";
export interface PageHandle { id: string; api: string; token: string; page_url: string; name?: string;
  expires_at?: number | null; next_step?: string }
export interface ClientOptions { fetch?: typeof globalThis.fetch }
export interface EventBatch { events: PublicEvent[]; cursor: number; next_poll?: string; [key: string]: unknown }
export interface NotificationRequest { title: string; body?: string; url?: string; device?: string; tag?: string }
export interface NotificationStatus { available: boolean; subscribed_devices: { id: string; name: string | null }[];
  count: number; quota: { limit: number; used: number; remaining: number } }
export interface NotificationDelivery { sent: number; failed: number;
  deliveries: { device: string; ok: boolean; status: number; gone: boolean }[] }
export interface AgentClient extends DurabilityClient, StreamsClient {
  request<T = unknown>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> }): Promise<T>;
  info(): Promise<Record<string, unknown>>;
  probeDelivery(): Promise<DeliveryProbe>;
  checkDeliveryProbe(nonce?: string): Promise<DeliveryProbe>;
  acknowledgeDeliveryProbe(nonce: string): Promise<DeliveryProbe>;
  say(body: SayRequest): Promise<{ message_id: string; [key: string]: unknown }>;
  notificationStatus(): Promise<NotificationStatus>;
  notify(body: NotificationRequest): Promise<NotificationDelivery>;
  state(): Promise<{ state: Record<string, unknown>; rev: number; scopes: ScopeDescriptor[] }>;
  updateState(body: CommandMetadata & ({ ops: StateOperation[] } | { state: Record<string, unknown> })): Promise<{ rev: number }>;
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
  service(): Promise<ServiceDescriptor>;
  scopes(): Promise<{scopes: ScopeDescriptor[]}>;
  putScope(id: string, body: CommandMetadata & {paths: string[][]; operations: string[]}): Promise<ScopeDescriptor>;
  rotateScope(id: string, body: CommandMetadata): Promise<ScopeDescriptor>;
  retireScope(id: string, body: CommandMetadata): Promise<void>;
  send(body: CommandMetadata & {data: unknown}): Promise<{seq: number}>;
  workflow<T = unknown>(module: string, operation: string, body: CommandMetadata & {data: unknown}): Promise<T>;
  readEvents(options: { after: number; wait?: number; signal?: AbortSignal }): Promise<EventBatch>;
}
export class ApiError extends Error { status: number; code: string; details?: ValidationIssue[]; error?: Partial<PublicError>; constructor(status: number, error?: Partial<PublicError>) }
export function createClient(handle: Pick<PageHandle, "api" | "token">, options?: ClientOptions): AgentClient;
export function createPage(service: string, body: CreateRequest, options?: ClientOptions): Promise<PageHandle>;

export interface CommandMetadata { cid: string; scope?: string; expected_generations: Record<string, string> }
export interface ServiceDescriptor { contract: number; core_release: string; limits: Record<string, unknown>; workflows: {id: string; interface_version: string; schema_version: string}[] }
export function describeService(service: string, options?: ClientOptions): Promise<ServiceDescriptor>;
export function requireService(descriptor: ServiceDescriptor, requirements?: {contract?: number; workflows?: Record<string, {interface_version: string; schema_version: string}>}): ServiceDescriptor;
