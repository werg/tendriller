import type { BlobTransferClient } from "./blobs-client.mjs";
import type { DurabilityClient } from "./durability-client.mjs";
import type { StreamsClient } from "./streams-client.mjs";
import type { RecordLogClient, RecordLogClientOptions } from "./records.mjs";
import type { CreateRequest, PublicEvent, DeliveryProbe, SayRequest, StateOperation, StateChecks, StateSnapshot, ValidationIssue, PublicError, DeviceConfiguration, DeviceInfo, DeviceUpdate,
  FocusRequest, CreateTimer, DurableTimer, TimerWrite, TimerDelete, TimerDeleted, TimerRun, SessionSummary, SessionWrite, SessionResult,
  PortableBundle, BundleStageResult, BundlePublish, BundleReceipt, RemixRequest, ScopeDescriptor } from "./index.mjs";
export interface PageHandle { id: string; api: string; token: string; page_url: string; name?: string;
  expires_at?: number | null; next_step?: string; application?: import("./application.mjs").ApplicationSelection;
  unclaimed_limits?: { request_body_bytes: number; stream_retained_bytes: number } }
export interface ClientOptions { fetch?: typeof globalThis.fetch; recordLogHints?: RecordLogClientOptions["subscribeHints"] }
export interface EventBatch { events: PublicEvent[]; cursor: number; withheld: number; [key: string]: unknown }
export interface NotificationRequest { title: string; body?: string; url?: string; device?: string; tag?: string }
export interface NotificationStatus { available: boolean; subscribed_devices: { id: string; name: string | null }[];
  count: number; quota: { limit: number; used: number; remaining: number } }
export interface NotificationDelivery { sent: number; failed: number;
  deliveries: { device: string; ok: boolean; status: number; gone: boolean }[] }
export interface AgentClient extends DurabilityClient, StreamsClient, BlobTransferClient {
  /** Explicit authenticated live connection; no durable queue or agent wake subscription. */
  connectSignals(options?: import('./hosted-signals.mjs').HostedSignalConnectionOptions): Promise<import('./hosted-signals.mjs').HostedSignals>;
  members: import("./members.mjs").MembersClient;
  application(): Promise<import("./application.mjs").ApplicationBackend<import("./application.mjs").CloudflareApplicationProgram, import("./application.mjs").CloudflareApplicationSubmission>>;
  peers: import("./peers.mjs").PeersClient;
  records: RecordLogClient;
  request<T = unknown>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> }): Promise<T>;
  info(): Promise<Record<string, unknown>>;
  probeDelivery(): Promise<DeliveryProbe>;
  checkDeliveryProbe(nonce?: string): Promise<DeliveryProbe>;
  acknowledgeDeliveryProbe(nonce: string): Promise<DeliveryProbe>;
  say(body: SayRequest): Promise<{ message_id: string; [key: string]: unknown }>;
  notificationStatus(): Promise<NotificationStatus>;
  notify(body: NotificationRequest): Promise<NotificationDelivery>;
  state(): Promise<StateSnapshot>;
  updateState(body: CommandMetadata & StateChecks & ({ ops: StateOperation[] } | { state: Record<string, unknown> })): Promise<{ rev: number }>;
  devices(): Promise<DeviceConfiguration>;
  updateDevice(device: string, body: DeviceUpdate): Promise<DeviceInfo>;
  focus(body: FocusRequest): Promise<DeviceConfiguration>;
  timers(): Promise<{ timers: DurableTimer[]; execution: "server"; lifetime: "ad_hoc" | "resident"; expires_at: number | null }>;
  createTimer(body: CreateTimer): Promise<DurableTimer>;
  updateTimer(timer: string, body: TimerWrite): Promise<DurableTimer>;
  deleteTimer(timer: string, body: TimerDelete): Promise<TimerDeleted>;
  timerHistory(): Promise<{ runs: TimerRun[] }>;
  session(): Promise<SessionSummary>;
  updateSession(body: SessionWrite): Promise<SessionResult>;
  exportBundle(options?: { includeData?: boolean }): Promise<PortableBundle>;
  stageBundle(body: PortableBundle): Promise<BundleStageResult>;
  publishBundle(body: BundlePublish): Promise<BundleReceipt>;
  discardBundle(): Promise<void>;
  remix(body: RemixRequest): Promise<PageHandle & { remix: { staged: true; requires_receiver: true; publish_url: string; expected_head_revision: number } }>;
  service(): Promise<ServiceDescriptor>;
  scopes(): Promise<{scopes: ScopeDescriptor[]}>;
  putScope(id: string, body: CommandMetadata & {paths: string[][]; operations: string[]}): Promise<ScopeDescriptor>;
  rotateScope(id: string, body: CommandMetadata): Promise<ScopeDescriptor>;
  retireScope(id: string, body: CommandMetadata): Promise<void>;
  send(body: CommandMetadata & {data: unknown}): Promise<{seq: number}>;
  workflow<T = unknown>(module: string, operation: string, body: CommandMetadata & {data: unknown}): Promise<T>;
  readEvents(options: { after: number; signal?: AbortSignal }): Promise<EventBatch>;
}
export class ApiError extends Error { status: number; code: string; details?: ValidationIssue[]; error?: Partial<PublicError>; constructor(status: number, error?: Partial<PublicError>) }
export function createClient(handle: Pick<PageHandle, "api" | "token" | "application">, options?: ClientOptions): AgentClient;
/** Requires an explicit immutable application selection; does not configure its descriptor, schema, keys or session. */
export function createPage(service: string, body: CreateRequest, options?: ClientOptions): Promise<PageHandle>;

export interface CommandMetadata { cid: string; scope?: string; expected_generations: Record<string, string> }
export interface ServiceDescriptor { contract: number; core_release: string; limits: Record<string, unknown>; workflows: {id: string; interface_version: string; schema_version: string}[] }
export function describeService(service: string, options?: ClientOptions): Promise<ServiceDescriptor>;
export function requireService(descriptor: ServiceDescriptor, requirements?: {contract?: number; workflows?: Record<string, {interface_version: string; schema_version: string}>}): ServiceDescriptor;
