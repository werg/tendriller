import { PcmResampler, PcmVoiceSegmenter } from "./pcm";

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class VoicePcmProcessor extends AudioWorkletProcessor {
  private enabled = false;
  private closed = false;
  private sequence = 0;
  private readonly resampler = new PcmResampler(sampleRate);
  private readonly segmenter = new PcmVoiceSegmenter();
  constructor() {
    super();
    this.port.onmessage = event => {
      const value = event.data;
      if (value?.type === "close") { this.closed = true; this.enabled = false; }
      else if (value?.type === "listen" && Number.isSafeInteger(value.sequence)) {
        this.sequence = value.sequence; this.enabled = value.enabled === true;
      }
      this.resampler.reset(); this.segmenter.reset();
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // The graph must stay connected for Safari; its output is always silence.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.closed) return false;
    const input = inputs[0]?.[0]; // AudioWorkletNode requests explicit mono downmix.
    if (!this.enabled || !input?.length) return true;
    const samples = this.segmenter.push(this.resampler.push(input));
    if (samples) {
      this.enabled = false; // Backpressure begins on the audio thread itself.
      this.port.postMessage({ type: "utterance", sequence: this.sequence, samples: samples.buffer }, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor("tendriller-voice-pcm", VoicePcmProcessor);
