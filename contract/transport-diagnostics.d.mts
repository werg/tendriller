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
  readonly kind: 'direct' | 'relay' | 'unknown';
  readonly reason: 'direct_failed' | 'direct_timeout' | null;
  readonly sentBytes: number | null;
  readonly receivedBytes: number | null;
  readonly sentReliableBytes: number | null;
  readonly receivedReliableBytes: number | null;
  readonly sentLiveBytes: number | null;
  readonly receivedLiveBytes: number | null;
  readonly sentRequests: number | null;
  readonly receivedRequests: number | null;
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
