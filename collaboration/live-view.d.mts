import type { ApplicationSession, PeerRevision } from '@chronolog/peer-session';

export type LiveViewStatus = ApplicationSession['status'];
export type LiveViewRecovery = Parameters<Parameters<ApplicationSession['onRecovery']>[0]>[0];
export interface LiveViewSnapshot<Value = unknown> {
  readonly revision: PeerRevision;
  readonly value: Value;
}
/** Only public observation/query methods; this helper never owns the session. */
export interface LiveViewSession<Query extends string, Input, Value> {
  readonly signal: AbortSignal;
  query(name: Query, input: Input): Promise<LiveViewSnapshot<Value>>;
  onStatus(listener: (status: LiveViewStatus) => void): () => void;
  onRecovery(listener: (notice: LiveViewRecovery) => void): () => void;
  changes(options: { signal: AbortSignal }): ReturnType<ApplicationSession['changes']>;
}
export interface LiveViewOptions<Query extends string, Input, Value> {
  query: Query;
  input?: Input;
  signal?: AbortSignal;
  onSnapshot?: (snapshot: LiveViewSnapshot<Value>) => void;
  onStatus?: (status: LiveViewStatus) => void;
  onRecovery?: (notice: LiveViewRecovery) => void;
  onError?: (error: unknown) => void;
}
export interface LiveView<Value = unknown> {
  readonly snapshot: LiveViewSnapshot<Value> | null;
  readonly status: LiveViewStatus | null;
  readonly error: unknown;
  /** One fixed deadline (default 30 seconds), surviving initial PEER_RECOVERING
   * through status/change events. Fatal errors and cancellation reject exactly. */
  ready(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<LiveViewSnapshot<Value>>;
  refresh(): Promise<LiveViewSnapshot<Value>>;
  subscribe(listener: (snapshot: LiveViewSnapshot<Value>) => void): () => void;
  /** Stops observation and waiters; never closes the supplied session. */
  close(): void;
}
export declare function createLiveView<Query extends string, Input = null, Value = unknown>(
  session: LiveViewSession<Query, Input, Value>, options: LiveViewOptions<NoInfer<Query>, NoInfer<Input>, NoInfer<Value>>,
): LiveView<Value>;
