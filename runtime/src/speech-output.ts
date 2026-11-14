import type { PhononTTS } from "phonon-tts";
import type { Bus } from "./types";

export interface SpeechStatus {
  enabled: boolean;
  state: "idle" | "loading" | "ready" | "error";
  message: string;
}
export interface SpeechOutput {
  readonly status: SpeechStatus;
  enable(): Promise<void>;
  disable(): void;
  stop(): void;
  speak(text: string): void;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
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

/** Neural English speech by default; the user's browser voice remains the fallback. */
export function createSpeechOutput(base: string, bus: Bus, prefs: () => { audio?: boolean; language?: string }): SpeechOutput {
  const storageKey = "tendriller:spoken-voice";
  let enabled = true;
  try { enabled = localStorage.getItem(storageKey) !== "browser"; } catch { /* storage may be unavailable */ }
  let status: SpeechStatus = { enabled, state: "idle", message: enabled ? "Neural voice is used for English replies. The first reply downloads about 65 MB, cached on this device." : "Using the browser voice." };
  let model: PhononTTS | null = null;
  let loading: Promise<PhononTTS> | null = null;
  let context: AudioContext | null = null;
  let generation: AbortController | null = null;
  let queue = Promise.resolve();
  let epoch = 0;
  let loadEpoch = 0;
  const sources = new Set<AudioBufferSourceNode>();
  const language = () => prefs().language || navigator.language || "en-US";
  const report = (state: SpeechStatus["state"], message: string) => {
    status = { enabled, state, message };
    bus.emit("tts", { ...status });
  };
  const remember = () => { try { localStorage.setItem(storageKey, enabled ? "neural" : "browser"); } catch { /* optional persistence */ } };
  const audioContext = () => {
    if (!context || context.state === "closed") context = new AudioContext({ sampleRate: 24000 });
    return context;
  };
  // Resume synchronously in a gesture, before model downloads or asynchronous synthesis.
  const unlock = () => {
    if (!enabled || prefs().audio === false) return;
    try { void audioContext().resume().catch(() => {}); } catch { /* browser voice can still work */ }
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);

  const load = (): Promise<PhononTTS> => {
    if (model) return Promise.resolve(model);
    if (loading) return loading;
    const token = ++loadEpoch;
    report("loading", "Preparing neural voice — downloading about 65 MB on first use. Replies will play when it is ready.");
    // Keep the upstream ES modules, workers, Wasm and notices together. This import
    // stays native/lazy so browser-only users do not download the neural runtime.
    const url = new URL(base + "_tendril/tts/index.js", location.href).href;
    let timer: ReturnType<typeof setTimeout>;
    let expired = false;
    const task = (async () => {
      if (typeof Worker === "undefined" || typeof WebAssembly === "undefined" || typeof AudioContext === "undefined") {
        throw new Error("Neural speech is not supported by this browser");
      }
      const { PhononTTS } = await import(/* @vite-ignore */ url) as typeof import("phonon-tts");
      if (token !== loadEpoch || !enabled) throw new Error("Voice setup cancelled");
      const loaded = await PhononTTS.load({
        lang: "en", device: "auto", quant: "q8", threads: 1,
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
    ++epoch;
    generation?.abort();
    generation = null;
    for (const source of sources) { try { source.stop(); } catch { /* already ended */ } }
    sources.clear();
    try { window.speechSynthesis?.cancel(); } catch { /* unavailable */ }
  };
  const browserSpeak = (text: string) => {
    try {
      if (prefs().audio === false || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") return;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = language();
      window.speechSynthesis.speak(utterance);
    } catch { /* the transcript still contains the reply */ }
  };
  const play = async (text: string, token: number) => {
    let played = false;
    const active = () => token === epoch && prefs().audio !== false;
    if (!active()) return;
    if (!enabled || !/^en(?:-|$)/i.test(language()) || status.state === "error") { browserSpeak(text); return; }
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
          at += buffer.duration;
          played = true;
        }
        if (active() && !played) throw new Error("No neural audio was produced");
        while (active() && ctx.currentTime < at && ctx.state === "running") await pause(25);
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
      if (generation === abort) generation = null;
    }
  };
  const api: SpeechOutput = {
    get status() { return { ...status }; },
    async enable() {
      stop(); enabled = true; remember(); unlock();
      if (model) report("ready", readyMessage);
      else await load();
    },
    disable() {
      stop(); enabled = false; remember(); ++loadEpoch;
      loading = null; model?.dispose(); model = null;
      report("idle", "Using the browser voice. The downloaded neural model stays cached.");
    },
    stop,
    speak(text) {
      if (!text || prefs().audio === false) return;
      const reply = String(text).trim();
      if (!reply) return;
      const token = epoch;
      queue = queue.then(() => play(reply, token)).catch(() => {});
    },
  };
  window.addEventListener("pagehide", () => {
    stop(); ++loadEpoch; loading = null; model?.dispose(); model = null;
    report("idle", enabled ? "Neural voice will reload from cache for the next reply." : "Using the browser voice.");
    if (context) void context.close().catch(() => {});
  });
  return api;
}
