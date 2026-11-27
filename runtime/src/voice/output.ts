import type { PhononTTS } from "phonon-tts";
import type { Bus } from "../types";
import type { VoicePreferencesApi, SpeechStatus, SpeechOutput } from "../../../contract/voice.mjs";
export type { SpeechStatus, SpeechOutput } from "../../../contract/voice.mjs";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const NEURAL_MODEL = "hf://gradium/phonon-31m-en@92741c5b07d085ff840e26fea8ce43110b87852f";
const readyMessage = "Neural voice is ready. English speech is generated on this device.";

/** Stop waiting even if a worker never acknowledges cancellation or completes a request. */
function waitFor<T>(task: Promise<T>, signal?: AbortSignal, timeoutMs = 0): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { clean(); reject(new DOMException("Speech stopped", "AbortError")); };
    task.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs) timer = setTimeout(() => { clean(); reject(new Error("Speech worker timed out")); }, timeoutMs);
  });
}

export interface SpeechMediaSessionOptions {
  title?: string;
  artist?: string;
  artworkUrl?: string;
  onPlay?: () => void;
}

/** Browser speech is immediate; neural English speech is an optional device preference. */
export function createSpeechOutput(base: string, bus: Bus, preferences: VoicePreferencesApi,
  moduleLoader: (url: string) => Promise<typeof import("phonon-tts")> = url => import(/* @vite-ignore */ url),
  mediaOptions?: SpeechMediaSessionOptions): SpeechOutput {
  const prefs = () => preferences.get();
  let enabled = prefs().voice === "neural";
  let status: SpeechStatus = { enabled, state: "idle", message: enabled ? "Natural voice is enabled. Prepare it once to cache about 65 MB on this device." : "Browser voice is ready. Natural voice is an optional download." };
  let model: PhononTTS | null = null;
  let loading: Promise<PhononTTS> | null = null;
  let context: AudioContext | null = null;
  let generation: AbortController | null = null;
  let queue = Promise.resolve();
  let epoch = 0;
  let disposed = false;
  let loadEpoch = 0;
  const sources = new Set<AudioBufferSourceNode>();
  const browserUtterances = new Set<SpeechSynthesisUtterance>();
  let neuralSpeaking = false;
  const language = () => prefs().language || navigator.language || "en-US";
  const report = (state: SpeechStatus["state"], message: string) => {
    status = { enabled, state, message };
    bus.emit("tts", { ...status });
  };
  let mediaSessionActive = false;
  const syncMediaSession = (speaking: boolean) => {
    const ms = typeof navigator !== "undefined" ? (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession : undefined;
    if (!ms) return;
    if (speaking) {
      mediaSessionActive = true;
      try {
        if (typeof MediaMetadata === "function") {
          const title = mediaOptions?.title || (typeof document !== "undefined" ? document.title : "") || "Assistant";
          ms.metadata = new MediaMetadata({
            title,
            artist: mediaOptions?.artist || "Tendriller Assistant",
            ...(mediaOptions?.artworkUrl ? { artwork: [{ src: mediaOptions.artworkUrl, sizes: "192x192", type: "image/svg+xml" }] } : {}),
          });
        }
        ms.playbackState = "playing";
        ms.setActionHandler("pause", () => stop());
        ms.setActionHandler("stop", () => stop());
        if (mediaOptions?.onPlay) ms.setActionHandler("play", () => mediaOptions.onPlay?.());
      } catch { /* mediaSession optional on older UAs */ }
    } else if (mediaSessionActive) {
      mediaSessionActive = false;
      try {
        ms.playbackState = "none";
        ms.setActionHandler("pause", null);
        ms.setActionHandler("stop", null);
        ms.setActionHandler("play", null);
      } catch { /* ignore */ }
    }
  };
  const emitSpeaking = (speaking: boolean, completed = false) => {
    syncMediaSession(speaking);
    bus.emit("tts_speaking", { speaking, completed });
  };
  const audioContext = () => {
    if (!context || context.state === "closed") context = new AudioContext({ sampleRate: 24000 });
    return context;
  };
  // Resume synchronously in a gesture, before model downloads or asynchronous synthesis.
  const unlock = () => {
    if (disposed || !enabled || prefs().audio === false) return;
    try { void audioContext().resume().catch(() => {}); } catch { /* browser voice can still work */ }
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);

  const load = (): Promise<PhononTTS> => {
    if (model) return Promise.resolve(model);
    if (loading) return loading;
    const token = ++loadEpoch;
    report("loading", "Preparing natural voice — about 65 MB on first use. Browser speech is available while it downloads.");
    // Keep the upstream ES modules, workers, Wasm and notices together. This import
    // stays native/lazy so browser-only users do not download the neural runtime.
    const url = new URL("tts/index.js", new URL(base, location.href)).href;
    let timer: ReturnType<typeof setTimeout>;
    let expired = false;
    const task = (async () => {
      if (typeof Worker === "undefined" || typeof WebAssembly === "undefined" || typeof AudioContext === "undefined") {
        throw new Error("Neural speech is not supported by this browser");
      }
      const { PhononTTS } = await moduleLoader(url);
      if (token !== loadEpoch || !enabled) throw new Error("Voice setup cancelled");
      const loaded = await PhononTTS.load({
        lang: "en", model: NEURAL_MODEL, device: "auto", quant: "q8", threads: 1,
        onProgress: p => {
          if (token !== loadEpoch) return;
          const size = p.total ? ` of ${(p.total / 1e6).toFixed(1)} MB` : " MB";
          report("loading", `Preparing neural voice: ${(p.loaded / 1e6).toFixed(1)}${size}${p.cached ? " (cached)" : ""}.`);
        },
      });
      if (token !== loadEpoch || !enabled) { loaded.dispose(); throw new Error("Voice setup cancelled"); }
      return loaded;
    })();
    // A failed or stalled download must never leave the speech queue stuck forever.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        if (token === loadEpoch) ++loadEpoch;
        reject(new Error("Voice download timed out"));
      }, 120_000);
    });
    const pending = Promise.race([task, timeout]).then(loaded => {
      if (token !== loadEpoch || !enabled) { loaded.dispose(); throw new Error("Voice setup cancelled"); }
      model = loaded;
      report("ready", readyMessage);
      return loaded;
    }).catch(error => {
      if (enabled && (token === loadEpoch || (expired && token + 1 === loadEpoch))) report("error", "Neural voice could not load. Using the browser voice; choose Try neural voice to retry.");
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      if (loading === pending) loading = null;
    });
    loading = pending;
    return pending;
  };

  const stop = () => {
    const wasSpeaking = neuralSpeaking || browserUtterances.size > 0;
    ++epoch;
    neuralSpeaking = false;
    browserUtterances.clear();
    generation?.abort();
    generation = null;
    for (const source of sources) { try { source.stop(); } catch { /* already ended */ } }
    sources.clear();
    try { window.speechSynthesis?.cancel(); } catch { /* unavailable */ }
    if (wasSpeaking) emitSpeaking(false);
    else syncMediaSession(false);
  };
  const browserSpeak = (text: string) => {
    try {
      if (prefs().audio === false || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") return;
      // Chromium can leave speechSynthesis in a paused queue state; resume before queuing.
      try { if (window.speechSynthesis.paused) window.speechSynthesis.resume(); } catch { /* ignore */ }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = language();
      const token = epoch;
      browserUtterances.add(utterance);
      utterance.onstart = () => { if (token === epoch && browserUtterances.has(utterance)) emitSpeaking(true); };
      const finish = (completed: boolean) => {
        if (token !== epoch || !browserUtterances.delete(utterance)) return;
        if (browserUtterances.size === 0 && !neuralSpeaking) emitSpeaking(false, completed);
      };
      utterance.onend = () => finish(true);
      utterance.onerror = () => finish(false);
      emitSpeaking(true);
      window.speechSynthesis.speak(utterance);
    } catch { browserUtterances.clear(); emitSpeaking(false); /* the transcript still contains the reply */ }
  };
  const play = async (text: string, token: number) => {
    let played = false, completed = false;
    const active = () => token === epoch && prefs().audio !== false;
    if (!active()) return;
    if (!enabled || !/^en(?:-|$)/i.test(language()) || status.state === "error") { browserSpeak(text); return; }
    if (!model && window.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined") {
      // Do not make a live conversation wait for a model download. This reply is
      // spoken once now; the prepared model is used only for future replies.
      void load().catch(() => {});
      browserSpeak(text);
      return;
    }
    const abort = new AbortController();
    generation = abort;
    try {
      const tts = await waitFor(load(), abort.signal);
      if (!active()) return;
      const ctx = audioContext();
      if (ctx.state !== "running") await Promise.race([ctx.resume().catch(() => {}), pause(1000)]);
      if (!active()) return;
      if (ctx.state !== "running") {
        // Autoplay permission is independent of the model: keep it ready for the
        // next reply after a tap rather than permanently switching to browser TTS.
        report("ready", "Neural voice is ready. Tap the page to allow audio; using the browser voice for this reply.");
        browserSpeak(text);
        return;
      }
      const stream = tts.stream(text, { signal: abort.signal });
      const iterator = stream[Symbol.asyncIterator]();
      let at = ctx.currentTime + .04;
      try {
        for (;;) {
          const item = await waitFor(iterator.next(), abort.signal, 30_000);
          if (item.done) break;
          const pcm = item.value;
          if (!active()) break;
          // Limit scheduled audio so Stop and new user input interrupt promptly.
          while (at - ctx.currentTime > 1 && active() && ctx.state === "running") await pause(25);
          if (!active()) break;
          if (ctx.state !== "running") throw new Error("Audio playback paused");
          const buffer = ctx.createBuffer(1, pcm.length, tts.sampleRate);
          buffer.copyToChannel(new Float32Array(pcm), 0);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          sources.add(source);
          source.onended = () => { sources.delete(source); source.disconnect(); };
          at = Math.max(at, ctx.currentTime + .02);
          source.start(at);
          if (!neuralSpeaking) { neuralSpeaking = true; emitSpeaking(true); }
          at += buffer.duration;
          played = true;
        }
        if (active() && !played) throw new Error("No neural audio was produced");
        while (active() && ctx.currentTime < at && ctx.state === "running") await pause(25);
        completed = active() && played && ctx.currentTime >= at;
      } finally {
        abort.abort();
        // Keep the queue ordered until cancellation settles. An unresponsive
        // worker is discarded, so a fresh reply can start with a fresh model.
        try { await waitFor(stream.done.catch(() => {}), undefined, 1000); }
        catch {
          tts.dispose();
          if (model === tts) {
            model = null;
            if (enabled) report("idle", "Neural voice stopped. It will reload from cache for the next reply.");
          }
        }
        void iterator.return?.().catch(() => {});
      }
    } catch {
      if (!active()) return;
      model?.dispose(); model = null;
      report("error", "Neural voice is unavailable. Using the browser voice; tap Try neural voice to retry.");
      // Do not repeat a partially played reply in a second voice.
      if (!played) browserSpeak(text);
    } finally {
      if (generation === abort) {
        const was = neuralSpeaking;
        neuralSpeaking = false;
        generation = null;
        if (was && browserUtterances.size === 0) emitSpeaking(false, completed);
      }
    }
  };
  const api: SpeechOutput = {
    get status() { return { ...status }; },
    get speaking() { return neuralSpeaking || browserUtterances.size > 0 || !!window.speechSynthesis?.speaking; },
    async enable() {
      if (disposed) throw new Error("Speech output is disposed");
      stop(); preferences.update({ voice: "neural" }); unlock();
      if (model) report("ready", readyMessage);
      else await load();
    },
    disable() {
      stop(); preferences.update({ voice: "browser" });
    },
    stop,
    dispose() {
      if (disposed) return;
      disposed = true; release(); offPreferences();
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
      window.removeEventListener("pagehide", release);
    },
    speak(text) {
      if (disposed || !text || prefs().audio === false) return;
      const reply = String(text).trim();
      if (!reply) return;
      const token = epoch;
      queue = queue.then(() => play(reply, token)).catch(() => {});
    },
  };
  let previous = prefs();
  const offPreferences = preferences.on(next => {
    if (next.audio !== previous.audio || next.language !== previous.language || next.voice !== previous.voice) stop();
    if (next.voice !== previous.voice) {
      enabled = next.voice === "neural";
      ++loadEpoch; loading = null; model?.dispose(); model = null;
      report("idle", enabled ? "Natural voice is enabled. Prepare it once to cache about 65 MB on this device."
        : "Using the browser voice. The downloaded neural model stays cached.");
    }
    previous = next;
  });
  const release = () => {
    stop(); ++loadEpoch; loading = null; model?.dispose(); model = null;
    report("idle", enabled ? "Neural voice will reload from cache for the next reply." : "Using the browser voice.");
    if (context) {
      const closing = context;
      context = null;
      void closing.close().catch(() => {});
    }
  };
  window.addEventListener("pagehide", release);
  return api;
}
