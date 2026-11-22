/** Optional voice configuration. Application presentation remains page-owned. */
export interface VoicePreferences {
  /** Session permission, never persisted or synchronized between tabs. */
  audio: boolean; language: string | null; voice: "browser" | "neural";
  /** Selection only; listening never resumes automatically. */
  wakePhrase: string; wakeMode: "model" | "local" | "browser";
}
export interface VoicePreferencesApi {
  get(): VoicePreferences; update(patch: Partial<VoicePreferences>): void;
  on(listener: (preferences: VoicePreferences) => void): () => void; dispose(): void;
}
export interface SpeechStatus { enabled: boolean; state: "idle" | "loading" | "ready" | "error"; message: string }
export interface SpeechOutput {
  readonly status: SpeechStatus; readonly speaking: boolean;
  stop(): void; enable(): Promise<void>; disable(): void; speak(text: string): void; dispose(): void;
}
