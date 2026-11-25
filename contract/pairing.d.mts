import type { PeerIdentity, SignedGeneration, SignedTransitionRequest, PeerGrant, HistoryPoint } from '@chronolog/peer-session';
export declare const DEVICE_PAIRING_DOMAIN: 'tendriller-device-pairing-v1';
export declare const DEVICE_PAIRING_LIMITS: Readonly<{ lifetimeMs: number; pendingPerAccount: number; retainedPerApplication: number;
  invalidProofs: number; challengesPerMinute: number; requestBytes: number; commitBytes: number }>;
export interface DevicePairingRights { readonly reader: true; readonly writer: boolean }
export interface DevicePairingChallenge {
  readonly version: 1; readonly domain: typeof DEVICE_PAIRING_DOMAIN; readonly pairingId: string; readonly requestId: string;
  readonly serviceOrigin: string; readonly pageOrigin: string; readonly applicationId: string; readonly accountId: string;
  readonly publicKey: string; readonly rights: DevicePairingRights; readonly expectedGeneration: string;
  readonly controlRevision: number; readonly nonce: string; readonly expiresAt: number;
}
export interface DevicePairingControl {
  readonly epoch: number; readonly keyDigest: string; readonly grants: readonly PeerGrant[]; readonly recoveryFloor: HistoryPoint | null;
  readonly accounts: readonly { readonly publicKey: string; readonly accountId: string }[];
}
export interface DevicePairingPrepared { readonly request: SignedTransitionRequest; readonly control: DevicePairingControl }
export type DevicePairingState = 'challenge' | 'pending' | 'approved' | 'committing' | 'committed' | 'expired' | 'denied' | 'stale' | 'revoked' | 'reconciliation_required';
export interface DevicePairingStatus {
  readonly pairingId: string; readonly requestId: string; readonly state: DevicePairingState;
  readonly challenge: DevicePairingChallenge; readonly expiresAt: number; readonly nextAction: string;
  readonly generation?: SignedGeneration; readonly preparedDigest?: string; readonly prepared?: DevicePairingPrepared;
}
export declare function validateDevicePairingChallenge(value: unknown): DevicePairingChallenge;
export declare function pairingProofBytes(challenge: DevicePairingChallenge): Uint8Array;
export declare function signDevicePairingChallenge(challenge: DevicePairingChallenge, identity: PeerIdentity): Promise<string>;
export declare function verifyDevicePairingProof(challenge: DevicePairingChallenge, signature: string): Promise<boolean>;
export interface DevicePairingRequestOptions { readonly signal?: AbortSignal }
export interface DevicePairingClient {
  challenge(input: { requestId: string; publicKey: string; rights: DevicePairingRights }, options?: DevicePairingRequestOptions): Promise<DevicePairingStatus>;
  prove(pairingId: string, signature: string, options?: DevicePairingRequestOptions): Promise<DevicePairingStatus>;
  inspect(pairingId: string, options?: DevicePairingRequestOptions): Promise<DevicePairingStatus>;
  pending(options?: DevicePairingRequestOptions): Promise<{ pairings: DevicePairingStatus[] }>;
  /** Retain and verify the exact native attempt for owner review, without selecting a generation. */
  prepare(pairingId: string, prepared: DevicePairingPrepared, options?: DevicePairingRequestOptions): Promise<DevicePairingStatus>;
  commit(pairingId: string, prepared: DevicePairingPrepared, options?: DevicePairingRequestOptions): Promise<DevicePairingStatus>;
}
export declare function createDevicePairingClient(options: { url: string | URL; fetch?: typeof fetch; headers?: HeadersInit }): DevicePairingClient;
