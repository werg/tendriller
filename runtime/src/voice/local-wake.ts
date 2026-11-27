import type { RuntimeArtifactFeatures } from "../../../contract/index.mjs";
import type { WakeState } from "./wakeword";
import { matchWakePhrase } from "./wakeword";
import { MAX_WAKE_SAMPLES, PCM_RATE } from "./pcm";
import { mediaRequestSettled } from "../sensors";
import { SPEECH_LANGUAGES } from "./resources";
import type { SharedSpeechWorker } from "./shared-worker";

type SpeechResource = NonNullable<RuntimeArtifactFeatures["speech"]>;
export interface LocalWakeSettings {
  phrase: string; lang: string; workerUrl: string; workletUrl: string; speech: SpeechResource;
  sharedWorker?: SharedSpeechWorker;
}
export interface LocalWakeHandlers {
  onState(state: WakeState, detail?: string): void;
  onWake(): void;
  onCommand(text: string): void;
  isOutputSpeaking?(): boolean;
}
const LANGUAGES = new Set(SPEECH_LANGUAGES);
const SESSION_MS = 5 * 60_000;
const INFERENCE_MS = 10_000;
const INFERENCE_BUDGET_MS = 20_000; // Wall time per fixed minute, a conservative CPU proxy.
const MAX_INFERENCES = 15;
const COMMAND_MS = 8_000;

function audioConstructor(): typeof AudioContext | undefined {
  return window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}
function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Microphone access was denied. Check site permissions and tap Start again.";
  if (error instanceof DOMException && error.name === "NotFoundError") return "No microphone is available. Connect one or use typed input.";
  return error instanceof Error ? error.message : "On-device listening failed. You can type instead.";
}

/** Bounded foreground phrase spotting using pinned local ASR, not a low-power KWS model. */
export class LocalWakeCapture {
  private active = false;
  private initializing = false;
  private generation = 0;
  private context: AudioContext | null = null;
  private primed: AudioContext | null = null;
  private primedResume: Promise<void> | null = null;
  private primingError: unknown = null;
  private unlockTimer: ReturnType<typeof setTimeout> | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private worker: Worker | null = null;
  private sharedWorker: SharedSpeechWorker | null = null;
  private sharedRelease: (() => void) | null = null;
  private inferenceAbort: AbortController | null = null;
  private requestSettled: Promise<void> = Promise.resolve();
  private requesting = false;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private deadlines = new Set<() => void>();
  private nextId = 0;
  private sequence = 0;
  private busy = false;
  private commandUntil = 0;
  private commandTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private rearmTimer: ReturnType<typeof setTimeout> | null = null;
  private minuteStarted = 0;
  private inferenceMs = 0;
  private inferenceCount = 0;
  private audioSamples = 0;
  private settings: LocalWakeSettings | null = null;
  private removeTrackListeners: Array<() => void> = [];

  constructor(private readonly handlers: LocalWakeHandlers) {}
  static supported(): boolean {
    return !!audioConstructor() && typeof AudioWorkletNode !== "undefined" && typeof Worker !== "undefined"
      && !!navigator.mediaDevices?.getUserMedia && typeof WebAssembly !== "undefined";
  }
  get running(): boolean { return this.active; }
  get preparing(): boolean { return this.initializing; }
  get microphoneActive(): boolean { return !!this.stream?.getAudioTracks().some(track => track.readyState === "live"); }
  /** Keep the origin microphone lease until a cancelled permission request actually settles. */
  get microphoneSettled(): Promise<void> { return this.requestSettled; }

  /** Call synchronously from the person's Start gesture, before consent/preflight awaits. */
  unlock(): void {
    if (this.primed || this.context) return;
    this.primingError = null;
    try {
      const Constructor = audioConstructor();
      if (!Constructor) throw new Error("This browser has no microphone audio processing. You can type instead.");
      const context = this.primed = new Constructor({ latencyHint: "interactive" });
      this.primedResume = context.resume();
      // A permission/consent dialog cannot retain a silent audio device indefinitely.
      this.unlockTimer = setTimeout(() => {
        if (this.primed !== context) return;
        this.primed = null; this.primedResume = null;
        void context.close().catch(() => {});
      }, 30_000);
      void this.primedResume.catch(error => { this.primingError = error; });
    } catch (error) { this.primingError = error; }
  }

  private async deadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
        cancel = () => reject(new Error("Listening stopped"));
        this.deadlines.add(cancel);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); if (cancel) this.deadlines.delete(cancel); }
  }

  private call(action: string, data: Record<string, unknown>, timeout: number, transfer: Transferable[] = []): Promise<any> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("The local speech worker is unavailable"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        reject(new Error("On-device speech took too long. Listening stopped to limit device work."));
        this.stop("error", "On-device speech took too long. Listening stopped to limit device work.");
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, action, ...data }, transfer); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error(errorText(error))); }
    });
  }

  private visibility = () => {
    if (document.visibilityState !== "visible") this.stop("paused", "Microphone stopped because the page was hidden. Tap Start to listen again.");
  };
  private pagehide = () => this.stop("paused", "Microphone stopped when you left the page.");
  private interrupted = () => {
    if (this.active && this.context?.state !== "running") this.stop("paused", "Audio was interrupted by the browser or another app. Tap Start to listen again.");
  };

  async start(settings: LocalWakeSettings): Promise<boolean> {
    if (this.active) return false;
    if (this.requesting) {
      this.stop("error", "A previous microphone permission request is still pending. Dismiss it before starting again.");
      return false;
    }
    const language = settings.lang.split("-")[0].toLowerCase();
    if (!LocalWakeCapture.supported() || !LANGUAGES.has(language) || !/[\p{L}\p{N}]/u.test(settings.phrase) || settings.phrase.length > 120) {
      this.stop("error", !LANGUAGES.has(language)
        ? "On-device wake phrases support English, German, French, Spanish, Italian, Dutch and Polish. Choose a supported language or type."
        : "On-device wake input needs a microphone, AudioWorklet and a wake phrase of at most 120 characters.");
      return false;
    }
    if (document.visibilityState !== "visible") { this.stop("paused", "Keep this page visible to start listening."); return false; }
    this.unlock();
    const context = this.context = this.primed;
    const resume = this.primedResume;
    this.primed = null; this.primedResume = null;
    if (this.unlockTimer !== null) clearTimeout(this.unlockTimer);
    this.unlockTimer = null;
    this.active = true; this.initializing = true; this.settings = { ...settings, lang: language };
    const generation = ++this.generation;
    const current = () => this.active && generation === this.generation;
    document.addEventListener("visibilitychange", this.visibility);
    document.addEventListener("freeze", this.pagehide);
    window.addEventListener("pagehide", this.pagehide);
    this.handlers.onState("loading", "Preparing the verified on-device speech model. Microphone is off.");
    try {
      if (!context || !resume || this.primingError) throw new Error("Tap Start again to allow audio processing in this browser.");
      await this.deadline(resume, 8_000, "Audio processing needs a fresh Start gesture in this browser.");
      if (!current()) return false;
      if (context.state !== "running" || !context.audioWorklet) throw new Error("AudioWorklet is unavailable or audio is blocked. Tap Start again or type.");
      context.addEventListener("statechange", this.interrupted);
      const speech = settings.speech;
      if (settings.sharedWorker) {
        this.sharedWorker = settings.sharedWorker;
        this.sharedRelease = settings.sharedWorker.retain();
        const ac = new AbortController();
        this.inferenceAbort = ac;
        await Promise.all([
          this.deadline(
            settings.sharedWorker.ensureInit(speech, {
              onProgress: progress => { if (current() && this.initializing) this.handlers.onState("loading", progress); },
              signal: ac.signal,
            }),
            120_000,
            "On-device speech took too long. Listening stopped to limit device work.",
          ),
          this.deadline(context.audioWorklet.addModule(settings.workletUrl), 30_000, "Microphone processing could not load."),
        ]);
        if (this.inferenceAbort === ac) this.inferenceAbort = null;
      } else {
        const worker = this.worker = new Worker(settings.workerUrl);
        worker.onmessage = event => {
          if (!current() || this.worker !== worker) return;
          const { id, progress, error, ...result } = event.data ?? {};
          if (progress) { if (this.initializing) this.handlers.onState("loading", String(progress)); return; }
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(id);
          if (error) pending.reject(new Error(String(error))); else pending.resolve(result);
        };
        worker.onerror = () => { if (current()) this.stop("error", "The on-device speech worker failed. Tap Start to retry or type."); };
        worker.onmessageerror = () => { if (current()) this.stop("error", "The on-device speech worker returned an invalid response."); };
        await Promise.all([
          this.call("init", { engine: speech.engine, modelUrl: speech.url, modelSha256: speech.sha256, modelSize: speech.size }, 120_000),
          this.deadline(context.audioWorklet.addModule(settings.workletUrl), 30_000, "Microphone processing could not load."),
        ]);
      }
      if (!current()) return false;
      this.handlers.onState("starting", "Waiting for microphone permission…");
      if (!current()) return false;
      const request = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      this.requesting = true;
      const cleanup = request.then(stream => {
        if (!current()) stream.getTracks().forEach(track => track.stop());
      }, () => {});
      this.requestSettled = Promise.all([cleanup, mediaRequestSettled(request)]).then(() => {}).finally(() => { this.requesting = false; });
      const stream = await this.deadline(request, 30_000, "Microphone permission timed out. Dismiss the browser prompt and tap Start again.");
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return false; }
      this.stream = stream;
      const tracks = stream.getAudioTracks();
      if (!tracks.length || tracks.some(track => track.readyState !== "live" || track.muted)) throw new Error("The microphone is unavailable or interrupted. Tap Start to retry.");
      for (const track of tracks) {
        const interrupted = () => this.stop("paused", "Microphone access ended or was interrupted. Tap Start to listen again.");
        track.addEventListener("ended", interrupted); track.addEventListener("mute", interrupted);
        this.removeTrackListeners.push(() => { track.removeEventListener("ended", interrupted); track.removeEventListener("mute", interrupted); });
      }
      this.source = context.createMediaStreamSource(stream);
      const worklet = this.worklet = new AudioWorkletNode(context, "tendriller-voice-pcm", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
      });
      worklet.port.onmessage = event => {
        const message = event.data;
        if (!current() || this.busy || message?.type !== "utterance" || message.sequence !== this.sequence) return;
        if (!(message.samples instanceof ArrayBuffer) || !message.samples.byteLength || message.samples.byteLength > MAX_WAKE_SAMPLES * 4 || message.samples.byteLength % 4) {
          this.stop("error", "Microphone processing produced an invalid audio window."); return;
        }
        void this.process(message.samples, generation);
      };
      worklet.onprocessorerror = () => { if (current()) this.stop("error", "Microphone processing failed. Tap Start to retry or type."); };
      this.source.connect(worklet); worklet.connect(context.destination);
      this.initializing = false; this.minuteStarted = Date.now(); this.inferenceMs = this.inferenceCount = this.audioSamples = 0;
      this.sessionTimer = setTimeout(() => this.stop("paused", "The five-minute listening limit was reached. Tap Start for another session."), SESSION_MS);
      this.listen();
      return true;
    } catch (error) {
      if (current()) this.stop("error", errorText(error));
      return false;
    } finally { if (generation === this.generation) this.initializing = false; }
  }

  private listen(): void {
    if (!this.active || !this.worklet) return;
    this.busy = false;
    this.worklet.port.postMessage({ type: "listen", enabled: true, sequence: ++this.sequence });
    this.handlers.onState(this.commandUntil ? "command" : "listening", this.commandUntil
      ? "Wake phrase detected. Speak your command within eight seconds."
      : "Microphone on. Listening for your wake phrase on this device.");
  }

  private async process(samples: ArrayBuffer, generation: number): Promise<void> {
    if (!this.active || generation !== this.generation || !this.settings) return;
    if (window.speechSynthesis?.speaking || this.handlers.isOutputSpeaking?.()) {
      new Float32Array(samples).fill(0);
      this.stop("paused", "Listening stopped while audio was speaking. Tap Start to listen again."); return;
    }
    const now = Date.now();
    if (now - this.minuteStarted >= 60_000) { this.minuteStarted = now; this.inferenceMs = 0; this.inferenceCount = 0; }
    this.audioSamples += samples.byteLength / 4;
    if (++this.inferenceCount > MAX_INFERENCES || this.inferenceMs >= INFERENCE_BUDGET_MS || this.audioSamples > PCM_RATE * 120) {
      new Float32Array(samples).fill(0);
      this.stop("paused", "Listening stopped at the device work limit. Try a quieter place or use push-to-talk."); return;
    }
    this.busy = true;
    const commandWindow = this.commandUntil > now;
    if (this.commandUntil && !commandWindow) this.clearCommand();
    // Stop the command timer while a window captured before its deadline is processed.
    if (this.commandTimer !== null) clearTimeout(this.commandTimer);
    this.commandTimer = null;
    this.handlers.onState("transcribing", commandWindow ? "Transcribing your command on this device…" : "Checking the wake phrase on this device…");
    try {
      const budgetTimeout = Math.min(INFERENCE_MS, INFERENCE_BUDGET_MS - this.inferenceMs);
      let result: any;
      if (this.sharedWorker) {
        const pcm = new Float32Array(samples);
        const ac = new AbortController();
        this.inferenceAbort = ac;
        try {
          if (commandWindow) {
            const text = await this.sharedWorker.transcribe(pcm, this.settings.lang, { signal: ac.signal, timeoutMs: budgetTimeout });
            result = { text };
          } else {
            result = await this.sharedWorker.detect(pcm, this.settings.lang, this.settings.phrase, { signal: ac.signal, timeoutMs: budgetTimeout });
          }
        } finally {
          pcm.fill(0);
          if (this.inferenceAbort === ac) this.inferenceAbort = null;
        }
      } else {
        result = await this.call(commandWindow ? "transcribe" : "detect", {
          samples, language: this.settings.lang, phrase: this.settings.phrase,
        }, budgetTimeout, [samples]);
      }
      this.inferenceMs += Date.now() - now;
      if (!this.active || generation !== this.generation) return;
      if (window.speechSynthesis?.speaking || this.handlers.isOutputSpeaking?.()) {
        this.stop("paused", "Listening stopped during audio playback. Tap Start to listen again."); return;
      }
      if (commandWindow) {
        const text = String(result.text ?? "").trim();
        const match = matchWakePhrase(text, this.settings.phrase);
        this.clearCommand();
        const command = match ? match.command : text;
        if (command) this.handlers.onCommand(command);
        this.rearm(generation);
      } else if (result.matched === true) {
        this.handlers.onState("detected", "Wake phrase detected.");
        if (!this.active || generation !== this.generation) return;
        this.handlers.onWake();
        if (!this.active || generation !== this.generation) return;
        const text = String(result.command ?? "").trim();
        if (text) { this.handlers.onCommand(text); this.rearm(generation); }
        else {
          this.commandUntil = Date.now() + COMMAND_MS;
          this.commandTimer = setTimeout(() => { this.clearCommand(); this.listen(); }, COMMAND_MS);
          this.listen();
        }
      } else this.listen();
    } catch (error) { if (this.active && generation === this.generation) this.stop("error", errorText(error)); }
  }

  private rearm(generation: number): void {
    this.clearCommand();
    if (!this.active || generation !== this.generation) return;
    // No pre-wake audio, duplicates or speaker tail survive into another command.
    this.handlers.onState("listening", "Command captured. Wait for the wake phrase indicator before speaking again.");
    this.rearmTimer = setTimeout(() => { this.rearmTimer = null; if (generation === this.generation) this.listen(); }, 1_000);
  }
  private clearCommand(): void {
    if (this.commandTimer !== null) clearTimeout(this.commandTimer);
    this.commandTimer = null; this.commandUntil = 0;
  }

  stop(state: WakeState = "off", detail = "Microphone off."): void {
    this.active = false; this.initializing = false; ++this.generation;
    this.clearCommand();
    for (const timer of [this.sessionTimer, this.rearmTimer, this.unlockTimer]) if (timer !== null) clearTimeout(timer);
    this.sessionTimer = this.rearmTimer = this.unlockTimer = null;
    document.removeEventListener("visibilitychange", this.visibility);
    document.removeEventListener("freeze", this.pagehide);
    window.removeEventListener("pagehide", this.pagehide);
    for (const remove of this.removeTrackListeners.splice(0)) remove();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    try { this.worklet?.port.postMessage({ type: "close" }); this.worklet?.port.close(); this.worklet?.disconnect(); this.source?.disconnect(); } catch { /* Already disconnected. */ }
    this.worklet = null; this.source = null;
    this.context?.removeEventListener("statechange", this.interrupted);
    if (this.context) void this.context.close().catch(() => {});
    if (this.primed) void this.primed.close().catch(() => {});
    this.context = this.primed = null; this.primedResume = null;
    this.inferenceAbort?.abort(); this.inferenceAbort = null;
    this.sharedRelease?.(); this.sharedRelease = null; this.sharedWorker = null;
    this.worker?.terminate(); this.worker = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("Listening stopped")); }
    for (const cancel of this.deadlines) cancel();
    this.deadlines.clear();
    this.pending.clear(); this.settings = null; this.busy = false; ++this.sequence;
    this.handlers.onState(state, detail);
  }
}
