// Opt-in wake-phrase recognition for explicitly selected voice experiences.
// On-device Web Speech is strict: never silently fall back to vendor/cloud recognition.
// This is transcript matching, not a dedicated low-power wake-word model.
export type WakeMode = "local" | "browser";
export type WakeState = "off" | "starting" | "listening" | "command" | "restarting" | "paused" | "error";

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
function recognitionFactory(): RecognitionFactory | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionFactory };
  return w.SpeechRecognition || null;
}

function tokens(text: string): { value: string; end: number }[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map(match => ({
    value: match[0].normalize("NFKC").toLocaleLowerCase(),
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
  private active = false;
  private rec: Recognition | null = null;
  private restartTimer: number | null = null;
  private commandTimer: number | null = null;
  private awaiting = false;
  private seen = new Set<number>();
  private failures = 0;
  private lastWake = 0;
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

  static supported(): boolean { return !!recognitionFactory(); }
  static async localAvailability(lang: string): Promise<string> {
    const factory = recognitionFactory();
    if (!factory?.available) return "unsupported";
    try { return await factory.available({ langs: [lang], processLocally: true }); }
    catch { return "unavailable"; }
  }
  static async installLocal(lang: string): Promise<boolean> {
    const factory = recognitionFactory();
    if (!factory?.install) return false;
    return factory.install({ langs: [lang], processLocally: true });
  }

  get running(): boolean { return this.active; }

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
    this.stop();
    const factory = recognitionFactory();
    if (!factory) {
      this.handlers.onState("error", "This browser has no speech recognition. Use the microphone button or type instead.");
      return false;
    }
    if (document.visibilityState !== "visible") {
      this.handlers.onState("paused", "Open the page to start hands-free listening.");
      return false;
    }
    if (!tokens(options.phrase).length) {
      this.handlers.onState("error", "Choose a nonempty wake phrase first.");
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
    this.lang = options.lang;
    this.mode = options.mode;
    this.active = true;
    this.failures = 0;
    this.lastWake = 0;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    this.begin();
    return this.active;
  }

  private awaitCommand(): void {
    this.clearCommand();
    this.awaiting = true;
    this.handlers.onState("command", "Wake phrase detected. Speak your command within 8 seconds.");
    this.commandTimer = window.setTimeout(() => {
      if (!this.active) return;
      this.clearCommand();
      this.handlers.onState("listening", "Command window expired. Say the wake phrase again.");
    }, 8000);
  }

  private deliver(text: string): void {
    const command = text.trim();
    this.clearCommand();
    this.handlers.onState("listening", "Listening for the wake phrase.");
    if (command) this.handlers.onCommand(command);
  }

  private begin(): void {
    if (!this.active) return;
    const factory = recognitionFactory();
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
      try { rec.processLocally = true; }
      catch {
        this.stop("error", "This browser could not enable on-device speech. Use another browser or explicitly choose Browser recognition.");
        return;
      }
    }
    this.begunAt = Date.now();
    this.handlers.onState("starting", "Starting microphone…");
    rec.onstart = () => {
      if (this.active && this.rec === rec) {
        this.handlers.onState(this.awaiting ? "command" : "listening",
          this.awaiting ? "Wake phrase detected. Speak now." : "Listening for the wake phrase.");
      }
    };
    rec.onresult = event => {
      if (!this.active || this.rec !== rec) return;
      // Avoid accepting the agent's own browser speech output as a command.
      if (window.speechSynthesis?.speaking || this.handlers.isOutputSpeaking?.()) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal || this.seen.has(i)) continue;
        this.seen.add(i);
        this.failures = 0;
        const text = result[0]?.transcript?.trim() || "";
        if (!text) continue;
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
          if (match.command) this.deliver(match.command);
          else this.awaitCommand();
        }
      }
    };
    rec.onerror = event => {
      if (!this.active || this.rec !== rec) return;
      if (event.error in FATAL) {
        this.stop("error", FATAL[event.error]);
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        this.failures++;
        this.handlers.onState("restarting", "Recognition interrupted (" + event.error + "). Retrying…");
      }
    };
    rec.onend = () => {
      if (!this.active || this.rec !== rec) return;
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
      if (this.rec !== rec) return;
      this.rec = null;
      this.failures++;
      if (this.failures >= 6) this.stop("error", "Could not start recognition. Check microphone permissions and try again.");
      else {
        this.handlers.onState("restarting", "Could not start speech recognition. Retrying…");
        this.restartTimer = window.setTimeout(() => { this.restartTimer = null; this.begin(); }, Math.min(15000, 500 * (2 ** this.failures)));
      }
    }
  }

  stop(state: WakeState = "off", detail = ""): void {
    this.active = false;
    if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.clearCommand();
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    const rec = this.rec;
    this.rec = null;
    try { rec?.abort(); } catch { /* Browser may already have ended it. */ }
    this.handlers.onState(state, detail);
  }
}
