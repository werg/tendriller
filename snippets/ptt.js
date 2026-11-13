/* Tendriller snippet: ptt.js — a push-to-talk button inside your own page.
 *
 *   <div id="talk"></div>
 *   <script src="_tendril/snippets/ptt.js"></script>
 *   <script>
 *     tendrilSnippets.ptt.mount("#talk", {
 *       label: "Hold to talk",           // visible button text
 *       lang: "en-US",                   // defaults to state _prefs.language or the browser's
 *       onText: (text, final) => {},     // interim and final transcripts (optional)
 *       onResult: (r) => {},             // {text, route:"voice"|"event"|"none"} after routing (optional)
 *       route: true,                     // false = just give me the text, do not route it
 *     });
 *   </script>
 *
 * The always-present tendril control already has push-to-talk; use this only when voice
 * belongs inside your own UI. Hold the button (or tap once to start, tap again to stop;
 * Enter/Space toggle it from the keyboard).
 *
 * Recognition: the browser's SpeechRecognition with interim results. Where that is missing
 * and the server offers transcription (window.__TENDRIL__.features.transcribe), it records with
 * MediaRecorder and POSTs the audio to _tendril/transcribe.
 *
 * Routing of the final text:
 *   1. window.tendril.voice.handleUtterance(text, "voice") if present (the fast voice layer:
 *      exposed page functions such as "tick milk"). If it returns true, done.
 *   2. otherwise tendril.send({type:"utterance", text, via:"ptt"}, {wake:true}).
 * IMPORTANT: (2) reaches the agent as page DATA (an `event`), not as an owner instruction.
 * Pages cannot send instructions by design; only the tendril control and voice layer can.
 * Treat utterance events accordingly in the agent.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  const canTranscribe = () =>
    !!(window.__TENDRIL__ && window.__TENDRIL__.features && window.__TENDRIL__.features.transcribe &&
       window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const supported = () => !!SR() || canTranscribe();

  async function route(text) {
    const t = window.tendril;
    if (!t) return "none";
    const v = t.voice;
    if (v && typeof v.handleUtterance === "function") {
      try {
        if (await v.handleUtterance(text, "voice")) return "voice";
      } catch (e) {
        console.warn("ptt: handleUtterance failed", e);
      }
    }
    await t.send({ type: "utterance", text, via: "ptt" }, { wake: true });
    return "event";
  }

  async function transcribe(blob) {
    const base = (window.__TENDRIL__ && window.__TENDRIL__.base) || "";
    const res = await fetch(base + "_tendril/transcribe", { method: "POST", body: blob, headers: { "Content-Type": blob.type || "audio/webm" } });
    if (!res.ok) throw new Error("Transcription failed (" + res.status + ")");
    return ((await res.json()).text || "").trim();
  }

  function mount(target, { label = "Hold to talk", lang, onText, onResult, route: doRoute = true } = {}) {
    const host = typeof target === "string" ? document.querySelector(target) : target;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tendril-ptt";
    btn.textContent = label;
    btn.setAttribute("aria-pressed", "false");
    btn.style.cssText = "min-width:44px;min-height:44px;padding:.6em 1.2em;font:inherit;border-radius:999px;touch-action:none;user-select:none";
    const status = document.createElement("p");
    status.className = "tendril-ptt-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.style.cssText = "margin:.4em 0;min-height:1.2em";
    host.append(btn, status);

    if (!supported()) {
      btn.disabled = true;
      status.textContent = "Voice input is not available in this browser. Type instead.";
      return { button: btn, start() {}, stop() {}, destroy: () => { btn.remove(); status.remove(); } };
    }

    let active = null; // {stop()}
    let pressedAt = 0;
    const language = () => lang || (window.tendril && window.tendril.state && (window.tendril.state.get(["_prefs", "language"]))) || navigator.language || "en-US";

    const setActive = (on) => {
      // The name stays the same; state is aria-pressed (+ the status line) so screen readers track it.
      btn.setAttribute("aria-pressed", String(on));
      btn.style.outline = on ? "3px solid currentColor" : "";
      btn.style.fontWeight = on ? "700" : "";
    };

    async function finish(text) {
      setActive(false);
      active = null;
      text = (text || "").trim();
      if (!text) { status.textContent = "Didn't catch that."; return; }
      if (onText) onText(text, true);
      let r = "none";
      if (doRoute) {
        status.textContent = "“" + text + "” — sending…";
        try { r = await route(text); } catch (e) { status.textContent = "Could not send: " + e.message; return; }
      }
      status.textContent = "“" + text + "”" + (r === "voice" ? " — done." : r === "event" ? " — sent to the agent." : "");
      if (onResult) onResult({ text, route: r });
    }

    function startSR() {
      const rec = new (SR())();
      rec.lang = language();
      rec.interimResults = true;
      rec.continuous = true;
      let finalText = "", ended = false;
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        status.textContent = (finalText + interim).trim() || "Listening…";
        if (onText && interim) onText((finalText + interim).trim(), false);
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") status.textContent = "Microphone permission was denied.";
        else if (e.error !== "no-speech" && e.error !== "aborted") status.textContent = "Voice error: " + e.error;
      };
      rec.onend = () => { if (!ended) { ended = true; finish(finalText); } };
      rec.start();
      status.textContent = "Listening…";
      return { stop: () => rec.stop() };
    }

    async function startRecorder() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        status.textContent = "Transcribing…";
        try {
          await finish(await transcribe(new Blob(chunks, { type: rec.mimeType || "audio/webm" })));
        } catch (e) {
          setActive(false);
          active = null;
          status.textContent = e.message;
        }
      };
      rec.start();
      status.textContent = "Recording…";
      return { stop: () => rec.state !== "inactive" && rec.stop() };
    }

    async function start() {
      if (active) return;
      setActive(true);
      let stopEarly = false;
      active = { stop() { stopEarly = true; } }; // a release while the mic is still opening
      try {
        active = SR() ? startSR() : await startRecorder();
        if (stopEarly) active.stop();
      } catch (e) {
        setActive(false);
        active = null;
        status.textContent = e.name === "NotAllowedError" ? "Microphone permission was denied." : "Could not start voice input: " + e.message;
      }
    }
    function stop() {
      if (active) active.stop();
    }

    // Hold = talk while pressed. A quick tap toggles instead (tap to start, tap to stop).
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (active) { stop(); pressedAt = 0; return; }
      pressedAt = Date.now();
      start();
    });
    btn.addEventListener("pointerup", () => {
      if (pressedAt && Date.now() - pressedAt > 400) stop();
      pressedAt = 0;
    });
    btn.addEventListener("pointercancel", () => { if (pressedAt) stop(); pressedAt = 0; });
    btn.addEventListener("click", (e) => { if (e.detail === 0) (active ? stop() : start()); }); // keyboard

    return { button: btn, status, start, stop, destroy() { stop(); btn.remove(); status.remove(); } };
  }

  ns.ptt = { supported, mount, route, transcribe };
})();
