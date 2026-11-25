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
  filter: string[]; sequence: number;
}
interface AssistantSession {
  readonly applicationId: string;
  readonly identity: { readonly publicKey: string };
  readonly signal: AbortSignal;
}
export interface AssistantParticipant {
  readonly online: boolean;
  readonly closed: Promise<void>;
  close(): Promise<void>;
  waitUntilOnline(options?: { signal?: AbortSignal }): Promise<void>;
  publish(event: { sourceEventId: string; proposalId: string; revision: AssistantProjectionRevision; observation: AssistantObservation;
    change?: 'upsert' | 'retract'; name: string; payload: unknown;
    context?: Omit<AssistantCallerContext['context'], 'evidence'> }): Promise<number>;
}
/** Portable host request; the supplied scoped controller validates native semantics. */
export interface AssistantToolRequest {
  readonly kind: 'query' | 'command' | 'inspect' | 'retry' | 'wait';
  readonly name: string;
  readonly input?: unknown;
  readonly operationId?: string;
  readonly basedOn?: AssistantProjectionRevision;
  readonly fact?: 'materialized' | 'retained' | 'finalized';
}
export function createAssistantKey(): string;
export function createApplicationAgentKey(bindingId?: string): string;
export function proposeApplicationAssistant(options: AssistantEndpoint & AssistantExposure & {
  token: string; backupKeys?: readonly string[]; label: string; events?: readonly AssistantEventDefinition[]; signal?: AbortSignal; fetcher?: typeof fetch;
}): Promise<{ applicationId: string; proposed: string; approved: boolean; reviewUrl: string }>;
export function connectApplicationAssistant(options: AssistantEndpoint & {
  session: AssistantSession;
  tools: { operationId(rawOperationId: string, context: { caller: string }): Promise<string>;
    execute(call: AssistantToolRequest, options: { signal?: AbortSignal; caller: string; callerContext?: Readonly<AssistantCallerContext> }): Promise<unknown> };
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
}): (projection: { name: string; payload: unknown; observation: AssistantObservation; change?: 'upsert' | 'retract' }, event: { readonly id: string; readonly proposalId: string },
  batch: { readonly revision: AssistantProjectionRevision }, signal: AbortSignal) => Promise<void>;

export interface AssistantProjectionRevision { readonly digest: string; readonly view: 'local' | 'final'; readonly executionManifestDigest: string; readonly policyDigest: string }
/** Exporter observations are not cryptographic finality/retention verification by the host. */
export interface AssistantObservation { readonly stored: boolean; readonly materialized: null | { readonly outcome: 'accepted' | 'rejected'; readonly revision: AssistantProjectionRevision }; readonly retained: readonly unknown[]; readonly finalized: boolean; readonly excluded: boolean }
export function assistantRevision(value: unknown): AssistantProjectionRevision;
export function assistantObservation(value: unknown): AssistantObservation;
