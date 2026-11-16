import type { PreferencesApi, RuntimePreferences } from "../../contract/index.mjs";

const defaults: RuntimePreferences = {
  audio: true, language: null, voice: "browser", textSize: "normal", contrast: "normal", mode: "interactive",
  wakePhrase: "Hey Tendril", wakeMode: "local",
};

function validate(patch: unknown): Partial<RuntimePreferences> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Preferences require an object");
  const result: Partial<RuntimePreferences> = {};
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "audio":
        if (typeof value !== "boolean") throw new TypeError("audio must be a boolean");
        result.audio = value; break;
      case "language":
        if (value === null) { result.language = null; break; }
        if (typeof value !== "string" || !value || value.length > 100) throw new TypeError("language must be a language tag or null");
        result.language = Intl.getCanonicalLocales(value)[0]; break;
      case "voice":
        if (value !== "browser" && value !== "neural") throw new TypeError("voice must be browser or neural");
        result.voice = value; break;
      case "wakePhrase": {
        if (typeof value !== "string") throw new TypeError("wakePhrase must be text");
        const phrase = value.trim().replace(/\s+/g, " ");
        if (phrase.length < 3 || phrase.length > 64 || !/^[\p{L}\p{N}]+(?:[ '-][\p{L}\p{N}]+)*$/u.test(phrase) || phrase.split(" ").length < 2)
          throw new TypeError("Use a wake phrase of 2 or more words (3–64 letters, numbers, spaces, apostrophes or hyphens)");
        result.wakePhrase = phrase; break;
      }
      case "wakeMode":
        if (value !== "local" && value !== "browser") throw new TypeError("wakeMode must be local or browser");
        result.wakeMode = value; break;
      case "textSize":
        if (value !== "normal" && value !== "large" && value !== "x-large") throw new TypeError("Invalid textSize");
        result.textSize = value; break;
      case "contrast":
        if (value !== "normal" && value !== "high") throw new TypeError("Invalid contrast");
        result.contrast = value; break;
      case "mode":
        if (value !== "interactive" && value !== "display") throw new TypeError("Invalid mode");
        result.mode = value; break;
      default: throw new TypeError(`Unknown preference: ${key}`);
    }
  }
  return result;
}

/** Core presentation settings are local to this browser device and page. */
export function createPreferences(page: string): PreferencesApi {
  const key = `tendril:v2:${page}:preferences`;
  const read = (value: string | null): RuntimePreferences => {
    try { return value === null ? { ...defaults } : { ...defaults, ...validate(JSON.parse(value)) }; }
    catch { return { ...defaults }; }
  };
  let current = { ...defaults };
  try { current = read(localStorage.getItem(key)); } catch { /* This visit still has local preferences when storage is unavailable. */ }
  const listeners = new Set<(preferences: RuntimePreferences) => void>();
  const install = (next: RuntimePreferences) => {
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    current = next;
    for (const listener of [...listeners]) {
      try { listener({ ...current }); } catch (error) { setTimeout(() => { throw error; }); }
    }
  };
  window.addEventListener("storage", event => {
    if (event.key === key) install(read(event.newValue));
  });
  return {
    get: () => ({ ...current }),
    update(patch) {
      const next = { ...current, ...validate(patch) };
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Preferences remain effective for this visit. */ }
      install(next);
    },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
