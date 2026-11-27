import type { RuntimeApi } from "@tendriller/core/contract";
import type {
  AsrEngineDescriptor,
  AsrEngineId,
  DictationOptions,
  DictationStream,
  SpeechStatus,
  SpeechStreamPartial,
  TranscribeAudioOptions,
  TranscriptEvent,
} from "@tendriller/core/voice";
export type {
  AsrEngineDescriptor,
  AsrEngineId,
  DictationOptions,
  DictationStream,
  SpeechStreamPartial,
  TranscribeAudioOptions,
  TranscriptEvent,
};
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
  partial?(partial: SpeechStreamPartial): void;
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
  senderHandle?: string;
  senderId?: string;
  isPrimary?: boolean;
  toHandles?: string[];
  actions?: Array<{ id: string; label: string; primary?: boolean }>;
}
export interface AgentChatStreamingEntry {
  id: string;
  senderHandle?: string;
  text: string;
}
export interface AgentChatActivityItem {
  id: string;
  senderHandle: string;
  toHandles?: string[];
  text: string;
  at?: number;
}
export interface AgentChatRosterItem {
  id: string;
  handle: string;
  bio?: string;
  publicKey: string;
  kind?: "workspace" | "hosted-mcp";
  isPrimary?: boolean;
  state: "online" | "busy" | "offline" | "stopped" | "unknown";
  enrolled?: boolean;
}
export interface AgentChatRosterState {
  primaryId: string | null;
  agents: readonly AgentChatRosterItem[];
  targetId?: string | null | "*";
  canSetPrimary?: boolean;
}
export interface AgentChatBanner {
  kind?: "warning" | "info";
  message: string;
  actions?: Array<{ id: string; label: string; primary?: boolean }>;
  onAction?(actionId: string): void | Promise<void>;
  onDismiss?(): void;
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
  onSend(input: { text: string; via: "text" | "voice"; context?: unknown; target?: string | null | "*" }): void | Promise<void>;
  onAction?(action: { messageId: string; actionId: string; label: string }): void | Promise<void>;
  onAttach?(file: File): void | Promise<void>;
  onSelectTarget?(target: string | null | "*"): void;
  onSetPrimary?(agentId: string | null): void | Promise<void>;
  consentMode?: VoiceConsentMode;
  autoSendVoice?: boolean;
  voiceOutput?: "browser" | "neural" | false;
  autoSpeak?: boolean;
  handsFreeLoop?: boolean;
  language?: string;
  layout?: "embedded" | "drawer" | "dock";
  open?: boolean;
  presence?: AgentChatPresence;
  consumeShares?: boolean;
}
export interface AgentChatHandle {
  readonly voice: VoiceAdapter;
  readonly element: HTMLElement;
  setMessages(messages: AgentChatMessage[]): void;
  setStreamingReply(text: string | null): void;
  setStreamingReplies(entries: AgentChatStreamingEntry[]): void;
  setRoster(roster: AgentChatRosterState): void;
  setActivity(items: AgentChatActivityItem[]): void;
  setBanner(banner: AgentChatBanner | null): void;
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
export function dictate(runtime: RuntimeApi, options?: DictationOptions): DictationStream;
export function transcribeAudio(
  runtime: RuntimeApi,
  audio: Blob | ArrayBuffer | AudioBuffer | Float32Array,
  options?: TranscribeAudioOptions,
): Promise<{ text: string; language: string; durationMs: number }>;
export interface BindDictationOptions {
  button?: HTMLButtonElement;
  mode?: "append" | "replace";
  language?: string;
  holdToTalk?: boolean;
  onPartial?: (partial: SpeechStreamPartial) => void;
  onTranscript?: (text: string) => void;
  onStatus?: (status: VoiceStatus) => void;
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
}
export interface DictationBinding {
  readonly state: "idle" | "working" | "recording" | "error";
  start(): Promise<void>;
  stop(): void;
  cancel(): void;
  toggle(): void;
  setLanguage(tag: string): void;
  dispose(): void;
}
export function bindDictation(
  runtime: RuntimeApi,
  target: HTMLTextAreaElement | HTMLInputElement | ((text: string) => void),
  options?: BindDictationOptions,
): DictationBinding;
export interface StreamTranscriptSegment {
  readonly utteranceId: string;
  readonly text: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly language: string;
  readonly droppedSegments: number;
}
export interface StreamTranscriberStatus {
  readonly state: "idle" | "loading" | "active" | "paused" | "error" | "disposed";
  readonly message: string;
  readonly droppedSegments: number;
}
export interface StreamTranscriberOptions {
  readonly stream: MediaStream;
  readonly language?: string;
  readonly maxSegmentMs?: number;
  readonly silenceMs?: number;
  readonly maxQueuedSegments?: number;
  readonly stopOnHidden?: boolean;
  readonly transcribe?: (input: { samples: Float32Array; language: string; signal: AbortSignal }) => Promise<string>;
  readonly onSegment: (segment: StreamTranscriptSegment) => void;
  readonly onLevel?: (level: number) => void;
  readonly onStatus?: (status: StreamTranscriberStatus) => void;
}
export interface StreamTranscriber {
  readonly status: StreamTranscriberStatus;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  flush(): void;
  setLanguage(tag: string): void;
  dispose(): void;
}
export function createStreamTranscriber(runtime: RuntimeApi, options: StreamTranscriberOptions): StreamTranscriber;
export function decodeAudioToPcm16k(input: Blob | ArrayBuffer | AudioBuffer | Float32Array, sampleRate?: number): Promise<Float32Array>;
export function classifyCaptureError(error: unknown, stage: "model" | "microphone_permission" | "recorder" | "transcription", permissionState?: string | null): string;
export function isBrowserLocalAvailable(language: string): Promise<boolean>;
export function resolveSpeechLanguage(requested?: string | null, options?: { fallbackLanguage?: string }): string;
export class UnsupportedLanguageError extends Error {
  readonly code: "UNSUPPORTED_SPEECH_LANGUAGE";
  readonly requested: string;
  readonly supported: readonly string[];
  constructor(requested: string, supported?: readonly string[]);
}
export const SPEECH_ENGINE_CATALOG: readonly AsrEngineDescriptor[];
export const SPEECH_DOWNLOAD_BYTES: number;
export const SPEECH_MODEL_BYTES: number;
export const SPEECH_LANGUAGES: readonly string[];
