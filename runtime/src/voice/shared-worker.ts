// Shared per-tab Cactus Whistle WASM worker pool and audio-to-16kHz-PCM decoder.
// Consolidates dictation, tap-to-talk, meeting stream transcription, and local wake spotting
// onto a single verified ~18 MB WASM worker per tab.
import type { RuntimeArtifactFeatures } from "../../../contract/index.mjs";

type SpeechResources = NonNullable<RuntimeArtifactFeatures["speech"]>;

export interface SpeechStreamPartial {
  readonly confirmed: string;
  readonly pending: string;
  readonly text: string;
}

export interface SpeechStreamHandle {
  readonly native: boolean;
  push(samples: Float32Array, options?: { signal?: AbortSignal }): Promise<SpeechStreamPartial>;
  stop(options?: { signal?: AbortSignal }): Promise<string>;
  cancel(): Promise<void>;
}

export interface SharedSpeechWorker {
  readonly supportsStreaming: boolean;
  retain(): () => void;
  ensureInit(speech: SpeechResources, options?: { onProgress?: (text: string) => void; signal?: AbortSignal }): Promise<void>;
  transcribe(samples: Float32Array, language: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string>;
  transcribeSegment(samples: Float32Array, language: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string>;
  detect(samples: Float32Array, language: string, phrase: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ matched: boolean; command: string }>;
  startStream(language: string, options?: { signal?: AbortSignal }): Promise<SpeechStreamHandle>;
}

const poolsByCtor = new WeakMap<Function, Map<string, SharedSpeechWorkerImpl>>();

function poolForCurrentWorker(): Map<string, SharedSpeechWorkerImpl> {
  const ctor = typeof Worker === "function" ? Worker : Object;
  let map = poolsByCtor.get(ctor);
  if (!map) {
    map = new Map();
    poolsByCtor.set(ctor, map);
  }
  return map;
}

function clampCopy(samples: Float32Array): Float32Array {
  const copy = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    copy[i] = Number.isFinite(v) ? (v > 1 ? 1 : v < -1 ? -1 : v) : 0;
  }
  return copy;
}

class SharedSpeechWorkerImpl implements SharedSpeechWorker {
  private worker: Worker | null = null;
  private initialized = false;
  private streamingSupported = false;
  private initPromise: Promise<void> | null = null;
  private initWaiters = 0;
  private holders = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private streamSeq = 0;
  private progressListeners = new Set<(text: string) => void>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(private readonly workerUrl: string) {}

  get supportsStreaming(): boolean { return this.streamingSupported; }

  retain(): () => void {
    this.holders++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders = Math.max(0, this.holders - 1);
      if (this.holders === 0) {
        this.fail(new Error("Speech worker disposed"));
      }
    };
  }

  private fail(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.initialized = false;
    this.streamingSupported = false;
    this.initPromise = null;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerUrl);
    worker.onmessage = (event: MessageEvent) => {
      if (this.worker !== worker) return;
      const { id, error, progress, ...result } = event.data ?? {};
      if (progress) {
        for (const fn of this.progressListeners) { try { fn(String(progress)); } catch {} }
        return;
      }
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (error) entry.reject(new Error(String(error)));
      else entry.resolve(result);
    };
    worker.onerror = (event: ErrorEvent) => {
      if (this.worker !== worker) return;
      const detail = event?.message ? ` (${event.message})` : "";
      this.fail(new Error(`On-device speech worker failed${detail}. Try again or type instead.`));
    };
    this.worker = worker;
    return worker;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private call(
    action: string,
    payload: Record<string, unknown>,
    transfer: Transferable[] = [],
    timeoutMs = 30_000,
    fatalOnTimeout = false,
  ): Promise<any> {
    const worker = this.ensureWorker();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        const err = new Error("On-device speech worker timed out.");
        if (fatalOnTimeout) {
          this.fail(err);
        } else {
          entry.reject(err);
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { worker.postMessage({ id, action, ...payload }, transfer); }
      catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async ensureInit(speech: SpeechResources, options: { onProgress?: (text: string) => void; signal?: AbortSignal } = {}): Promise<void> {
    if (options.signal?.aborted) throw new DOMException("Speech preparation cancelled", "AbortError");
    if (this.initialized && this.worker) return;
    if (options.onProgress) this.progressListeners.add(options.onProgress);
    this.initWaiters++;
    try {
      if (!this.initPromise) {
        const baseUrl = new URL(".", this.workerUrl);
        this.initPromise = this.enqueue(async () => {
          if (this.initialized && this.worker) return;
          for (const fn of this.progressListeners) { try { fn("Downloading private speech model…"); } catch {} }
          const res = await this.call("init", {
            engine: speech.engine,
            modelUrl: new URL(speech.url, baseUrl).href,
            modelSha256: speech.sha256,
            modelSize: speech.size,
          }, [], 120_000, true);
          this.initialized = true;
          this.streamingSupported = res?.streaming === true;
        }).catch(err => {
          this.initPromise = null;
          throw err;
        });
      }
      await raceAbort(this.initPromise, options.signal);
    } finally {
      this.initWaiters = Math.max(0, this.initWaiters - 1);
      if (options.onProgress) this.progressListeners.delete(options.onProgress);
      if (options.signal?.aborted && this.initWaiters === 0 && !this.initialized) {
        this.fail(new Error("Speech setup cancelled"));
      }
    }
  }

  async transcribe(samples: Float32Array, language: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
    if (options.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");
    if (!this.initialized || !this.worker) throw new Error("Speech model is not loaded yet.");
    const copy = clampCopy(samples);
    const task = this.enqueue(async () => {
      if (options.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");
      const res = await this.call("transcribe", { samples: copy.buffer, language }, [copy.buffer], options.timeoutMs ?? 30_000, false);
      return String(res?.text ?? "").trim();
    });
    return raceAbort(task, options.signal);
  }

  async transcribeSegment(samples: Float32Array, language: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
    if (options.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");
    if (!this.initialized || !this.worker) throw new Error("Speech model is not loaded yet.");
    const copy = clampCopy(samples);
    const task = this.enqueue(async () => {
      if (options.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");
      const res = await this.call("transcribe-segment", { samples: copy.buffer, language }, [copy.buffer], options.timeoutMs ?? 12_000, false);
      return String(res?.text ?? "").trim();
    });
    return raceAbort(task, options.signal);
  }

  async detect(samples: Float32Array, language: string, phrase: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ matched: boolean; command: string }> {
    if (options.signal?.aborted) throw new DOMException("Detection cancelled", "AbortError");
    if (!this.initialized || !this.worker) throw new Error("Speech model is not loaded yet.");
    const copy = clampCopy(samples);
    const task = this.enqueue(async () => {
      if (options.signal?.aborted) throw new DOMException("Detection cancelled", "AbortError");
      const res = await this.call("detect", { samples: copy.buffer, language, phrase }, [copy.buffer], options.timeoutMs ?? 10_000, false);
      return { matched: res?.matched === true, command: String(res?.command ?? "").trim() };
    });
    return raceAbort(task, options.signal);
  }

  async startStream(language: string, options: { signal?: AbortSignal } = {}): Promise<SpeechStreamHandle> {
    if (options.signal?.aborted) throw new DOMException("Stream cancelled", "AbortError");
    if (!this.initialized || !this.worker) throw new Error("Speech model is not loaded yet.");

    const sessionId = `stream-${++this.streamSeq}`;
    let closed = false;
    let native = false;
    const fallbackChunks: Float32Array[] = [];
    let fallbackSamples = 0;

    if (this.streamingSupported) {
      try {
        const res = await raceAbort(
          this.enqueue(() => this.call("stream-start", { sessionId, language }, [], 15_000, false)),
          options.signal,
        );
        native = res?.native === true;
      } catch {
        native = false;
      }
    }

    return {
      get native() { return native; },
      push: async (samples: Float32Array, pushOpts: { signal?: AbortSignal } = {}): Promise<SpeechStreamPartial> => {
        if (closed || pushOpts.signal?.aborted) throw new DOMException("Stream closed", "AbortError");
        const copy = clampCopy(samples);
        if (!native) {
          const cap = 16_000 * 30;
          const remaining = cap - fallbackSamples;
          if (remaining > 0) {
            const take = copy.length <= remaining ? copy : copy.subarray(0, remaining);
            fallbackChunks.push(take);
            fallbackSamples += take.length;
          }
          return { confirmed: "", pending: "", text: "" };
        }
        const task = this.enqueue(async () => {
          if (closed || pushOpts.signal?.aborted) return { confirmed: "", pending: "", text: "" };
          const res = await this.call("stream-chunk", { sessionId, samples: copy.buffer }, [copy.buffer], 15_000, false);
          return {
            confirmed: String(res?.confirmed ?? ""),
            pending: String(res?.pending ?? ""),
            text: String(res?.text ?? ""),
          };
        });
        return raceAbort(task, pushOpts.signal);
      },
      stop: async (stopOpts: { signal?: AbortSignal } = {}): Promise<string> => {
        if (closed) return "";
        closed = true;
        if (!native) {
          if (fallbackSamples === 0) return "";
          const merged = new Float32Array(fallbackSamples);
          let offset = 0;
          for (const chunk of fallbackChunks) { merged.set(chunk, offset); offset += chunk.length; }
          fallbackChunks.length = 0;
          fallbackSamples = 0;
          return this.transcribe(merged, language, { signal: stopOpts.signal });
        }
        const task = this.enqueue(async () => {
          const res = await this.call("stream-stop", { sessionId }, [], 15_000, false);
          return String(res?.text ?? "").trim();
        });
        return raceAbort(task, stopOpts.signal);
      },
      cancel: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        fallbackChunks.length = 0;
        fallbackSamples = 0;
        if (!native || !this.worker) return;
        try {
          await this.enqueue(() => this.call("stream-cancel", { sessionId }, [], 5_000, false));
        } catch { /* best-effort reset */ }
      },
    };
  }
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      err => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

export function getSharedSpeechWorker(workerUrl: string, modelSha256: string): SharedSpeechWorker {
  const pool = poolForCurrentWorker();
  const key = `${workerUrl}#${modelSha256}`;
  let existing = pool.get(key);
  if (!existing) {
    existing = new SharedSpeechWorkerImpl(workerUrl);
    pool.set(key, existing);
  }
  return existing;
}

/** Downmix & linearly resample PCM samples to 16 kHz mono Float32Array clamped to [-1, 1]. */
export function resampleTo16kMono(channels: readonly Float32Array[], sampleRate: number, maxSeconds = 120): Float32Array {
  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Invalid audio samples or sample rate.");
  }
  const srcLen = Math.min(channels[0]!.length, Math.floor(sampleRate * maxSeconds));
  if (srcLen <= 0) throw new Error("Audio recording is empty.");
  const mono = new Float32Array(srcLen);
  const scale = 1 / channels.length;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c]!;
    for (let i = 0; i < srcLen; i++) mono[i] = mono[i]! + (ch[i] ?? 0) * scale;
  }
  if (Math.round(sampleRate) === 16000) {
    for (let i = 0; i < mono.length; i++) mono[i] = Math.max(-1, Math.min(1, Number.isFinite(mono[i]!) ? mono[i]! : 0));
    return mono;
  }
  const outLen = Math.max(1, Math.ceil((srcLen * 16000) / sampleRate));
  const out = new Float32Array(outLen);
  const ratio = sampleRate / 16000;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const frac = pos - left;
    const v = mono[left]! * (1 - frac) + (mono[Math.min(left + 1, srcLen - 1)] ?? 0) * frac;
    out[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  }
  return out;
}

/** Decode a Blob, File, ArrayBuffer, AudioBuffer, or Float32Array into 16 kHz mono PCM. */
export async function decodeAudioToPcm16k(
  input: Blob | ArrayBuffer | AudioBuffer | Float32Array,
  sampleRate = 16000,
): Promise<Float32Array> {
  if (input instanceof Float32Array) {
    return resampleTo16kMono([input], sampleRate);
  }
  if ("getChannelData" in input) {
    const chs: Float32Array[] = [];
    for (let i = 0; i < input.numberOfChannels; i++) chs.push(input.getChannelData(i));
    return resampleTo16kMono(chs, input.sampleRate);
  }
  const buffer = input instanceof ArrayBuffer ? input.slice(0) : await input.arrayBuffer();
  if (!buffer.byteLength) throw new Error("No audio data was provided.");
  const Offline = typeof OfflineAudioContext !== "undefined" ? OfflineAudioContext : (window as any).webkitOfflineAudioContext;
  if (!Offline) throw new Error("This browser cannot decode audio files locally (missing OfflineAudioContext).");
  const decoder = new Offline(1, 1, 16000);
  const decoded = await decoder.decodeAudioData(buffer);
  const chs: Float32Array[] = [];
  for (let i = 0; i < decoded.numberOfChannels; i++) chs.push(decoded.getChannelData(i));
  return resampleTo16kMono(chs, decoded.sampleRate);
}
