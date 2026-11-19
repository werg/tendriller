import type { WireContracts } from './wire.mjs';
export type { WireContracts } from './wire.mjs';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ValidationIssue { path: string; message: string }
export type PublicError = WireContracts['error'];
export type ErrorResponse = WireContracts['errorResponse'];
export type Role = 'owner' | 'guest' | 'display';
export type CreateRequest = WireContracts['create'];
export type ServiceDescriptor = WireContracts['serviceDescriptor'];
export interface RuntimeLocalEventMap { ready: void; application_ready: void; capabilities: CapabilityReport; sensors: SensorStatus; sensors_stopped: { count: number } }
export interface PublicationAsset { path: string; sha256: string; type: string }
export interface RuntimeArtifactFeatures {
  speech: { model: string; url: string; sha256: string; engine: { script: string; wasm: string; wasm_sha256: string } } | null;
}
export interface PublicationManifest {
  id: string; base: string;
  /** Canonical authored root entry, identical for every document in this publication. */
  entry: string;
  runtime: { version: string; id?: string; base: string; assets?: PublicationAsset[]; features?: RuntimeArtifactFeatures };
  assets: PublicationAsset[];
}
export type RuntimeConfiguration = {
  id: string; base: string; version: number;
  features: RuntimeArtifactFeatures & { shared_by: string };
  application: import("./application.mjs").ApplicationSelection;
  /** Public resident introduction addresses supplied with the initial page. */
  peerBootstrap?: import("./peers.mjs").PeerBootstrap;
} & (
  /** Decoded logical path of this document, independently of the publication's root entry. */
  { publication: PublicationManifest; documentPath: string }
  | { publication?: undefined; documentPath: null }
);
export type SensorKind = "camera" | "microphone" | "screen" | "location" | "motion";
export interface SensorStatus {
  /** Observed live resources, registered watches/listeners, or a recent location fix. */
  active: SensorKind[];
  /** Wrapped media acquisitions and one-shot location reads awaiting a native result. */
  pending: SensorKind[];
}
export interface Capability { available: boolean; permission: "granted" | "prompt" | "denied" | "unknown"; needs_user_tap: boolean; active: boolean | null; note?: string }
export interface CapabilityReport { captured_at: number; secure: boolean; device: string; capabilities: Record<string, Capability> }
export interface InstallationStatus {
  /** available means the browser supplied a native prompt; manual means browser-menu instructions are needed. */
  state: "installed" | "available" | "manual" | "unavailable";
  platform: "ios" | "android" | "desktop";
}
export interface RuntimeInstallation {
  status(): InstallationStatus;
  /** Observe subsequent changes. Read status() for the initial snapshot. */
  on(listener: (status: InstallationStatus) => void): () => void;
  /** Call directly from a user gesture. accepted is a choice, not confirmation that installation completed. */
  prompt(): Promise<"accepted" | "dismissed" | "unavailable">;
}
/** Explicit hosted operations. Constructing these services starts no connection or request. */
export interface HostServices {
  readonly peers: import("./peers.mjs").PeersClient;
  request<T = unknown>(path: string, options?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal }): Promise<T>;
}
export interface RuntimeServices {
  readonly host: HostServices;
  readonly signals: import("./signals.mjs").SignalBinding;
  readonly application: import("./application.mjs").ApplicationBinding;
  on<K extends keyof RuntimeLocalEventMap>(type: K, fn: (payload: RuntimeLocalEventMap[K]) => void): () => void;
  /** Page UI readiness, independent of application synchronization. */
  ready(): void;
  capabilities(): Promise<CapabilityReport>;
  readonly version: number;
  readonly identity: Readonly<{ page: string; version: number; publication: string | null; documentPath: string | null; base: string; managementUrl: string }>;
  /** Browser installation state and an explicit native prompt; never registers offline support. */
  readonly installation: RuntimeInstallation;
  /** Resolve an explicit runtime dependency against the publication-pinned runtime. */
  assetUrl(path: string): string;
  /** Resolves only after the exact required publication graph is saved by its service worker. */
  publication: { saveOffline(): Promise<{ id: string; status: "ready" }> };
  sensors: { status(): SensorStatus; on(listener: (status: SensorStatus) => void): () => void; stopAll(): number };
}
/** Application work belongs to the installed session; host services are explicit. */
export interface RuntimeApi extends RuntimeServices {}
export type Contracts = WireContracts;
export const CONTRACT_VERSION: 3;
export const CORE_RELEASE: '0.3.0-rc.10';
export { RESOURCE_LIMITS } from './limits.mjs';
export { assertFilePath } from './paths.mjs';
export const ROLES: readonly Role[];
export const schemas: Readonly<Record<keyof Contracts, Record<string, any>>>;
export const schemaDocument: Readonly<{ $schema: string; $id: string; title: string; $defs: typeof schemas }>;
export function validateSchema(schema: Record<string, any>, value: unknown, path?: string): ValidationIssue[];
export function validate<K extends keyof Contracts>(name: K, value: unknown): ValidationIssue[];
export function assertValid<K extends keyof Contracts>(name: K, value: unknown): Contracts[K];
export class ContractError extends TypeError { code: "bad_request"; issues: ValidationIssue[]; constructor(issues: ValidationIssue[]) }
