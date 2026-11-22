export { watchApplicationSetup, validateSetupNotice, SETUP_WATCH_PROTOCOL, type SetupNotice, type SetupWatchStatus } from './setup-watch.mjs';
import type { PageHandle } from './client.mjs';
export interface SetupInput { operationId: string; name?: string; mode?: 'interactive' | 'dashboard'; applicationId?: string }
export interface SetupRequest { operationId: string; name: string; mode: 'interactive' | 'dashboard'; applicationId: string; credentialCommitment: string }
export interface SetupIntent extends SetupRequest { schemaVersion: 1; serviceOrigin: string; credential: string; requestDigest: string }
export interface SetupStore { load(operationId: string): Promise<SetupIntent | null | undefined>; /** Atomically create if absent; never replace retained state. */ save(operationId: string, intent: SetupIntent): Promise<void> }
export interface SetupResult { schemaVersion: 1; serviceOrigin: string; operationId: string; requestDigest: string; credentialCommitment: string;
  state: 'prepared' | 'provisioning' | 'ready' | 'blocked' | 'expired' | 'reconciliation_required'; code: string | null; nextAction: string;
  pageId: string; applicationId: string; expiresAt: number; page?: Omit<PageHandle, 'token'> }
export function setupRequest(value: SetupRequest | SetupIntent): SetupRequest;
export function setupRequestDigest(service: string, value: SetupRequest | SetupIntent): Promise<string>;
export function createSetupIntent(service: string, input: SetupInput, options: { store: SetupStore }): Promise<SetupIntent>;
export function completeSetupIntent(intent: SetupIntent, result: SetupResult): Promise<PageHandle>;
export interface SetupHttpOptions { accessToken: string; fetch?: typeof globalThis.fetch; signal?: AbortSignal }
export function prepareTendrilSetup(intent: SetupIntent, options: SetupHttpOptions): Promise<SetupResult>;
export function inspectTendrilSetup(service: string, operationId: string, options: SetupHttpOptions): Promise<SetupResult>;
export function listTendrilSetups(service: string, options: SetupHttpOptions): Promise<{ serviceOrigin: string; setups: SetupResult[] }>;
