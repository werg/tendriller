// Shared runtime types. Owned by the runtime-core agent (others import, don't edit).
export interface Features { push: boolean; vapid: string | null; shared_by: string;
  speech: { model: string; url: string; sha256: string } }
export interface TendrilConfig { id: string; base: string; version: number; ws: string; features: Features }
export type Role = "owner" | "guest" | "display";
export interface Presence {
  state: "listening" | "working" | "done" | "scheduled" | "not_responding" | "away" | "no_agent";
  text: string; last_seen: number | null; schedule_minutes: number | null; withheld: number;
  wake: "long_poll" | "webhook" | "schedule" | "none";
}
export interface TranscriptEntry { ts: number; from: "agent" | "user"; text: string }
export type Path = string | string[];
export interface StateApi {
  get(path?: Path): any; set(path: Path, value: any): void; delete(path: Path): void;
  patch(mergePatch: object): void; mine(): any;
  on(fn: (state: any, ops: any[], by: string) => void): () => void;
}
export type Bus = { on(type: string, fn: (payload: any) => void): () => void; emit(type: string, payload?: any): void };
export interface Device { id: string; role: Role; name: string; pending: boolean; pairCode?: string }
export interface Core {
  bus: Bus;
  config: TendrilConfig;
  device: Device;
  connected: boolean;
  presence: Presence | null;
  transcript: TranscriptEntry[];
  state: StateApi;
  send(data: any, opts?: { wake?: boolean }): Promise<{ seq?: number; queued: boolean }>;
  instruction(text: string, via: "voice" | "text"): Promise<void>;
  request(msg: { t: string; [k: string]: any }): Promise<any>;
  raw(msg: object): void;
  upload(blob: Blob, opts?: { name?: string }): Promise<{ id: string; url: string }>;
  /** Headers proving this device to page HTTP routes. */
  deviceHeaders(): Record<string, string>;
  // Additions (runtime-core). Bus also emits: "transcript" (entry), "notify_local" ({title,body}) when no
  // Notification permission, "reload" ({version}), "welcome" (the raw welcome message).
  /** Last `welcome` message from the server (tendril name, version pointers, budget, primary…), or null. */
  welcome: any | null;
  /** Current device rules (from welcome / `rules`). */
  rules: any[];
  /** Local speech synthesis honoring `_prefs.audio` / `_prefs.language`. */
  speak(text: string): void;
  /** Health signal (PROTOCOL 4): report now / defer the automatic report until ready(). */
  ready(): void;
  readyManual(): void;
}
export interface Push { available: boolean; subscribed(): Promise<boolean>; subscribe(): Promise<boolean>; unsubscribe(): Promise<void> }
export interface ControlApi { hide(): void; show(): void; position(p: "bottom-right" | "bottom-left" | "top-right" | "top-left"): void }
declare global { interface Window { __TENDRIL__: TendrilConfig; tendril: any } }
