// First-class ergonomic on-device ASR helpers for normal Tendriller page code.
// Shares the verified per-tab Cactus Whistle WASM worker so apps never double-load the model.
import type { RuntimeApi } from "../../../contract/index.mjs";
import { loadSpeechResources, SPEECH_LANGUAGES } from "./resources";
import { decodeAudioToPcm16k, getSharedSpeechWorker } from "./shared-worker";
import { createVoice, type VoiceStatus } from "./index";

export interface TranscribeAudioOptions {
  /** BCP-47 language tag (e.g. "en-US", "de"). Defaults to navigator.language. */
  language?: string;
  /** Sample rate when passing raw Float32Array PCM samples (defaults to 16000). */
  sampleRate?: number;
  /** Optional model download / verification progress updates. */
  onProgress?: (status: string) => void;
  signal?: AbortSignal;
}

/**
 * One-shot on-device transcription of any Blob, File, ArrayBuffer, AudioBuffer, or Float32Array.
 * Splits recordings longer than 28 seconds automatically and joins the resulting text.
 * Never requests microphone access or uploads audio off-device.
 */
export async function transcribeAudio(
  runtime: RuntimeApi,
  audio: Blob | ArrayBuffer | AudioBuffer | Float32Array,
  options: TranscribeAudioOptions = {},
): Promise<{ text: string; language: string; durationMs: number }> {
  const rawLang = (options.language || (typeof navigator !== "undefined" && navigator.language) || "en-US").split("-")[0]!.toLowerCase();
  const language = SPEECH_LANGUAGES.includes(rawLang) ? rawLang : "en";
  if (options.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");
  const speech = await loadSpeechResources(runtime, options.signal);
  const worker = getSharedSpeechWorker(runtime.assetUrl("voice-worker.js"), speech.sha256);
  const [pcm] = await Promise.all([
    decodeAudioToPcm16k(audio, options.sampleRate ?? 16000),
    worker.ensureInit(speech, { onProgress: options.onProgress, signal: options.signal }),
  ]);
  const windowSamples = 16_000 * 28;
  const parts: string[] = [];
  for (let offset = 0; offset < pcm.length; offset += windowSamples) {
    if (options.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");
    const slice = pcm.subarray(offset, Math.min(pcm.length, offset + windowSamples));
    if (slice.length < 160) continue; // ignore <10ms trailing sliver
    const chunkText = await worker.transcribe(slice, language, { signal: options.signal });
    if (chunkText) parts.push(chunkText);
  }
  return {
    text: parts.join(" ").trim(),
    language,
    durationMs: Math.round((pcm.length / 16000) * 1000),
  };
}

export interface BindDictationOptions {
  /** Existing button to bind. If omitted, a button is not auto-inserted; caller can trigger via returned handle. */
  button?: HTMLButtonElement;
  /** How transcripts populate an input/textarea target (default "append"). */
  mode?: "append" | "replace";
  language?: string;
  /** Support press-and-hold on the bound button in addition to tap-to-toggle (default true). */
  holdToTalk?: boolean;
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

/**
 * Drop-in on-device dictation binding for any `<textarea>`, `<input>`, or custom callback.
 * Wires tap-to-toggle + optional press-and-hold, updates `data-state` / `aria-pressed` / `--level`,
 * and dispatches standard `input` events so reactive page state stays synchronized.
 */
export function bindDictation(
  runtime: RuntimeApi,
  target: HTMLTextAreaElement | HTMLInputElement | ((text: string) => void),
  options: BindDictationOptions = {},
): DictationBinding {
  const mode = options.mode ?? "append";
  const holdToTalk = options.holdToTalk !== false;
  let state: "idle" | "working" | "recording" | "error" = "idle";
  let disposed = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holding = false;
  let suppressClick = false;

  const syncButton = () => {
    const button = options.button;
    if (!button) return;
    button.dataset.state = state;
    button.setAttribute("aria-pressed", String(state === "recording"));
  };

  const applyText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (typeof target === "function") {
      target(trimmed);
    } else {
      const prev = target.value.trim();
      target.value = mode === "replace" || !prev ? trimmed : `${prev} ${trimmed}`;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.focus?.();
    }
    options.onTranscript?.(trimmed);
  };

  const voice = createVoice(runtime, {
    consentMode: "auto",
    transcript(text) {
      if (!disposed) applyText(text);
    },
    level(level) {
      if (disposed) return;
      options.button?.style.setProperty("--level", level.toFixed(3));
      options.onLevel?.(level);
    },
    status(st) {
      if (disposed || st.kind !== "capture") return;
      state = st.state === "recording" || st.state === "working" || st.state === "error" ? st.state : "idle";
      syncButton();
      options.onStatus?.(st);
      if (st.state === "error" && st.message) options.onError?.(st.message);
    },
  });
  if (options.language) voice.language(options.language);

  const toggle = () => {
    if (disposed) return;
    if (state === "recording") voice.finishCapture();
    else if (state === "working") voice.cancelCapture();
    else void voice.startCapture();
  };

  const detachWindow = () => {
    window.removeEventListener("pointerup", onPointerEnd);
    window.removeEventListener("pointercancel", onPointerEnd);
  };
  const onPointerEnd = (e: PointerEvent) => {
    detachWindow();
    if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
    if (holding) {
      holding = false;
      if (e.type === "pointercancel") voice.cancelCapture();
      else if (state === "recording") voice.finishCapture();
      else voice.cancelCapture();
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    if (!holdToTalk || (e.button !== 0 && e.pointerType === "mouse")) return;
    holding = false;
    suppressClick = false;
    if (state === "idle" || state === "error") {
      window.addEventListener("pointerup", onPointerEnd);
      window.addEventListener("pointercancel", onPointerEnd);
      holdTimer = setTimeout(() => {
        holdTimer = null;
        holding = true;
        suppressClick = true;
        void voice.startCapture();
      }, 280);
    }
  };
  const onClick = (e: MouseEvent) => {
    if (suppressClick && e.detail !== 0) { suppressClick = false; return; }
    suppressClick = false;
    toggle();
  };

  if (options.button) {
    syncButton();
    options.button.addEventListener("pointerdown", onPointerDown);
    options.button.addEventListener("click", onClick);
  }

  return {
    get state() { return state; },
    async start() { if (!disposed) await voice.startCapture(); },
    stop() { if (!disposed) voice.finishCapture(); },
    cancel() { if (!disposed) voice.cancelCapture(); },
    toggle,
    setLanguage(tag: string) { if (!disposed) voice.language(tag); },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
      detachWindow();
      options.button?.removeEventListener("pointerdown", onPointerDown);
      options.button?.removeEventListener("click", onClick);
      voice.dispose();
    },
  };
}
