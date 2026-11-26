import { ContinuousPcmSegmenter, PcmResampler, PcmVoiceSegmenter } from "./pcm";

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class VoicePcmProcessor extends AudioWorkletProcessor {
  private mode: "wake" | "continuous" | "capture" = "wake";
  private enabled = false;
  private closed = false;
  private sequence = 0;
  private levelCounter = 0;
  private captureBuffer: number[] = [];
  private readonly resampler = new PcmResampler(sampleRate);
  private readonly segmenter = new PcmVoiceSegmenter();
  private continuous = new ContinuousPcmSegmenter();
  constructor() {
    super();
    this.port.onmessage = event => {
      const value = event.data;
      if (value?.type === "close") { this.closed = true; this.enabled = false; this.captureBuffer = []; }
      else if (value?.type === "listen" && Number.isSafeInteger(value.sequence)) {
        this.mode = "wake"; this.sequence = value.sequence; this.enabled = value.enabled === true;
        this.resampler.reset(); this.segmenter.reset();
      } else if (value?.type === "capture" && Number.isSafeInteger(value.sequence)) {
        if (value.enabled === false && this.mode === "capture" && this.captureBuffer.length > 0) {
          const out = new Float32Array(this.captureBuffer);
          this.captureBuffer = [];
          this.port.postMessage({ type: "pcm", sequence: this.sequence, samples: out.buffer }, [out.buffer]);
        }
        this.mode = "capture"; this.sequence = value.sequence; this.enabled = value.enabled === true;
        this.captureBuffer = [];
        this.resampler.reset();
      } else if (value?.type === "continuous" && Number.isSafeInteger(value.sequence)) {
        this.mode = "continuous"; this.sequence = value.sequence; this.enabled = value.enabled === true;
        this.continuous = new ContinuousPcmSegmenter({
          maxSegmentMs: typeof value.maxSegmentMs === "number" ? value.maxSegmentMs : undefined,
          silenceMs: typeof value.silenceMs === "number" ? value.silenceMs : undefined,
          overlapMs: typeof value.overlapMs === "number" ? value.overlapMs : undefined,
        });
        this.resampler.reset();
      } else if (value?.type === "flush" && this.mode === "continuous") {
        const segment = this.continuous.flush();
        if (segment) {
          this.port.postMessage({
            type: "segment", sequence: this.sequence,
            samples: segment.samples.buffer,
            startedOffsetMs: segment.startedOffsetMs,
            endedOffsetMs: segment.endedOffsetMs,
          }, [segment.samples.buffer]);
        }
      }
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // The graph must stay connected for Safari; its output is always silence.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.closed) return false;
    const input = inputs[0]?.[0]; // AudioWorkletNode requests explicit mono downmix.
    if (!this.enabled || !input?.length) return true;
    const resampled = this.resampler.push(input);
    if (this.mode === "capture") {
      let sum = 0;
      for (let i = 0; i < resampled.length; i++) {
        const s = Math.max(-1, Math.min(1, resampled[i]!));
        this.captureBuffer.push(s);
        sum += s * s;
      }
      if (this.captureBuffer.length >= 2048) {
        const out = new Float32Array(this.captureBuffer);
        this.captureBuffer = [];
        this.port.postMessage({ type: "pcm", sequence: this.sequence, samples: out.buffer }, [out.buffer]);
      }
      if (++this.levelCounter >= 8 && resampled.length > 0) {
        this.levelCounter = 0;
        const rms = Math.sqrt(sum / resampled.length);
        const level = Math.min(1, Math.max(0, (rms - 0.01) * 4));
        this.port.postMessage({ type: "level", sequence: this.sequence, level });
      }
      return true;
    }
    if (this.mode === "continuous") {
      const segments = this.continuous.push(resampled);
      for (const segment of segments) {
        this.port.postMessage({
          type: "segment", sequence: this.sequence,
          samples: segment.samples.buffer,
          startedOffsetMs: segment.startedOffsetMs,
          endedOffsetMs: segment.endedOffsetMs,
        }, [segment.samples.buffer]);
      }
      if (++this.levelCounter >= 8) {
        this.levelCounter = 0;
        this.port.postMessage({ type: "level", sequence: this.sequence, level: this.continuous.level });
      }
      return true;
    }
    const samples = this.segmenter.push(resampled);
    if (samples) {
      this.enabled = false; // Backpressure begins on the audio thread itself.
      this.port.postMessage({ type: "utterance", sequence: this.sequence, samples: samples.buffer }, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor("tendriller-voice-pcm", VoicePcmProcessor);
