import type { EphemeralSignal, SignalPayload, Signals } from './signals.mjs';
export declare const HOSTED_SIGNAL_PROTOCOL: 'tendriller.signals.v1';
export declare const HOSTED_SIGNAL_LIMITS: Readonly<{ payloadBytes: number; frameBytes: number; defaultTtlMs: number; maxTtlMs: number; futureSkewMs: number;
  subscriptions: number; queuedSignals: number; queuedBytes: number; pendingRequests: number; inFlightFrames: number;
  jsonValues: number; latestKeys: number; sendsPerSecond: number; connections: number }>;
export declare function signalTopic(value: unknown): string;
export declare function signalPayload(value: unknown): SignalPayload;
export declare function validateHostedSignal(value: unknown, scope?: string): EphemeralSignal;
export interface HostedSignalTransport {
  connected(): boolean;
  send(message: Record<string, unknown>): boolean;
  onMessage(listener: (message: any) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  readonly scope?: string;
  readonly now?: () => number;
}
export interface HostedSignals extends Signals { readonly connected: boolean; close(): void }
export interface HostedSignalConnectionOptions {
  readonly api: string;
  /** Agent token; omit for the cookie-authenticated page endpoint. */
  readonly token?: string;
  readonly socket?: (url: string, protocols: readonly string[]) => import('./peers.mjs').PeerSocket;
  readonly signal?: AbortSignal;
}
export declare function createHostedSignals(transport: HostedSignalTransport): HostedSignals;
export declare function connectHostedSignals(options: HostedSignalConnectionOptions): Promise<HostedSignals>;
