import type { WireContracts } from './wire.mjs';
export type { WireContracts } from './wire.mjs';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ValidationIssue { path: string; message: string }
export type PublicError = WireContracts['error'];
export type ErrorResponse = WireContracts['errorResponse'];
export type Role = 'owner' | 'guest' | 'display';
export type CreateRequest = WireContracts['create'];
export type ServiceDescriptor = WireContracts['serviceDescriptor'];
export interface RuntimeErrorEntry {
  readonly id: string;
  readonly at: number;
  readonly kind: "error" | "unhandledrejection" | "report";
  readonly message: string;
  readonly source?: string;
  readonly line?: number;
  readonly column?: number;
  readonly stack?: string;
  readonly context?: string;
}
export interface RuntimeErrors {
  list(): RuntimeErrorEntry[];
  on(listener: (entry: RuntimeErrorEntry) => void): () => void;
  report(error: unknown, context?: string): RuntimeErrorEntry;
  clear(): void;
}
export interface RuntimeLocalEventMap { ready: void; application_ready: void; capabilities: CapabilityReport; sensors: SensorStatus; sensors_stopped: { count: number }; error: RuntimeErrorEntry }
export interface PublicationAsset { path: string; sha256: string; type: string }
export interface RuntimeArtifactFeatures {
  speech: { model: string; url: string; sha256: string; size?: number; total_size?: number; languages?: string[];
    engine: { script: string; script_sha256: string; script_size?: number; wasm: string; wasm_sha256: string; wasm_size?: number } } | null;
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
/** Automatic core kinds plus application-defined cooperative resource kinds. */
export type SensorKind = "camera" | "microphone" | "screen" | "location" | "motion" | (string & {});
export type ResourcePhase = "pending" | "active" | "stopping" | "failed";
export interface RegisteredSensorOptions {
  /** Use a capability key (for example bluetooth or wake_lock) when one exists. */
  kind: string;
  /** Human-readable, local-only label displayed in Page options. */
  label?: string;
  /** Defaults to pending: register before starting a browser chooser/acquisition. */
  state?: ResourcePhase;
  /** Called at most once, after signal invalidation. Return asynchronous cleanup. */
  stop(): void | Promise<void>;
}
export interface RegisteredSensorHandle {
  readonly signal: AbortSignal;
  /** Ignored after cancellation; cannot revive an old acquisition. */
  setState(state: ResourcePhase): void;
  /** Abort and run cleanup at most once. Repeated disposal preserves failures; explicitly acknowledge only after manual recovery. */
  unregister(options?: { acknowledgeFailure: true }): void;
}
export interface RegisteredSensorStatus {
  readonly id: string;
  readonly kind: string;
  readonly label?: string;
  readonly state: ResourcePhase;
}
export interface SensorStatus {
  /** Observed use, a recent location fix, and custom resources in the active phase. */
  active: SensorKind[];
  /** Wrapped acquisitions and custom resources in the pending phase. */
  pending: SensorKind[];
  /** Present only while custom registrations exist, including stopping/failed cleanup. */
  resources?: RegisteredSensorStatus[];
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
  /** Local authenticated-link observation; explicit refresh never opens network work. */
  readonly transport: import("./transport-diagnostics.mjs").RuntimeTransport;
  /** Bounded boot-to-runtime error ring buffer; zero network work. */
  readonly errors: RuntimeErrors;
  on<K extends keyof RuntimeLocalEventMap>(type: K, fn: (payload: RuntimeLocalEventMap[K]) => void): () => void;
  /** Page UI readiness, independent of application synchronization. */
  ready(): void;
  /** No-prompt inspection. Unknown filter keys are ignored; an empty filter queries nothing. */
  capabilities(filter?: readonly string[]): Promise<CapabilityReport>;
  readonly version: number;
  readonly identity: Readonly<{ page: string; version: number; publication: string | null; documentPath: string | null; base: string; managementUrl: string }>;
  /** Browser installation state and an explicit native prompt; never registers offline support. */
  readonly installation: RuntimeInstallation;
  /** Pure URL builder for authored document/fragment links; preserves live or explicit pinned navigation. No fetch or navigation. */
  documentUrl(reference: string): string;
  /** Resolve an explicit runtime dependency against the publication-pinned runtime. */
  assetUrl(path: string): string;
  /** Resolves only after the exact required publication graph is saved by its service worker. */
  publication: {
    saveOffline(): Promise<{ id: string; status: "ready" }>;
    /** True only when this document was opened at its immutable /_publications/ID/ URL. */
    readonly pinned: boolean;
    /** A newer release is selected; the page switches at its next safe point. */
    readonly updateAvailable: boolean;
    /** Called with the selected version when it differs from this document's release; version null when the selection returns to it. */
    onUpdate(listener: (update: { version: number | null }) => void): () => void;
    /** Defer the automatic switch while there is unsaved work; call the result to release. */
    hold(): () => void;
    /** Load the latest selected release now. */
    update(): void;
  };
  sensors: {
    status(): SensorStatus;
    on(listener: (status: SensorStatus) => void): () => void;
    register(options: RegisteredSensorOptions): RegisteredSensorHandle;
    /** Number of newly stopped/cancelled resources; async cleanup may still be stopping. */
    stopAll(): number;
  };
}
/** Application work belongs to the installed session; host services are explicit. */
export interface RuntimeApi extends RuntimeServices {}
export type Contracts = WireContracts;
export const CONTRACT_VERSION: 3;
export const CORE_RELEASE: '0.3.0-rc.12';
export { RESOURCE_LIMITS } from './limits.mjs';
export { assertFilePath } from './paths.mjs';
export const ROLES: readonly Role[];
export const schemas: Readonly<Record<keyof Contracts, Record<string, any>>>;
export const schemaDocument: Readonly<{ $schema: string; $id: string; title: string; $defs: typeof schemas }>;
export function validateSchema(schema: Record<string, any>, value: unknown, path?: string): ValidationIssue[];
export function validate<K extends keyof Contracts>(name: K, value: unknown): ValidationIssue[];
export function assertValid<K extends keyof Contracts>(name: K, value: unknown): Contracts[K];
export class ContractError extends TypeError { code: "bad_request"; issues: ValidationIssue[]; constructor(issues: ValidationIssue[]) }
