import type { EphemeralSignal, Signals, SignalPayload, SignalSendOptions } from './signals.mjs';
export declare const HOSTED_SIGNAL_PROTOCOL: 'tendriller.signals.v1';
export declare const SIGNAL_LIMITS: Readonly<{ bytes: number; ttlMs: number; futureSkewMs: number; pending: number; subscriptions: number; queue: number; latestKeys: number; connections: number }>;
export interface SignalInput { topic: string; payload: SignalPayload; issuedAtMs: number; expiresAtMs: number }
export declare function validateSignalTopic(topic: unknown): string;
export declare function createSignalInput(topic: string, payload: SignalPayload, options?: SignalSendOptions, now?: number): SignalInput;
export declare function validateSignalInput(value: unknown, now?: number): SignalInput;
export declare function validateSignalEnvelope(value: unknown): EphemeralSignal;
export interface HostedSignals extends Signals { readonly connected: boolean; close(error?: Error): void }
export interface HostedSignalTransport {
  connected(): boolean;
  request(message: { t: string; [key: string]: unknown }, options?: { signal?: AbortSignal }): Promise<any>;
  onMessage(listener: (message: unknown) => void): () => void;
  onConnection?(listener: () => void): () => void;
  close?(): void;
}
export declare function createHostedSignalPort(host: HostedSignalTransport): HostedSignals;
export interface HostedSignalConnectionOptions {
  base: string; protocols?: string[]; signal?: AbortSignal;
  open?: (url: string, protocols: string[]) => Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'addEventListener'>;
}
export declare function connectHostedSignals(options: HostedSignalConnectionOptions): Promise<HostedSignals>;
