// Runtime internals use the same public identities and browser API as the wire contract.
import type { RuntimeApi } from "../../contract/index.mjs";
export type { Role, Presence, TranscriptEntry, Device } from "../../contract/index.mjs";
import type { Role, Presence, TranscriptEntry, Device } from "../../contract/index.mjs";
export interface Features { push: boolean; vapid: string | null; shared_by: string;
  speech: { model: string; url: string; sha256: string } }
export interface TendrilConfig { id: string; base: string; version: number; ws: string; features: Features }
export type { Path } from "../../contract/index.mjs";
import type { Path } from "../../contract/index.mjs";
export interface StateApi {
  get(path?: Path): any; set(path: Path, value: any): void; delete(path: Path): void;
  patch(mergePatch: object): void; mine(): any;
  on(fn: (state: any, ops: any[], by: string) => void): () => void;
}
export type Bus = { on(type: string, fn: (payload: any) => void): () => void; emit(type: string, payload?: any): void };
export interface Core extends Pick<RuntimeApi, "send" | "upload" | "uploadEvent" | "captures" | "retryCapture" | "discardCapture" | "setBlobRetention" | "deviceHeaders" | "speak" | "tts"> {
  bus: Bus;
  config: TendrilConfig;
  device: Device;
  connected: boolean;
  presence: Presence | null;
  transcript: TranscriptEntry[];
  state: StateApi;
  instruction(text: string, via: "voice" | "text"): Promise<{ queued: boolean; cid?: string }>;
  request(msg: { t: string; [k: string]: any }): Promise<any>;
  raw(msg: object): void;
  // Additions (runtime-core). Bus also emits: "transcript" (entry), "notify_local" ({title,body}) when no
  // Notification permission, "reload" ({version}), "welcome" (the raw welcome message).
  /** Last `welcome` message from the server (tendril name, version pointers, budget, primary…), or null. */
  welcome: any | null;
  /** Current device rules (from welcome / `rules`). */
  rules: any[];
  /** Health signal (PROTOCOL 4): report now / defer the automatic report until ready(). */
  ready(): void;
  readyManual(): void;
}
export interface Push { available: boolean; subscribed(): Promise<boolean>; subscribe(): Promise<boolean>; unsubscribe(): Promise<void> }
export interface ControlApi { hide(): void; show(): void; position(p: "bottom-right" | "bottom-left" | "top-right" | "top-left"): void }
declare global { interface Window { __TENDRIL__: TendrilConfig; tendril: RuntimeApi } }
