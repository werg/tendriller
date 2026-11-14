/* Agent-editable UI blocks. Example:
 * tendrilSnippets.ui.mount('#app', {path:'interface'});
 * The agent writes state.interface = { title:'Check in', blocks:[
 *   {id:'mood',type:'choice',label:'How are you?',options:['Good','Tired']},
 *   {id:'note',type:'text',label:'Anything else?'} ] }.
 * Interactions send {type:'ui', block, value} as page data. No HTML is injected.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const types = ["message", "status", "choice", "text", "slider", "button", "photo", "location", "file", "drawing", "hardware"];
  const hardware = new Set(["screen", "clipboard", "contacts", "directory", "gamepad", "midi", "hid", "usb", "serial", "bluetooth", "nfc", "xr", "ambient_light", "magnetometer", "proximity", "accelerometer", "gyroscope"]);
  const element = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = String(text); return e; };
  function mount(target, { path = "interface" } = {}) {
    const host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) throw new Error("UI target not found");
    let inputKits = [];
    let signature = "";
    let feedback;
    const emit = async (block, value) => {
      if (feedback) feedback.textContent = "Sending…";
      try {
        const result = await tendril.send({ type: "ui", block, value, at: Date.now() });
        if (feedback) feedback.textContent = result?.queued ? "Saved for the agent to receive later." : "Sent to the agent.";
      } catch (error) { if (feedback) feedback.textContent = error?.message || "Could not send. Please try again."; }
    };
    const render = () => {
      const spec = tendril.state.get(path) || {};
      const sig = JSON.stringify(spec);
      if (sig === signature) return;
      signature = sig;
      for (const kit of inputKits) kit.stop(); inputKits = [];
      const root = element("section");
      root.style.cssText = "display:grid;gap:1rem;max-width:42rem;font:inherit";
      if (spec.title) root.append(element("h1", spec.title));
      if (spec.description) root.append(element("p", spec.description));
      for (const block of Array.isArray(spec.blocks) ? spec.blocks.slice(0, 40) : []) {
        if (!block || !types.includes(block.type) || typeof block.id !== "string") continue;
        const wrap = element("div");
        wrap.style.cssText = "display:grid;gap:.35rem";
        const label = String(block.label || block.id).slice(0, 200);
        if (block.type === "message" || block.type === "status") {
          const p = element("p", block.text || label);
          if (block.type === "status") p.setAttribute("role", "status");
          wrap.append(p);
        } else if (block.type === "drawing") {
          const canvas = element("canvas"); canvas.width = 640; canvas.height = 320;
          canvas.style.cssText = "width:100%;max-width:40rem;border:1px solid currentColor;touch-action:none";
          canvas.setAttribute("aria-label", label);
          const ctx = canvas.getContext("2d"); ctx.lineWidth = 3; ctx.lineCap = "round";
          let down = false;
          const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX-r.left)*canvas.width/r.width,(e.clientY-r.top)*canvas.height/r.height]; };
          canvas.onpointerdown = (e) => { down = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); };
          canvas.onpointermove = (e) => { if (down) { ctx.lineTo(...pos(e)); ctx.stroke(); } };
          canvas.onpointerup = () => { down = false; };
          const send = element("button", "Send drawing"); send.type = "button";
          send.onclick = async () => {
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
            const file = await tendril.upload(blob, { name: "drawing.png" });
            await emit(block.id, { blob: file.id, url: file.url, width: canvas.width, height: canvas.height });
          };
          wrap.append(canvas, send);
        } else if (["photo", "location", "file"].includes(block.type)) {
          const slot = element("div"); wrap.append(slot);
          const s = document.createElement("script"); s.src = "_tendril/snippets/input-kit.js";
          s.onload = () => { if (slot.isConnected) inputKits.push(ns.inputs.mount(slot, { modalities: [block.type], block: block.id })); };
          document.head.append(s);
        } else if (block.type === "hardware" && hardware.has(block.connector)) {
          const slot = element("div"); wrap.append(slot);
          const load = (name, key) => new Promise((resolve, reject) => {
            if (ns[key]) return resolve(ns[key]);
            const script = document.createElement("script"); script.src = `_tendril/snippets/${name}.js`;
            script.onload = () => resolve(ns[key]); script.onerror = () => reject(new Error(`Could not load ${name}`));
            document.head.append(script);
          });
          void load("connectors", "connectors").then(() =>
            ["serial", "bluetooth"].includes(block.connector) ? load(block.connector, block.connector) : null)
            .then(() => load("hardware-lab", "hardwareLab"))
            .then((lab) => { if (slot.isConnected) inputKits.push(lab.mount(slot, { only: block.connector })); })
            .catch((error) => { slot.textContent = error.message; });
        } else {
          const id = `tendril-ui-${block.id.replace(/[^a-z0-9_-]/gi, "-")}`;
          const caption = element("label", label); caption.htmlFor = id; wrap.append(caption);
          if (block.type === "choice") {
            const select = element("select"); select.id = id;
            select.append(element("option", "Choose…"));
            for (const option of Array.isArray(block.options) ? block.options.slice(0, 30) : []) {
              const o = element("option", option); o.value = String(option); select.append(o);
            }
            select.onchange = () => { if (select.selectedIndex) void emit(block.id, select.value); };
            wrap.append(select);
          } else if (block.type === "text") {
            const form = element("form"); const input = element("textarea"); input.id = id; input.rows = 3;
            form.style.cssText = "display:grid;gap:.5rem";
            const submit = element("button", "Send"); submit.type = "submit";
            form.append(input, submit);
            form.onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) { void emit(block.id, input.value.trim()); input.value = ""; } };
            wrap.append(form);
          } else if (block.type === "slider") {
            const input = element("input"); input.id = id; input.type = "range";
            input.min = String(Number.isFinite(+block.min) ? +block.min : 0);
            input.max = String(Number.isFinite(+block.max) ? +block.max : 100);
            input.value = String(Number.isFinite(+block.value) ? +block.value : 50);
            const value = element("output", input.value);
            input.oninput = () => { value.textContent = input.value; };
            input.onchange = () => { void emit(block.id, Number(input.value)); };
            wrap.append(input, value);
          } else if (block.type === "button") {
            const button = element("button", label); button.id = id; button.type = "button";
            button.onclick = () => { void emit(block.id, true); };
            wrap.append(button);
          }
        }
        root.append(wrap);
      }
      feedback = element("p"); feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
      root.append(feedback);
      host.replaceChildren(root);
    };
    render();
    const off = tendril.state.on(render);
    return { render, destroy() { off(); for (const kit of inputKits) kit.stop(); host.replaceChildren(); } };
  }
  ns.ui = { supported: () => true, mount, types };
})();
