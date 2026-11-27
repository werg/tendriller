// Pluggable on-device ASR engine abstraction & catalog.
// Default engine: Streaming Cactus Whistle v4 (18.2 MB, 7 EU langs, universal single-thread WASM).
// Optional zero-download accelerator: Browser-local SpeechRecognition (processLocally: true, desktop only).
import { SPEECH_DOWNLOAD_BYTES, SPEECH_LANGUAGES } from "./resources";

export type AsrEngineId = "auto" | "whistle" | "browser-local";

export interface AsrEngineDescriptor {
  readonly id: Exclude<AsrEngineId, "auto">;
  readonly label: string;
  readonly streaming: boolean;
  readonly downloadBytes: number;
  readonly languages: readonly string[];
  readonly requiresProcessLocally?: boolean;
}

export const SPEECH_ENGINE_CATALOG: readonly AsrEngineDescriptor[] = Object.freeze([
  Object.freeze({
    id: "whistle",
    label: "Cactus Whistle v4 (on-device WASM, streaming)",
    streaming: true,
    downloadBytes: SPEECH_DOWNLOAD_BYTES,
    languages: SPEECH_LANGUAGES,
  }),
  Object.freeze({
    id: "browser-local",
    label: "Browser on-device recognition (processLocally, zero download)",
    streaming: true,
    downloadBytes: 0,
    languages: SPEECH_LANGUAGES,
    requiresProcessLocally: true,
  }),
]);

export class UnsupportedLanguageError extends Error {
  readonly code = "UNSUPPORTED_SPEECH_LANGUAGE";
  readonly requested: string;
  readonly supported: readonly string[];

  constructor(requested: string, supported: readonly string[] = SPEECH_LANGUAGES) {
    super(`Speech language "${requested}" is not supported on-device (supported: ${supported.join(", ")}). Choose a supported language or type instead.`);
    this.name = "UnsupportedLanguageError";
    this.requested = requested;
    this.supported = supported;
  }
}

/**
 * Normalize and validate a requested BCP-47 speech language tag against SPEECH_LANGUAGES.
 * Never silently falls back to English when an explicit unsupported tag is passed,
 * unless `fallbackLanguage` is explicitly provided by the caller.
 */
export function resolveSpeechLanguage(
  requested?: string | null,
  options: { fallbackLanguage?: string } = {},
): string {
  const raw = (requested || (typeof navigator !== "undefined" && navigator.language) || "en-US").trim();
  const primary = raw.split("-")[0]?.toLowerCase() || "";
  if (SPEECH_LANGUAGES.includes(primary)) return primary;
  if (options.fallbackLanguage) {
    const fb = options.fallbackLanguage.split("-")[0]?.toLowerCase() || "";
    if (SPEECH_LANGUAGES.includes(fb)) return fb;
  }
  throw new UnsupportedLanguageError(raw || primary || "unknown", SPEECH_LANGUAGES);
}

interface LocalSpeechRecognitionCtor {
  new (): {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    processLocally?: boolean;
    onresult: ((event: any) => void) | null;
    onerror: ((event: any) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
  };
  available?(options: { langs: string[]; processLocally: boolean }): Promise<string>;
}

function getLocalSpeechRecognitionCtor(): LocalSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { SpeechRecognition?: LocalSpeechRecognitionCtor }).SpeechRecognition;
  if (!ctor || typeof ctor.available !== "function") return null;
  return ctor;
}

/**
 * Checks whether the browser supports strictly local (`processLocally: true`) SpeechRecognition
 * for the requested language without any cloud audio upload.
 */
export async function isBrowserLocalAvailable(language: string): Promise<boolean> {
  const Ctor = getLocalSpeechRecognitionCtor();
  if (!Ctor?.available) return false;
  try {
    const status = await Ctor.available({ langs: [language], processLocally: true });
    return status === "available";
  } catch {
    return false;
  }
}

export interface BrowserLocalSession {
  stop(): void;
  cancel(): void;
}

/**
 * Starts a strictly on-device (`processLocally = true`) browser SpeechRecognition stream.
 * Never falls back to cloud recognition.
 */
export function startBrowserLocalStream(options: {
  language: string;
  onPartial: (partial: { confirmed: string; pending: string; text: string }) => void;
  onFinal: (text: string) => void;
  onError: (error: Error) => void;
}): BrowserLocalSession {
  const Ctor = getLocalSpeechRecognitionCtor();
  if (!Ctor) throw new Error("Browser on-device SpeechRecognition (processLocally) is unavailable.");
  const rec = new Ctor();
  rec.lang = options.language;
  rec.continuous = true;
  rec.interimResults = true;
  rec.processLocally = true;
  if (rec.processLocally !== true) {
    throw new Error("Browser refused strictly local speech recognition (processLocally).");
  }

  let confirmed = "";
  let pending = "";
  let settled = false;
  let cancelled = false;

  rec.onresult = (event: any) => {
    if (settled || cancelled) return;
    let nextConfirmed = "";
    let nextPending = "";
    for (let i = 0; i < (event.results?.length ?? 0); i++) {
      const result = event.results[i];
      const transcript = String(result?.[0]?.transcript ?? "").trim();
      if (!transcript) continue;
      if (result.isFinal) nextConfirmed = nextConfirmed ? `${nextConfirmed} ${transcript}` : transcript;
      else nextPending = nextPending ? `${nextPending} ${transcript}` : transcript;
    }
    confirmed = nextConfirmed;
    pending = nextPending;
    const text = [confirmed, pending].filter(Boolean).join(" ").trim();
    options.onPartial({ confirmed, pending, text });
  };

  rec.onerror = (event: any) => {
    if (settled || cancelled) return;
    settled = true;
    const code = String(event?.error || "recognition-error");
    options.onError(new Error(`On-device browser recognition failed (${code}).`));
  };

  rec.onend = () => {
    if (settled || cancelled) return;
    settled = true;
    const finalText = [confirmed, pending].filter(Boolean).join(" ").trim();
    options.onFinal(finalText);
  };

  rec.start();

  return {
    stop() {
      if (settled || cancelled) return;
      try { rec.stop(); } catch {
        settled = true;
        options.onFinal([confirmed, pending].filter(Boolean).join(" ").trim());
      }
    },
    cancel() {
      if (settled || cancelled) return;
      cancelled = true;
      settled = true;
      try { rec.abort(); } catch { /* ignore */ }
    },
  };
}
