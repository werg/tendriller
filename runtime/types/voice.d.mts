import type { RuntimeApi } from "@tendriller/core/contract";
import type { SpeechStatus } from "@tendriller/core/voice";
/** model uses pinned local assets; local uses an installed browser language pack; browser may upload ambient audio. */
export type WakeMode = "model" | "local" | "browser";
export type WakeState = "off" | "starting" | "loading" | "listening" | "detected" | "command" | "transcribing" | "restarting" | "paused" | "error";
export interface VoiceConsent {
  purpose: "output" | "transcription" | "wake"; engine: string; description: string;
  phrase?: string; language?: string; downloadBytes?: number; maxSessionMs?: number;
}
export interface VoiceStatus {
  kind: "output" | "capture" | "wake"; state: string; message?: string; microphone?: boolean;
}
export interface VoiceOptions {
  /** Every microphone start requests a fresh decision. Choices never imply consent. */
  consent(request: Readonly<VoiceConsent>): boolean | Promise<boolean>;
  transcript(text: string): void;
  status?(status: VoiceStatus): void;
}
export interface VoiceOutputStatus { engine: "browser" | "neural"; state: SpeechStatus["state"]; message: string }
export interface VoiceAdapter {
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
  localAvailability(): Promise<string>; installLocalLanguage(): Promise<boolean>; dispose(): void;
}
/** Explicit adapter: creation starts no listening, playback, or model download. */
export function createVoice(runtime: RuntimeApi, options: VoiceOptions): VoiceAdapter;
export function matchWakePhrase(transcript: string, phrase: string): { command: string } | null;
export interface VoiceControlsOptions {
  container?: HTMLElement;
  /** Reviewed text only. When omitted, the standard control offers Copy text. */
  transcript?(text: string): void | Promise<void>;
  language?: string; phrase?: string;
}
/** Inert accessible controls; only trusted local clicks can authorize their microphone. */
export function mountVoiceControls(runtime: RuntimeApi, options?: VoiceControlsOptions): { voice: VoiceAdapter; element: HTMLElement; dispose(): void };
export const SPEECH_DOWNLOAD_BYTES: number;
export const SPEECH_MODEL_BYTES: number;
export const SPEECH_LANGUAGES: readonly string[];
