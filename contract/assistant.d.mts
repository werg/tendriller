export interface AssistantEventDefinition { name: string; description: string }
export interface AssistantEndpoint { api: string; key: string }
export interface AssistantExposure { queries?: readonly string[]; commands?: readonly string[] }
export interface AssistantCallerContext {
  account: string; agentBindingId: string; bindingRevision: number;
  verification: 'approved-binding' | 'oauth-client';
  context: { evidence: 'caller-asserted'; endpointId?: string; endpointIncarnation?: string; runId?: string;
    interactionId?: string; threadId?: string; documentPath?: string; publicationId?: string };
}
export interface AssistantInboxCursor {
  version: 1; applicationId: string; agentBindingId: string; exportVersion: string;
  generation: string | null; filter: string[]; sequence: number;
}
interface AssistantSession {
  readonly applicationId: string;
  readonly historyId?: string;
  readonly deviceId: string;
  readonly status: { readonly generation: string };
  readonly signal: AbortSignal;
}
export interface AssistantParticipant {
  readonly online: boolean;
  readonly closed: Promise<void>;
  close(): Promise<void>;
  waitUntilOnline(options?: { signal?: AbortSignal }): Promise<void>;
  publish(event: { sourceEventId: string; name: string; generation: string; payload: unknown;
    context?: Omit<AssistantCallerContext['context'], 'evidence'> }): Promise<number>;
}
/** Portable host request; the supplied scoped controller validates native semantics. */
export interface AssistantToolRequest {
  readonly kind: 'query' | 'command' | 'reapply' | 'operation' | 'retry' | 'wait';
  readonly name: string;
  readonly input?: unknown;
  readonly operationId?: string;
  readonly basedOn?: unknown;
  readonly originalOperationId?: string;
  readonly originalAuthor?: string;
  readonly generation?: string;
}
export function createAssistantKey(): string;
export function createApplicationAgentKey(bindingId?: string): string;
export function proposeApplicationAssistant(options: AssistantEndpoint & AssistantExposure & {
  token: string; backupKeys?: readonly string[]; label: string; events?: readonly AssistantEventDefinition[]; signal?: AbortSignal; fetcher?: typeof fetch;
}): Promise<{ applicationId: string; proposed: string; approved: boolean; reviewUrl: string }>;
export function connectApplicationAssistant(options: AssistantEndpoint & {
  session: AssistantSession;
  tools: { execute(call: AssistantToolRequest, options?: { signal?: AbortSignal; caller?: Readonly<AssistantCallerContext> }): Promise<unknown> };
  onStatus?: (status: { state: string; reason?: string; retryInMs?: number }) => void;
  openSocket?: (url: string, protocols: string[]) => WebSocket;
  /** Initial sign-in/consent window, 1000–600000 ms; defaults to ten minutes. */
  initialConnectTimeoutMs?: number;
  signal?: AbortSignal;
}): AssistantParticipant;
/** Host-specific delivery callback for Chronolog's forwardSessionEvents. */
export function createAssistantEventDelivery(options: {
  assistant: AssistantParticipant;
  onSkipped?: (event: { name: string; sourceEventId: string }) => void;
}): (projection: { name: string; payload: unknown }, event: { readonly id: string },
  batch: { readonly revision: { readonly generation: string } }, signal: AbortSignal) => Promise<void>;
