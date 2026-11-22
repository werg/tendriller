// Small, bounded DSP primitives shared by the AudioWorklet and deterministic tests.
// These detect sound activity, not words. Word recognition stays in the local worker.
export const PCM_RATE = 16_000;
export const PCM_FRAME = 320; // 20 ms at the model's sample rate.
export const MAX_WAKE_SAMPLES = PCM_RATE * 8;

/** Area averaging avoids aliasing a simple nearest-neighbour decimator would add. */
export class PcmResampler {
  private filled = 0;
  private sum = 0;
  private readonly width: number;
  constructor(sourceRate: number) {
    if (!Number.isFinite(sourceRate) || sourceRate < PCM_RATE || sourceRate > 192_000) throw new Error("Unsupported microphone sample rate");
    this.width = sourceRate / PCM_RATE;
  }
  reset(): void { this.filled = 0; this.sum = 0; }
  push(input: Float32Array): Float32Array {
    const output = new Float32Array(Math.ceil((input.length + this.filled) / this.width));
    let count = 0;
    for (const value of input) {
      const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      let remaining = 1;
      while (remaining > 1e-8) {
        const part = Math.min(remaining, this.width - this.filled);
        this.sum += sample * part; this.filled += part; remaining -= part;
        if (this.filled >= this.width - 1e-8) {
          output[count++] = this.sum / this.width;
          this.filled = 0; this.sum = 0;
        }
      }
    }
    return output.subarray(0, count);
  }
}

/** One utterance at a time, fixed memory, silence gating and a hard eight-second cap. */
export class PcmVoiceSegmenter {
  private readonly samples = new Float32Array(MAX_WAKE_SAMPLES);
  private readonly prefix = new Float32Array(PCM_FRAME * 13); // 260 ms.
  private readonly frame = new Float32Array(PCM_FRAME);
  private frameLength = 0;
  private prefixAt = 0;
  private prefixLength = 0;
  private length = 0;
  private voicedFrames = 0;
  private quietFrames = 0;
  private noise = 0.002;

  reset(): void {
    this.samples.fill(0); this.prefix.fill(0); this.frame.fill(0);
    this.frameLength = this.prefixAt = this.prefixLength = this.length = this.voicedFrames = this.quietFrames = 0;
  }

  /** Returns at most one utterance; the caller must stop accepting frames until ready. */
  push(input: Float32Array): Float32Array | null {
    for (const value of input) {
      this.frame[this.frameLength++] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      if (this.frameLength !== PCM_FRAME) continue;
      this.frameLength = 0;
      let power = 0;
      for (const sample of this.frame) power += sample * sample;
      const rms = Math.sqrt(power / PCM_FRAME);
      const voiced = rms >= Math.max(0.008, this.noise * 3);
      if (!voiced) this.noise = this.noise * 0.98 + Math.min(rms, 0.02) * 0.02;
      if (!this.length && voiced) {
        const start = (this.prefixAt - this.prefixLength + this.prefix.length) % this.prefix.length;
        for (let i = 0; i < this.prefixLength; i++) this.samples[this.length++] = this.prefix[(start + i) % this.prefix.length];
      }
      if (this.length || voiced) {
        const size = Math.min(PCM_FRAME, this.samples.length - this.length);
        this.samples.set(this.frame.subarray(0, size), this.length); this.length += size;
        if (voiced) { this.voicedFrames++; this.quietFrames = 0; }
        else this.quietFrames++;
        if (this.length === this.samples.length || this.quietFrames >= 33) {
          // Reject clicks and brief bumps instead of invoking the model for every sound.
          const result = this.voicedFrames >= 9 ? this.samples.slice(0, this.length) : null;
          this.reset();
          if (result) return result;
        }
      } else {
        for (const sample of this.frame) {
          this.prefix[this.prefixAt] = sample;
          this.prefixAt = (this.prefixAt + 1) % this.prefix.length;
          this.prefixLength = Math.min(this.prefix.length, this.prefixLength + 1);
        }
      }
    }
    return null;
  }
}
