import type { ValidationIssue, PublicError } from './index.mjs';
import type { ApplicationSelection } from './application.mjs';
export interface AgentPage { id: string; name?: string; page_url: string; scopes?: string[]; application: ApplicationSelection; lifetime?: string; [key: string]: unknown }
export interface AgentPageList { pages: AgentPage[]; next_cursor?: string | null }
export interface AgentCredential { id: string; name: string; token: string; account_state?: 'unclaimed' | 'claimed'; [key: string]: unknown }
export interface ClientOptions { fetch?: typeof globalThis.fetch; WebSocket?: typeof globalThis.WebSocket; hub?: Partial<AgentHubOptions> }
export interface RequestOptions { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> }
/** The former per-page client, based at /api/agent/pages/<id>. */
export interface PageClient {
  readonly id: string;
  readonly base: string;
  readonly peers: import('./peers.mjs').PeersClient;
  request<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  /** A hub stream onto one page socket endpoint (setup/watch, peers/*, assistant/adapter). */
  socket(path: string, protocols?: readonly string[]): HubSocket;
  /** Authenticated raw fetch confined to this page's routes, for helpers that take a fetch. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  info(): Promise<Record<string, unknown>>;
  service(): Promise<ServiceDescriptor>;
}
export interface AgentClient {
  readonly service: string;
  request<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  self(options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  readonly pages: {
    list(options?: { cursor?: string; signal?: AbortSignal }): Promise<AgentPageList>;
    all(options?: { signal?: AbortSignal }): AsyncIterable<AgentPage>;
    create(body?: { name?: string }, options?: { signal?: AbortSignal }): Promise<AgentPage>;
  };
  page(id: string, options?: { applicationId?: string }): PageClient;
  readonly hub: AgentHub;
  close(): void;
}
export interface HubSocket extends EventTarget {
  readonly readyState: number; readonly protocol: string; readonly page: string; readonly path: string; readonly bufferedAmount: number;
  binaryType: 'arraybuffer' | 'blob';
  onopen: ((event: Event) => void) | null; onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null; onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}
export interface HubEvent { readonly page: string; readonly kind: 'grant' | 'revoked' | 'page-deleted' | 'publication' | string; readonly data: unknown }
export interface HubStatus { readonly state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'replaced' | 'revoked' | 'closed'; readonly retryInMs?: number; readonly reconnected?: boolean }
export interface AgentHubOptions { service: string; token: string; WebSocket?: typeof globalThis.WebSocket; probe?: (options: { signal: AbortSignal }) => Promise<unknown>;
  retryMs?: number; maxRetryMs?: number; pingMs?: number; openTimeoutMs?: number; keepAlive?: boolean }
export interface AgentHub {
  readonly state: HubStatus['state'];
  readonly streams: number;
  socket(page: string, path: string, protocols?: readonly string[]): HubSocket;
  events(listener: (event: HubEvent) => void): () => void;
  onStatus(listener: (status: HubStatus) => void): () => boolean;
  connect(): void;
  close(): void;
}
export class HubError extends Error { code: string }
export const HUB_PROTOCOL: 'tendriller.hub.v1';
export const HUB_PATHS: readonly string[];
export const HUB_LIMITS: Readonly<{ streams: number; frameBytes: number; maxStreamId: number; openTimeoutMs: number; closeTimeoutMs: number; pingMs: number; retryMs: number; maxRetryMs: number }>;
export function validateHubPath(path: string): string;
export function createAgentHub(options: AgentHubOptions): AgentHub;
export class ApiError extends Error { status: number; code: string; details?: ValidationIssue[]; error?: Partial<PublicError>; constructor(status: number, error?: Partial<PublicError>) }
export function createAgentClient(credential: { service: string; token: string }, options?: ClientOptions): AgentClient;
export function registerAgent(service: string, body: { owner: string; name: string; publicKey: string }, options?: { fetch?: typeof globalThis.fetch; signal?: AbortSignal }): Promise<AgentCredential>;
export function joinAgent(service: string, body: { code: string; name: string; publicKey: string }, options?: { fetch?: typeof globalThis.fetch; signal?: AbortSignal }): Promise<AgentCredential>;
export interface ServiceDescriptor { contract: number; core_release: string; limits: Record<string, unknown> }
export function describeService(service: string, options?: ClientOptions & { signal?: AbortSignal }): Promise<ServiceDescriptor>;
export function requireService(descriptor: ServiceDescriptor, requirements?: { contract?: number }): ServiceDescriptor;
export function requireServiceOrigin(service: string): string;
export interface ServiceReadiness {
  schemaVersion: 1;
  serviceOrigin: string;
  environment: { id: string; label: string; kind: 'deployment' | 'preview' | 'local' };
  build: { coreRelease: string; runtimeId: string; sourceCommit: string | null; compositionId?: string | null };
  mode: 'open' | 'creation_paused' | 'read_only' | 'unavailable';
  creation: { available: boolean; code: null | 'creation_paused' | 'unavailable'; message: string; nextAction: string };
  writes: { available: boolean; code: null | 'read_only' | 'unavailable' };
  readinessUrl: string;
  statusUrl: string;
  checkedAt: string;
}
export function describeReadiness(service: string, options?: ClientOptions & { signal?: AbortSignal }): Promise<ServiceReadiness>;
export function requireCreationReady(readiness: ServiceReadiness, options?: { service?: string }): ServiceReadiness;
