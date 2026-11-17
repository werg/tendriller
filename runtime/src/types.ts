// Runtime internals use the same public identities and browser API as the wire contract.
import type { RuntimeApi, RuntimeServices, HostedRuntimeApi, RuntimeConfiguration, RuntimeSocket, ConversationResult, StateApi as PublicStateApi } from "../../contract/index.mjs";
export type { Role, Presence, TranscriptEntry, Device } from "../../contract/index.mjs";
import type { Role, Presence, TranscriptEntry, Device } from "../../contract/index.mjs";
export interface Features { push: boolean; vapid: string | null; shared_by: string;
  speech: { model: string; url: string; sha256: string; engine: { script: string; wasm: string; wasm_sha256: string } } | null }
export type TendrilConfig = RuntimeConfiguration;
export type { Path } from "../../contract/index.mjs";
import type { Path } from "../../contract/index.mjs";
export type StateApi = PublicStateApi<any>;
export type Bus = { on(type: string, fn: (payload: any) => void): () => void; emit(type: string, payload?: any): void };
export interface PageCore extends Pick<RuntimeServices, "host" | "application" | "device"> {
  bus: Bus;
  config: TendrilConfig;
  ready(): void;
}
export interface PeerCore extends PageCore { readonly kind: "peer" }
export interface HostedCore extends PageCore, Pick<HostedRuntimeApi, "send" | "scopes" | "service" | "conversation" | "upload" | "uploadEvent" | "pendingWork" | "captures" | "retryCapture" | "discardCapture" | "setBlobRetention" | "streams" | "records" | "timers"> {
  readonly kind: "cloudflare";
  device: Device;
  connected: boolean;
  presence: Presence | null;
  transcript: TranscriptEntry[];
  state: StateApi;
  instruction(text: string, via: "voice" | "text"): Promise<ConversationResult>;
  transportRequest(msg: { t: string; [k: string]: any }, options?: { signal?: AbortSignal }): Promise<any>;
  raw(msg: object): void;
  // Additions (runtime-core). Bus also emits: "transcript" (entry), "notify_local" ({title,body}) when no
  // Notification permission, "reload" ({version}), "welcome" (the raw welcome message).
  /** Last `welcome` message from the server (tendril name, version pointers, budget, primary…), or null. */
  welcome: any | null;
  /** Health signal (PROTOCOL 4): report now / defer the automatic report until ready(). */
  readyManual(): void;
}
export type RuntimeCore = PeerCore | HostedCore;
export interface Push { available: boolean; subscribed(): Promise<boolean>; subscribe(): Promise<boolean>; unsubscribe(): Promise<void> }
declare global { interface Window { __TENDRIL__: TendrilConfig; __TENDRIL_TRANSPORT__?: (url: string) => RuntimeSocket; tendril: RuntimeApi } }
