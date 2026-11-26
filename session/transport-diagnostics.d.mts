import type { TransportDiagnosticOptions, TransportDiagnosticSource, TransportDiagnostics } from '../contract/transport-diagnostics.mjs';
export type { TransportDiagnosticOptions, TransportPeer, TransportPeerDescription, TransportDiagnosticSource, TransportDiagnostics, TransportDiagnosticReport, TransportDiagnosticConnection, TransportSignalRejections } from '../contract/transport-diagnostics.mjs';
export declare const TRANSPORT_DIAGNOSTIC_PROTOCOL: 'tendriller.transport-diagnostics.v1';
export declare const TRANSPORT_DIAGNOSTIC_LIMIT: 64;
export declare function createTransportDiagnostics(participation?: TransportDiagnosticSource, options?: TransportDiagnosticOptions): TransportDiagnostics;
export declare function readTransportDiagnostics(participation?: TransportDiagnosticSource, options?: TransportDiagnosticOptions): Promise<import('../contract/transport-diagnostics.mjs').TransportDiagnosticReport>;
