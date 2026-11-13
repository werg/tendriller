// Push-to-talk capture: browser speech recognition, or record-and-transcribe on the
// server when recognition is missing and the server offers it.

import type { SensorTracker } from "./sensors";

export type CaptureMode = "recognition" | "recorder" | null;

export interface CaptureHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onState(listening: boolean): void;
  onError(message: string): void;
}

export class SpeechCapture {
  readonly mode: CaptureMode;
  listening = false;
  private rec: any = null;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private finalText = "";
  private interimText = "";

  constructor(
    private h: CaptureHandlers,
    private sensors: SensorTracker,
    private lang: () => string,
    private transcribeUrl: string | null,
  ) {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (SR) this.mode = "recognition";
    else if (transcribeUrl && typeof w.MediaRecorder === "function" && typeof (navigator as any).mediaDevices?.getUserMedia === "function") this.mode = "recorder";
    else this.mode = null;
  }

  /** `hold`: keep listening until stop(); otherwise stop at the end of the utterance. */
  async start(hold: boolean): Promise<void> {
    if (this.listening || !this.mode) return;
    this.finalText = "";
    this.interimText = "";
    if (this.mode === "recognition") this.startRecognition(hold);
    else await this.startRecorder();
  }

  stop(): void {
    if (!this.listening) return;
    if (this.rec) { try { this.rec.stop(); } catch { /* ignore */ } }
    if (this.recorder && this.recorder.state !== "inactive") { try { this.recorder.stop(); } catch { /* ignore */ } }
  }

  cancel(): void {
    this.finalText = "";
    this.interimText = "";
    if (this.rec) { try { this.rec.abort(); } catch { /* ignore */ } }
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = () => this.finish(null);
      try { this.recorder.stop(); } catch { /* ignore */ }
    }
  }

  private setListening(v: boolean) {
    this.listening = v;
    this.h.onState(v);
  }

  private startRecognition(hold: boolean) {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    const rec = new SR();
    this.sensors.own(rec);
    this.rec = rec;
    rec.lang = this.lang();
    rec.interimResults = true;
    rec.continuous = hold;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += (this.finalText ? " " : "") + r[0].transcript.trim();
        else interim += r[0].transcript;
      }
      this.interimText = interim.trim();
      this.h.onInterim([this.finalText, this.interimText].filter(Boolean).join(" "));
    };
    rec.onerror = (e: any) => {
      const code = e?.error || "error";
      if (code === "no-speech" || code === "aborted") return;
      this.h.onError(code === "not-allowed" || code === "service-not-allowed"
        ? "Microphone permission was denied. You can type instead."
        : code === "network" ? "Speech recognition needs a connection. You can type instead."
        : "Speech recognition stopped. You can type instead.");
    };
    rec.onend = () => {
      this.rec = null;
      // Some engines end without promoting the last interim result to final.
      const text = [this.finalText, this.interimText].filter(Boolean).join(" ").trim();
      this.setListening(false);
      if (text) this.h.onFinal(text);
    };
    try {
      rec.start();
      this.setListening(true);
    } catch {
      this.rec = null;
      this.h.onError("Could not start listening. You can type instead.");
    }
  }

  private async startRecorder() {
    try {
      this.stream = await this.sensors.getUserMedia({ audio: true });
    } catch {
      this.h.onError("Microphone permission was denied. You can type instead.");
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(this.stream);
    this.recorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => this.finish(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    rec.start();
    this.setListening(true);
    this.h.onInterim("");
  }

  private async finish(blob: Blob | null) {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.setListening(false);
    if (!blob || !blob.size || !this.transcribeUrl) return;
    this.h.onInterim("Transcribing…");
    try {
      const res = await fetch(this.transcribeUrl, { method: "POST", body: blob, headers: { "Content-Type": blob.type } });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      const text = String(j?.text ?? "").trim();
      if (text) this.h.onFinal(text);
      else this.h.onError("I didn't catch that. Try again or type instead.");
    } catch {
      this.h.onError("Transcription failed. You can type instead.");
    }
  }
}
