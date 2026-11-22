import type { SpeechStatus } from "../../../contract/voice.mjs";
import type { RuntimeApi, RuntimeArtifactFeatures } from "../../../contract/index.mjs";
import { createSpeechOutput } from "./output";
import { createPreferences } from "./preferences";
import { SpeechCapture } from "./capture";
import { WakeWordCapture, type WakeMode, type WakeState } from "./wakeword";
import { LocalWakeCapture } from "./local-wake";
import { acquireMicrophoneSession, type MicrophoneSession } from "./microphone";
import { loadSpeechResources, SPEECH_DOWNLOAD_BYTES, SPEECH_LANGUAGES } from "./resources";

export interface VoiceConsent {
  purpose: "output" | "transcription" | "wake";
  engine: string;
  description: string;
  phrase?: string;
  language?: string;
  downloadBytes?: number;
  maxSessionMs?: number;
}
export interface VoiceStatus {
  kind: "output" | "capture" | "wake";
  state: string;
  message?: string;
  microphone?: boolean;
}
export interface VoiceOptions {
  consent(request: Readonly<VoiceConsent>): boolean | Promise<boolean>;
  transcript(text: string): void;
  status?(status: VoiceStatus): void;
}
export { matchWakePhrase } from "./wakeword";
export type { WakeMode, WakeState } from "./wakeword";
export { mountVoiceControls } from "./controls";
export type { VoiceControlsOptions } from "./controls";
export { SPEECH_DOWNLOAD_BYTES, SPEECH_MODEL_BYTES, SPEECH_LANGUAGES } from "./resources";

type InputSession = { kind: "capture" | WakeMode; epoch: number; abort: AbortController; lease?: MicrophoneSession; released: boolean };
const terminal = (state: WakeState) => state === "off" || state === "paused" || state === "error";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Voice input could not start. You can type instead.";

/** Creation is inert. Every microphone start requires a fresh local consent decision. */
export function createVoice(runtime: RuntimeApi, options: VoiceOptions) {
  const preferences = createPreferences(runtime.identity.page);
  preferences.update({ audio: false });
  let disposed = false, operation = 0;
  let capture: SpeechCapture | null = null;
  let resources: NonNullable<RuntimeArtifactFeatures["speech"]> | null = null;
  let preparation: AbortController | null = null;
  let input: InputSession | null = null;
  const draining = new Set<Promise<void>>();
  let wakeStatus: { state: WakeState; message: string; phrase: string; mode: WakeMode } = {
    state: "off", message: "", phrase: preferences.get().wakePhrase, mode: preferences.get().wakeMode,
  };
  let captureStatus = { state: "idle", message: "" };
  const language = () => preferences.get().language || navigator.language || "en-US";
  const notify = (status: VoiceStatus) => {
    try { options.status?.(status); } catch { /* A broken UI observer cannot keep a microphone alive. */ }
  };
  const reportCapture = (state: string, message = "") => {
    captureStatus = { state, message };
    notify({ kind: "capture", state, message, microphone: !!capture?.microphoneActive });
  };
  const current = (session: InputSession) => !disposed && input === session && !session.abort.signal.aborted && session.epoch === operation;
  const release = (session: InputSession) => {
    if (session.released) return;
    session.released = true;
    // getUserMedia has no cancellation API. Keep ownership until a late native
    // permission result has been received AND its tracks stopped.
    const settled = session.kind === "model" ? local.microphoneSettled : session.kind === "capture" ? capture?.microphoneSettled : wake.microphoneSettled;
    const drained = Promise.resolve(settled).catch(() => {}).then(async () => {
      const lease = session.lease;
      lease?.release();
      await lease?.settled;
      session.lease = undefined;
      if (!disposed) {
        if (session.kind === "capture") reportCapture(captureStatus.state, captureStatus.message);
        else reportWake(wakeStatus.state, wakeStatus.message);
      }
    });
    draining.add(drained);
    void drained.finally(() => draining.delete(drained));
  };
  const end = (session: InputSession) => {
    if (input === session) input = null;
    session.abort.abort();
    release(session);
  };
  const reportWake = (state: WakeState, message = "") => {
    wakeStatus = { ...wakeStatus, state, message };
    notify({ kind: "wake", state, message, microphone: local.microphoneActive || wake.microphoneActive });
  };
  const handleWake = (kind: "model" | "recognizer", state: WakeState, message?: string) => {
    const session = input;
    if (terminal(state) && session && (kind === "model" ? session.kind === "model" : session.kind === "local" || session.kind === "browser")) end(session);
    // A stopped, unused engine must not overwrite the other engine's live state.
    if (input && (kind === "model" ? input.kind !== "model" : input.kind === "model" || input.kind === "capture")) return;
    reportWake(state, message);
  };
  const deliver = (text: string) => {
    if (disposed || !input || input.abort.signal.aborted) return;
    try { options.transcript(text); }
    catch { stopInput("error", "The page could not accept the transcript. Stop listening and use typed input."); }
  };
  const output = createSpeechOutput(new URL(".", runtime.assetUrl("voice.mjs")).href, { on: () => () => {}, emit(type, value: SpeechStatus) {
    if (type === "tts") notify({ kind: "output", state: value.state, message: value.message });
  } }, preferences);
  const wake = new WakeWordCapture({
    onState: (state, message) => handleWake("recognizer", state, message),
    onWake: () => output.stop(), onCommand: deliver, isOutputSpeaking: () => output.speaking,
  });
  const local = new LocalWakeCapture({
    onState: (state, message) => handleWake("model", state, message),
    onWake: () => output.stop(), onCommand: deliver, isOutputSpeaking: () => output.speaking,
  });
  function stopInput(state: WakeState = "off", detail = "") {
    ++operation;
    const session = input;
    const hadCapture = session?.kind === "capture" || preparation !== null;
    input = null;
    preparation?.abort(); preparation = null;
    // Detach the operation before callbacks; none can rearm a cancelled session.
    wake.stop(); local.stop(); capture?.cancel();
    if (session) { session.abort.abort(); release(session); }
    if (hadCapture) reportCapture(state === "error" ? "error" : "idle", detail);
    else reportWake(state, detail);
  }
  const stop = () => { stopInput(); output.stop(); };
  const consent = (request: VoiceConsent) => {
    if (disposed) throw new Error("Voice adapter is disposed");
    return options.consent(Object.freeze(request));
  };
  const begin = (kind: InputSession["kind"]) => {
    stop();
    if (disposed) throw new Error("Voice adapter is disposed");
    const session: InputSession = { kind, epoch: operation, abort: new AbortController(), released: false };
    input = session;
    return session;
  };
  const acquire = async (session: InputSession) => {
    if (draining.size) {
      // A quick Stop→Start should wait for our own lock callback to return. An
      // unanswered native permission prompt must not silently queue a new mic.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.all([...draining]), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("This page's previous microphone is still stopping. Dismiss any permission prompt and tap Start again.")), 1_000);
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
      if (!current(session)) return false;
    }
    const lease = await acquireMicrophoneSession({ signal: session.abort.signal, wake: session.kind !== "capture",
      onStop: reason => { if (input === session) stopInput("paused", reason); } });
    if (!current(session) || session.released) { lease.release(); return false; }
    session.lease = lease;
    return true;
  };
  const getResources = async (signal: AbortSignal) => {
    if (!resources) resources = await loadSpeechResources(runtime, signal);
    if (signal.aborted) throw new DOMException("Voice preparation cancelled", "AbortError");
    return resources;
  };
  const prepareCapture = async (signal: AbortSignal) => {
    if (!capture) {
      const selected = await getResources(signal);
      if (disposed || signal.aborted) throw new DOMException("Voice preparation cancelled", "AbortError");
      // Another admitted preparation may have installed the same shared capture
      // while metadata was pending. Never overwrite a live instance.
      if (!capture) capture = new SpeechCapture({
        // The public adapter already obtained a fresh explicit decision.
        onConsent: async () => !disposed,
        onInterim(message) {
          if (disposed || !input && !preparation) return;
          if (!message && captureStatus.state === "error") return;
          reportCapture(capture?.listening ? "recording" : message ? "working" : "idle", message);
        },
        onFinal(text) {
          const session = input;
          if (!session || session.kind !== "capture" || !current(session)) return;
          deliver(text);
          if (input === session) end(session);
          reportCapture("idle", "Text is ready to review.");
        },
        onState(active) {
          if (!active && input?.kind === "capture") release(input);
          reportCapture(active ? "recording" : "idle");
        },
        onError(message) {
          if (input?.kind === "capture") end(input);
          reportCapture("error", message);
        },
      }, language, new URL(".", runtime.assetUrl("voice-worker.js")).href, selected);
    }
    const selected = capture;
    await selected.prepare();
    if (disposed || signal.aborted) throw new DOMException("Voice preparation cancelled", "AbortError");
    return selected;
  };
  const captureDisclosure = (): VoiceConsent => ({ purpose: "transcription", engine: "cactus-whistle",
    description: `Prepare ${SPEECH_DOWNLOAD_BYTES.toLocaleString("en-US")} bytes of verified speech assets and record at most 30 seconds. Audio is transcribed on this device and never uploaded.`,
    language: language(), downloadBytes: SPEECH_DOWNLOAD_BYTES, maxSessionMs: 30_000 });
  const offSensors = runtime.on("sensors_stopped", () => { stopInput("paused", "Microphone stopped with Stop sensors. Tap Start to listen again."); output.stop(); });
  const visibility = () => { if (document.visibilityState !== "visible") { stopInput("paused", "Microphone stopped because the page is hidden. Tap Start to listen again."); output.stop(); } };
  const pagehide = () => { stopInput("paused", "Microphone stopped because you left the page."); output.stop(); };
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("freeze", pagehide);
  window.addEventListener("pagehide", pagehide);
  return {
    get outputStatus() { const { enabled, ...status } = output.status; return { engine: enabled ? "neural" as const : "browser" as const, ...status }; },
    get muted() { return !preferences.get().audio; },
    get speaking() { return output.speaking; },
    get listening() { return local.running || wake.running || !!capture?.listening; },
    get microphoneActive() { return local.microphoneActive || wake.microphoneActive || !!capture?.microphoneActive; },
    get wakeStatus() { return { ...wakeStatus }; },
    get captureStatus() { return { ...captureStatus }; },
    get settings() { const { language: lang, wakePhrase, wakeMode } = preferences.get(); return { language: lang || navigator.language || "en-US", wakePhrase, wakeMode }; },
    async enableOutput(engine: "browser" | "neural" = "browser") {
      const epoch = operation;
      if (await consent({ purpose: "output", engine, description: engine === "neural" ? "Download an optional neural voice (about 65 MB) and speak on this device." : "Speak using this device's browser voice." }) !== true || disposed || epoch !== operation) return false;
      preferences.update({ audio: true, voice: engine });
      if (engine === "neural") await output.enable();
      return true;
    },
    mute() { preferences.update({ audio: false }); output.stop(); },
    speak(text: string) {
      if (disposed || !preferences.get().audio || !text.trim()) return;
      // Stop BEFORE output is queued. Ignoring results only while speaking does
      // not protect against delayed transcripts of the device's own voice.
      stopInput("paused", "Microphone stopped for speech playback. Tap Start to listen again.");
      output.speak(text);
    },
    stop,
    stopWake() { if (input && input.kind !== "capture" || local.running || wake.running) stopInput(); },
    language(tag: string) { stop(); preferences.update({ language: tag }); },
    async prepareCapture() {
      // Allocate ownership before consent. A second preparation or any input
      // start invalidates the first, including an unanswered consent callback.
      stopInput();
      if (disposed) throw new Error("Voice adapter is disposed");
      const epoch = operation;
      const pending = preparation = new AbortController();
      try {
        if (await consent(captureDisclosure()) !== true || disposed || epoch !== operation || pending.signal.aborted) return;
        reportCapture("working", "Preparing verified local transcription. Microphone is off.");
        await prepareCapture(pending.signal);
        if (preparation === pending && !pending.signal.aborted) reportCapture("idle", "Local speech is ready. Microphone is off.");
      } catch (error) {
        if (preparation === pending && !pending.signal.aborted) reportCapture("error", messageOf(error));
        throw error;
      }
      finally { if (preparation === pending) preparation = null; }
    },
    async startCapture() {
      const session = begin("capture");
      try {
        if (await consent(captureDisclosure()) !== true || !current(session)) { if (input === session) end(session); return; }
        if (!SPEECH_LANGUAGES.includes(language().split("-")[0].toLowerCase())) throw new Error("Choose a supported speech language or type instead.");
        reportCapture("working", "Preparing verified local transcription. Microphone is off.");
        const selected = await prepareCapture(session.abort.signal);
        if (!current(session)) return;
        if (!await acquire(session)) return;
        await selected.start();
        if (input === session && !selected.listening) end(session);
      } catch (error) {
        if (input === session) { end(session); capture?.cancel(); reportCapture("error", messageOf(error)); }
      }
    },
    finishCapture() { capture?.stop(); },
    cancelCapture() { if (input?.kind === "capture" || preparation) stopInput(); },
    async startWake(settings: { phrase: string; mode: WakeMode }) {
      // Snapshot before consent. A caller cannot change local consent to a cloud
      // recognizer by mutating its options while a decision is pending.
      const requested = { phrase: settings.phrase, mode: settings.mode, lang: language() };
      const session = begin(requested.mode);
      try {
        preferences.update({ wakePhrase: requested.phrase, wakeMode: requested.mode });
        const phrase = preferences.get().wakePhrase;
        wakeStatus = { state: "starting", message: "Review microphone consent.", phrase, mode: requested.mode };
        const model = requested.mode === "model";
        if (model && !SPEECH_LANGUAGES.includes(requested.lang.split("-")[0].toLowerCase())) throw new Error("On-device wake phrases support English, German, French, Spanish, Italian, Dutch and Polish. Choose a supported language or type.");
        const decision = consent({ purpose: "wake", engine: model ? "cactus-whistle" : requested.mode, phrase, language: requested.lang,
          ...(model ? { downloadBytes: SPEECH_DOWNLOAD_BYTES } : {}), maxSessionMs: 300_000,
          description: model
            ? `Listen for “${phrase}” in ${requested.lang} on this device. The verified download is ${SPEECH_DOWNLOAD_BYTES.toLocaleString("en-US")} bytes. Ambient audio is never uploaded. Listening stops when hidden or after five minutes; speech processing has additional device-work limits.`
            : requested.mode === "local"
              ? `Listen for “${phrase}” using this browser's installed on-device ${requested.lang} recognition. No cloud fallback. Visible page only, at most five minutes.`
              : `Listen for “${phrase}” while this page is visible, at most five minutes. Browser recognition may send ALL microphone audio, including ambient speech, to its provider.` });
        // Synchronous decisions preserve Safari/iOS activation before any await.
        if (decision === true && model) local.unlock();
        const accepted = await decision;
        if (accepted !== true || !current(session)) { if (input === session) { local.stop(); end(session); reportWake("off", "Wake listening was not enabled."); } return false; }
        if (model && decision !== true) local.unlock();
        reportWake("starting", "Checking foreground microphone availability…");
        if (!await acquire(session)) return false;
        let started: boolean;
        if (model) {
          const speech = await getResources(session.abort.signal);
          if (!current(session)) return false;
          started = await local.start({ phrase, lang: requested.lang, speech, workerUrl: runtime.assetUrl("voice-worker.js"), workletUrl: runtime.assetUrl("voice-pcm-worklet.js") });
        } else {
          if (requested.mode === "local" && await WakeWordCapture.localAvailability(requested.lang) !== "available") throw new Error("The browser's on-device language pack is not installed or unavailable. Install it explicitly, choose the pinned model, or type.");
          if (!current(session)) return false;
          started = wake.start({ phrase, mode: requested.mode, lang: requested.lang });
        }
        if (!started && input === session) end(session);
        return started && current(session);
      } catch (error) {
        if (input === session) { input = null; local.stop(); wake.stop(); session.abort.abort(); release(session); reportWake("error", messageOf(error)); }
        return false;
      }
    },
    localAvailability: () => WakeWordCapture.localAvailability(language()),
    async installLocalLanguage() {
      const epoch = operation, lang = language();
      if (await consent({ purpose: "wake", engine: "local", language: lang, description: "Install the browser language pack for on-device speech recognition. This does not start a microphone." }) !== true || disposed || epoch !== operation) return false;
      return WakeWordCapture.installLocal(lang);
    },
    dispose() {
      if (disposed) return;
      stop(); disposed = true; capture?.dispose(); output.dispose(); preferences.dispose(); offSensors();
      document.removeEventListener("visibilitychange", visibility); document.removeEventListener("freeze", pagehide); window.removeEventListener("pagehide", pagehide);
    },
  };
}
