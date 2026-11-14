// Push-to-talk recording and in-browser Cactus Whistle transcription.
import type { SensorTracker } from "./sensors";

export type CaptureMode = "local" | null;
export interface CaptureHandlers {
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
  private maxTimer: number | null = null;

  constructor(private h: CaptureHandlers, private sensors: SensorTracker, private lang: () => string,
    private base: string, private speech: { model: string; url: string; sha256: string }) {
    this.mode = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia && !!window.AudioContext && !!window.Worker ? "local" : null;
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
    if (!window.confirm("Download 18 MB for private, on-device speech transcription? Audio stays on this device.")) throw new Error("Download declined. You can type instead.");
    this.worker = new Worker(this.base + "_tendril/speech-worker.js");
    this.worker.onmessage = (event: MessageEvent) => {
      const { id, error, ...result } = event.data ?? {};
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
    this.ready = this.call("init", { base: this.base, modelUrl: new URL(this.speech.url, location.origin + this.base).href,
      modelSha256: this.speech.sha256 }).then(() => {});
    try { await this.ready; }
    catch (error) { this.worker?.terminate(); this.worker = null; this.ready = null; throw error; }
  }

  async start(_hold: boolean): Promise<void> {
    if (this.listening || !this.mode) return;
    this.cancelled = false;
    try {
      await this.load();
      if (this.cancelled) return;
      this.stream = await this.sensors.getUserMedia({ audio: true });
      if (this.cancelled) { this.stream.getTracks().forEach(track => track.stop()); this.stream = null; return; }
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(this.stream);
      this.recorder = rec;
      rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      rec.onstop = () => { void this.finish(new Blob(chunks, { type: rec.mimeType })); };
      rec.start();
      this.listening = true;
      this.h.onState(true);
      this.h.onInterim("");
      this.maxTimer = window.setTimeout(() => this.stop(), 30_000);
    } catch (error) {
      this.stream?.getTracks().forEach(track => track.stop());
      this.stream = null;
      this.h.onError(error instanceof Error ? error.message : "Microphone unavailable. You can type instead.");
    }
  }

  stop(): void { if (this.recorder?.state === "recording") this.recorder.stop(); else this.cancelled = true; }
  cancel(): void { this.cancelled = true; this.stop(); }

  private async finish(blob: Blob): Promise<void> {
    if (this.maxTimer !== null) window.clearTimeout(this.maxTimer);
    this.maxTimer = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.recorder = null;
    this.listening = false;
    this.h.onState(false);
    if (this.cancelled || !blob.size) return;
    this.h.onInterim("Transcribing on this device…");
    let context: AudioContext | null = null;
    try {
      context = new AudioContext();
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
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
      if (result.text?.trim()) this.h.onFinal(result.text.trim());
      else this.h.onError("I didn't catch that. Try again or type instead.");
    } catch {
      this.h.onError("On-device transcription failed. You can type instead.");
    } finally {
      await context?.close();
      this.h.onInterim("");
    }
  }
}
