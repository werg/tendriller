// Push-to-talk recording and in-browser Cactus Whistle transcription.
import type { RuntimeArtifactFeatures } from "../../../contract/index.mjs";
import { mediaRequestSettled } from "../sensors";

export type CaptureMode = "local" | null;
export interface CaptureHandlers {
  onConsent(): Promise<boolean>;
  onInterim(text: string): void;
  onFinal(text: string): void;
  onState(listening: boolean): void;
  onError(message: string): void;
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

  constructor(private h: CaptureHandlers, private lang: () => string,
    private base: string, private speech: RuntimeArtifactFeatures["speech"]) {
    this.mode = !!speech && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia && !!window.OfflineAudioContext && !!window.Worker ? "local" : null;
  }

  get microphoneActive(): boolean { return this.listening; }
  get busy(): boolean { return this.starting || this.requesting || !!this.recorder || this.processing; }

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
    if (!this.mode) throw new Error("Private speech is unavailable on this device. You can type instead.");
    await this.load();
  }

  async start(): Promise<void> {
    if (this.disposed || this.recorder || this.starting || this.requesting || !this.mode) return;
    if (this.processing) { this.h.onError("Transcription is still in progress. Wait or cancel it before recording again."); return; }
    this.starting = true;
    const session = ++this.session;
    this.cancelled = false;
    const cancelled = new Promise<void>(resolve => { this.cancelStart = resolve; });
    let permissionTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const language = this.lang().split("-")[0].toLowerCase();
      if (!["en", "de", "fr", "es", "it", "nl", "pl"].includes(language)) throw new Error("Speech currently supports English, German, French, Spanish, Italian, Dutch and Polish. Choose one in page settings or type instead.");
      await Promise.race([this.load(), cancelled]);
      if (this.cancelled || session !== this.session) return;
      this.h.onInterim("Waiting for microphone permission…");
      if (this.cancelled || session !== this.session) return;
      const media = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      this.requesting = true;
      const opening = media.then(stream => {
        if (this.cancelled || session !== this.session || this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
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
      if (!this.cancelled && session === this.session) this.h.onError(error instanceof Error ? error.message : "Microphone unavailable. You can type instead.");
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

  private releaseStream(): void {
    this.offTracks?.(); this.offTracks = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.listening) { this.listening = false; this.h.onState(false); }
  }

  stop(): void {
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
    const recorder = this.recorder; this.recorder = null;
    try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch { /* All tracks are stopped below. */ }
    this.releaseStream();
    if (!this.prepared || this.processing) this.failWorker(new Error("Speech capture cancelled"));
    this.processing = false;
    this.h.onInterim("");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.failWorker(new Error("Speech capture disposed"));
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
      // Offline decoding does not need an autoplay-capable playback device.
      const decoder = new OfflineAudioContext(1, 1, 16000);
      const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
      if (this.cancelled || session !== this.session) return;
      const channels = decoded.numberOfChannels;
      const length = Math.min(decoded.length, decoded.sampleRate * 30);
      if (!channels || !length || !Number.isFinite(decoded.sampleRate) || decoded.sampleRate <= 0) throw new Error("Invalid decoded audio");
      const mono = new Float32Array(length);
      for (let channel = 0; channel < channels; channel++) {
        const data = decoded.getChannelData(channel);
        for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
      }
      const out = new Float32Array(Math.ceil(length * 16000 / decoded.sampleRate));
      for (let i = 0; i < out.length; i++) {
        const position = i * decoded.sampleRate / 16000;
        const left = Math.floor(position);
        const fraction = position - left;
        out[i] = mono[left] * (1 - fraction) + (mono[Math.min(left + 1, length - 1)] ?? 0) * fraction;
      }
      if (this.cancelled || session !== this.session) return;
      const result = await this.call("transcribe", { samples: out.buffer, language: this.lang().split("-")[0].toLowerCase() }, [out.buffer]);
      if (this.cancelled || session !== this.session) return;
      if (result.text?.trim()) this.h.onFinal(result.text.trim());
      else this.h.onError("I didn't catch that. Try again or type instead.");
    } catch {
      if (!this.cancelled && session === this.session) this.h.onError("On-device transcription failed. You can type instead.");
    } finally {
      if (this.processingSession === session) this.processing = false;
      if (session === this.session) this.h.onInterim("");
    }
  }
}
