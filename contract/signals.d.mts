/** Live application data. Signals have no durable identity, replay cursor or finality. */
export type SignalPayload = null | boolean | number | string | readonly SignalPayload[] | { readonly [key: string]: SignalPayload };
export interface EphemeralSignal {
  readonly scope: string;
  readonly authorId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly topic: string;
  readonly payload: SignalPayload;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}
export interface SignalSendOptions { readonly ttlMs?: number; readonly signal?: AbortSignal }
export interface SignalSubscribeOptions {
  readonly topics?: readonly string[];
  /** all preserves admitted messages in a bounded FIFO; latest replaces pending author/session/topic values. */
  readonly mode?: 'all' | 'latest';
  readonly signal?: AbortSignal;
}
export interface Signals {
  /** Dispatch on live routes. Completion does not acknowledge remote receipt or application processing. */
  send(topic: string, payload: SignalPayload, options?: SignalSendOptions): Promise<EphemeralSignal>;
  subscribe(options?: SignalSubscribeOptions): AsyncIterable<EphemeralSignal>;
}
export interface SignalBinding extends Signals {
  /** An installed implementation, not a claim that a remote peer is reachable. */
  readonly available: boolean;
  /** Explicitly wait for composition. send/subscribe never wait or queue for installation. */
  ready(): Promise<Signals>;
  /** Install once, independently of the durable application backend. Reconnect within that implementation. */
  install(signals: Signals): void;
}
export declare class SignalError extends Error { readonly code: string; constructor(code: string, message: string) }
/** No sockets, timers, persistence, host fallback, Chronolog imports or protocol assumptions. */
export declare function createSignalBinding(initial?: Signals): SignalBinding;
