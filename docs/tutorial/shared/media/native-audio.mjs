// Pure-JS / optional pure-WASM Opus <-> PCM16 + VAD utterance pipeline for native Node agents.
// Zero native C++ build toolchains required.

/** Encode mono/stereo 16-bit signed PCM into a standard RIFF WAV Uint8Array. */
export function encodeWavPcm16(samples, sampleRate = 16_000, channels = 1) {
  const pcm = samples instanceof Int16Array ? samples : floatToInt16(samples);
  const dataBytes = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return new Uint8Array(buffer);
}

export function floatToInt16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(input[i]) ? input[i] : 0));
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

/** Downsample/resample Int16Array mono PCM using linear interpolation. */
export function resampleInt16(input, sourceRate, targetRate) {
  if (sourceRate === targetRate || input.length === 0) return input;
  const ratio = sourceRate / targetRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[Math.min(input.length - 1, idx + 1)] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/**
 * Attempt to load an installed pure-WASM Opus decoder (`opus-decoder` or `@evan/opus`)
 * without requiring native C++ addons. Returns null when unavailable; callers may also
 * supply a custom `decodeOpus(payload)` function.
 */
export async function loadWasmOpusDecoder({ sampleRate = 48_000, channels = 1 } = {}) {
  try {
    const mod = await import('opus-decoder');
    const Decoder = mod.OpusDecoder ?? mod.default?.OpusDecoder;
    if (typeof Decoder === 'function') {
      const decoder = new Decoder({ sampleRate, channels });
      await decoder.ready;
      return {
        sampleRate,
        decode(payload) {
          const { channelData } = decoder.decodeFrame(payload instanceof Uint8Array ? payload : new Uint8Array(payload));
          return floatToInt16(channelData[0] ?? new Float32Array(0));
        },
        close() { try { decoder.free(); } catch {} },
      };
    }
  } catch { /* Optional pure-WASM decoder not installed. */ }
  return null;
}

function asyncQueue(signal) {
  const items = [];
  let wake = null, ended = false;
  const stop = () => { if (!ended) { ended = true; wake?.(); wake = null; } };
  signal?.addEventListener('abort', stop, { once: true });
  return {
    push(item, maxLen = 256) {
      if (ended) return;
      if (items.length >= maxLen) items.shift();
      items.push(item);
      wake?.(); wake = null;
    },
    end: stop,
    iterable(readSignal) {
      return {
        async *[Symbol.asyncIterator]() {
          const combined = readSignal && signal ? AbortSignal.any([signal, readSignal]) : (readSignal ?? signal);
          const onAbort = () => { wake?.(); wake = null; };
          combined?.addEventListener('abort', onAbort, { once: true });
          try {
            while (true) {
              if (items.length > 0) { yield items.shift(); continue; }
              if (ended || combined?.aborted) return;
              await new Promise(resolve => { wake = resolve; });
            }
          } finally {
            combined?.removeEventListener('abort', onAbort);
          }
        },
      };
    },
  };
}

/**
 * Wrap a native Werift remote audio track into high-level per-speaker streams:
 * - `.rtp`        -> AsyncIterable of raw RTP packets (Opus payload + header)
 * - `.pcm(opts)`  -> AsyncIterable of Int16Array PCM frames (16kHz/24kHz/48kHz)
 * - `.utterances` -> AsyncIterable of VAD-segmented turns `{ pcm, wav, startedAtMs, endedAtMs, durationMs }`
 */
export function createRtpAudioReceiver(track, {
  signal,
  decodeOpus,
  defaultSampleRate = 16_000,
} = {}) {
  const stop = new AbortController();
  const lifetime = signal ? AbortSignal.any([stop.signal, signal]) : stop.signal;
  const rtpQueues = new Set();
  let wasmDecoderPromise = null;
  let closed = false;

  const subscribeRawRtp = listener => {
    // Support both Werift MediaStreamTrack (`onReceiveRtp.subscribe`) and `NativeAudioTrack.onRtp`.
    if (typeof track?.onRtp === 'function') return track.onRtp(listener);
    if (typeof track?.onReceiveRtp?.subscribe === 'function') {
      const sub = track.onReceiveRtp.subscribe(packet => {
        listener({
          payload: new Uint8Array(packet.payload),
          sequenceNumber: packet.header.sequenceNumber,
          timestamp: packet.header.timestamp,
          payloadType: packet.header.payloadType,
          ssrc: packet.header.ssrc,
        });
      });
      return () => { sub.unSubscribe(); };
    }
    throw Error('NATIVE_AUDIO_TRACK_UNSUPPORTED');
  };

  const unsubscribe = subscribeRawRtp(packet => {
    if (closed || lifetime.aborted) return;
    for (const q of rtpQueues) q.push(packet, 512);
  });

  const getDecoder = async () => {
    if (typeof decodeOpus === 'function') return { sampleRate: 48_000, decode: decodeOpus, close() {} };
    wasmDecoderPromise ??= loadWasmOpusDecoder({ sampleRate: 48_000, channels: 1 });
    return wasmDecoderPromise;
  };

  const rtpStream = (readSignal) => {
    const q = asyncQueue(readSignal ? AbortSignal.any([lifetime, readSignal]) : lifetime);
    rtpQueues.add(q);
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const packet of q.iterable(readSignal)) yield packet;
        } finally {
          rtpQueues.delete(q);
          q.end();
        }
      },
    };
  };

  const pcmStream = ({ sampleRate = defaultSampleRate, signal: readSignal } = {}) => {
    // Subscribe synchronously so RTP packets arriving while WASM Opus loads are buffered, not lost.
    const rawRtp = rtpStream(readSignal);
    return {
      async *[Symbol.asyncIterator]() {
        const decoder = await getDecoder();
        if (!decoder) {
          throw Object.assign(
            Error('Opus PCM decoding requires `opus-decoder` (pure WASM) or a custom `decodeOpus` callback; raw `.rtp` packets remain available.'),
            { code: 'OPUS_DECODER_UNAVAILABLE' },
          );
        }
        for await (const packet of rawRtp) {
          const decoded = decoder.decode(packet.payload);
          if (!decoded || decoded.length === 0) continue;
          const int16 = decoded instanceof Int16Array ? decoded : floatToInt16(decoded);
          yield resampleInt16(int16, decoder.sampleRate, sampleRate);
        }
      },
    };
  };

  const utterancesStream = ({ sampleRate = defaultSampleRate, silenceMs = 600, maxMs = 15_000, minVoicedMs = 200, signal: readSignal } = {}) => {
    const frames = pcmStream({ sampleRate, signal: readSignal });
    return {
      async *[Symbol.asyncIterator]() {
        const maxSamples = Math.floor((maxMs / 1000) * sampleRate);
        const silenceSamples = Math.floor((silenceMs / 1000) * sampleRate);
        const minVoicedSamples = Math.floor((minVoicedMs / 1000) * sampleRate);
        let chunks = [];
        let totalSamples = 0;
        let voicedSamples = 0;
        let quietSamples = 0;
        let startedAtMs = 0;
        let noise = 0.004;

        const emitTurn = () => {
          if (voicedSamples < minVoicedSamples || totalSamples === 0) {
            chunks = []; totalSamples = voicedSamples = quietSamples = 0;
            return null;
          }
          const pcm = new Int16Array(totalSamples);
          let offset = 0;
          for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
          const endedAtMs = Date.now();
          const turn = Object.freeze({
            pcm,
            wav: encodeWavPcm16(pcm, sampleRate, 1),
            sampleRate,
            startedAtMs: startedAtMs || endedAtMs - Math.round((totalSamples / sampleRate) * 1000),
            endedAtMs,
            durationMs: Math.round((totalSamples / sampleRate) * 1000),
          });
          chunks = []; totalSamples = voicedSamples = quietSamples = 0; startedAtMs = 0;
          return turn;
        };

        for await (const frame of frames) {
          let power = 0;
          for (let i = 0; i < frame.length; i++) { const v = frame[i] / 32768; power += v * v; }
          const rms = Math.sqrt(power / Math.max(1, frame.length));
          const voiced = rms >= Math.max(0.012, noise * 3);
          if (!voiced) noise = noise * 0.98 + Math.min(rms, 0.02) * 0.02;

          if (totalSamples === 0 && !voiced) continue;
          if (totalSamples === 0) startedAtMs = Date.now();
          chunks.push(frame);
          totalSamples += frame.length;
          if (voiced) { voicedSamples += frame.length; quietSamples = 0; }
          else quietSamples += frame.length;

          if (totalSamples >= maxSamples || quietSamples >= silenceSamples) {
            const turn = emitTurn();
            if (turn) yield turn;
          }
        }
        const trailing = emitTurn();
        if (trailing) yield trailing;
      },
    };
  };

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    stop.abort(new Error('AUDIO_RECEIVER_CLOSED'));
    for (const q of rtpQueues) q.end();
    rtpQueues.clear();
    void wasmDecoderPromise?.then(d => d?.close?.()).catch(() => {});
  };
  lifetime.addEventListener('abort', close, { once: true });

  return Object.freeze({
    get rtp() { return rtpStream(); },
    pcm: pcmStream,
    utterances: utterancesStream,
    close,
  });
}

/**
 * Outbound native audio publisher: frames Int16 PCM into 20ms chunks, encodes via
 * supplied Opus encoder callback, and sends RTP packets over a Werift `NativeAudioTrack`
 * with instant `clear()` barge-in support.
 */
export function createRtpAudioPublisher(nativeTrack, {
  sampleRate = 24_000,
  payloadType = 111,
  ssrc = (Math.random() * 0xffffffff) >>> 0,
  encodeOpus,
} = {}) {
  if (typeof encodeOpus !== 'function') {
    throw Object.assign(Error('Provide an `encodeOpus(pcm48kFrame960)` function to publish native RTP audio.'), { code: 'OPUS_ENCODER_REQUIRED' });
  }
  const frameSamples = 960; // 20 ms at 48 kHz Opus clock rate.
  let sequenceNumber = 0;
  let timestamp = 0;
  let pending = new Int16Array(0);
  let queue = [];
  let timer = null;
  let closed = false;

  const pump = () => {
    if (closed || queue.length === 0) {
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }
    const frame = queue.shift();
    const encoded = encodeOpus(frame);
    if (!encoded || encoded.length === 0) return;
    sequenceNumber = (sequenceNumber + 1) & 0xffff;
    timestamp = (timestamp + frameSamples) >>> 0;
    // Build minimal 12-byte RFC 3550 RTP header + Opus payload.
    const packet = new Uint8Array(12 + encoded.length);
    const view = new DataView(packet.buffer);
    view.setUint8(0, 0x80);
    view.setUint8(1, payloadType & 0x7f);
    view.setUint16(2, sequenceNumber, false);
    view.setUint32(4, timestamp, false);
    view.setUint32(8, ssrc, false);
    packet.set(encoded, 12);
    try { nativeTrack.writeRtp(packet); } catch { /* Wait for SRTP readiness. */ }
  };

  return Object.freeze({
    write(samples) {
      if (closed) throw Error('AUDIO_PUBLISHER_CLOSED');
      const int16 = samples instanceof Int16Array ? samples : floatToInt16(samples);
      const resampled = resampleInt16(int16, sampleRate, 48_000);
      const merged = new Int16Array(pending.length + resampled.length);
      merged.set(pending, 0);
      merged.set(resampled, pending.length);
      let offset = 0;
      while (offset + frameSamples <= merged.length) {
        queue.push(merged.subarray(offset, offset + frameSamples));
        offset += frameSamples;
      }
      pending = merged.subarray(offset);
      if (!timer && queue.length > 0) timer = setInterval(pump, 20);
    },
    /** Immediately drop queued outbound speech (e.g. on human barge-in). */
    clear() {
      queue = [];
      pending = new Int16Array(0);
    },
    close() {
      if (closed) return;
      closed = true;
      queue = [];
      pending = new Int16Array(0);
      if (timer) { clearInterval(timer); timer = null; }
      try { nativeTrack.stop?.(); } catch {}
    },
  });
}
