import type { RuntimeApi, SpeechStatus } from "@tendriller/core/contract";
export type WakeMode = "local" | "browser";
export type WakeState = "off" | "starting" | "listening" | "command" | "restarting" | "paused" | "error";
export interface VoiceOptions {
  consent(request: { purpose: "output" | "transcription" | "wake"; engine: string; description: string }): boolean | Promise<boolean>;
  transcript(text: string): void;
  status?(status: { kind: "output" | "capture" | "wake"; state: string; message?: string }): void;
  speakReplies?: boolean;
}
export interface VoiceAdapter {
  readonly outputStatus: SpeechStatus; readonly speaking: boolean; readonly listening: boolean;
  enableOutput(engine?: "browser" | "neural"): Promise<boolean>;
  mute(): void; speak(text: string): void; stop(): void; language(tag: string): void;
  prepareCapture(): Promise<void>; startCapture(): Promise<void>; finishCapture(): void; cancelCapture(): void;
  startWake(settings: { phrase: string; mode: WakeMode }): Promise<boolean>;
  localAvailability(): Promise<string>; installLocalLanguage(): Promise<boolean>; dispose(): void;
}
/** Explicit adapter: creation starts no listening, playback, or model download. */
export function createVoice(runtime: RuntimeApi, options: VoiceOptions): VoiceAdapter;
export function matchWakePhrase(transcript: string, phrase: string): { command: string } | null;
