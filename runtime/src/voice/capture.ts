// Push-to-talk recording and in-browser Cactus Whistle transcription.
import type { Features } from "../types";

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
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private cancelled = false;
  private starting = false;
  private session = 0;
  private maxTimer: number | null = null;
  private consented = false;

  constructor(private h: CaptureHandlers, private lang: () => string,
    private base: string, private speech: Features["speech"]) {
    this.mode = !!speech && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia && !!window.OfflineAudioContext && !!window.Worker ? "local" : null;
  }

  private call(action: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<any> {
    if (!this.worker) return Promise.reject(new Error("Speech worker unavailable"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, action, ...payload }, transfer);
    });
  }

  private async load(): Promise<void> {
    if (this.ready) return this.ready;
    if (!this.speech) throw new Error("Speech transcription is unavailable in this environment.");
    if (!this.consented) {
      if (!await this.h.onConsent()) throw new Error("Speech setup cancelled. You can type instead.");
      this.consented = true;
    }
    this.worker = new Worker(new URL("voice-worker.js", new URL(this.base, location.href)).href);
    this.worker.onmessage = (event: MessageEvent) => {
      const { id, error, progress, ...result } = event.data ?? {};
      if (progress) { this.h.onInterim(progress); return; }
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve(result);
    };
    this.worker.onerror = () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Speech worker failed"));
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
      this.ready = null;
    };
    this.h.onInterim("Downloading private speech model…");
    this.ready = this.call("init", { engine: this.speech.engine, modelUrl: new URL(this.speech.url, new URL(this.base, location.href)).href,
      modelSha256: this.speech.sha256 }).then(() => {});
    try { await this.ready; }
    catch (error) { this.worker?.terminate(); this.worker = null; this.ready = null; throw error; }
  }

  /** Warm transcription without opening the microphone. */
  async prepare(): Promise<void> {
    if (!this.mode) throw new Error("Private speech is unavailable on this device. You can type instead.");
    await this.load();
  }

  async start(): Promise<void> {
    if (this.listening || this.starting || !this.mode) return;
    this.starting = true;
    const session = ++this.session;
    this.cancelled = false;
    try {
      const language = this.lang().slice(0, 2).toLowerCase();
      if (!["en", "de", "fr", "es", "it", "nl", "pl"].includes(language)) throw new Error("Speech currently supports English, German, French, Spanish, Italian, Dutch and Polish. Choose one in page settings or type instead.");
      await this.load();
      if (this.cancelled || session !== this.session) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.cancelled || session !== this.session) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(this.stream);
      this.recorder = rec;
      rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      rec.onstop = () => { void this.finish(new Blob(chunks, { type: rec.mimeType }), session); };
      rec.start();
      this.listening = true;
      this.h.onState(true);
      this.h.onInterim("");
      this.maxTimer = window.setTimeout(() => this.stop(), 30_000);
    } catch (error) {
      this.stream?.getTracks().forEach(track => track.stop());
      this.stream = null;
      this.h.onError(error instanceof Error ? error.message : "Microphone unavailable. You can type instead.");
    } finally { this.starting = false; }
  }

  stop(): void { if (this.recorder?.state === "recording") this.recorder.stop(); else this.cancelled = true; }
  cancel(): void { ++this.session; this.cancelled = true; this.stop(); }

  dispose(): void {
    this.cancel();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.maxTimer !== null) window.clearTimeout(this.maxTimer);
    this.maxTimer = null;
    this.worker?.terminate(); this.worker = null; this.ready = null;
    for (const pending of this.pending.values()) pending.reject(new Error("Speech capture disposed"));
    this.pending.clear();
  }

  private async finish(blob: Blob, session: number): Promise<void> {
    if (this.maxTimer !== null) window.clearTimeout(this.maxTimer);
    this.maxTimer = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.recorder = null;
    this.listening = false;
    this.h.onState(false);
    if (this.cancelled || session !== this.session || !blob.size) return;
    this.h.onInterim("Transcribing on this device…");
    try {
      // Decoding needs no playback device. An AudioContext created from MediaRecorder's
      // async stop callback may be blocked by autoplay rules after the tap has ended.
      const decoder = new OfflineAudioContext(1, 1, 16000);
      const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
      const channels = decoded.numberOfChannels;
      const length = Math.min(decoded.length, decoded.sampleRate * 30);
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
      const result = await this.call("transcribe", { samples: out.buffer, language: this.lang().slice(0, 2) }, [out.buffer]);
      if (this.cancelled || session !== this.session) return;
      if (result.text?.trim()) this.h.onFinal(result.text.trim());
      else this.h.onError("I didn't catch that. Try again or type instead.");
    } catch {
      if (!this.cancelled && session === this.session) this.h.onError("On-device transcription failed. You can type instead.");
    } finally {
      this.h.onInterim("");
    }
  }
}
