import type { ApplicationSession } from '@chronolog/peer-session';
import type { WorkerApplicationSession } from '@chronolog/peer-session/browser';
export declare const DIAGNOSTIC_PROTOCOL:'tendriller.diagnostics.v1';
export interface DiagnosticFinding {
  readonly code:string;readonly severity:'info'|'warning'|'error';readonly scope:Readonly<Record<string,string>>;
  readonly state:Readonly<Record<string,string|number|boolean>>;readonly retrySafe:boolean;readonly nextAction:string;
}
export interface DiagnosticEndpoint {
  readonly ownerInstanceId?:string;readonly endpointId?:string;readonly endpointIncarnation?:string;readonly state?:string;
  readonly identity:Readonly<Record<string,string>>;readonly context:Readonly<Record<string,string>>;readonly capabilities:readonly string[]|null;
}
export interface DiagnosticReport {
  readonly protocol:typeof DIAGNOSTIC_PROTOCOL;readonly assessment:'ready'|'attention-required'|'unavailable';
  readonly identity:{readonly mode:string;readonly applicationId:string|null;readonly publicKey:string|null;readonly endpoint:DiagnosticEndpoint|null};
  readonly scope:Readonly<Record<string,string>>;readonly status:Readonly<Record<string,string|number|boolean>>;
  readonly definition:{readonly id?:string;readonly version?:string;readonly commands:readonly string[];readonly queries:readonly string[]}|null;
  readonly participation:{readonly phase:'connected'|'disconnected'|'closed';readonly connectedPeers:number|null}|null;
  readonly transport:import('../contract/transport-diagnostics.mjs').TransportDiagnosticReport;
  readonly capabilities:readonly string[]|null;readonly endpoints?:readonly (DiagnosticEndpoint|null)[];readonly findings:readonly DiagnosticFinding[];
}
export declare function diagnosticFinding(error:unknown,options?:{scope?:Record<string,unknown>;state?:Record<string,unknown>;severity?:'info'|'warning'|'error'}):DiagnosticFinding;
export declare function diagnoseApplicationSession(session:ApplicationSession|WorkerApplicationSession,options?:{mode?:'attach'|'own'|'independent';signal?:AbortSignal}):Promise<DiagnosticReport>;
