/* User-triggered hardware explorer. Load connectors.js before this script. */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const connectors = ns.connectors;
  if (!connectors) throw new Error("Load connectors.js before hardware-lab.js");
  const options = [
    ["screen", "Capture selected screen", "captureScreen"],
    ["clipboard", "Read clipboard text", "readClipboard"],
    ["contacts", "Choose contacts", "pickContacts"],
    ["directory", "Choose directory", "pickDirectory"],
    ["gamepad", "Inspect gamepads", "gamepads"],
    ["midi", "Inspect MIDI", "midi"],
    ["hid", "Choose HID device", "hid"],
    ["usb", "Choose USB device", "usb"],
    ["serial", "Choose Serial device", "serial"],
    ["bluetooth", "Choose Bluetooth device", "bluetooth"],
    ["nfc", "Scan NFC tags", "nfc"],
    ["xr", "Start XR session", "xr"],
    ...["ambient_light", "magnetometer", "proximity", "accelerometer", "gyroscope"].map((name) => [name, `Inspect ${name.replaceAll("_", " ")}`, "sensor"]),
  ];
  const text = (tag, content) => { const el = document.createElement(tag); el.textContent = content; return el; };
  function mount(target, { only = null } = {}) {
    const host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) throw new Error("Hardware lab target not found");
    const root = text("section", "");
    const title = text("h2", "Hardware lab");
    const note = text("p", "Choose an input. Live readings stay on this device until you press Send snapshot. NFC sends each scanned tag. Stop ends the connection.");
    const grid = text("div", "");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.65rem";
    const unavailable = document.createElement("details");
    const unavailableTitle = text("summary", "Unavailable inputs");
    const unavailableGrid = text("div", ""); unavailableGrid.style.cssText = grid.style.cssText;
    unavailable.append(unavailableTitle, unavailableGrid);
    root.append(title, note, grid, unavailable);
    host.replaceChildren(root);
    const sessions = new Set();
    let unavailableCount = 0;
    for (const [name, label, method] of options) {
      if (only && name !== only) continue;
      const available = connectors.supported(name);
      const card = text("div", ""); card.dataset.connector = name;
      card.style.cssText = "display:grid;gap:.4rem;border:1px solid currentColor;border-radius:.5rem;padding:.65rem";
      const heading = text("strong", label);
      const status = text("p", available ? "Ready to request access" : "Unavailable in this browser or device");
      status.setAttribute("role", "status"); status.style.margin = "0";
      const start = text("button", label); start.type = "button"; start.disabled = !available;
      if (["serial", "bluetooth"].includes(name) && available && !ns[name]) {
        start.disabled = true; status.textContent = "Loading connector…";
        const script = document.createElement("script"); script.src = `_tendril/snippets/${name}.js`;
        script.onload = () => { start.disabled = false; status.textContent = "Ready to request access"; };
        script.onerror = () => { status.textContent = `Could not load ${name} connector`; };
        document.head.append(script);
      }
      const send = text("button", "Send snapshot"); send.type = "button"; send.hidden = true;
      const stop = text("button", "Stop"); stop.type = "button"; stop.hidden = true;
      const output = text("pre", ""); output.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;max-height:10rem;overflow:auto;margin:0";
      const parameter = name === "bluetooth" ? text("input", "") : null;
      if (parameter) { parameter.setAttribute("aria-label", "Bluetooth service UUID or standard name (optional)"); parameter.setAttribute("placeholder", "e.g. heart_rate"); }
      let session = null;
      const display = (value) => { output.textContent = JSON.stringify(value, null, 2).slice(0, 4000); };
      start.onclick = async () => {
        start.disabled = true; status.textContent = "Requesting access…";
        try {
          const opts = method === "sensor" ? { onReading: display, onError: (e) => { status.textContent = e.error?.message || "Sensor stopped unexpectedly"; } } :
            method === "gamepads" ? { onChange: display } :
            method === "midi" ? { onMessage: display } :
            method === "hid" ? { onReport: display } :
            method === "nfc" ? { onTag: display } :
            method === "xr" ? { onAction: display } : {};
          // The chooser call begins in this click handler; no script load or async probe comes first.
          if (name === "serial") {
            const port = await ns.serial.connect({ onLine: (line) => display({ line }) });
            session = { sendSnapshot: () => connectors.send("serial", { lines: port.lines.slice(-20) }), stop: () => port.close(), descriptor: { kind: "serial", connected: true } };
          } else if (name === "bluetooth") {
            const service = parameter.value.trim();
            const device = await ns.bluetooth.connect({ services: service ? [service] : [] });
            session = { sendSnapshot: () => connectors.send("bluetooth", { name: device.name || null, service: service || null }), stop: () => device.disconnect(), descriptor: { name: device.name || null, service: service || null } };
          } else session = method === "sensor" ? connectors.sensor(name, opts) : await connectors[method](opts);
          if (session?.stop) {
            sessions.add(session); status.textContent = name === "nfc" ? "Scanning. Each tag is sent to the agent; press Stop to finish." : "Connected. Send a snapshot when useful.";
            stop.hidden = false; send.hidden = !session.sendSnapshot;
            if (session.descriptor) display(session.descriptor);
          } else { status.textContent = "Sent to the agent."; display(session); start.disabled = false; }
        } catch (error) { status.textContent = error?.message || String(error); start.disabled = false; }
      };
      send.onclick = async () => { try { const result = await session.sendSnapshot(); status.textContent = result?.queued ? "Saved for the agent to receive later." : "Sent to the agent."; } catch (error) { status.textContent = error?.message || String(error); } };
      stop.onclick = async () => { try { await session?.stop(); } finally { sessions.delete(session); session = null; stop.hidden = true; send.hidden = true; start.disabled = false; status.textContent = "Stopped"; } };
      card.append(heading, status); if (parameter) card.append(parameter);
      card.append(start, send, stop, output);
      if (available) grid.append(card); else { unavailableGrid.append(card); unavailableCount++; }
    }
    unavailableTitle.textContent = `Show ${unavailableCount} unavailable inputs`;
    unavailable.hidden = unavailableCount === 0;
    return { stop() { for (const session of sessions) void session.stop(); sessions.clear(); } };
  }
  ns.hardwareLab = { mount, supported: () => true };
})();
