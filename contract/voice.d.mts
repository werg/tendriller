/** Optional voice & on-device ASR contract. Application presentation remains page-owned. */
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

export type AsrEngineId = "auto" | "whistle" | "browser-local";

export interface AsrEngineDescriptor {
  readonly id: Exclude<AsrEngineId, "auto">;
  readonly label: string;
  readonly streaming: boolean;
  readonly downloadBytes: number;
  readonly languages: readonly string[];
  readonly requiresProcessLocally?: boolean;
}

export interface SpeechStreamPartial {
  readonly confirmed: string;
  readonly pending: string;
  readonly text: string;
}

export type TranscriptEvent =
  | {
    readonly type: "status";
    readonly state: "loading" | "listening" | "finalizing" | "idle" | "error";
    readonly message?: string;
    readonly engine?: Exclude<AsrEngineId, "auto">;
  }
  | { readonly type: "level"; readonly value: number }
  | { readonly type: "partial"; readonly confirmed: string; readonly pending: string; readonly text: string }
  | { readonly type: "final"; readonly text: string; readonly language: string; readonly startedAtMs: number; readonly endedAtMs: number };

export interface DictationOptions {
  readonly language?: string;
  readonly fallbackLanguage?: string;
  readonly engine?: AsrEngineId;
  readonly stream?: MediaStream;
  readonly signal?: AbortSignal;
}

export interface DictationStream extends AsyncIterable<TranscriptEvent> {
  stop(): void;
  cancel(): void;
}

export interface TranscribeAudioOptions {
  language?: string;
  fallbackLanguage?: string;
  sampleRate?: number;
  onProgress?: (status: string) => void;
  signal?: AbortSignal;
}

export interface VoiceModule {
  readonly SPEECH_DOWNLOAD_BYTES: number;
  readonly SPEECH_MODEL_BYTES: number;
  readonly SPEECH_LANGUAGES: readonly string[];
  readonly SPEECH_ENGINE_CATALOG: readonly AsrEngineDescriptor[];
  dictate(runtime: any, options?: DictationOptions): DictationStream;
  transcribeAudio(runtime: any, audio: Blob | ArrayBuffer | AudioBuffer | Float32Array, options?: TranscribeAudioOptions): Promise<{ text: string; language: string; durationMs: number }>;
  bindDictation(runtime: any, target: HTMLTextAreaElement | HTMLInputElement | ((text: string) => void), options?: Record<string, any>): {
    readonly state: "idle" | "working" | "recording" | "error";
    start(): Promise<void>;
    stop(): void;
    cancel(): void;
    toggle(): void;
    setLanguage(tag: string): void;
    dispose(): void;
  };
  createVoice(runtime: any, options: Record<string, any>): any;
  createStreamTranscriber(runtime: any, options: Record<string, any>): any;
  mountVoiceControls(runtime: any, options?: Record<string, any>): any;
  mountAgentChat(runtime: any, options: Record<string, any>): any;
  decodeAudioToPcm16k(input: Blob | ArrayBuffer | AudioBuffer | Float32Array, sampleRate?: number): Promise<Float32Array>;
  classifyCaptureError(error: unknown, stage: "model" | "microphone_permission" | "recorder" | "transcription", permissionState?: string | null): string;
  isBrowserLocalAvailable(language: string): Promise<boolean>;
  resolveSpeechLanguage(requested?: string | null, options?: { fallbackLanguage?: string }): string;
  matchWakePhrase(transcript: string, phrase: string): { command: string } | null;
}
