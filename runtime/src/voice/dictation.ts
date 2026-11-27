// First-class ergonomic on-device ASR helpers for normal Tendriller page code.
// Shares the verified per-tab Cactus Whistle WASM worker so apps never double-load the model.
import type { RuntimeApi } from "../../../contract/index.mjs";
import { loadSpeechResources } from "./resources";
import { decodeAudioToPcm16k, getSharedSpeechWorker, type SpeechStreamPartial } from "./shared-worker";
import {
  isBrowserLocalAvailable,
  resolveSpeechLanguage,
  startBrowserLocalStream,
  type AsrEngineId,
} from "./asr-engine";
import { createVoice, type VoiceStatus } from "./index";

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
  /** BCP-47 language tag (e.g. "en-US", "de"). Defaults to navigator.language. */
  readonly language?: string;
  /** Optional explicit fallback language if `language` is unsupported (never silently defaults without this). */
  readonly fallbackLanguage?: string;
  /** ASR engine preference: "auto" (default Whistle streaming), "whistle", or "browser-local" (zero-download processLocally). */
  readonly engine?: AsrEngineId;
  /** Optional existing MediaStream (e.g. WebRTC call track) for continuous segment dictation without getUserMedia. */
  readonly stream?: MediaStream;
  /** AbortSignal to cancel dictation cleanly. */
  readonly signal?: AbortSignal;
}

export interface DictationStream extends AsyncIterable<TranscriptEvent> {
  /** Gracefully finish recording, flush pending words, emit `final`, and close the stream. */
  stop(): void;
  /** Immediately abort recording and close the stream without emitting `final`. */
  cancel(): void;
}

/**
 * Primary streaming on-device dictation primitive returning an `AsyncIterable<TranscriptEvent>`.
 * Emits live `{ type: "partial", confirmed, pending, text }` updates while speaking and
 * `{ type: "final", text, language, startedAtMs, endedAtMs }` on finish.
 */
export function dictate(runtime: RuntimeApi, options: DictationOptions = {}): DictationStream {
  const languageTag = options.language || (typeof navigator !== "undefined" && navigator.language) || "en-US";
  const resolvedLang = resolveSpeechLanguage(languageTag, { fallbackLanguage: options.fallbackLanguage });

  const buffer: TranscriptEvent[] = [];
  let notifyWaiter: (() => void) | null = null;
  let closed = false;
  let started = false;
  let startedAtMs = Date.now();
  let stopImpl: () => void = () => {};
  let cancelImpl: () => void = () => {};

  const push = (event: TranscriptEvent) => {
    if (closed) return;
    buffer.push(Object.freeze(event));
    const wake = notifyWaiter;
    notifyWaiter = null;
    wake?.();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", onAbort);
    const wake = notifyWaiter;
    notifyWaiter = null;
    wake?.();
  };

  const onAbort = () => {
    cancelImpl();
    close();
  };

  if (options.signal?.aborted) {
    closed = true;
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }

  const startSession = async () => {
    if (started || closed) return;
    started = true;
    startedAtMs = Date.now();

    const requestedEngine = options.engine ?? "auto";
    if (!options.stream && requestedEngine === "browser-local") {
      const ok = await isBrowserLocalAvailable(languageTag);
      if (closed) return;
      if (!ok) {
        push({ type: "status", state: "error", message: "Browser on-device recognition (processLocally) is unavailable for this language.", engine: "browser-local" });
        close();
        return;
      }
      push({ type: "status", state: "listening", message: "Listening locally via browser speech recognition…", engine: "browser-local" });
      try {
        const session = startBrowserLocalStream({
          language: languageTag,
          onPartial(partial) {
            push({ type: "partial", confirmed: partial.confirmed, pending: partial.pending, text: partial.text });
          },
          onFinal(text) {
            if (text) push({ type: "final", text, language: resolvedLang, startedAtMs, endedAtMs: Date.now() });
            push({ type: "status", state: "idle", engine: "browser-local" });
            close();
          },
          onError(error) {
            push({ type: "status", state: "error", message: error.message, engine: "browser-local" });
            close();
          },
        });
        stopImpl = () => {
          push({ type: "status", state: "finalizing", engine: "browser-local" });
          session.stop();
        };
        cancelImpl = () => {
          session.cancel();
          close();
        };
      } catch (err) {
        push({ type: "status", state: "error", message: err instanceof Error ? err.message : String(err), engine: "browser-local" });
        close();
      }
      return;
    }

    if (options.stream) {
      const { createStreamTranscriber } = await import("./transcriber");
      if (closed) return;
      const transcriber = createStreamTranscriber(runtime, {
        stream: options.stream,
        language: languageTag,
        onSegment(seg) {
          push({
            type: "final",
            text: seg.text,
            language: seg.language,
            startedAtMs: seg.startedAtMs,
            endedAtMs: seg.endedAtMs,
          });
        },
        onLevel(value) {
          push({ type: "level", value });
        },
        onStatus(st) {
          const state = st.state === "active" ? "listening"
            : st.state === "loading" ? "loading"
            : st.state === "error" ? "error" : "idle";
          push({ type: "status", state, message: st.message, engine: "whistle" });
          if (st.state === "error" || st.state === "disposed") close();
        },
      });
      stopImpl = () => {
        push({ type: "status", state: "finalizing", engine: "whistle" });
        transcriber.flush();
        setTimeout(() => { transcriber.dispose(); close(); }, 150);
      };
      cancelImpl = () => {
        transcriber.dispose();
        close();
      };
      try {
        await transcriber.start();
      } catch (err) {
        push({ type: "status", state: "error", message: err instanceof Error ? err.message : String(err), engine: "whistle" });
        transcriber.dispose();
        close();
      }
      return;
    }

    try {
      const voice = createVoice(runtime, {
        consentMode: "auto",
        partial(ev) {
          push({ type: "partial", confirmed: ev.confirmed, pending: ev.pending, text: ev.text });
        },
        transcript(text) {
          if (text.trim()) {
            push({ type: "final", text: text.trim(), language: resolvedLang, startedAtMs, endedAtMs: Date.now() });
          }
          push({ type: "status", state: "idle", engine: "whistle" });
          voice.dispose();
          close();
        },
        level(value) {
          push({ type: "level", value });
        },
        status(st) {
          if (st.kind !== "capture") return;
          if (st.state === "working") {
            push({ type: "status", state: "loading", message: st.message, engine: "whistle" });
          } else if (st.state === "recording") {
            startedAtMs = Date.now();
            push({ type: "status", state: "listening", message: st.message, engine: "whistle" });
          } else if (st.state === "error") {
            push({ type: "status", state: "error", message: st.message, engine: "whistle" });
            voice.dispose();
            close();
          }
        },
      });
      voice.language(languageTag);
      let stopping = false;
      stopImpl = () => {
        if (stopping || closed) return;
        stopping = true;
        push({ type: "status", state: "finalizing", engine: "whistle" });
        voice.finishCapture();
      };
      cancelImpl = () => {
        voice.cancelCapture();
        voice.dispose();
        close();
      };
      await voice.startCapture();
    } catch (err) {
      push({ type: "status", state: "error", message: err instanceof Error ? err.message : String(err), engine: "whistle" });
      close();
    }
  };

  return {
    stop() { stopImpl(); },
    cancel() { cancelImpl(); close(); },
    async *[Symbol.asyncIterator](): AsyncIterator<TranscriptEvent> {
      if (!closed) void startSession();
      try {
        for (;;) {
          if (buffer.length > 0) {
            yield buffer.shift()!;
            continue;
          }
          if (closed) return;
          await new Promise<void>(resolve => { notifyWaiter = resolve; });
        }
      } finally {
        if (!closed) {
          cancelImpl();
          close();
        }
      }
    },
  };
}

export interface TranscribeAudioOptions {
  /** BCP-47 language tag (e.g. "en-US", "de"). Defaults to navigator.language. */
  language?: string;
  /** Optional explicit fallback language if `language` is unsupported. */
  fallbackLanguage?: string;
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
  const language = resolveSpeechLanguage(options.language, { fallbackLanguage: options.fallbackLanguage });
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
  /** Optional live streaming partial callback while speaking. */
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

/**
 * Drop-in on-device dictation binding for any `<textarea>`, `<input>`, or custom callback.
 * Wires tap-to-toggle + optional press-and-hold, updates `data-state` / `aria-pressed` / `--level`,
 * streams live partial updates, and dispatches standard `input` events so reactive page state stays synchronized.
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
    partial(partial) {
      if (!disposed) options.onPartial?.(partial);
    },
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
