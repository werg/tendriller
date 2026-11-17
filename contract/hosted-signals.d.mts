import type { EphemeralSignal, Signals, SignalPayload, SignalSendOptions, SignalSubscribeOptions } from './signals.mjs';
export declare const HOSTED_SIGNAL_PROTOCOL: 'tendriller.signals.v1';
export declare const SIGNAL_LIMITS: Readonly<{ payloadBytes: number; frameBytes: number; ttlMs: number; futureSkewMs: number;
  requestTimeoutMs: number; pendingSends: number; subscriptions: number; pendingMessages: number; pendingBytes: number; latestKeys: number;
  connections: number; messagesPerSecond: number; authorizations: number }>;
export interface SignalInput { readonly topic: string; readonly payload: SignalPayload; readonly issuedAtMs: number; readonly expiresAtMs: number }
export declare function validateSignalTopic(topic: unknown): string;
export declare function createSignalInput(topic: string, payload: SignalPayload, options?: Pick<SignalSendOptions, 'ttlMs'>, now?: number): SignalInput;
export declare function validateSignalInput(value: unknown, now?: number): SignalInput;
export declare function validateSignalEnvelope(value: unknown): EphemeralSignal;
export interface HostedSignals extends Signals {
  readonly connected: boolean;
  subscribe(options?: SignalSubscribeOptions): AsyncIterableIterator<EphemeralSignal>;
  close(error?: unknown): void;
}
/** Requests must abort when their signal aborts and must never queue or retry offline. */
export interface HostedSignalTransport {
  connected(): boolean;
  scope(): string;
  request(message: { t: string; message?: SignalInput }, options: { signal: AbortSignal }): Promise<{ signal?: EphemeralSignal }>;
  onMessage(listener: (signal: unknown) => void): () => void;
  onConnection?(listener: () => void): () => void;
  close?(): void;
  now?(): number;
}
export declare function createHostedSignalPort(host: HostedSignalTransport): HostedSignals;
export interface HostedSignalConnectionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly open?: (url: string, protocols: string[]) => Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'>;
}
export declare function connectHostedSignals(options: HostedSignalConnectionOptions & { base: string; protocols?: string[] }): Promise<HostedSignals>;
