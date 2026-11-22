// Opt-in wake-phrase recognition for explicitly selected voice experiences.
// On-device Web Speech is strict: never silently fall back to vendor/cloud recognition.
// This is transcript matching, not a dedicated low-power wake-word model.
export type WakeMode = "model" | "local" | "browser";
export type WakeState = "off" | "starting" | "loading" | "listening" | "transcribing" | "detected" | "command" | "restarting" | "paused" | "error";

interface RecognitionResult { isFinal: boolean; [index: number]: { transcript: string } }
interface RecognitionResultEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
interface RecognitionFactory {
  new(): Recognition;
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (options: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
}
function recognitionFactory(mode: WakeMode = "browser"): RecognitionFactory | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionFactory; webkitSpeechRecognition?: RecognitionFactory };
  return w.SpeechRecognition || (mode === "browser" ? w.webkitSpeechRecognition : null) || null;
}

function tokens(text: string): { value: string; end: number }[] {
  return [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)].map(match => ({
    value: match[0].normalize("NFKC").toLowerCase(),
    end: (match.index ?? 0) + match[0].length,
  }));
}

/** Match whole words only and preserve punctuation in the following command. */
export function matchWakePhrase(transcript: string, phrase: string): { command: string } | null {
  const heard = tokens(transcript);
  const wanted = tokens(phrase).map(token => token.value);
  if (!wanted.length) return null;
  for (let i = 0; i + wanted.length <= heard.length; i++) {
    if (wanted.every((word, offset) => heard[i + offset].value === word)) {
      return { command: transcript.slice(heard[i + wanted.length - 1].end).replace(/^[^\p{L}\p{N}]+/u, "").trim() };
    }
  }
  return null;
}

const FATAL: Record<string, string> = {
  "not-allowed": "Microphone or speech permission was denied. Check site permissions and tap Start again.",
  "service-not-allowed": "The selected speech recognition service is blocked on this device.",
  "audio-capture": "No usable microphone was found. Connect one and try again.",
  "language-not-supported": "This language has no installed on-device speech pack. Install that language pack or choose another language.",
  "network": "Speech recognition lost its connection. Tap Start again when online.",
};

export class WakeWordCapture {
  microphoneSettled: Promise<void> = Promise.resolve();
  private active = false;
  private microphone = false;
  private ending = false;
  private rec: Recognition | null = null;
  private restartTimer: number | null = null;
  private commandTimer: number | null = null;
  private startupTimer: number | null = null;
  private sessionTimer: number | null = null;
  private awaiting = false;
  private seen = new Set<number>();
  private failures = 0;
  private lastWake = -Infinity;
  private begunAt = 0;
  private phrase = "";
  private lang = "en-US";
  private mode: WakeMode = "local";

  constructor(private handlers: {
    onState(state: WakeState, detail?: string): void;
    onWake(): void;
    onCommand(text: string): void;
    isOutputSpeaking?(): boolean;
  }) {}

  static supported(mode: WakeMode = "browser"): boolean { return mode !== "model" && !!recognitionFactory(mode); }
  static async localAvailability(lang: string): Promise<string> {
    const factory = recognitionFactory("local");
    if (!factory?.available) return "unsupported";
    try { return await factory.available({ langs: [lang], processLocally: true }); }
    catch { return "unavailable"; }
  }
  static async installLocal(lang: string): Promise<boolean> {
    const factory = recognitionFactory("local");
    if (!factory?.install) return false;
    try { return await factory.install({ langs: [lang], processLocally: true }); }
    catch { return false; }
  }

  get running(): boolean { return this.active; }
  get microphoneActive(): boolean { return this.microphone; }

  private clearCommand(): void {
    if (this.commandTimer !== null) window.clearTimeout(this.commandTimer);
    this.commandTimer = null;
    this.awaiting = false;
  }

  private onVisibility = () => {
    if (document.visibilityState !== "visible") {
      this.stop("paused", "Listening paused when the page was hidden. Return and tap Start to resume.");
    }
  };
  private onPageHide = () => {
    this.stop("paused", "Listening stopped when you left the page. Tap Start to resume.");
  };

  start(options: { phrase: string; lang: string; mode: WakeMode }): boolean {
    this.stop("off", "", false);
    if (options.mode !== "local" && options.mode !== "browser") {
      this.handlers.onState("error", "Select the pinned model adapter for model-based wake recognition.");
      return false;
    }
    if (this.ending) {
      this.handlers.onState("error", "The previous microphone is still stopping. Wait, then tap Start again.");
      return false;
    }
    const factory = recognitionFactory(options.mode);
    if (!factory) {
      this.handlers.onState("error", "This browser has no speech recognition. Use the microphone button or type instead.");
      return false;
    }
    if (document.visibilityState !== "visible") {
      this.handlers.onState("paused", "Open the page to start hands-free listening.");
      return false;
    }
    if (typeof options.phrase !== "string" || !tokens(options.phrase).length || options.phrase.length > 120 || tokens(options.phrase).length > 8 || /[\u0000-\u001f\u007f]/.test(options.phrase)) {
      this.handlers.onState("error", "Choose a wake phrase of one to eight words and no more than 120 characters.");
      return false;
    }
    let lang: string;
    try { if (typeof options.lang !== "string" || options.lang.length > 50) throw new Error(); lang = Intl.getCanonicalLocales(options.lang)[0]; if (!lang) throw new Error(); }
    catch {
      this.handlers.onState("error", "Choose a valid recognition language before starting.");
      return false;
    }
    if (options.mode === "local") {
      try {
        const probe = new factory();
        if (!("processLocally" in probe)) {
          this.handlers.onState("error", "On-device speech is not supported here. Choose Browser recognition in wake settings only if you accept its privacy trade-off.");
          return false;
        }
      } catch {
        this.handlers.onState("error", "Could not initialize on-device recognition. Try another browser.");
        return false;
      }
    }
    this.phrase = options.phrase;
    this.lang = lang;
    this.mode = options.mode;
    this.active = true;
    this.failures = 0;
    this.lastWake = -Infinity;
    document.addEventListener("visibilitychange", this.onVisibility);
    document.addEventListener("freeze", this.onPageHide);
    window.addEventListener("pagehide", this.onPageHide);
    this.sessionTimer = window.setTimeout(() => this.stop("paused", "Wake listening reached its five-minute limit. Tap Start for another session."), 300_000);
    this.begin();
    return this.active;
  }

  private awaitCommand(): void {
    this.clearCommand();
    this.awaiting = true;
    this.handlers.onState("command", "Wake phrase detected. Speak your command within 8 seconds.");
    if (!this.active) return;
    this.commandTimer = window.setTimeout(() => {
      if (!this.active) return;
      this.clearCommand();
      this.handlers.onState("listening", "Command window expired. Say the wake phrase again.");
    }, 8000);
  }

  private deliver(text: string): void {
    const command = text.trim();
    const rec = this.rec;
    this.clearCommand();
    this.handlers.onState("listening", "Listening for the wake phrase.");
    if (command && this.active && this.rec === rec) this.handlers.onCommand(command);
  }

  private begin(): void {
    if (!this.active) return;
    const factory = recognitionFactory(this.mode);
    if (!factory) { this.stop("error", "Speech recognition is no longer available."); return; }
    let rec: Recognition;
    try { rec = new factory(); }
    catch {
      this.stop("error", "Could not initialize speech recognition. Check browser support and try again.");
      return;
    }
    this.rec = rec;
    this.seen = new Set();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = false; // Never expose background speech as live transcripts.
    if (this.mode === "local") {
      try {
        rec.processLocally = true;
        if (rec.processLocally !== true) throw new Error("Local recognition was not enabled");
      }
      catch {
        this.stop("error", "This browser could not enable on-device speech. Use another browser or explicitly choose Browser recognition.");
        return;
      }
    }
    this.begunAt = Date.now();
    this.ending = true;
    let settle: () => void;
    this.microphoneSettled = new Promise<void>(resolve => { settle = resolve; });
    let hasEnded = false;
    const ended = () => { if (hasEnded) return; hasEnded = true; this.ending = false; this.microphone = false; settle!(); };
    this.handlers.onState("starting", "Starting microphone…");
    if (!this.active || this.rec !== rec) { ended(); return; }
    this.startupTimer = window.setTimeout(() => {
      if (this.rec === rec) this.stop("error", "Microphone startup timed out. Dismiss any permission prompt and tap Start again.");
    }, 15_000);
    rec.onstart = () => {
      if (this.active && this.rec === rec) {
        if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
        this.startupTimer = null;
        this.microphone = true;
        this.handlers.onState(this.awaiting ? "command" : "listening",
          this.awaiting ? "Wake phrase detected. Speak now." : "Listening for the wake phrase.");
      }
    };
    rec.onresult = event => {
      if (!this.active || this.rec !== rec) return;
      if (!Number.isInteger(event.resultIndex) || event.resultIndex < 0 || !event.results || event.results.length > 10_000) {
        this.stop("error", "Speech recognition returned an invalid result. Tap Start to try again.");
        return;
      }
      // Avoid accepting the agent's own browser speech output as a command.
      if (window.speechSynthesis?.speaking || this.handlers.isOutputSpeaking?.()) {
        this.stop("paused", "Microphone stopped during audio playback. Tap Start when playback finishes.");
        return;
      }
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (!this.active || this.rec !== rec) return;
        const result = event.results[i];
        if (!result.isFinal || this.seen.has(i)) continue;
        this.seen.add(i);
        this.failures = 0;
        const text = result[0]?.transcript?.trim() || "";
        if (!text || text.length > 4_096) continue;
        const match = matchWakePhrase(text, this.phrase);
        if (this.awaiting) {
          if (match) {
            if (match.command) this.deliver(match.command);
            else this.awaitCommand();
          } else {
            this.deliver(text);
          }
        } else if (match && Date.now() - this.lastWake >= 2000) {
          this.lastWake = Date.now();
          this.handlers.onWake();
          if (!this.active || this.rec !== rec) return;
          if (match.command) this.deliver(match.command);
          else this.awaitCommand();
        }
      }
    };
    rec.onerror = event => {
      if (!this.active || this.rec !== rec) return;
      if (Object.hasOwn(FATAL, event.error)) {
        this.stop("error", FATAL[event.error]);
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        this.failures++;
        this.handlers.onState("restarting", "Recognition interrupted (" + event.error + "). Retrying…");
      }
    };
    rec.onend = () => {
      ended();
      if (!this.active || this.rec !== rec) return;
      this.microphone = false;
      if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.rec = null;
      if (document.visibilityState !== "visible") {
        this.stop("paused", "Listening paused in the background. Tap Start to resume.");
        return;
      }
      if (Date.now() - this.begunAt < 2500) this.failures++;
      else this.failures = 0;
      if (this.failures >= 6) {
        this.stop("error", "Speech recognition stopped repeatedly. Check microphone access and tap Start to retry.");
        return;
      }
      const delay = Math.min(15000, this.failures ? 500 * (2 ** this.failures) : 350);
      this.handlers.onState("restarting", "Reconnecting speech recognition…");
      this.restartTimer = window.setTimeout(() => { this.restartTimer = null; this.begin(); }, delay);
    };
    try { rec.start(); }
    catch (error) {
      ended();
      if (this.rec !== rec) return;
      if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.rec = null;
      this.failures++;
      if (this.failures >= 6) this.stop("error", "Could not start recognition. Check microphone permissions and try again.");
      else {
        this.handlers.onState("restarting", "Could not start speech recognition. Retrying…");
        this.restartTimer = window.setTimeout(() => { this.restartTimer = null; this.begin(); }, Math.min(15000, 500 * (2 ** this.failures)));
      }
    }
  }

  stop(state: WakeState = "off", detail = "", notify = true): void {
    this.active = false;
    if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
    if (this.sessionTimer !== null) window.clearTimeout(this.sessionTimer);
    this.startupTimer = null; this.sessionTimer = null;
    this.clearCommand();
    document.removeEventListener("visibilitychange", this.onVisibility);
    document.removeEventListener("freeze", this.onPageHide);
    window.removeEventListener("pagehide", this.onPageHide);
    const rec = this.rec;
    this.rec = null;
    try { rec?.abort(); } catch { /* Browser may already have ended it. */ }
    if (notify) this.handlers.onState(state, detail);
  }
}
