import type { Tendril } from './tendril';
export function initializeAssistantDevice(t: Tendril, create?: boolean): Promise<string>;
export function openAssistantSession(t: Tendril, options: {
  applicationId: string;
  definition: unknown;
  onDevice(publicKey: string): void;
  exchange(path: string, options: { method: string; body?: unknown; signal?: AbortSignal }): Promise<unknown>;
  upgrade(url: URL, protocols: string[]): Promise<Response>;
}): (options?: { signal?: AbortSignal }) => Promise<unknown>;
