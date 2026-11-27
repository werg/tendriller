import type { RuntimeApi } from "../../../contract/index.mjs";
import { createVoice, type VoiceConsentMode } from "./index";
import { SPEECH_DOWNLOAD_BYTES, SPEECH_LANGUAGES, SPEECH_MODEL_BYTES } from "./resources";
import { MAX_WAKE_SESSION_MS } from "./microphone";
import { utilityBottom, utilityMaxWidth, utilityRight, utilityTop } from "../utility-layout";

/** Optional, shared presentation for local voice input and spoken output. */
export interface VoiceControlsOptions {
  container?: HTMLElement;
  transcript?(text: string): void | Promise<void>;
  language?: string;
  phrase?: string;
  /**
   * "auto": immediate 1-tap recording (browser permission is consent).
   * "session": confirm once per session per purpose (default; zero per-utterance popups).
   * "prompt": confirm every time before starting.
   */
  consentMode?: VoiceConsentMode;
  /** When true and `transcript` is provided, sends recognized speech directly instead of holding in draft. */
  autoSend?: boolean;
  /** Expose spoken reply controls (browser/neural TTS + Stop speaking). Defaults to true. */
  output?: boolean;
  /** Automatically enable spoken replies ("browser" | "neural" | true). */
  autoOutput?: boolean | "browser" | "neural";
}

const LANGUAGE_NAMES: Record<string, [string, string]> = {
  en: ["en-US", "English"],
  de: ["de-DE", "Deutsch"],
  fr: ["fr-FR", "Français"],
  es: ["es-ES", "Español"],
  it: ["it-IT", "Italiano"],
  nl: ["nl-NL", "Nederlands"],
  pl: ["pl-PL", "Polski"],
};
const LANGUAGES = SPEECH_LANGUAGES.map(code => LANGUAGE_NAMES[code] ?? [code, code.toUpperCase()]) as ReadonlyArray<readonly [string, string]>;
const terminal = (state: string) => ["off", "idle", "paused", "error"].includes(state);

/**
 * Mount only when an authored page deliberately selects voice input. The default
 * dock sits above the runtime's Page options; a container places it inline.
 * Ambient recognition results never enter the DOM. Only a detected command or a
 * deliberate recording becomes an editable draft, and Use text is a local click.
 */
export function mountVoiceControls(runtime: RuntimeApi, options: VoiceControlsOptions = {}) {
  if (options.transcript !== undefined && typeof options.transcript !== "function") throw new TypeError("The transcript callback must be a function");
  const host = document.createElement("tendril-voice-controls");
  host.style.cssText = options.container
    ? "display:block;max-width:100%;"
    : `position:fixed;right:${utilityRight};bottom:calc(${utilityBottom} + var(--tendril-utility-height,54px) + 10px);z-index:2147483646;display:flex;flex-direction:column;align-items:flex-end;max-width:${utilityMaxWidth};max-height:calc(100vh - ${utilityTop} - ${utilityBottom} - var(--tendril-utility-height,54px) - 10px);max-height:calc(100dvh - ${utilityTop} - ${utilityBottom} - var(--tendril-utility-height,54px) - 10px);`;
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host{all:initial;font:14px/1.5 system-ui,sans-serif;color:CanvasText;color-scheme:light dark}
    *{box-sizing:border-box}[hidden]{display:none!important}
    button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer;touch-action:manipulation;min-height:44px;padding:10px 12px;border:1px solid #8886;border-radius:9px;background:Canvas}
    button:hover{background:color-mix(in srgb,Canvas 88%,CanvasText)}button:disabled{opacity:.6;cursor:default}
    button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid Highlight;outline-offset:2px}
    .dock,.panel{background:Canvas;color:CanvasText;border:1px solid #8886;box-shadow:0 4px 24px #0002}
    .dock{display:flex;flex-shrink:0;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;padding:5px;border-radius:14px;width:fit-content;max-width:100%;margin-left:auto}
    .indicator{display:flex;align-items:center;gap:7px;font-size:12px;padding:0 7px;overflow-wrap:anywhere}
    .dot{display:inline-block;width:9px;height:9px;border:1px solid currentColor;border-radius:50%;background:transparent;flex:none}
    .indicator[data-active=true] .dot{background:#b72222;border-color:#b72222}.indicator[data-active=true]{font-weight:700}
    .stop{background:#a32020;color:white;border-color:#a32020}.stop:hover{background:#861919}
    .panel{flex-shrink:1;min-height:0;width:min(390px,calc(100vw - 24px));max-width:100%;max-height:calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom));overflow:auto;overscroll-behavior:contain;border-radius:16px;padding:18px;margin:0 0 9px auto}
    .heading,.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.heading{justify-content:space-between;align-items:flex-start}
    h2{font-size:18px;line-height:1.3;margin:3px 0 12px}h3{font-size:15px;margin:0 0 8px}h2:focus,h3:focus{outline:none}
    .close{font-size:22px;line-height:1;min-width:44px;padding:8px;margin:-8px -8px 0 0;border:0}
    p{margin:0 0 12px}.note{font-size:12px}.section{border-top:1px solid #8885;padding-top:14px;margin-top:14px}
    label{display:block;font-weight:600;margin-bottom:5px}input,select,textarea{display:block;width:100%;min-width:0;min-height:44px;border:1px solid #8889;border-radius:8px;padding:9px;background:Canvas;margin:0 0 11px}
    textarea{resize:vertical;min-height:92px}input:disabled,select:disabled{opacity:.7}
    .primary{background:#1e644a;color:white;border-color:#1e644a;font-weight:650}.primary:hover{background:#174d39}
    .actions button{flex:1}.error{border-left:3px solid #b72222;padding-left:10px}.consent{border:2px solid Highlight;border-radius:10px;padding:12px;margin-top:14px}
    .privacy{font-size:12px;overflow-wrap:anywhere}.progress{font-size:12px;overflow-wrap:anywhere;margin:10px 0 0}
    @media(prefers-color-scheme:dark){.primary{background:#a6dfbd;color:#123b2b;border-color:#a6dfbd}.primary:hover{background:#bcebcf}.indicator[data-active=true] .dot{background:#ff8585;border-color:#ff8585}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
    @media(max-height:480px){.dock{gap:3px}}
  `;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text: string, className?: string) => {
    const node = element("button", text, className); node.type = "button"; return node;
  };
  const panel = element("section", undefined, "panel"); panel.id = "voice-panel"; panel.hidden = !options.container;
  panel.setAttribute("aria-label", "Voice input");
  const heading = element("h2", "Voice input"); heading.tabIndex = -1;
  const close = button("×", "close"); close.setAttribute("aria-label", "Close voice input");
  const headingRow = element("div", undefined, "heading"); headingRow.append(heading, close);
  const introduction = element("p", options.transcript
    ? "Use the microphone on this device, or type below. Review the text before sharing it with this page."
    : "Use the microphone on this device, or type below. Review and copy the text when it is ready.", "note");
  const error = element("p", undefined, "error"); error.hidden = true; error.setAttribute("role", "alert");
  panel.append(headingRow, introduction, error);

  const wakeSection = element("section", undefined, "section"); wakeSection.setAttribute("aria-labelledby", "wake-heading");
  const wakeHeading = element("h3", "Wake word"); wakeHeading.id = "wake-heading";
  const phraseLabel = element("label", "Wake phrase"); phraseLabel.htmlFor = "wake-phrase";
  const phrase = element("input"); phrase.id = "wake-phrase"; phrase.type = "text"; phrase.maxLength = 64;
  phrase.autocomplete = "off"; phrase.spellcheck = false; phrase.value = options.phrase || "Listen computer";
  const languageLabel = element("label", "Speech language"); languageLabel.htmlFor = "voice-language";
  const language = element("select"); language.id = "voice-language";
  for (const [value, label] of LANGUAGES) {
    const option = element("option", label); option.value = value; language.append(option);
  }
  const chooseLanguage = (preferred: string) => {
    const selectedLanguage = LANGUAGES.find(([tag]) => tag.toLowerCase() === preferred.toLowerCase())?.[0] || preferred;
    for (const item of [...language.querySelectorAll("[data-device-language]")]) item.remove();
    if (!LANGUAGES.some(([tag]) => tag === selectedLanguage)) {
      const supported = LANGUAGES.find(([tag]) => tag.slice(0, 2) === preferred.slice(0, 2).toLowerCase());
      const option = element("option", supported ? `${supported[1]} (${selectedLanguage})` : `${selectedLanguage} (device language; model support required)`);
      option.value = selectedLanguage; option.dataset.deviceLanguage = "true"; language.append(option);
    }
    language.value = selectedLanguage;
  };
  chooseLanguage(options.language || navigator.language || "en-US");
  const wakeExplanation = element("p", "Optional foreground listening: say your phrase, then a short command. Ambient audio stays on this device. Nothing starts when you open or reload this page.", "note");
  const reviewWake = button("Set up wake word", "primary");
  wakeSection.append(wakeHeading, wakeExplanation, phraseLabel, phrase, languageLabel, language, reviewWake);
  const captureSection = element("section", undefined, "section"); captureSection.setAttribute("aria-labelledby", "capture-heading");
  const captureHeading = element("h3", "Tap to talk"); captureHeading.id = "capture-heading";
  const reviewCapture = button("Record a message");
  const autoSendWrap = element("label", undefined, "note");
  autoSendWrap.style.cssText = "display:flex;align-items:center;gap:6px;margin:0 0 10px;font-weight:500;";
  const autoSendBox = element("input"); autoSendBox.type = "checkbox";
  autoSendBox.style.cssText = "width:auto;min-height:auto;margin:0;";
  autoSendBox.checked = Boolean(options.autoSend && options.transcript);
  autoSendWrap.append(autoSendBox, document.createTextNode("Send recognized speech immediately"));
  autoSendWrap.hidden = !options.transcript;
  captureSection.append(captureHeading, element("p", "Record a message, then finish to transcribe it locally. Recording stops after 30 seconds.", "note"), autoSendWrap, reviewCapture);

  const outputSection = element("section", undefined, "section"); outputSection.setAttribute("aria-labelledby", "output-heading");
  outputSection.hidden = options.output === false;
  const outputHeading = element("h3", "Spoken replies"); outputHeading.id = "output-heading";
  const outputActions = element("div", undefined, "actions");
  const toggleOutput = button("Enable voice output");
  const outputEngineSelect = element("select"); outputEngineSelect.setAttribute("aria-label", "Voice output engine");
  outputEngineSelect.style.marginBottom = "8px";
  const optBrowser = element("option", "Browser voice (instant)"); optBrowser.value = "browser";
  const optNeural = element("option", "Neural voice (~65 MB cached)"); optNeural.value = "neural";
  outputEngineSelect.append(optBrowser, optNeural);
  if (options.autoOutput === "neural") outputEngineSelect.value = "neural";
  const stopSpeakingBtn = button("Stop speaking", "stop"); stopSpeakingBtn.hidden = true;
  outputActions.append(toggleOutput, stopSpeakingBtn);
  const outputMessage = element("p", "Spoken replies are muted.", "note");
  outputSection.append(outputHeading, outputEngineSelect, outputActions, outputMessage);

  panel.append(wakeSection, captureSection, outputSection);

  const consent = element("section", undefined, "consent"); consent.hidden = true;
  consent.setAttribute("aria-labelledby", "voice-consent-heading");
  const consentHeading = element("h3"); consentHeading.id = "voice-consent-heading"; consentHeading.tabIndex = -1;
  const selected = element("p");
  const privacy = element("p", `The pinned Whistle model is ${(SPEECH_MODEL_BYTES / 1_000_000).toFixed(1)} MB. The first download, including its engine, is ${(SPEECH_DOWNLOAD_BYTES / 1_000_000).toFixed(1)} MB (${SPEECH_DOWNLOAD_BYTES.toLocaleString("en-US")} bytes). Assets are verified before use. Audio is processed here, never uploaded.`, "privacy");
  const limits = element("p", "Microphone access begins only after you press Start microphone and the assets are ready. Your browser may ask for permission. Stop is always available. Hiding or leaving the page stops listening; returning never restarts it.", "privacy");
  const consentPurpose = element("p", undefined, "privacy");
  const consentActions = element("div", undefined, "actions");
  const accept = button("Start microphone", "primary"), decline = button("Cancel");
  consentActions.append(accept, decline); consent.append(consentHeading, selected, privacy, limits, consentPurpose, consentActions);
  panel.append(consent);

  const draftSection = element("section", undefined, "section");
  const draftLabel = element("label", "Text to review or type"); draftLabel.htmlFor = "voice-draft";
  const draft = element("textarea"); draft.id = "voice-draft"; draft.rows = 3; draft.maxLength = 8000;
  const deliveryLabel = options.transcript ? "Use text" : "Copy text";
  draft.placeholder = `Your text stays here until you choose ${deliveryLabel}.`;
  const useText = button(deliveryLabel, "primary"); useText.disabled = true;
  const draftMessage = element("p", undefined, "note"); draftMessage.setAttribute("role", "status");
  draftSection.append(draftLabel, draft, useText, draftMessage);
  const closedPage = element("p", "Wake word needs this visible, running page and microphone permission. It cannot listen when all tabs are closed. Background Web Push notifications use no microphone and are a separate feature.", "note section");
  const progress = element("p", undefined, "progress"); progress.hidden = true; progress.setAttribute("aria-live", "off");
  panel.append(draftSection, closedPage, progress);

  const dock = element("div", undefined, "dock"); dock.setAttribute("role", "group"); dock.setAttribute("aria-label", "Voice input controls");
  const indicator = element("span", undefined, "indicator"); indicator.setAttribute("role", "status"); indicator.setAttribute("aria-live", "polite"); indicator.setAttribute("aria-atomic", "true");
  const dot = element("span", undefined, "dot"); dot.setAttribute("aria-hidden", "true");
  const indicatorText = element("span", "Microphone off"); indicator.append(dot, indicatorText);
  const dockStopSpeak = button("Stop speaking", "stop"); dockStopSpeak.hidden = true;
  const stop = button("Stop microphone", "stop"); stop.hidden = true;
  const expand = button("Voice"); expand.setAttribute("aria-expanded", String(!panel.hidden)); expand.setAttribute("aria-controls", "voice-panel");
  dock.append(indicator, dockStopSpeak, stop, expand); root.append(style, panel, dock);

  const consentMode: VoiceConsentMode = options.consentMode ?? "session";
  const grantedPurposes = new Set<string>();
  let disposed = false, pendingStart = false, sharing = false, draftRevision = 0, speaking = false;
  let wake = { state: "off", message: "" }, capture = { state: "idle", message: "" };
  let voice: ReturnType<typeof createVoice> | null = null;
  let review: { kind: "wake" | "capture"; phrase: string; language: string } | null = null;
  let oneShotConsent: "wake" | "transcription" | "output" | null = null;
  let reviewButton: HTMLButtonElement = reviewWake;
  let startGeneration = 0;
  const trusted = (event: Event) => !disposed && event.isTrusted;
  const sayError = (message: string) => { error.textContent = message; error.hidden = !message; };
  const openPanel = (focus = true) => {
    panel.hidden = false; expand.setAttribute("aria-expanded", "true"); if (focus) heading.focus();
  };
  const closePanel = () => {
    panel.hidden = true; expand.setAttribute("aria-expanded", "false"); expand.focus();
  };
  const render = () => {
    if (disposed) return;
    const microphone = voice?.microphoneActive ?? false;
    const activeWake = !terminal(wake.state), activeCapture = !terminal(capture.state);
    const busy = pendingStart || activeWake || activeCapture || microphone;
    let label = "Microphone off";
    if (microphone) label = capture.state === "recording" ? "Microphone on · Recording"
      : wake.state === "detected" ? "Microphone on · Wake phrase detected"
      : wake.state === "command" ? "Microphone on · Speak your command"
      : wake.state === "transcribing" ? "Microphone on · Processing locally"
      : terminal(wake.state) && terminal(capture.state) ? "Microphone on · Stopping"
      : "Microphone on · Listening";
    else if (pendingStart || ["starting", "loading"].includes(wake.state)) label = "Microphone off · Preparing";
    else if (capture.state === "working" || capture.state === "transcribing" || wake.state === "transcribing") label = "Microphone off · Transcribing";
    else if (wake.state === "paused") label = "Microphone off · Paused";
    else if (wake.state === "error" || capture.state === "error") label = "Microphone off · Needs attention";
    if (indicatorText.textContent !== label) indicatorText.textContent = label;
    indicator.dataset.active = String(microphone);
    stop.hidden = !busy;
    stop.textContent = microphone ? "Stop microphone" : pendingStart ? "Cancel preparation" : "Cancel voice input";
    phrase.disabled = busy || !!review; language.disabled = busy || !!review;
    reviewWake.disabled = busy || !!review;
    reviewCapture.textContent = capture.state === "recording" ? "Finish recording" : "Record a message";
    reviewCapture.disabled = !!review || (busy && capture.state !== "recording");
    useText.disabled = sharing || !draft.value.trim();
    const muted = voice?.muted ?? true;
    toggleOutput.textContent = muted ? "Enable voice output" : "Mute voice output";
    stopSpeakingBtn.hidden = dockStopSpeak.hidden = !speaking;
    outputMessage.textContent = speaking ? "Speaking reply…" : muted ? "Spoken replies are muted." : (voice?.outputStatus.message || "Spoken replies enabled.");
    const message = activeWake ? wake.message : activeCapture || capture.state === "error" ? capture.message : wake.message || capture.message;
    progress.textContent = message; progress.hidden = !message;
  };
  voice = createVoice(runtime, {
    consentMode,
    autoOutput: options.autoOutput,
    consent(request) {
      if (disposed) return false;
      if (consentMode === "auto") return true;
      if (consentMode === "session" && grantedPurposes.has(request.purpose)) return true;
      if (oneShotConsent !== request.purpose) return false;
      oneShotConsent = null;
      if (consentMode === "session") grantedPurposes.add(request.purpose);
      return true;
    },
    transcript(text) {
      if (disposed || !text.trim()) return;
      if (options.transcript && autoSendBox.checked) {
        void Promise.resolve().then(() => options.transcript?.(text.trim())).catch(cause => {
          if (!disposed) sayError(cause instanceof Error ? cause.message : "The page could not receive the text.");
        });
        return;
      }
      const combined = [draft.value.trim(), text.trim()].filter(Boolean).join("\n");
      if (combined.length > draft.maxLength) {
        sayError("Your draft is full. Copy or use the current text, then clear it before recording more.");
        openPanel(false); return;
      }
      draft.value = combined;
      ++draftRevision;
      draftMessage.textContent = `Text is ready to review. Edit it, then choose ${deliveryLabel}.`;
      openPanel(false); render();
    },
    level(level) {
      if (!disposed) dot.style.boxShadow = level > 0.05 ? `0 0 0 ${Math.round(level * 6)}px color-mix(in srgb,#b72222 35%,transparent)` : "";
    },
    status(status) {
      if (disposed) return;
      if (status.kind === "wake") wake = { state: status.state, message: status.message || "" };
      if (status.kind === "capture") capture = { state: status.state, message: status.message || "" };
      if (status.kind === "output") speaking = Boolean(status.speaking);
      if (status.state === "error" && status.kind !== "output") sayError(status.message || "Voice input could not start. You can type instead.");
      render();
    },
  });
  const selectedVoice = voice;
  const revokeAdapterConsent = selectedVoice.revokeConsent;
  selectedVoice.revokeConsent = () => { grantedPurposes.clear(); revokeAdapterConsent(); };
  const offSensorsStopped = runtime.on?.("sensors_stopped", () => {
    selectedVoice.revokeConsent();
    ++startGeneration; pendingStart = false; cancelReview(false);
  }) ?? (() => {});
  if (options.phrase === undefined) phrase.value = selectedVoice.settings.wakePhrase;
  if (options.language === undefined) chooseLanguage(selectedVoice.settings.language);
  const cancelReview = (focus = true) => {
    review = null; oneShotConsent = null; consent.hidden = true; render(); if (focus) reviewButton.focus();
  };
  const stopInput = () => {
    ++startGeneration; oneShotConsent = null; pendingStart = false; selectedVoice.stop();
    wake = { state: "off", message: "" }; capture = { state: "idle", message: "" }; render();
  };
  const startChosen = async (chosen: { kind: "wake" | "capture"; phrase: string; language: string }) => {
    const generation = ++startGeneration;
    pendingStart = true;
    try {
      selectedVoice.language(chosen.language);
      oneShotConsent = chosen.kind === "wake" ? "wake" : "transcription";
      // Invoke synchronously in this trusted click. The adapter can unlock its
      // silent AudioContext before awaiting verified model download or permission.
      const starting = chosen.kind === "wake"
        ? selectedVoice.startWake({ phrase: chosen.phrase, mode: "model" })
        : selectedVoice.startCapture();
      oneShotConsent = null;
      render();
      if (!stop.hidden) stop.focus();
      await starting;
    } catch (cause) {
      if (!disposed && generation === startGeneration) sayError(cause instanceof Error ? cause.message : "Voice input could not start. You can type instead.");
    } finally {
      oneShotConsent = null;
      if (!disposed && generation === startGeneration) { pendingStart = false; render(); }
    }
  };
  const beginReview = (kind: "wake" | "capture", event: Event) => {
    if (!trusted(event)) return;
    const value = phrase.value.trim().replace(/\s+/g, " ");
    if (kind === "wake" && (value.length < 3 || value.length > 64 || !/^[\p{L}\p{N}]+(?:[ '-][\p{L}\p{N}]+)*$/u.test(value) || value.split(" ").length < 2)) {
      sayError("Choose a wake phrase with at least two words, using 3–64 letters, numbers, spaces, apostrophes or hyphens."); phrase.focus(); return;
    }
    stopInput(); sayError("");
    const purpose = kind === "wake" ? "wake" : "transcription";
    // Automatic consent OR already granted in this session: start immediately without nagging again.
    if (consentMode === "auto" || (consentMode === "session" && grantedPurposes.has(purpose))) {
      void startChosen({ kind, phrase: value, language: language.value });
      return;
    }
    reviewButton = kind === "wake" ? reviewWake : reviewCapture;
    review = { kind, phrase: value, language: language.value };
    consentHeading.textContent = kind === "wake" ? "Enable on-device wake word?" : "Enable on-device recording?";
    selected.textContent = kind === "wake" ? `Wake phrase: “${value}”. Language: ${language.selectedOptions[0]?.textContent || language.value}.`
      : `One recorded message. Language: ${language.selectedOptions[0]?.textContent || language.value}.`;
    consentPurpose.textContent = kind === "wake"
      ? `This uses local speech recognition, not a low-power always-on detector. Listening stops after ${MAX_WAKE_SESSION_MS / 60_000} minutes and may stop sooner on battery or performance limits.`
      : "Recording is limited to 30 seconds on this device. Approval is remembered for this session until you stop sensors or leave the page.";
    consent.hidden = false; openPanel(false); render(); consentHeading.focus();
  };
  reviewWake.addEventListener("click", event => beginReview("wake", event));
  reviewCapture.addEventListener("click", event => {
    if (!trusted(event)) return;
    if (capture.state === "recording") { selectedVoice.finishCapture(); render(); }
    else beginReview("capture", event);
  });
  accept.addEventListener("click", async event => {
    if (!trusted(event) || !review || pendingStart) return;
    const chosen = review;
    cancelReview(false); sayError("");
    await startChosen(chosen);
  });
  toggleOutput.addEventListener("click", async event => {
    if (!trusted(event)) return;
    if (!selectedVoice.muted) {
      selectedVoice.mute();
      speaking = false;
      render();
      return;
    }
    oneShotConsent = "output";
    const engine = outputEngineSelect.value === "neural" ? "neural" : "browser";
    try { await selectedVoice.enableOutput(engine); }
    catch (cause) { if (!disposed) sayError(cause instanceof Error ? cause.message : "Voice output could not start."); }
    finally { oneShotConsent = null; render(); }
  });
  const stopSpeaking = (event: Event) => {
    if (!trusted(event)) return;
    selectedVoice.stop();
    speaking = false;
    render();
  };
  stopSpeakingBtn.addEventListener("click", stopSpeaking);
  dockStopSpeak.addEventListener("click", stopSpeaking);
  decline.addEventListener("click", event => { if (trusted(event)) cancelReview(); });
  expand.addEventListener("click", event => {
    if (!trusted(event)) return;
    if (panel.hidden) openPanel(); else { cancelReview(false); closePanel(); }
  });
  close.addEventListener("click", event => { if (trusted(event)) { cancelReview(false); closePanel(); } });
  stop.addEventListener("click", event => { if (trusted(event)) { selectedVoice.revokeConsent(); stopInput(); cancelReview(false); expand.focus(); } });
  root.addEventListener("keydown", event => {
    if (!(event instanceof KeyboardEvent) || !trusted(event) || event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    if (review) cancelReview();
    else { stopInput(); closePanel(); }
  });
  draft.addEventListener("input", () => { ++draftRevision; draftMessage.textContent = ""; render(); });
  useText.addEventListener("click", async event => {
    if (!trusted(event) || sharing || !draft.value.trim()) return;
    const text = draft.value.trim(), revision = draftRevision;
    sharing = true; sayError(""); render();
    try {
      if (options.transcript) await options.transcript(text);
      else {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Select the text above and copy it with your device's controls.");
        await navigator.clipboard.writeText(text);
      }
      if (disposed) return;
      if (options.transcript && revision === draftRevision) { draft.value = ""; ++draftRevision; }
      draftMessage.textContent = options.transcript ? "Text shared with this page." : "Text copied. Paste it where you want to use it.";
    } catch (cause) {
      if (!disposed) sayError(cause instanceof Error ? cause.message : "The page could not receive the text. Your draft is still here.");
    } finally { sharing = false; render(); }
  });
  phrase.addEventListener("input", () => sayError(""));
  const abandonReview = () => {
    if (document.visibilityState !== "visible") { ++startGeneration; pendingStart = false; cancelReview(false); render(); }
  };
  document.addEventListener("visibilitychange", abandonReview);
  (options.container || document.body).append(host);
  render();
  return {
    voice: selectedVoice,
    element: host,
    speak(text: string) { selectedVoice.speak(text); },
    mute() { selectedVoice.mute(); speaking = false; render(); },
    dispose() {
      if (disposed) return;
      disposed = true; ++startGeneration; oneShotConsent = null; review = null; grantedPurposes.clear();
      offSensorsStopped();
      document.removeEventListener("visibilitychange", abandonReview);
      selectedVoice.dispose(); host.remove();
    },
  };
}
