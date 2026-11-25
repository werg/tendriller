export const SETUP_WATCH_PROTOCOL: 'tendriller.setup.v1';
export interface SetupNotice { type: 'setup'; version: 1; assistant: { proposalId: string | null; approved: boolean; revision: string | null } }
export interface SetupWatchStatus {
  state: 'connected' | 'handler_failed' | 'access_revoked' | 'application_not_found' | 'reconnecting' | 'closed';
  retryInMs?: number;
  futureWakeVerified?: boolean;
  next?: string;
}
export function validateSetupNotice(value: unknown): SetupNotice;
export function watchApplicationSetup(options: { page: Pick<import('./client.mjs').PageClient, 'request' | 'socket'>; signal?: AbortSignal;
  onChange(notice: SetupNotice): void | Promise<void>; onStatus?(status: SetupWatchStatus): void;
  openSocket?(path: 'setup/watch', protocols: string[]): import('./peers.mjs').PeerSocket;
}): { readonly closed: Promise<void>; close(): Promise<void> };
