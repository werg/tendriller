import type { TransportDiagnosticSource, TransportDiagnostics } from '../contract/transport-diagnostics.mjs';
export type { TransportDiagnosticSource, TransportDiagnostics, TransportDiagnosticReport, TransportDiagnosticConnection, TransportSignalRejections } from '../contract/transport-diagnostics.mjs';
export declare const TRANSPORT_DIAGNOSTIC_PROTOCOL: 'tendriller.transport-diagnostics.v1';
export declare const TRANSPORT_DIAGNOSTIC_LIMIT: 64;
export declare function createTransportDiagnostics(participation?: TransportDiagnosticSource, options?: { signal?: AbortSignal; timeoutMs?: number }): TransportDiagnostics;
export declare function readTransportDiagnostics(participation?: TransportDiagnosticSource, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<import('../contract/transport-diagnostics.mjs').TransportDiagnosticReport>;
