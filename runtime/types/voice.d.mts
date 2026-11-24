import type { RuntimeApi } from "@tendriller/core/contract";
import type { SpeechStatus } from "@tendriller/core/voice";
/** model uses pinned local assets; local uses an installed browser language pack; browser may upload ambient audio. */
export type WakeMode = "model" | "local" | "browser";
export type WakeState = "off" | "starting" | "loading" | "listening" | "detected" | "command" | "transcribing" | "restarting" | "paused" | "error";
export type VoiceConsentMode = "auto" | "session" | "prompt";
export interface VoiceConsent {
  purpose: "output" | "transcription" | "wake"; engine: string; description: string;
  phrase?: string; language?: string; downloadBytes?: number; maxSessionMs?: number;
}
export interface VoiceStatus {
  kind: "output" | "capture" | "wake"; state: string; message?: string; microphone?: boolean; speaking?: boolean; completed?: boolean;
}
export interface VoiceOptions {
  /**
   * "auto": immediate consent (browser permission prompt is consent; default when `consent` is omitted).
   * "session": ask once per purpose/engine per visible session (default when `consent` is provided).
   * "prompt": call `consent` before every start.
   */
  consentMode?: VoiceConsentMode;
  consent?(request: Readonly<VoiceConsent>): boolean | Promise<boolean>;
  transcript(text: string): void;
  status?(status: VoiceStatus): void;
  /** Normalized 0..1 live microphone RMS level while recording. */
  level?(level: number): void;
  /** Automatically enable spoken output ("browser" | "neural" | true for "browser") when consent allows. */
  autoOutput?: boolean | "browser" | "neural";
}
export interface VoiceOutputStatus { engine: "browser" | "neural"; state: SpeechStatus["state"]; message: string }
export interface VoiceAdapter {
  readonly consentMode: VoiceConsentMode;
  readonly outputStatus: VoiceOutputStatus; readonly muted: boolean; readonly speaking: boolean; readonly listening: boolean;
  /** Live microphone state, separate from preparing or awaiting permission. */
  readonly microphoneActive: boolean;
  readonly wakeStatus: { state: WakeState; message: string; phrase: string; mode: WakeMode };
  readonly captureStatus: { state: string; message: string };
  readonly settings: { language: string; wakePhrase: string; wakeMode: WakeMode };
  enableOutput(engine?: "browser" | "neural"): Promise<boolean>;
  mute(): void; speak(text: string): void; stop(): void; stopWake(): void; language(tag: string): void;
  prepareCapture(): Promise<void>; startCapture(): Promise<void>; finishCapture(): void; cancelCapture(): void;
  startWake(settings: { phrase: string; mode: WakeMode }): Promise<boolean>;
  localAvailability(): Promise<string>; installLocalLanguage(): Promise<boolean>;
  revokeConsent(): void; dispose(): void;
}
export function createVoice(runtime: RuntimeApi, options: VoiceOptions): VoiceAdapter;
export function matchWakePhrase(transcript: string, phrase: string): { command: string } | null;
export interface VoiceControlsOptions {
  container?: HTMLElement;
  /** Delivered text callback. When omitted, the standard control offers Copy text. */
  transcript?(text: string): void | Promise<void>;
  language?: string; phrase?: string;
  consentMode?: VoiceConsentMode;
  autoSend?: boolean;
  output?: boolean;
  autoOutput?: boolean | "browser" | "neural";
}
export function mountVoiceControls(runtime: RuntimeApi, options?: VoiceControlsOptions): {
  voice: VoiceAdapter; element: HTMLElement; speak(text: string): void; mute(): void; dispose(): void;
};
export interface AgentChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  at?: number;
  status?: "sending" | "delivered" | "seen" | "thinking" | "answered" | "error";
  contextLabel?: string;
  actions?: Array<{ id: string; label: string; primary?: boolean }>;
}
export interface AgentChatPresence {
  status: "online" | "busy" | "offline" | "unknown";
  label?: string;
}
export interface AgentChatContext {
  label: string;
  data?: unknown;
}
export interface AgentChatOptions {
  container?: HTMLElement;
  title?: string;
  placeholder?: string;
  messages?: AgentChatMessage[];
  onSend(input: { text: string; via: "text" | "voice"; context?: unknown }): void | Promise<void>;
  onAction?(action: { messageId: string; actionId: string; label: string }): void | Promise<void>;
  onAttach?(file: File): void | Promise<void>;
  consentMode?: VoiceConsentMode;
  autoSendVoice?: boolean;
  voiceOutput?: "browser" | "neural" | false;
  autoSpeak?: boolean;
  handsFreeLoop?: boolean;
  language?: string;
  layout?: "embedded" | "drawer" | "dock";
  open?: boolean;
  presence?: AgentChatPresence;
}
export interface AgentChatHandle {
  readonly voice: VoiceAdapter;
  readonly element: HTMLElement;
  setMessages(messages: AgentChatMessage[]): void;
  setStreamingReply(text: string | null): void;
  setPresence(presence: AgentChatPresence): void;
  setContext(context: AgentChatContext | null): void;
  speak(text: string): void;
  stopSpeaking(): void;
  open(): void;
  close(): void;
  toggle(): void;
  focus(): void;
  dispose(): void;
}
export function mountAgentChat(runtime: RuntimeApi, options: AgentChatOptions): AgentChatHandle;
export const SPEECH_DOWNLOAD_BYTES: number;
export const SPEECH_MODEL_BYTES: number;
export const SPEECH_LANGUAGES: readonly string[];
