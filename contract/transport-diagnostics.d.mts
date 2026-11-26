/** Fixed, payload-free counters from the current link; null means unavailable. */
export interface TransportSignalRejections {
  readonly total: number | null;
  readonly clockSkew: number | null;
  readonly expired: number | null;
  readonly unauthorized: number | null;
  readonly duplicate: number | null;
  readonly capacity: number | null;
}
/**
 * A bounded, local description of an authenticated peer:
 * - `agent`: a page agent, with its public handle (without "@") when known;
 * - `own-device`: another device signed in to the viewer's own account, with a short safe label when known;
 * - `member`: another admitted member, with its host-verified email when known;
 * - `unknown`: no description.
 */
export interface TransportPeer {
  readonly role: 'agent' | 'own-device' | 'member' | 'unknown';
  readonly handle: string | null;
  readonly label: string | null;
  readonly email: string | null;
  /** Whether the signed page membership makes this peer an administrator; null when not described. */
  readonly administrator: boolean | null;
}
export type TransportPeerDescription =
  | { readonly role: 'agent'; readonly handle?: string | null; readonly administrator?: boolean | null }
  | { readonly role: 'own-device'; readonly label?: string | null; readonly administrator?: boolean | null }
  | { readonly role: 'member'; readonly email?: string | null; readonly administrator?: boolean | null };
/** Cached authenticated-link evidence, never raw adapter selection or delivery proof. */
export interface TransportDiagnosticConnection {
  readonly link: number;
  /** Who is on the other end, from the local `describePeer` lookup; `unknown` without one. Never the key. */
  readonly peer: TransportPeer;
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
  /** Owner extensions. When the owner composes page admission, the runtime reads its
   * `admission.state` locally to name links; peer keys never leave this page. */
  readonly extensions?: {
    call(name: string, args?: readonly unknown[]): Promise<unknown>;
    subscribe(listener: (notice: unknown) => void): () => void;
  };
}
export interface TransportDiagnosticOptions {
  readonly signal?: AbortSignal;
  /** Local read deadline in milliseconds (1–30000, default 5000). */
  readonly timeoutMs?: number;
  /** Describes an authenticated signing key (agent, own device or member), or null. Evaluated locally on each status read. */
  readonly describePeer?: (peerId: string) => TransportPeerDescription | null | undefined;
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
