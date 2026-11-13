/* Tendriller snippet: vad.js — voice activity detection (is someone speaking right now?).
 *
 *   <button id="go">Start listening</button>
 *   <script src="_tendril/snippets/vad.js"></script>
 *   <script>
 *     document.getElementById("go").onclick = async () => {    // mic permission needs a tap
 *       const vad = await tendrilSnippets.vad.start({
 *         record: true,                         // also give me the audio of each utterance
 *         onStart: () => console.log("speaking"),
 *         onStop: async (blob, ms) => {         // blob is null unless record:true
 *           if (blob && ms > 800) {
 *             const { id } = await tendril.upload(blob, { name: "speech.webm" });
 *             tendril.send({ type: "speech_clip", blob: id, ms }, { wake: false });
 *           }
 *         },
 *         onLevel: (rms, speaking) => {},       // ~30 times a second, for a meter (optional)
 *       });
 *       // later: vad.stop()
 *     };
 *   </script>
 *
 * Method: RMS energy from WebAudio, an adaptive noise floor, and a hangover so short pauses
 * do not end the utterance. Options: threshold (absolute RMS floor, default 0.015),
 * ratio (how far above the noise floor counts as speech, default 3), minSpeechMs (150),
 * hangoverMs (600), stream (use an existing MediaStream instead of opening the mic).
 * It is energy-based: loud non-speech noise also counts. Recording starts at the first loud
 * frame, so the first ~minSpeechMs are included.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const supported = () => !!((window.AudioContext || window.webkitAudioContext) && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  async function start({
    stream, threshold = 0.015, ratio = 3, minSpeechMs = 150, hangoverMs = 600, frameMs = 30,
    record = false, onStart, onStop, onLevel,
  } = {}) {
    const own = !stream;
    if (own) stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);

    let noise = threshold / ratio; // adaptive noise floor
    let speaking = false, loudSince = 0, quietSince = 0, startedAt = 0;
    let rec = null, chunks = [];

    const startRec = () => {
      if (!record || !window.MediaRecorder || rec) return;
      chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.start();
    };
    const stopRec = () => new Promise((resolve) => {
      if (!rec) return resolve(null);
      const r = rec;
      rec = null;
      r.onstop = () => resolve(new Blob(chunks, { type: r.mimeType || "audio/webm" }));
      r.stop();
    });

    const api = { speaking: false, level: 0, stop };

    const timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const rms = Math.sqrt(s / buf.length);
      const now = performance.now();
      const limit = Math.max(threshold, noise * ratio);
      const loud = rms > limit;
      if (!speaking && !loud) noise = noise * 0.95 + rms * 0.05; // learn the room only while quiet
      api.level = rms;

      if (!speaking) {
        if (loud) {
          if (!loudSince) { loudSince = now; startRec(); }
          if (now - loudSince >= minSpeechMs) {
            speaking = api.speaking = true;
            startedAt = loudSince;
            quietSince = 0;
            if (onStart) onStart();
          }
        } else if (loudSince) {
          loudSince = 0;
          stopRec(); // false start: discard
        }
      } else if (loud) {
        quietSince = 0;
      } else {
        if (!quietSince) quietSince = now;
        if (now - quietSince >= hangoverMs) {
          speaking = api.speaking = false;
          loudSince = 0;
          const ms = Math.round(quietSince - startedAt);
          stopRec().then((blob) => onStop && onStop(blob, ms));
        }
      }
      if (onLevel) onLevel(rms, speaking);
    }, frameMs);

    function stop() {
      clearInterval(timer);
      stopRec();
      src.disconnect();
      ctx.close().catch(() => {});
      if (own) stream.getTracks().forEach((t) => t.stop());
    }
    return api;
  }

  ns.vad = { supported, start };
})();
