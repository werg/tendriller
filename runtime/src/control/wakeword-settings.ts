// Hands-free setup lives outside the universal control's rendering and transport logic.
import type { PreferencesApi } from "../../../contract/index.mjs";
import { h, clear } from "./dom";
import { WakeWordCapture, type WakeMode } from "./wakeword";

interface Options {
  preferences: PreferencesApi;
  language(): string;
  onTest(): void;
}

/** Mount into the control's Settings tab. Returns its live status element. */
export function mountWakeSettings(panel: HTMLElement, { preferences, language, onTest }: Options): HTMLElement {
  const prefs = preferences.get();
  const phrase = h("input", {
    id: "tendril-wake-phrase-input", type: "text", maxlength: "64",
    value: prefs.wakePhrase, autocomplete: "off", spellcheck: false,
  }) as HTMLInputElement;
  const mode = h("select", { id: "tendril-wake-mode" },
    h("option", { value: "local", text: "On-device only (recommended)" }),
    h("option", { value: "browser", text: "Browser recognition (may use cloud)" }),
  ) as HTMLSelectElement;
  mode.value = prefs.wakeMode;

  const note = h("p", { class: "muted" });
  function describeMode() {
    note.textContent = mode.value === "local"
      ? "Requires a browser with on-device SpeechRecognition and an installed language pack. Audio is processed on this device; no cloud fallback."
      : "The browser may send microphone audio to its speech provider and require internet. Choose this mode only if you accept that processing.";
  }
  mode.addEventListener("change", describeMode);
  describeMode();

  const status = h("p", { class: "muted", role: "status", "aria-live": "polite" });
  function save(): boolean {
    try {
      preferences.update({ wakePhrase: phrase.value, wakeMode: mode.value as WakeMode });
      phrase.value = preferences.get().wakePhrase;
      status.textContent = "Saved on this device. Tap Start to listen.";
      return true;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Invalid wake phrase.";
      return false;
    }
  }

  const setup = h("button", { type: "button", class: "btn", onclick: async () => {
    if (mode.value !== "local") {
      status.textContent = "Choose On-device only to install a language pack.";
      return;
    }
    setup.disabled = true;
    const lang = language();
    status.textContent = "Checking on-device support for " + lang + "…";
    try {
      const availability = await WakeWordCapture.localAvailability(lang);
      switch (availability) {
        case "available":
          status.textContent = "On-device speech is ready for " + lang + ". Tap Start.";
          break;
        case "downloadable":
        case "downloading": {
          status.textContent = "Installing the browser's language pack…";
          const installed = await WakeWordCapture.installLocal(lang);
          status.textContent = installed
            ? "Language pack installed. Tap Start hands-free."
            : "Language pack installation failed. Try again or use push-to-talk.";
          break;
        }
        default:
          status.textContent = "On-device recognition is not available for this browser/language. Use push-to-talk or explicitly select Browser recognition.";
      }
    } catch (error) {
      status.textContent = "Could not set up on-device speech: " +
        (error instanceof Error ? error.message : "browser permission or installation error");
    } finally {
      setup.disabled = false;
    }
  } }, "Check / install on-device language");

  const test = h("button", { type: "button", class: "btn", onclick: () => {
    if (save()) onTest();
  } }, "Test wake phrase");
  test.disabled = !WakeWordCapture.supported();

  clear(panel,
    h("p", { text: "Say your phrase and command together, or speak the command up to 8 seconds after the phrase. Commands use the normal conversation delivery and permission rules." }),
    h("div", { class: "field" },
      h("label", { for: "tendril-wake-phrase-input", text: "Wake phrase (2+ words)" }), phrase),
    h("div", { class: "field" },
      h("label", { for: "tendril-wake-mode", text: "Recognition and privacy" }), mode),
    note,
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn", onclick: save }, "Save phrase and mode"),
      setup, test),
    status,
    h("p", { class: "muted", text: "This matches speech transcripts, not raw audio with a low-power wake-word chip. Keep this page visible and unlocked. Listening stops on backgrounding, navigation, sensor-stop, or a permissions error; it never starts automatically." }),
    h("p", { class: "muted", text: "Test confirms the phrase without sending a command. Stop from the microphone indicator or Talk panel at any time. Push-to-talk and typing remain available." }),
  );
  return status;
}
