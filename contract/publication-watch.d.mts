export interface PublicationSelectionNotice { readonly type: 'publication'; readonly version: 1; readonly current: number }
/** Persistent receive-only page-origin subscription, independent of application enrollment. */
export function watchPublicationUpdates(options: { base: string; signal?: AbortSignal;
  onCurrent(notice: PublicationSelectionNotice): void;
  onStatus?(status: { state: 'connected' | 'reconnecting' | 'access_ended' | 'protocol_error'; retryInMs?: number }): void;
}): { close(): void };
