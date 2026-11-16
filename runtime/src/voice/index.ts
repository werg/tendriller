// Explicit optional voice adapter. All input is delivered to a page-owned callback.
// Constructing it starts no microphone, speech output, engine download or wake loop.
import { createSpeechOutput } from "./output";
import { createPreferences } from "./preferences";
import { SpeechCapture } from "./capture";
import { WakeWordCapture, type WakeMode, type WakeState } from "./wakeword";
import type { RuntimeApi, SpeechStatus, RuntimeArtifactFeatures } from "../../../contract/index.mjs";

export interface VoiceOptions {
  consent(request: { purpose: "output" | "transcription" | "wake"; engine: string; description: string }): boolean | Promise<boolean>;
  transcript(text: string): void;
  status?(status: { kind: "output" | "capture" | "wake"; state: string; message?: string }): void;
  /** Explicitly route suitable owner replies to speech after enableOutput. */
  speakReplies?: boolean;
}
export { matchWakePhrase } from "./wakeword";
export type { WakeMode, WakeState } from "./wakeword";

export function createVoice(runtime: RuntimeApi, options: VoiceOptions) {
  const preferences = createPreferences(runtime.identity.page);
  // A stored selection never starts or unmutes this visit.
  preferences.update({ audio: false });
  let disposed = false;
  let operation = 0;
  let capture: SpeechCapture | null = null;
  let preparing: Promise<SpeechCapture> | null = null;
  const language = () => preferences.get().language || navigator.language || "en-US";
  const output = createSpeechOutput(new URL(".", runtime.assetUrl("voice.mjs")).href, { on: () => () => {}, emit(type, value: SpeechStatus) {
    if (type === "tts") options.status?.({ kind: "output", state: value.state, message: value.message });
  } }, preferences);
  const wake = new WakeWordCapture({
    onState: (state, message) => options.status?.({ kind: "wake", state, message }),
    onWake: () => output.stop(),
    onCommand: text => { if (!disposed) options.transcript(text); },
    isOutputSpeaking: () => output.speaking,
  });
  const stop = () => { ++operation; wake.stop(); capture?.cancel(); output.stop(); };
  const allowed = async (purpose: "output" | "transcription" | "wake", engine: string, description: string) => {
    if (disposed) throw new Error("Voice adapter is disposed");
    const current = operation;
    const accepted = await options.consent({ purpose, engine, description });
    return accepted && !disposed && current === operation;
  };
  const prepareCapture = async (): Promise<SpeechCapture> => {
    if (capture) { await capture.prepare(); return capture; }
    if (preparing) return preparing;
    const current = operation;
    const task = (async () => {
      if (!await allowed("transcription", "cactus-whistle", "Download the explicitly selected speech model; recorded audio is transcribed on this device.")) throw new Error("Speech transcription was not enabled");
      const response = await fetch(runtime.assetUrl("resources.json"), { credentials: "same-origin" });
      if (!response.ok) throw new Error("Speech resource metadata is unavailable");
      const metadata = await response.json() as { features: RuntimeArtifactFeatures };
      const resource = metadata.features?.speech;
      if (!resource) throw new Error("This runtime has no transcription engine");
      if (disposed || current !== operation) throw new Error("Speech setup cancelled");
      const absolute = (path: string) => new URL(path, runtime.identity.base).href;
      const selected = { ...resource, url: absolute(resource.url), engine: { ...resource.engine, script: absolute(resource.engine.script), wasm: absolute(resource.engine.wasm) } };
      const instance = new SpeechCapture({
        onConsent: async () => !disposed && current === operation,
        onInterim: message => options.status?.({ kind: "capture", state: "working", message }),
        onFinal: text => { if (!disposed) options.transcript(text); },
        onState: active => options.status?.({ kind: "capture", state: active ? "recording" : "idle" }),
        onError: message => options.status?.({ kind: "capture", state: "error", message }),
      }, language, new URL(".", runtime.assetUrl("voice-worker.js")).href, selected);
      capture = instance;
      await instance.prepare();
      if (disposed || current !== operation) { instance.dispose(); capture = null; throw new Error("Speech setup cancelled"); }
      return instance;
    })();
    preparing = task;
    try { return await task; } finally { if (preparing === task) preparing = null; }
  };
  const offReply = runtime.on("reply", message => {
    if (options.speakReplies && runtime.device.role === "owner" && !runtime.device.pending && message.speak !== false) output.speak(message.text);
  });
  const offRole = runtime.on("role", () => { if (runtime.device.role !== "owner" || runtime.device.pending) stop(); });
  const offSensors = runtime.on("sensors_stopped", stop);
  const visibility = () => { if (document.visibilityState !== "visible") stop(); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", stop);
  return {
    get outputStatus() { return output.status; },
    get speaking() { return output.speaking; },
    get listening() { return wake.running || !!capture?.listening; },
    async enableOutput(engine: "browser" | "neural" = "browser") {
      if (!await allowed("output", engine, engine === "neural" ? "Download an optional neural voice (about 65 MB) and speak on this device." : "Speak using this device's browser voice.")) return false;
      preferences.update({ audio: true, voice: engine });
      if (engine === "neural") await output.enable();
      return true;
    },
    mute() { preferences.update({ audio: false }); output.stop(); },
    speak(text: string) { if (!disposed) output.speak(text); },
    stop,
    language(tag: string) { stop(); preferences.update({ language: tag }); },
    async prepareCapture() { await prepareCapture(); },
    async startCapture() { const current = operation; wake.stop(); output.stop(); const selected = await prepareCapture(); if (!disposed && current === operation) await selected.start(); },
    finishCapture() { capture?.stop(); },
    cancelCapture() { capture?.cancel(); },
    async startWake(settings: { phrase: string; mode: WakeMode }) {
      stop();
      preferences.update({ wakePhrase: settings.phrase, wakeMode: settings.mode });
      if (!await allowed("wake", settings.mode, settings.mode === "local"
        ? "Listen while this page is visible using on-device browser recognition. No cloud fallback."
        : "Listen while this page is visible. Browser recognition may send microphone audio to its provider.")) return false;
      return wake.start({ phrase: preferences.get().wakePhrase, mode: settings.mode, lang: language() });
    },
    localAvailability: () => WakeWordCapture.localAvailability(language()),
    async installLocalLanguage() {
      if (!await allowed("wake", "local", "Install the browser language pack for on-device speech recognition.")) return false;
      return WakeWordCapture.installLocal(language());
    },
    dispose() {
      if (disposed) return;
      stop(); disposed = true; capture?.dispose(); output.dispose();
      offReply(); offRole(); offSensors();
      document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", stop);
    },
  };
}
