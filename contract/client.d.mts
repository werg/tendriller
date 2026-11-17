import type { CreateRequest, ValidationIssue, PublicError } from './index.mjs';
import type { ApplicationSelection } from './application.mjs';
export interface PageHandle { id: string; api: string; token: string; page_url: string; name?: string;
  application: ApplicationSelection; expires_at?: number | null; next_step?: string;
  unclaimed_limits?: { request_body_bytes: number } }
export interface ClientOptions { fetch?: typeof globalThis.fetch; applicationId?: string }
export interface AgentClient {
  readonly peers: import('./peers.mjs').PeersClient;
  request<T = unknown>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> }): Promise<T>;
  info(): Promise<Record<string, unknown>>;
  service(): Promise<ServiceDescriptor>;
}
export class ApiError extends Error { status: number; code: string; details?: ValidationIssue[]; error?: Partial<PublicError>; constructor(status: number, error?: Partial<PublicError>) }
export function createClient(handle: Pick<PageHandle, 'api' | 'token'>, options?: ClientOptions): AgentClient;
export function createPage(service: string, body: CreateRequest, options?: ClientOptions): Promise<PageHandle>;
export interface ServiceDescriptor { contract: number; core_release: string; limits: Record<string, unknown> }
export function describeService(service: string, options?: ClientOptions): Promise<ServiceDescriptor>;
export function requireService(descriptor: ServiceDescriptor, requirements?: { contract?: number }): ServiceDescriptor;
