import type { RuntimeApi } from "../../../contract/index.mjs";
import { loadSpeechResources, SPEECH_LANGUAGES } from "./resources";
import { getSharedSpeechWorker, type SharedSpeechWorker } from "./shared-worker";

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
  /** Keep transcribing while tab is backgrounded during an active call (default: false = keep running). */
  readonly stopOnHidden?: boolean;
  /** Optional custom transcription function (useful for tests or alternate local engines). */
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

interface QueuedSegment {
  readonly samples: Float32Array;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

const INFERENCE_TIMEOUT_MS = 12_000;

function audioConstructor(): typeof AudioContext | undefined {
  return window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/**
 * Continuous per-speaker on-device transcriber that taps an existing call MediaStream
 * (using the call's AEC/NS/AGC mic track) without calling getUserMedia or taking
 * the wake-word Web Lock. Shares the tab's single verified Cactus Whistle WASM worker pool.
 */
export function createStreamTranscriber(runtime: RuntimeApi, options: StreamTranscriberOptions): StreamTranscriber {
  const maxQueued = Math.max(1, Math.min(8, options.maxQueuedSegments ?? 3));
  let language = (options.language || navigator.language || "en-US").split("-")[0]!.toLowerCase();
  let status: StreamTranscriberStatus = { state: "idle", message: "", droppedSegments: 0 };
  let disposed = false;
  let started = false;
  let paused = false;
  let sequence = 0;
  let originTimeMs = Date.now();
  let droppedSegments = 0;

  let clonedTrack: MediaStreamTrack | null = null;
  let clonedStream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let sharedWorker: SharedSpeechWorker | null = null;
  let releaseWorker: (() => void) | null = null;
  const queue: QueuedSegment[] = [];
  let processing = false;
  const lifetime = new AbortController();

  const report = (state: StreamTranscriberStatus["state"], message = "") => {
    status = Object.freeze({ state, message, droppedSegments });
    try { options.onStatus?.(status); } catch { /* Isolate UI observer errors. */ }
  };

  const drainQueue = async () => {
    if (processing || disposed) return;
    processing = true;
    try {
      while (!disposed && queue.length > 0) {
        const item = queue.shift()!;
        let text = "";
        try {
          if (options.transcribe) {
            text = await options.transcribe({ samples: item.samples, language, signal: lifetime.signal });
          } else if (sharedWorker) {
            text = await sharedWorker.transcribeSegment(item.samples, language, {
              signal: lifetime.signal,
              timeoutMs: INFERENCE_TIMEOUT_MS,
            });
          }
        } catch (err) {
          if (!disposed) report("error", err instanceof Error ? err.message : String(err));
          continue;
        }
        if (disposed || !text) continue;
        try {
          options.onSegment(Object.freeze({
            utteranceId: crypto.randomUUID(),
            text,
            startedAtMs: item.startedAtMs,
            endedAtMs: item.endedAtMs,
            language,
            droppedSegments,
          }));
        } catch { /* Isolate consumer errors. */ }
      }
    } finally {
      processing = false;
    }
  };

  const enqueueSegment = (samples: Float32Array, startedOffsetMs: number, endedOffsetMs: number) => {
    if (disposed) return;
    if (queue.length >= maxQueued) {
      queue.shift();
      droppedSegments += 1;
    }
    queue.push({
      samples,
      startedAtMs: originTimeMs + startedOffsetMs,
      endedAtMs: originTimeMs + endedOffsetMs,
    });
    void drainQueue();
  };

  const cleanupAudio = () => {
    try { worklet?.port.postMessage({ type: "close" }); } catch {}
    try { source?.disconnect(); } catch {}
    try { worklet?.disconnect(); } catch {}
    source = null; worklet = null;
    if (context) { void context.close().catch(() => {}); context = null; }
    if (clonedTrack) { try { clonedTrack.stop(); } catch {} clonedTrack = null; }
    clonedStream = null;
  };

  const stopSensors = () => { dispose(); };
  const onVisibility = () => {
    if (options.stopOnHidden && document.visibilityState !== "visible") pause();
  };
  const onPageHide = () => { dispose(); };
  const offSensors = runtime.on("sensors_stopped", stopSensors);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);

  const start = async () => {
    if (disposed || started) return;
    if (!options.transcribe && !SPEECH_LANGUAGES.includes(language)) {
      report("error", `Unsupported on-device speech language: ${language}`);
      throw new Error(`Unsupported on-device speech language: ${language}`);
    }
    const audioTrack = options.stream.getAudioTracks().find(track => track.readyState === "live");
    if (!audioTrack) {
      report("error", "No active microphone track available for transcription");
      throw new Error("No active microphone track available for transcription");
    }
    const AudioCtx = audioConstructor();
    if (!AudioCtx || typeof AudioWorkletNode === "undefined") {
      report("error", "AudioWorklet transcription is unavailable in this browser");
      throw new Error("AudioWorklet transcription is unavailable in this browser");
    }
    started = true;
    report("loading", "Preparing on-device meeting transcription…");
    try {
      if (!options.transcribe) {
        const speech = await loadSpeechResources(runtime, lifetime.signal);
        if (disposed) return;
        const worker = getSharedSpeechWorker(runtime.assetUrl("voice-worker.js"), speech.sha256);
        sharedWorker = worker;
        releaseWorker = worker.retain();
        await worker.ensureInit(speech, {
          onProgress: msg => { if (!disposed) report("loading", msg); },
          signal: lifetime.signal,
        });
        if (disposed) return;
      }
      clonedTrack = audioTrack.clone();
      clonedStream = new MediaStream([clonedTrack]);
      context = new AudioCtx({ latencyHint: "interactive" });
      await context.resume();
      await context.audioWorklet.addModule(runtime.assetUrl("voice-pcm-worklet.js"));
      if (disposed) { cleanupAudio(); return; }
      source = context.createMediaStreamSource(clonedStream);
      worklet = new AudioWorkletNode(context, "tendriller-voice-pcm", {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit",
      });
      const currentSeq = ++sequence;
      originTimeMs = Date.now();
      worklet.port.onmessage = event => {
        const data = event.data;
        if (!data || data.sequence !== currentSeq || disposed) return;
        if (data.type === "segment" && data.samples instanceof ArrayBuffer) {
          enqueueSegment(new Float32Array(data.samples), Number(data.startedOffsetMs) || 0, Number(data.endedOffsetMs) || 0);
        } else if (data.type === "level" && typeof data.level === "number") {
          try { options.onLevel?.(data.level); } catch {}
        }
      };
      source.connect(worklet);
      worklet.connect(context.destination);
      paused = false;
      worklet.port.postMessage({
        type: "continuous",
        enabled: true,
        sequence: currentSeq,
        maxSegmentMs: options.maxSegmentMs ?? 8000,
        silenceMs: options.silenceMs ?? 520,
      });
      report("active", "On-device meeting transcription active.");
    } catch (err) {
      started = false;
      cleanupAudio();
      releaseWorker?.();
      releaseWorker = null;
      sharedWorker = null;
      report("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  const pause = () => {
    if (disposed || !started || paused) return;
    paused = true;
    try { worklet?.port.postMessage({ type: "flush" }); } catch {}
    try { worklet?.port.postMessage({ type: "continuous", enabled: false, sequence }); } catch {}
    report("paused", "Transcription paused.");
  };

  const resume = () => {
    if (disposed || !started || !paused) return;
    paused = false;
    originTimeMs = Date.now();
    try {
      worklet?.port.postMessage({
        type: "continuous", enabled: true, sequence: ++sequence,
        maxSegmentMs: options.maxSegmentMs ?? 8000, silenceMs: options.silenceMs ?? 520,
      });
    } catch {}
    report("active", "On-device meeting transcription active.");
  };

  const flush = () => {
    if (disposed || !started) return;
    try { worklet?.port.postMessage({ type: "flush" }); } catch {}
  };

  const setLanguage = (tag: string) => {
    const next = String(tag || "en").split("-")[0]!.toLowerCase();
    if (!options.transcribe && !SPEECH_LANGUAGES.includes(next)) {
      throw new Error(`Unsupported on-device speech language: ${tag}`);
    }
    language = next;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort(new Error("STREAM_TRANSCRIBER_DISPOSED"));
    offSensors();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    cleanupAudio();
    releaseWorker?.();
    releaseWorker = null;
    sharedWorker = null;
    queue.length = 0;
    report("disposed", "Transcription stopped.");
  };

  return Object.freeze({
    get status() { return status; },
    start, pause, resume, flush, setLanguage, dispose,
  });
}
