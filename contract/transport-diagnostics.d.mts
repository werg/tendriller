/** Fixed, payload-free counters from the current link; null means unavailable. */
export interface TransportSignalRejections {
  readonly total: number | null;
  readonly clockSkew: number | null;
  readonly expired: number | null;
  readonly unauthorized: number | null;
  readonly duplicate: number | null;
  readonly capacity: number | null;
}
/** Cached authenticated-link evidence, never raw adapter selection or delivery proof. */
export interface TransportDiagnosticConnection {
  readonly link: number;
  /** The page agent's public @handle (without "@") when `agentHandle` names this link's signing key; otherwise null. */
  readonly agent: string | null;
  /** The route the participant selected for this link; `unknown` when the source does not say. */
  readonly kind: 'direct' | 'relay' | 'unknown';
  /** Why a relay link fell back from direct, when known. Always null for direct links. */
  readonly reason: 'direct_failed' | 'direct_timeout' | null;
  /** Reliable plus live framed payload on this link; null when the reliable lane is unmeasured. */
  readonly sentBytes: number | null;
  readonly receivedBytes: number | null;
  readonly sentReliableBytes: number | null;
  readonly receivedReliableBytes: number | null;
  readonly sentLiveBytes: number | null;
  readonly receivedLiveBytes: number | null;
  readonly signalRejections: TransportSignalRejections | null;
}
export interface TransportDiagnosticReport {
  readonly protocol: 'tendriller.transport-diagnostics.v1';
  readonly state: 'available' | 'unavailable' | 'closed';
  readonly phase: 'unknown' | 'connecting' | 'connected' | 'disconnected' | 'unavailable' | 'closed';
  readonly connectionRevision: number | null;
  readonly authenticatedPeers: number | null;
  readonly sampled: boolean;
  readonly limited: boolean;
  readonly error: 'timed_out' | 'invalid_diagnostics' | 'read_failed' | 'status_unavailable' | null;
  readonly connections: readonly TransportDiagnosticConnection[];
}
export interface TransportDiagnosticSource {
  readonly status?: unknown;
  diagnostics?(): Promise<readonly unknown[]>;
  onStatus?(listener: (status: unknown) => void): () => void;
}
export interface TransportDiagnosticOptions {
  readonly signal?: AbortSignal;
  /** Local read deadline in milliseconds (1–30000, default 5000). */
  readonly timeoutMs?: number;
  /** Maps an authenticated signing key to a known agent's public handle, or null. Evaluated locally on each status read. */
  readonly agentHandle?: (peerId: string) => string | null | undefined;
}
export interface TransportDiagnostics {
  status(): TransportDiagnosticReport;
  /** Coalesced, bounded local read. Never invokes host requests or peer negotiation. */
  refresh(): Promise<TransportDiagnosticReport>;
  onChange(listener: (report: TransportDiagnosticReport) => void): () => void;
  /** Detaches observation; never closes the participant or its links. */
  close(): void;
}
export interface RuntimeTransport extends Pick<TransportDiagnostics, 'status' | 'refresh' | 'onChange'> {
  /** Register this page's owned participant once. No session or network is opened. */
  install(participation: TransportDiagnosticSource): void;
}
