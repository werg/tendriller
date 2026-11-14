/* Tendriller input kit. Load after tendril.js, then call
 * tendrilSnippets.inputs.mount('#inputs', { modalities: ['photo','audio','location','motion','file'] }).
 * Every button is user-triggered. Emitted page data has {type:'input', modality, ...}.
 * The agent should treat these events as data, not owner instructions.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const names = { photo: "Take photo", audio: "Record voice note", location: "Share location once", motion: "Measure movement", file: "Choose a file" };
  const valid = Object.keys(names);
  const script = (name) => new Promise((resolve, reject) => {
    if (ns[name]) return resolve(ns[name]);
    const s = document.createElement("script");
    s.src = `_tendril/snippets/${name}.js`;
    s.onload = () => resolve(ns[name]);
    s.onerror = () => reject(new Error(`Could not load ${name}.js`));
    document.head.append(s);
  });
  const emit = (modality, data) => tendril.send({ type: "input", modality, at: Date.now(), ...data });

  function mount(target, { modalities = valid, block } = {}) {
    const host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) throw new Error("Input kit target was not found");
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const view = document.createElement("div");
    view.style.cssText = "max-width:32rem;aspect-ratio:4/3;overflow:hidden";
    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;flex-wrap:wrap;gap:.6rem";
    host.replaceChildren(buttons, view, status);
    const say = (message) => { status.textContent = message; };
    const send = async (modality, data) => {
      say("Sending…");
      const result = await emit(modality, block ? { block, ...data } : data);
      return result?.queued ? "saved for the agent to receive later." : "sent to the agent.";
    };
    let camera, recorder, stream, motion, motionStart, motionCount = 0, discardAudio = false;
    // Load code before the tap; motion permission must be requested in the tap task.
    const cameraKit = modalities.includes("photo") ? script("camera").catch(() => null) : null;
    const motionKit = modalities.includes("motion") ? script("motion").catch(() => null) : null;
    const add = (modality, action, ready) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = names[modality];
      button.style.cssText = "min-height:44px;padding:.55em .85em;font:inherit";
      if (ready) { button.disabled = true; ready.then((kit) => { button.disabled = !kit; if (!kit) say(`${names[modality]} is unavailable.`); }); }
      button.onclick = async () => {
        button.disabled = true;
        try { await action(button); }
        catch (error) { say(error?.message || String(error)); }
        finally { button.disabled = false; }
      };
      buttons.append(button);
    };
    if (modalities.includes("photo")) add("photo", async () => {
      if (!camera) camera = await (await cameraKit).open(view);
      const picture = await camera.capture();
      let delivery;
      try { delivery = await send("photo", { blob: picture.id, url: picture.url, width: picture.width, height: picture.height }); }
      finally { camera.close(); camera = null; }
      say(`Photo ${delivery}`);
    }, cameraKit);
    if (modalities.includes("location")) add("location", async () => {
      if (!navigator.geolocation) throw new Error("Location is unavailable on this device.");
      const p = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 15000 }));
      const delivery = await send("location", { latitude: p.coords.latitude, longitude: p.coords.longitude,
        accuracy_m: p.coords.accuracy });
      say(`Location ${delivery}`);
    });
    if (modalities.includes("file")) add("file", async () => {
      const input = document.createElement("input"); input.type = "file";
      const picked = new Promise((resolve) => { input.onchange = () => resolve(input.files?.[0] || null); input.oncancel = () => resolve(null); });
      input.click();
      const file = await picked;
      if (!file) return;
      const blob = await tendril.upload(file, { name: file.name });
      const delivery = await send("file", { blob: blob.id, url: blob.url, name: file.name, size: file.size, mime: file.type });
      say(`${file.name}: ${delivery}`);
    });
    if (modalities.includes("audio")) add("audio", async (button) => {
      if (recorder && recorder.state === "recording") {
        recorder.stop(); button.textContent = names.audio; return;
      }
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Audio recording is unavailable.");
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      recorder = new MediaRecorder(stream);
      const current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (discardAudio) { discardAudio = false; return; }
        try {
          const file = new Blob(chunks, { type: current.mimeType || "audio/webm" });
          const blob = await tendril.upload(file, { name: "voice-note" });
          const delivery = await send("audio", { blob: blob.id, url: blob.url, size: file.size, mime: file.type });
          say(`Voice note ${delivery}`);
        } catch (e) { say(e?.message || String(e)); }
      };
      recorder.start(); button.textContent = "Stop and send recording"; say("Recording. Tap again to stop.");
    });
    if (modalities.includes("motion")) add("motion", async (button) => {
      if (motion) {
        motion.stop(); motion = null;
        const delivery = await send("motion", { duration_ms: Date.now() - motionStart, steps: motionCount });
        button.textContent = names.motion; say(`Movement summary ${delivery}`); return;
      }
      const kit = await motionKit;
      if (!kit.supported()) throw new Error("Motion sensors are unavailable.");
      const permission = await kit.requestPermission();
      if (permission === "denied") throw new Error("Motion permission was denied.");
      motionStart = Date.now(); motionCount = 0;
      motion = kit.start({ onStep: (n) => { motionCount = n; say(`${n} estimated steps. Tap again to send a summary.`); } });
      button.textContent = "Stop and send movement";
      say("Measuring movement. Tap again to stop.");
    }, motionKit);
    return { stop() { camera?.close(); if (recorder?.state === "recording") { discardAudio = true; recorder.stop(); } motion?.stop(); } };
  }
  ns.inputs = { supported: () => true, mount, modalities: valid };
})();
