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
  /** Signed stream context; a local session owner supplies endpoint fields. */
  readonly stream?: SignalStream;
}
export interface SignalStream { readonly streamId: string; readonly endpointId?: string; readonly endpointIncarnation?: string; readonly target?: string }
export interface SignalStreamSelector { readonly authorId?: string; readonly sessionId?: string; readonly streamId?: string; readonly endpointId?: string; readonly endpointIncarnation?: string; readonly target?: string }
export interface SignalSendOptions { readonly ttlMs?: number; readonly signal?: AbortSignal; readonly stream?: SignalStream }
export interface SignalSubscribeOptions {
  readonly topics?: readonly string[];
  /** Exact selectors are applied before coalescing, so unrelated runs cannot suppress one another. */
  readonly streams?: readonly SignalStreamSelector[];
  /** all preserves bounded FIFO; latest coalesces by signed author/session/topic/endpoint/stream/target. */
  readonly mode?: 'all' | 'latest';
  readonly signal?: AbortSignal;
}
export interface Signals {
  /** Explicit best-effort reach, never an acknowledgement from every participant. */
  readonly delivery?: 'neighbors' | 'application';
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
