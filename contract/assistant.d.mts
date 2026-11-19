export interface AssistantEventDefinition { name: string; description: string }
export interface AssistantEndpoint { api: string; key: string }
export interface AssistantExposure { queries?: readonly string[]; commands?: readonly string[] }
interface AssistantSession {
  readonly applicationId: string;
  readonly deviceId: string;
  readonly status: { readonly generation: string };
  readonly signal: AbortSignal;
}
export interface AssistantParticipant {
  readonly online: boolean;
  readonly closed: Promise<void>;
  close(): Promise<void>;
  waitUntilOnline(options?: { signal?: AbortSignal }): Promise<void>;
  publish(event: { sourceEventId: string; name: string; generation: string; payload: unknown }): Promise<number>;
}
export function createAssistantKey(): string;
export function proposeApplicationAssistant(options: AssistantEndpoint & AssistantExposure & {
  token: string; backupKeys?: readonly string[]; label: string; events?: readonly AssistantEventDefinition[]; signal?: AbortSignal; fetcher?: typeof fetch;
}): Promise<{ applicationId: string; proposed: string; approved: boolean; reviewUrl: string }>;
export function connectApplicationAssistant(options: AssistantEndpoint & AssistantExposure & {
  session: AssistantSession;
  tools: { call(name: string, input: unknown, options?: { signal?: AbortSignal }): Promise<unknown> };
  onStatus?: (status: { state: string; reason?: string; retryInMs?: number }) => void;
  openSocket?: (url: string, protocols: string[]) => WebSocket;
  signal?: AbortSignal;
}): AssistantParticipant;
export function forwardApplicationEvents<Event extends { readonly id: string }>(options: {
  session: AssistantSession & {
    changes(options?: { signal?: AbortSignal }): AsyncIterable<{ kind: string }>;
    readView(): Promise<{
      readEvents(options: { topics: readonly string[]; cursor?: string; limit?: number }):
        { readonly events: readonly Event[]; readonly cursor: string; readonly hasMore: boolean; readonly revision: { readonly generation: string } };
      release(): void | Promise<void>;
    }>;
  };
  assistant: AssistantParticipant; topics: readonly string[];
  project(event: Event): { name: string; payload: unknown } | null | Promise<{ name: string; payload: unknown } | null>;
  onSkipped?: (event: { name: string; sourceEventId: string }) => void;
  checkpoint: { load(): string | undefined | Promise<string | undefined>; save(cursor: string): void | Promise<void> };
  signal?: AbortSignal;
}): Promise<void>;
