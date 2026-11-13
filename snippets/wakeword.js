/* Tendriller snippet: wakeword.js — listen continuously for a phrase such as "hey kitchen".
 *
 *   <button id="go">Start hands-free</button>
 *   <script src="_tendril/snippets/wakeword.js"></script>
 *   <script>
 *     document.getElementById("go").onclick = () => {          // mic permission needs a tap
 *       const ww = tendrilSnippets.wakeword.start({
 *         phrases: ["hey kitchen", "okay kitchen"],
 *         onWake: ({ phrase, command }) => {
 *           // command = what was said after the phrase in the same breath ("" if nothing)
 *           if (command) tendril.voice?.handleUtterance?.(command, "voice");
 *           else tendril.voice?.start?.();
 *         },
 *         onError: (msg) => console.warn(msg),
 *       });
 *       // later: ww.stop()
 *     };
 *   </script>
 *
 * Honest note: this is NOT a true offline wake word engine. It runs the browser's
 * SpeechRecognition continuously and matches text, so it works only where that works
 * (Chrome, Edge, Safari; usually needs a network connection, and audio may go to the browser
 * vendor's speech service). Browsers stop recognition after silence or a minute or so;
 * this snippet restarts it automatically with a back-off. It cannot run with the screen off.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = () => !!SR();
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

  function start({ phrases = ["hey tendril"], lang, onWake, onHeard, onError, cooldownMs = 2000 } = {}) {
    if (!supported()) {
      const msg = "Speech recognition is not available in this browser, so wake words cannot work here.";
      if (onError) onError(msg);
      return { stop() {}, running: false, error: msg };
    }
    const wanted = phrases.map(norm);
    let stopped = false, rec = null, failures = 0, lastWake = 0, restartTimer = null;
    const handled = new Set(); // result indexes already used for a wake in this session

    function match(text) {
      const t = " " + norm(text) + " ";
      for (const p of wanted) {
        const i = t.indexOf(" " + p + " ");
        if (i >= 0) return { phrase: p, command: t.slice(i + p.length + 2).trim() };
      }
      return null;
    }

    function begin() {
      if (stopped) return;
      rec = new (SR())();
      rec.lang = lang || navigator.language || "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      handled.clear();
      rec.onresult = (e) => {
        failures = 0;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i], text = r[0].transcript;
          if (onHeard) onHeard(text, r.isFinal);
          if (handled.has(i)) continue;
          const m = match(text);
          // Wait for the final result so the command after the phrase is complete.
          if (m && r.isFinal && Date.now() - lastWake > cooldownMs) {
            handled.add(i);
            lastWake = Date.now();
            if (onWake) onWake({ ...m, transcript: text });
          }
        }
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          stopped = true;
          if (onError) onError("Microphone or speech permission was denied; wake word stopped.");
        } else if (e.error !== "no-speech" && e.error !== "aborted") {
          failures++;
          if (onError) onError("Speech recognition error: " + e.error);
        }
      };
      rec.onend = () => {
        if (stopped) return;
        // Restart quickly after normal ends; back off when it keeps failing (e.g. offline).
        const delay = Math.min(30000, failures ? 1000 * 2 ** Math.min(failures, 5) : 250);
        restartTimer = setTimeout(begin, delay);
      };
      try {
        rec.start();
      } catch (e) {
        failures++;
        restartTimer = setTimeout(begin, 1000);
      }
    }

    // Recognition is suspended in background tabs; restart when we come back.
    const onVis = () => {
      if (document.visibilityState === "visible" && !stopped) {
        clearTimeout(restartTimer);
        try { rec && rec.abort(); } catch {}
      }
    };
    document.addEventListener("visibilitychange", onVis);
    begin();
    return {
      get running() { return !stopped; },
      stop() {
        stopped = true;
        clearTimeout(restartTimer);
        document.removeEventListener("visibilitychange", onVis);
        try { rec && rec.abort(); } catch {}
      },
    };
  }

  ns.wakeword = { supported, start };
})();
