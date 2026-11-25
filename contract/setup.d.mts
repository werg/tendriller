export { watchApplicationSetup, validateSetupNotice, SETUP_WATCH_PROTOCOL, type SetupNotice, type SetupWatchStatus } from './setup-watch.mjs';
/** Host-only canonicalization for the current server's account-setup route; removed with it. */
export interface SetupRequest { operationId: string; name: string; mode: 'interactive' | 'dashboard'; applicationId: string; credentialCommitment: string }
export interface SetupResult { schemaVersion: 1; serviceOrigin: string; operationId: string; requestDigest: string; credentialCommitment: string;
  state: 'prepared' | 'provisioning' | 'ready' | 'blocked' | 'expired' | 'reconciliation_required'; code: string | null; nextAction: string;
  pageId: string; applicationId: string; expiresAt: number; page?: Record<string, unknown> }
export function setupRequest(value: SetupRequest): SetupRequest;
export function setupRequestDigest(service: string, value: SetupRequest): Promise<string>;
