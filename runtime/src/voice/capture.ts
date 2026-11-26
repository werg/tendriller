// Push-to-talk recording and in-browser Cactus Whistle transcription.
// Uses direct 16 kHz PCM capture via AudioWorklet when available (avoiding mobile
// MediaRecorder/decodeAudioData codec failures), falling back cleanly to MediaRecorder.
import type { RuntimeArtifactFeatures } from "../../../contract/index.mjs";
import { mediaRequestSettled } from "../sensors";
import { decodeAudioToPcm16k, type SharedSpeechWorker } from "./shared-worker";

export type CaptureMode = "local" | null;
export type CaptureStage = "model" | "microphone_permission" | "recorder" | "transcription";

/** Produce an actionable, user-safe message distinguishing OS/browser permission denial, policy, device, and stage failures. */
export function classifyCaptureError(error: unknown, stage: CaptureStage, permissionState?: string | null): string {
  const name = (error && typeof error === "object" && "name" in error && typeof (error as { name?: unknown }).name === "string")
    ? (error as { name: string }).name : "";
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";

  if (stage === "microphone_permission") {
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      if (permissionState === "denied") {
        return "Microphone access is blocked for this site or browser (NotAllowedError). Allow microphone permission in your browser site settings and device app permissions, then try again or type instead.";
      }
      return "Microphone permission was not granted (NotAllowedError). If no prompt appeared, check that your browser is allowed to use the microphone in your device/OS app permissions and site settings, or type instead.";
    }
    if (name === "SecurityError") {
      return "Microphone capture requires a secure HTTPS context or is blocked by browser/device policy (SecurityError). You can type instead.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No microphone was found on this device (NotFoundError). Connect a microphone or type instead.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "The microphone is busy or blocked by another app or device privacy switch (NotReadableError). Close other apps using the mic and try again, or type instead.";
    }
    if (name === "OverconstrainedError") {
      return "This device's microphone could not match the requested audio settings (OverconstrainedError). You can type instead.";
    }
    if (name === "AbortError") {
      return "Microphone request was interrupted before recording started (AbortError). Tap the microphone to try again, or type instead.";
    }
    if (raw) return `Microphone could not start${name ? ` (${name})` : ""}: ${raw}`;
    return "Microphone unavailable. Check browser and device microphone permissions, or type instead.";
  }

  if (stage === "recorder") {
    return `Recording could not start${name ? ` (${name})` : ""}. Check your microphone and try again, or type instead.`;
  }

  if (raw) return raw;
  return "Microphone unavailable. You can type instead.";
}

async function probeMicrophonePermissionState(): Promise<string | null> {
  try {
    const query = navigator.permissions?.query;
    if (typeof query !== "function") return null;
    const result = await Promise.race([
      query.call(navigator.permissions, { name: "microphone" as PermissionName }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 250)),
    ]);
    return result && typeof result.state === "string" ? result.state : null;
  } catch {
    return null;
  }
}

export interface CaptureHandlers {
  onConsent(): Promise<boolean>;
  onInterim(text: string): void;
  onFinal(text: string): void;
  onState(listening: boolean): void;
  onError(message: string): void;
  onLevel?(level: number): void;
}

export class SpeechCapture {
  readonly mode: CaptureMode;
  listening = false;
  /** Pending getUserMedia cannot be aborted; retain ownership until this settles. */
  microphoneSettled: Promise<void> = Promise.resolve();
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private prepared = false;
  private loadingGeneration = 0;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private cancelled = false;
  private starting = false;
  private requesting = false;
  private cancelStart: (() => void) | null = null;
  private processing = false;
  private processingSession = 0;
  private session = 0;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private consented = false;
  private disposed = false;
  private offTracks: (() => void) | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private meterContext: AudioContext | null = null;
  private pcmContext: AudioContext | null = null;
  private pcmNode: AudioWorkletNode | null = null;
  private pcmSource: MediaStreamAudioSourceNode | null = null;
  private pcmChunks: Float32Array[] = [];
  private pcmTotalSamples = 0;
  private pcmActive = false;
  private sharedRelease: (() => void) | null = null;
  private initAbort: AbortController | null = null;
  private transcribeAbort: AbortController | null = null;

  constructor(private h: CaptureHandlers, private lang: () => string,
    private base: string, private speech: RuntimeArtifactFeatures["speech"],
    private workletUrl?: string, private sharedWorker?: SharedSpeechWorker) {
    const hasAudioWorklet = !!workletUrl && typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
    const hasMediaRecorder = typeof MediaRecorder !== "undefined" && !!window.OfflineAudioContext;
    this.mode = !!speech && !!navigator.mediaDevices?.getUserMedia && (hasAudioWorklet || hasMediaRecorder) && !!window.Worker ? "local" : null;
  }

  get microphoneActive(): boolean { return this.listening; }
  get busy(): boolean { return this.starting || this.requesting || !!this.recorder || this.pcmActive || this.processing; }

  private call(action: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<any> {
    if (!this.worker) return Promise.reject(new Error("Speech worker unavailable"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failWorker(new Error("Speech worker timed out")), action === "init" ? 120000 : 30000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { this.worker!.postMessage({ id, action, ...payload }, transfer); }
      catch (error) { this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error))); this.pending.delete(id); }
    });
  }

  private failWorker(error: Error): void {
    ++this.loadingGeneration;
    this.worker?.terminate(); this.worker = null; this.ready = null; this.prepared = false;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private load(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Speech capture is disposed"));
    if (this.ready) return this.ready;
    const generation = ++this.loadingGeneration;
    const current = () => !this.disposed && generation === this.loadingGeneration;
    const task = (async () => {
      if (!this.speech) throw new Error("Speech transcription is unavailable in this environment.");
      if (!this.consented) {
        if (!await this.h.onConsent()) throw new Error("Speech setup cancelled. You can type instead.");
        if (!current()) throw new Error(this.disposed ? "Speech capture is disposed" : "Speech setup cancelled");
        this.consented = true;
      }
      if (!current()) throw new Error(this.disposed ? "Speech capture is disposed" : "Speech setup cancelled");
      if (this.sharedWorker) {
        if (!this.sharedRelease) this.sharedRelease = this.sharedWorker.retain();
        const ac = new AbortController();
        this.initAbort = ac;
        try {
          await this.sharedWorker.ensureInit(this.speech, {
            onProgress: text => { if (current()) this.h.onInterim(text); },
            signal: ac.signal,
          });
        } finally {
          if (this.initAbort === ac) this.initAbort = null;
        }
        if (!current()) throw new Error("Speech setup cancelled");
        this.prepared = true;
        return;
      }
      const worker = this.worker = new Worker(new URL("voice-worker.js", new URL(this.base, location.href)).href);
      worker.onmessage = (event: MessageEvent) => {
        if (this.worker !== worker || !current()) return;
        const { id, error, progress, ...result } = event.data ?? {};
        if (progress) { this.h.onInterim(progress); return; }
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
      };
      worker.onerror = () => {
        if (this.worker !== worker) return;
        this.failWorker(new Error("Speech worker failed"));
        if (this.listening) { this.cancel(); this.h.onError("Speech worker failed. The microphone is stopped; try again or type instead."); }
      };
      this.h.onInterim("Downloading private speech model…");
      await this.call("init", { engine: this.speech.engine, modelUrl: new URL(this.speech.url, new URL(this.base, location.href)).href,
        modelSha256: this.speech.sha256, modelSize: this.speech.size });
      if (!current()) throw new Error("Speech setup cancelled");
      this.prepared = true;
    })();
    const pending = task.catch(error => {
      if (this.ready === pending) { this.worker?.terminate(); this.worker = null; this.ready = null; this.prepared = false; }
      throw error;
    });
    this.ready = pending;
    return pending;
  }

  /** Warm transcription without opening the microphone. */
  async prepare(): Promise<void> {
    if (!this.mode) {
      const missing: string[] = [];
      if (!this.speech) missing.push("on-device speech model");
      if (!navigator.mediaDevices?.getUserMedia) missing.push("microphone capture");
      if (typeof MediaRecorder === "undefined") missing.push("MediaRecorder");
      if (!window.OfflineAudioContext) missing.push("OfflineAudioContext");
      if (!window.Worker) missing.push("Web Workers");
      const detail = missing.length ? ` (missing ${missing.join(", ")})` : "";
      throw new Error(`On-device speech capture is unavailable in this browser${detail}. You can type instead.`);
    }
    await this.load();
  }

  async start(): Promise<void> {
    if (this.disposed || this.recorder || this.starting || this.requesting) return;
    if (!this.mode) {
      const missing: string[] = [];
      if (!this.speech) missing.push("on-device speech model");
      if (!navigator.mediaDevices?.getUserMedia) missing.push("microphone capture");
      if (typeof MediaRecorder === "undefined") missing.push("MediaRecorder");
      if (!window.OfflineAudioContext) missing.push("OfflineAudioContext");
      if (!window.Worker) missing.push("Web Workers");
      this.h.onError(`On-device speech capture is unavailable in this browser${missing.length ? ` (missing ${missing.join(", ")})` : ""}. You can type instead.`);
      return;
    }
    if (this.processing) { this.h.onError("Transcription is still in progress. Wait or cancel it before recording again."); return; }
    this.starting = true;
    const session = ++this.session;
    this.cancelled = false;
    const cancelled = new Promise<void>(resolve => { this.cancelStart = resolve; });
    let permissionTimer: ReturnType<typeof setTimeout> | null = null;
    let stage: CaptureStage = "model";
    try {
      const language = this.lang().split("-")[0].toLowerCase();
      if (!["en", "de", "fr", "es", "it", "nl", "pl"].includes(language)) throw new Error("Speech currently supports English, German, French, Spanish, Italian, Dutch and Polish. Choose one in page settings or type instead.");
      await Promise.race([this.load(), cancelled]);
      if (this.cancelled || session !== this.session) return;
      this.h.onInterim("Waiting for microphone permission…");
      if (this.cancelled || session !== this.session) return;
      stage = "microphone_permission";
      const media = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      this.requesting = true;
      const opening = media.then(async stream => {
        if (this.cancelled || session !== this.session || this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
        stage = "recorder";
        this.stream = stream;
        try {
          const tracks = stream.getAudioTracks?.() || stream.getTracks();
          if (!tracks.length || tracks.every(track => track.readyState === "ended")) throw new Error("No active microphone track was provided.");
          const interrupted = () => {
            if (session !== this.session || this.stream !== stream) return;
            this.cancel();
            this.h.onError("Microphone access was interrupted. Check your device and tap the microphone to try again.");
          };
          for (const track of tracks) {
            track.addEventListener?.("ended", interrupted);
            track.addEventListener?.("mute", interrupted);
          }
          this.offTracks = () => {
            for (const track of tracks) {
              track.removeEventListener?.("ended", interrupted);
              track.removeEventListener?.("mute", interrupted);
            }
          };

          // Prefer direct 16 kHz PCM capture via AudioWorklet (immune to mobile MediaRecorder codec issues).
          const startedPcm = await this.tryStartPcmCapture(stream, session);
          if (this.cancelled || session !== this.session || this.disposed) {
            this.releaseStream();
            return;
          }
          if (!startedPcm) {
            const chunks: Blob[] = [];
            let bytes = 0;
            const rec = new MediaRecorder(stream);
            this.recorder = rec;
            rec.ondataavailable = event => {
              if (session !== this.session || this.cancelled) return;
              bytes += event.data.size;
              if (bytes > 16 * 1024 * 1024) { this.cancel(); this.h.onError("Recording exceeded its memory limit. Try a shorter utterance."); return; }
              if (event.data.size) chunks.push(event.data);
            };
            rec.onerror = interrupted;
            rec.onstop = () => { void this.finish(new Blob(chunks, { type: rec.mimeType }), session, rec, stream); };
            rec.start(1000);
            this.startMeter(stream);
          }
          this.listening = true;
          this.h.onState(true);
          this.h.onInterim("");
          this.maxTimer = setTimeout(() => this.stop(), 30_000);
        } catch (error) {
          this.releaseStream(); this.recorder = null;
          throw error;
        }
      });
      this.microphoneSettled = Promise.all([mediaRequestSettled(media), opening.catch(() => {})]).then(() => { this.requesting = false; });
      const permissionDeadline = new Promise<void>(resolve => {
        permissionTimer = setTimeout(() => {
          if (session === this.session) {
            this.cancel();
            this.h.onError("Microphone permission request timed out. Dismiss the browser prompt before starting again.");
          }
          resolve();
        }, 30_000);
      });
      await Promise.race([opening, cancelled, permissionDeadline]);
    } catch (error) {
      this.releaseStream(); this.recorder = null;
      if (!this.cancelled && session === this.session) {
        const perm = stage === "microphone_permission" ? await probeMicrophonePermissionState() : null;
        if (!this.cancelled && session === this.session) {
          this.h.onError(classifyCaptureError(error, stage, perm));
        }
      }
    } finally {
      if (permissionTimer !== null) clearTimeout(permissionTimer);
      this.starting = false;
      this.cancelStart = null;
    }
  }

  private clearTimers(): void {
    if (this.maxTimer !== null) clearTimeout(this.maxTimer);
    if (this.finishTimer !== null) clearTimeout(this.finishTimer);
    this.maxTimer = null; this.finishTimer = null;
  }

  private startMeter(stream: MediaStream): void {
    this.stopMeter();
    if (!this.h.onLevel || typeof AudioContext === "undefined") return;
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      this.meterContext = ctx;
      this.meterTimer = setInterval(() => {
        if (!this.listening) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          const v = (samples[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / samples.length);
        // Scale conversational speech (~0.02..0.28 RMS) smoothly onto 0..1.
        const level = Math.min(1, Math.max(0, (rms - 0.01) * 4));
        try { this.h.onLevel?.(level); } catch { /* ignore meter listener errors */ }
      }, 65);
    } catch {
      this.stopMeter();
    }
  }

  private stopMeter(): void {
    if (this.meterTimer !== null) { clearInterval(this.meterTimer); this.meterTimer = null; }
    if (this.meterContext) { void this.meterContext.close().catch(() => {}); this.meterContext = null; }
    try { this.h.onLevel?.(0); } catch { /* ignore */ }
  }

  private async tryStartPcmCapture(stream: MediaStream, session: number): Promise<boolean> {
    if (!this.workletUrl || typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") return false;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      if (!ctx.audioWorklet) { void ctx.close().catch(() => {}); return false; }
      await ctx.audioWorklet.addModule(this.workletUrl);
      if (this.cancelled || session !== this.session || this.disposed) {
        void ctx.close().catch(() => {});
        return true;
      }
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "tendriller-voice-pcm", {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit",
      });
      this.pcmChunks = [];
      this.pcmTotalSamples = 0;
      const maxSamples = 16_000 * 30;
      node.port.onmessage = (event: MessageEvent) => {
        if (session !== this.session || this.cancelled) return;
        const msg = event.data;
        if (msg?.type === "pcm" && msg.samples && typeof msg.samples.byteLength === "number") {
          const chunk = new Float32Array(msg.samples);
          const remaining = maxSamples - this.pcmTotalSamples;
          if (remaining > 0) {
            const take = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
            this.pcmChunks.push(take);
            this.pcmTotalSamples += take.length;
          }
          if (typeof msg.level === "number") {
            try { this.h.onLevel?.(msg.level); } catch { /* ignore */ }
          }
          if (this.pcmTotalSamples >= maxSamples && this.pcmActive) this.stop();
        } else if (msg?.type === "level" && typeof msg.level === "number") {
          try { this.h.onLevel?.(msg.level); } catch { /* ignore */ }
        }
      };
      source.connect(node);
      node.connect(ctx.destination);
      node.port.postMessage({ type: "capture", sequence: session, enabled: true });
      this.pcmContext = ctx;
      this.pcmSource = source;
      this.pcmNode = node;
      this.pcmActive = true;
      return true;
    } catch {
      try { void ctx?.close().catch(() => {}); } catch {}
      this.teardownPcm();
      return false;
    }
  }

  private teardownPcm(): void {
    this.pcmActive = false;
    try { this.pcmNode?.port.postMessage({ type: "close" }); } catch {}
    try { this.pcmSource?.disconnect(); } catch {}
    try { this.pcmNode?.disconnect(); } catch {}
    this.pcmSource = null;
    this.pcmNode = null;
    if (this.pcmContext) {
      void this.pcmContext.close().catch(() => {});
      this.pcmContext = null;
    }
  }

  private releaseStream(): void {
    this.stopMeter();
    this.teardownPcm();
    this.offTracks?.(); this.offTracks = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.listening) { this.listening = false; this.h.onState(false); }
  }

  stop(): void {
    if (this.pcmActive) {
      const session = this.session;
      this.clearTimers();
      this.pcmActive = false;
      this.processing = true; this.processingSession = session;
      try { this.pcmNode?.port.postMessage({ type: "capture", sequence: session, enabled: false }); } catch {}
      // Give the worklet one micro-window (~35ms) to flush trailing samples before tearing down.
      setTimeout(() => {
        const chunks = this.pcmChunks;
        const total = this.pcmTotalSamples;
        this.pcmChunks = [];
        this.pcmTotalSamples = 0;
        this.releaseStream();
        if (this.cancelled || session !== this.session) return;
        const merged = new Float32Array(total);
        let offset = 0;
        for (const c of chunks) { merged.set(c, offset); offset += c.length; }
        void this.transcribePcm(merged, session);
      }, 35);
      return;
    }
    const rec = this.recorder;
    if (!rec) { this.cancel(); return; }
    this.clearTimers();
    this.processing = true; this.processingSession = this.session;
    try { if (rec.state !== "inactive") rec.stop(); }
    catch { this.cancel(); this.h.onError("Recording could not be completed. Try again or type instead."); return; }
    // Never wait for MediaRecorder.onstop to turn the microphone off.
    this.releaseStream();
    if (this.recorder === rec) {
      this.finishTimer = setTimeout(() => {
        if (this.recorder !== rec) return;
        this.cancel(); this.h.onError("Recording did not finish. The microphone is stopped; try again.");
      }, 5_000);
    }
  }

  cancel(): void {
    ++this.session; this.cancelled = true; this.cancelStart?.();
    this.clearTimers();
    this.pcmChunks = []; this.pcmTotalSamples = 0;
    const recorder = this.recorder; this.recorder = null;
    try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch { /* All tracks are stopped below. */ }
    this.releaseStream();
    if (this.sharedWorker) {
      if (!this.prepared) {
        ++this.loadingGeneration;
        this.ready = null;
        this.initAbort?.abort();
        this.initAbort = null;
      }
      if (this.processing) {
        this.transcribeAbort?.abort();
        this.transcribeAbort = null;
      }
    } else if (!this.prepared || this.processing) {
      this.failWorker(new Error("Speech capture cancelled"));
    }
    this.processing = false;
    this.h.onInterim("");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    if (this.sharedWorker) {
      this.initAbort?.abort();
      this.initAbort = null;
      this.transcribeAbort?.abort();
      this.transcribeAbort = null;
      this.ready = null;
      this.prepared = false;
      this.sharedRelease?.();
      this.sharedRelease = null;
    } else {
      this.failWorker(new Error("Speech capture disposed"));
    }
  }

  private async transcribePcm(samples: Float32Array, session: number): Promise<void> {
    if (this.cancelled || session !== this.session) return;
    if (!samples.length) {
      this.processing = false;
      this.h.onError("No audio was recorded. Try again or type instead.");
      return;
    }
    this.processing = true; this.processingSession = session;
    this.h.onInterim("Transcribing on this device…");
    try {
      const language = this.lang().split("-")[0]!.toLowerCase();
      let text = "";
      if (this.sharedWorker) {
        const ac = new AbortController();
        this.transcribeAbort = ac;
        try {
          text = await this.sharedWorker.transcribe(samples, language, { signal: ac.signal });
        } finally {
          if (this.transcribeAbort === ac) this.transcribeAbort = null;
        }
      } else {
        const copy = new Float32Array(samples);
        const result = await this.call("transcribe", { samples: copy.buffer, language }, [copy.buffer]);
        text = String(result?.text ?? "").trim();
      }
      if (this.cancelled || session !== this.session) return;
      if (text) this.h.onFinal(text);
      else this.h.onError("I didn't catch that. Try again or type instead.");
    } catch {
      if (!this.cancelled && session === this.session) this.h.onError("On-device transcription failed. You can type instead.");
    } finally {
      if (this.processingSession === session) this.processing = false;
      if (session === this.session) this.h.onInterim("");
    }
  }

  private async finish(blob: Blob, session: number, recorder: MediaRecorder, stream: MediaStream): Promise<void> {
    stream.getTracks().forEach(track => track.stop());
    if (this.recorder === recorder) {
      this.clearTimers(); this.recorder = null; this.releaseStream();
    }
    if (this.cancelled || session !== this.session) return;
    if (!blob.size) { this.processing = false; this.h.onError("No audio was recorded. Try again or type instead."); return; }
    this.processing = true; this.processingSession = session;
    this.h.onInterim("Transcribing on this device…");
    try {
      const out = await decodeAudioToPcm16k(blob);
      const bounded = out.length > 16_000 * 30 ? out.subarray(0, 16_000 * 30) : out;
      await this.transcribePcm(bounded, session);
    } catch {
      if (!this.cancelled && session === this.session) this.h.onError("On-device audio decoding failed in this browser. Try again or type instead.");
      if (this.processingSession === session) this.processing = false;
      if (session === this.session) this.h.onInterim("");
    }
  }
}
