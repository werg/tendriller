export const SETUP_WATCH_PROTOCOL: 'tendriller.setup.v1';
export interface SetupNotice { type: 'setup'; version: 1; assistant: { proposalId: string | null; approved: boolean; revision: string | null } }
export function validateSetupNotice(value: unknown): SetupNotice;
export function watchApplicationSetup(options: { api: string; token: string; signal?: AbortSignal;
  onChange(notice: SetupNotice): void | Promise<void>; onStatus?(status: { state: string; retryInMs?: number; futureWakeVerified?: boolean }): void;
  fetcher?: typeof fetch;
  openSocket?(url: string, protocols: string[]): WebSocket;
}): { readonly closed: Promise<void>; close(): Promise<void> };
