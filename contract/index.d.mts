import type { WireContracts } from './wire.mjs';
export type { WireContracts } from './wire.mjs';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ValidationIssue { path: string; message: string }
export type PublicError = WireContracts['error'];
export type ErrorResponse = WireContracts['errorResponse'];
export type Role = 'owner' | 'guest' | 'display';
export type AgentRegistration = WireContracts['agentRegistration'];
export type AgentPageCreate = WireContracts['agentPageCreate'];
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
export type PublicationUpdatePhase = "current" | "applying" | "deferred" | "pinned";
export interface PublicationUpdate {
  readonly version: number | null;
  readonly kind?: "hot-swapped" | "reload" | "reverted";
  readonly phase?: PublicationUpdatePhase;
  readonly reasons?: readonly string[];
  readonly publication?: PublicationManifest | null;
  readonly changedPaths?: readonly string[];
}
export interface SlotContext<T = Record<string, unknown>> {
  readonly name: string;
  readonly path: string;
  readonly version: number;
  readonly publication: PublicationManifest | null;
  /** Aborted automatically just before unmount or live hot-swap. */
  readonly signal: AbortSignal;
  /** Ephemeral in-memory map preserved across live hot-swaps of this slot and cleared on dispose. */
  readonly slotState: Map<string, unknown>;
  /** Application-supplied services (e.g. session, signals, rtc, runtime). */
  readonly app: T;
}
export interface SlotModule<T = Record<string, unknown>> {
  mount(root: HTMLElement | ShadowRoot, ctx: SlotContext<T>): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
export interface MountSlotOptions<T = Record<string, unknown>> {
  /** Relative ES module path inside the publication (e.g. "slots/stage.mjs"). */
  readonly module: string;
  /** Additional relative file paths or directory prefixes (ending in "/") owned by this slot that may change without forcing a page reload. */
  readonly owns?: readonly string[];
  /** Passed as `ctx.app` to the slot's `mount()`. */
  readonly context?: T;
  /** "shadow" (default) isolates CSS & DOM inside an open ShadowRoot; "light" mounts directly in the container. */
  readonly isolation?: "shadow" | "light";
  readonly onSwap?: (info: { readonly name: string; readonly path: string; readonly version: number; readonly publicationId: string | null; readonly hash: string | null; readonly initial: boolean }) => void;
  readonly onError?: (error: unknown, info: { readonly name: string; readonly path: string; readonly version: number; readonly phase: "import" | "mount" | "unmount" }) => void;
}
export interface MountedSlot {
  readonly name: string;
  readonly path: string;
  readonly version: number;
  readonly publicationId: string | null;
  select(modulePath: string): Promise<void>;
  reload(): Promise<void>;
  dispose(): Promise<void>;
}
export interface FacetDescriptor {
  readonly id: string;
  readonly title: string;
  readonly module: string;
  readonly description?: string;
  /** Optional roles this facet is designed for (e.g. ["owner", "guest", "display"]). */
  readonly roles?: readonly Role[];
}
export interface FacetsManifest {
  readonly default: string;
  /**
   * Optional declarative routing rules mapping selectors to a facet id.
   * Supported keys: "role:<owner|guest|display>", "form:<phone|tablet|desktop>",
   * "role:<role>+form:<form>", "participant:<id>", "device:<id>".
   */
  readonly defaultFor?: Readonly<Record<string, string>>;
  readonly facets: readonly FacetDescriptor[];
}
export interface FacetBindingSource {
  /** Return the currently assigned facet id for this device/participant/role, or null for default routing. */
  resolve(): string | null;
  /** Subscribe to live binding changes (e.g. Chronolog session updates); returns unsubscribe fn. */
  onChange(listener: () => void): () => void;
}
export interface MountFacetsOptions<T = Record<string, unknown>> {
  /** Relative path to a JSON facets manifest in the publication (default "facets.json") or an inline manifest object. */
  readonly manifest?: string | FacetsManifest;
  /** Query parameter carrying the active facet id in shareable URLs (default "view"). */
  readonly param?: string;
  /** Optional fallback facet id overriding manifest.default when no URL parameter is present. */
  readonly defaultFacet?: string;
  /** Viewer role override (defaults to `tendril.identity.role`). */
  readonly role?: Role;
  /** Optional authenticated participant identifier (e.g. account id or @handle) for `participant:` routing. */
  readonly participantId?: string;
  /** Optional device identifier (e.g. signing public key) for `device:` routing. */
  readonly deviceId?: string;
  /** Optional device form factor override ("phone" | "tablet" | "desktop"); auto-detected from viewport when omitted. */
  readonly formFactor?: "phone" | "tablet" | "desktop";
  /** Optional live per-participant / per-device Chronolog view binding source. */
  readonly bindings?: FacetBindingSource;
  /** Remember explicit manual facet switches on this device in localStorage (default false). */
  readonly rememberDevice?: boolean;
  /** Additional relative file paths or directory prefixes owned by these facets. */
  readonly owns?: readonly string[];
  readonly context?: T;
  readonly isolation?: "shadow" | "light";
  readonly onChange?: (state: { readonly current: FacetDescriptor; readonly facets: readonly FacetDescriptor[] }) => void;
  readonly onSwap?: MountSlotOptions<T>["onSwap"];
  readonly onError?: MountSlotOptions<T>["onError"];
}
export interface MountedFacets {
  readonly current: FacetDescriptor;
  list(): readonly FacetDescriptor[];
  /** Facets available to the current viewer role (omitting facets restricted to other roles). */
  visible(): readonly FacetDescriptor[];
  select(id: string, options?: { readonly replace?: boolean }): Promise<void>;
  url(id: string, options?: { readonly pinned?: boolean }): string;
  onChange(listener: (state: { readonly current: FacetDescriptor; readonly facets: readonly FacetDescriptor[] }) => void): () => void;
  dispose(): Promise<void>;
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
  /** Owner pages only: draw the page's icon SVGs into 512px PNGs for Android home-screen installs. */
  iconRaster?: { key: string };
  /** Trusted service Ed25519 public keys for verifying signed system broadcasts. */
  broadcastKeys?: import("./broadcasts.mjs").BroadcastPublicJwk[];
  /** Latest active system broadcast sequence number (omitted or 0 when no broadcasts are active, avoiding eager page fetches). */
  broadcastLatestSeq?: number;
  /** Authenticated access role of the current page load ("owner" | "guest" | "display"). */
  viewerRole?: Role;
  /** Optional default facet id bound to the share/invite link that opened this page. */
  defaultView?: string;
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
export interface WakeLockOptions {
  label?: string;
  /** Re-acquire automatically when returning to visible while this lease remains open. Defaults to false. */
  autoReacquire?: boolean;
}
export interface WakeLockLease {
  readonly supported: boolean;
  readonly active: boolean;
  release(): Promise<void>;
}
export interface SharedPayload {
  title?: string;
  text?: string;
  url?: string;
  files: File[];
}
export interface RuntimeShareTarget {
  /** Consume any pending Web Share Target payload (from ?_shared=<id>), deleting it from local cache and cleaning the URL. */
  consume(): Promise<SharedPayload | null>;
  /** Subscribe to an incoming share payload; invokes immediately if one is already pending. */
  onShare(listener: (payload: SharedPayload) => void): () => void;
}
export interface NotificationStatus {
  state: "unsupported" | "install_required" | "prompt" | "granted" | "denied";
  subscribed: boolean;
}
export interface RuntimeNotifications {
  status(): Promise<NotificationStatus>;
  /** Must be called from a user gesture. Requests browser notification permission and registers Web Push with the page host. */
  enable(): Promise<NotificationStatus>;
  /** Unsubscribe this browser from Web Push and delete its host subscription. */
  disable(): Promise<void>;
  /** Update the PWA app icon badge when supported (0 or omitted clears). */
  setBadge(count?: number): Promise<void>;
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
export interface AgentLiveStatus {
  readonly enrolled?: boolean;
  readonly state: "online" | "busy" | "offline" | "stopped" | "unknown";
  readonly capabilities?: readonly string[];
  readonly lastSeenAt?: number;
  readonly route?: "worker" | "same-conversation" | (string & {});
  readonly idleWakeReachable?: boolean;
  readonly detail?: string;
}
export interface PagePersonEntry {
  readonly id: string;
  readonly handle: string;
  readonly role: "owner" | "guest";
  readonly is_self?: boolean;
}
export interface PageViewerInfo {
  readonly role: Role;
  readonly handle: string;
  readonly email?: string;
}
export interface PageAgentRoster {
  readonly primary_agent_id: string | null;
  readonly agents: readonly import("./publication-watch.mjs").PageAgentEntry[];
  readonly can_manage?: boolean;
  readonly dashboard?: string;
  readonly connections?: string;
  readonly platforms?: string;
  readonly viewer?: PageViewerInfo;
  readonly people?: readonly PagePersonEntry[];
  readonly pending_guests?: number;
  readonly live?: Readonly<Record<string, AgentLiveStatus>>;
}
export interface RuntimeChatAttachment {
  readonly contentId: string;
  readonly name: string;
  readonly mime: string;
  readonly size?: number;
  /** Optional local object/data URL for immediate thumbnail preview; never persisted to the log. */
  readonly previewUrl?: string;
  /** Optional Chronolog v2 BlobReference (needed for encrypted private P2P reads). */
  readonly ref?: unknown;
}
export interface RuntimeChatMessage {
  readonly id: string;
  readonly role: "user" | "agent" | "system";
  readonly text: string;
  readonly at?: number;
  readonly status?: "sending" | "delivered" | "seen" | "thinking" | "answered" | "error";
  readonly senderHandle?: string;
  readonly senderRole?: "owner" | "guest" | "agent";
  readonly senderId?: string;
  readonly isSelf?: boolean;
  readonly isPrimary?: boolean;
  readonly toHandles?: readonly string[];
  readonly contextLabel?: string;
  readonly attachments?: readonly RuntimeChatAttachment[];
  readonly actions?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly primary?: boolean }>;
}
export interface RuntimeChatStream {
  readonly id: string;
  readonly senderHandle?: string;
  readonly text: string;
}
export interface RuntimeChatActivity {
  readonly id: string;
  readonly senderHandle: string;
  readonly toHandles?: readonly string[];
  readonly text: string;
  readonly at?: number;
}
export interface RuntimeChatSendInput {
  readonly text: string;
  readonly via: "text" | "voice";
  readonly target?: string | null | "*";
  readonly to?: readonly string[];
  readonly files?: readonly File[];
  readonly attachments?: readonly RuntimeChatAttachment[];
}
export interface RuntimeChatProvider {
  readonly title?: string;
  onSend(input: RuntimeChatSendInput): void | Promise<void>;
  onAction?(action: { messageId: string; actionId: string; label: string }): void | Promise<void>;
  onAttach?(file: File): void | Promise<void>;
  onSelectTarget?(target: string | null | "*"): void;
  onSetPrimary?(agentId: string | null): void | Promise<void>;
}
export interface RuntimeChatSnapshot {
  readonly connected: boolean;
  readonly title: string;
  readonly messages: readonly RuntimeChatMessage[];
  readonly streams: readonly RuntimeChatStream[];
  readonly activity: readonly RuntimeChatActivity[];
  readonly people: readonly PagePersonEntry[];
  readonly userHandle: string;
  readonly unreadCount: number;
  readonly lastIncomingAt: number;
  readonly targetId: string | null | "*";
  readonly presence?: { readonly status: "online" | "busy" | "offline" | "unknown"; readonly label?: string };
}
export interface RuntimeChat {
  snapshot(): RuntimeChatSnapshot;
  onChange(listener: (snapshot: RuntimeChatSnapshot) => void): () => void;
  register(provider: RuntimeChatProvider): () => void;
  readonly hasProvider: boolean;
  setMessages(messages: readonly RuntimeChatMessage[]): void;
  setStreams(streams: readonly RuntimeChatStream[]): void;
  setActivity(items: readonly RuntimeChatActivity[]): void;
  setPeople(people: readonly PagePersonEntry[]): void;
  setPresence(presence: { status: "online" | "busy" | "offline" | "unknown"; label?: string } | undefined): void;
  setTarget(targetId: string | null | "*"): void;
  setUserHandle(handle: string): void;
  notifyIncoming(info?: { id?: string; senderHandle?: string; text?: string }): void;
  clearUnread(): void;
  send(input: RuntimeChatSendInput): Promise<void>;
  onOpenRequest(listener: (open: boolean) => void): () => void;
  open(): void;
  close(): void;
}
export interface HostedMcpConnectInput {
  readonly grantId: string;
  readonly wrapPublicKey: string;
  readonly handle: string;
  readonly bio?: string;
  readonly label?: string;
  readonly writer?: boolean;
  readonly capabilities?: { read?: boolean; write?: boolean; queries?: string[] | null; commands?: string[] | null };
}
export interface RuntimeAgents {
  snapshot(): PageAgentRoster;
  refresh(): Promise<PageAgentRoster>;
  setPrimary(agentId: string | null): Promise<PageAgentRoster>;
  onChange(listener: (roster: PageAgentRoster) => void): () => void;
  resolveHandle(handleOrKey: string): import("./publication-watch.mjs").PageAgentEntry | null;
  reportLiveStatus(map: Record<string, AgentLiveStatus>): void;
  readonly canConnectMcp: boolean;
  registerMcpConnector(connector: (input: HostedMcpConnectInput) => Promise<unknown>): () => void;
  connectMcp(input: HostedMcpConnectInput): Promise<unknown>;
}
export interface RuntimeBroadcastEntry {
  readonly id: string;
  readonly seq: number;
  readonly kind: import("./broadcasts.mjs").BroadcastKind;
  readonly severity: import("./broadcasts.mjs").BroadcastSeverity;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly docs_url: string | null;
  readonly action: import("./broadcasts.mjs").BroadcastAction | null;
  readonly dismissible: boolean;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly dismissed: boolean;
  readonly verified: boolean;
  readonly matchReasons: readonly string[];
}
export interface RuntimeBroadcasts {
  list(): RuntimeBroadcastEntry[];
  active(): RuntimeBroadcastEntry[];
  refresh(): Promise<RuntimeBroadcastEntry[]>;
  dismiss(id: string): void;
  onChange(listener: (entries: RuntimeBroadcastEntry[]) => void): () => void;
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
  /** Page-level agent roster (handles, bios, primary selection, live status). */
  readonly agents: RuntimeAgents;
  /** Shared reactive chat state bridged to the floating Talk/Assistant modal. */
  readonly chat?: RuntimeChat;
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
  readonly identity: Readonly<{ page: string; version: number; publication: string | null; documentPath: string | null; base: string; managementUrl: string; role?: Role; defaultView?: string | null }>;
  /** Browser installation state and an explicit native prompt; never registers offline support. */
  readonly installation: RuntimeInstallation;
  /** Pure URL builder for authored document/fragment links; preserves live or explicit pinned navigation. No fetch or navigation. */
  documentUrl(reference: string): string;
  /** Resolve an explicit runtime dependency against the publication-pinned runtime. */
  assetUrl(path: string): string;
  /** Lazily load the optional on-device voice & ASR module (`createVoice`, `transcribeAudio`, `bindDictation`, `createStreamTranscriber`). */
  loadVoice(): Promise<Record<string, any>>;
  /** Publication lifecycle, offline persistence, URL-addressable facets, and live hot-swappable slots. */
  publication: {
    saveOffline(): Promise<{ id: string; status: "ready" }>;
    /** Currently active atomic publication manifest (updated live after slot/facet hot-swaps). */
    readonly current: PublicationManifest | null;
    /** True only when this document was opened at its immutable /_publications/ID/ URL. */
    readonly pinned: boolean;
    /** Always "live": switches automatically as soon as no draft, composition, pointer gesture, or app hold defers it. */
    readonly policy: "live";
    /** A newer release requires a full document reload; the page switches at its next safe point. */
    readonly updateAvailable: boolean;
    /** Fetch the latest selected publication manifest from `_tendril/info` on demand (zero polling). */
    latest(): Promise<{ version: number; publication: PublicationManifest | null }>;
    /** Resolve a validated relative asset path against a publication's immutable base (defaults to current). */
    assetUrl(path: string, publication?: PublicationManifest | null): string;
    /** Pure shareable URL builder for a named facet (`?view=<id>`), preserving live vs pinned publication context. */
    facetUrl(id: string, options?: { readonly param?: string; readonly pinned?: boolean; readonly base?: string }): string;
    /** Mount a hot-swappable ES module slot from the active publication. */
    mountSlot<T = Record<string, unknown>>(name: string, container: HTMLElement, options: MountSlotOptions<T>): Promise<MountedSlot>;
    /** Mount URL-addressable, hot-swappable facets from `facets.json` (or an inline manifest). */
    mountFacets<T = Record<string, unknown>>(container: HTMLElement, options?: MountFacetsOptions<T>): Promise<MountedFacets>;
    /** Currently mounted facet descriptors on this page (empty when the page does not use facets). */
    readonly facets?: readonly FacetDescriptor[];
    /** Called when a new release is selected (live hot-swapped, requires reload, or reverted to this document's release). */
    onUpdate(listener: (update: PublicationUpdate) => void): () => void;
    /** Runs asynchronously right before an automatic full-page reload (bounded timeout). Flush debounced drafts here, or return `false` / acquire `hold()` to defer. */
    onBeforeReload(handler: (update: PublicationUpdate) => boolean | void | Promise<boolean | void>): () => void;
    /** Defer the automatic full-page reload while there is unsaved work or an active call; call the result to release. */
    hold(reason?: string): () => void;
    /** Load the latest selected release now. */
    update(): void;
    /** Register a peer-to-peer asset recovery callback invoked by the Service Worker when the host returns 404/410 for a pruned publication asset. */
    registerP2pAssetProvider?(provider: (req: { url: string; sha256?: string; type?: string; path?: string; publicationId?: string }) => Promise<{ bytes: Uint8Array; type?: string } | null>): () => void;
  };
  sensors: {
    status(): SensorStatus;
    on(listener: (status: SensorStatus) => void): () => void;
    register(options: RegisteredSensorOptions): RegisteredSensorHandle;
    /** Acquire a Screen Wake Lock integrated with Stop sensors and visibility lifecycle. */
    wakeLock?(options?: WakeLockOptions): Promise<WakeLockLease>;
    /** Number of newly stopped/cancelled resources; async cleanup may still be stopping. */
    stopAll(): number;
  };
  /** Consume content shared into this installed PWA via the OS share sheet (zero network requests). */
  readonly shareTarget?: RuntimeShareTarget;
  /** Opt-in Web Push notifications and app icon badging (zero eager network requests). */
  readonly notifications?: RuntimeNotifications;
  /** Signed service-wide system broadcasts matched locally for this page. */
  readonly broadcasts?: RuntimeBroadcasts;
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
