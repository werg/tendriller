/* Browser input and hardware connectors. Load after tendril.js.
 * Call chooser methods directly from a click handler. The page author controls
 * when readings become events: callbacks can call tendril.send() with arbitrary
 * logic, or a UI can offer sendSnapshot(). NFC sends tags by default.
 * All emitted page data has {type:'input',modality,at,...}. Device-specific packet
 * formats remain the page author's responsibility.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const n = navigator;
  const supported = (name) => ({
    screen: !!n.mediaDevices?.getDisplayMedia,
    clipboard: !!n.clipboard?.readText,
    contacts: !!n.contacts?.select,
    directory: !!window.showDirectoryPicker,
    gamepad: !!n.getGamepads,
    midi: !!n.requestMIDIAccess,
    hid: !!n.hid?.requestDevice,
    usb: !!n.usb?.requestDevice,
    nfc: !!window.NDEFReader,
    xr: !!n.xr?.requestSession,
    ambient_light: !!window.AmbientLightSensor,
    magnetometer: !!window.Magnetometer,
    proximity: !!window.ProximitySensor,
    accelerometer: !!window.Accelerometer,
    gyroscope: !!window.Gyroscope,
    serial: !!n.serial?.requestPort,
    bluetooth: !!n.bluetooth?.requestDevice,
  })[name] || false;
  const requireApi = (name) => { if (!supported(name)) throw new Error(`${name.replaceAll('_',' ')} is unavailable on this browser or device.`); };
  const bytes = (data, cap = 256) => Array.from(new Uint8Array(data.buffer || data, data.byteOffset || 0, Math.min(data.byteLength || 0, cap)));
  const send = (modality, data, opts) => tendril.send({ type: "input", modality, at: Date.now(), ...data }, opts);
  const upload = async (blob, name) => { const file = await tendril.upload(blob, { name }); return { blob: file.id, url: file.url, size: blob.size, mime: blob.type }; };

  async function captureScreen({ maxWidth = 1280, sendEvent = true } = {}) {
    requireApi("screen");
    const stream = await n.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    try {
      await video.play();
      if (!video.videoWidth) await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));
      const scale = Math.min(1, maxWidth / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Screen capture failed")), "image/png"));
      const data = { ...await upload(blob, "screen.png"), width: canvas.width, height: canvas.height };
      if (sendEvent) await send("screen", data);
      return data;
    } finally { stream.getTracks().forEach((track) => track.stop()); video.srcObject = null; }
  }

  async function readClipboard({ sendEvent = true, maxChars = 12000 } = {}) {
    requireApi("clipboard");
    const original = await n.clipboard.readText();
    const text = original.slice(0, maxChars);
    if (sendEvent) await send("clipboard", { text, truncated: original.length > maxChars });
    return text;
  }

  async function pickContacts({ fields = ["name", "email", "tel"], multiple = false, sendEvent = true } = {}) {
    requireApi("contacts");
    const chosen = await n.contacts.select(fields, { multiple });
    const contacts = chosen.map((c) => Object.fromEntries(fields.filter((f) => c[f] != null).map((f) => [f, c[f]])));
    if (sendEvent && contacts.length) await send("contacts", { contacts });
    return contacts;
  }

  async function pickDirectory({ maxEntries = 100, sendEvent = true } = {}) {
    requireApi("directory");
    const handle = await window.showDirectoryPicker();
    const entries = [];
    for await (const [name, item] of handle.entries()) {
      entries.push({ name, kind: item.kind });
      if (entries.length >= maxEntries) break;
    }
    const data = { name: handle.name, entries, truncated: entries.length >= maxEntries };
    if (sendEvent) await send("directory", data);
    return { ...data, handle };
  }

  function gamepads({ onChange } = {}) {
    requireApi("gamepad");
    let active = true, frame = 0, latest = [], signature = "";
    const read = () => Array.from(n.getGamepads() || []).filter(Boolean).map((pad) => ({
      index: pad.index, id: String(pad.id || "").slice(0, 120), connected: pad.connected,
      buttons: pad.buttons.map((button) => ({ pressed: button.pressed, value: Math.round(button.value * 100) / 100 })),
      axes: pad.axes.map((axis) => Math.round(axis * 100) / 100),
    }));
    const tick = () => {
      if (!active) return;
      latest = read();
      const next = JSON.stringify(latest);
      if (next !== signature) { signature = next; onChange?.(latest); }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return { snapshot: () => latest, sendSnapshot: () => send("gamepad", { gamepads: latest }),
      stop() { active = false; cancelAnimationFrame(frame); } };
  }

  async function midi({ onMessage } = {}) {
    requireApi("midi");
    const access = await n.requestMIDIAccess({ sysex: false });
    const messages = [];
    const handlers = new Map();
    const attach = (input) => {
      const handler = (event) => {
        const packet = { input: input.name || input.id, data: bytes(event.data, 3), at: Date.now() };
        messages.push(packet); if (messages.length > 50) messages.shift(); onMessage?.(packet);
      };
      input.addEventListener("midimessage", handler); handlers.set(input, handler);
    };
    for (const input of access.inputs.values()) attach(input);
    const change = () => {
      for (const [input, handler] of handlers) input.removeEventListener("midimessage", handler);
      handlers.clear(); for (const input of access.inputs.values()) attach(input);
    };
    access.addEventListener?.("statechange", change);
    return { inputs: () => Array.from(access.inputs.values()).map((i) => ({ id: i.id, name: i.name, manufacturer: i.manufacturer })),
      messages, sendSnapshot: () => send("midi", { messages: messages.slice(-20) }),
      stop() { access.removeEventListener?.("statechange", change); for (const [input, handler] of handlers) input.removeEventListener("midimessage", handler); } };
  }

  async function hid({ filters = [], onReport } = {}) {
    requireApi("hid");
    const [device] = await n.hid.requestDevice({ filters });
    if (!device) throw new Error("No HID device was chosen.");
    await device.open();
    const reports = [];
    const handler = (event) => {
      const packet = { report_id: event.reportId, bytes: bytes(event.data), at: Date.now() };
      reports.push(packet); if (reports.length > 20) reports.shift(); onReport?.(packet);
    };
    device.addEventListener("inputreport", handler);
    const descriptor = { product_name: device.productName, vendor_id: device.vendorId, product_id: device.productId,
      collections: (device.collections || []).map((c) => ({ usage_page: c.usagePage, usage: c.usage })) };
    return { device, descriptor, reports, sendSnapshot: () => send("hid", { descriptor, reports: reports.slice(-10) }),
      sendReport: (id, data) => device.sendReport(id, new Uint8Array(data)),
      async stop() { device.removeEventListener("inputreport", handler); await device.close(); } };
  }

  async function usb({ filters = [], configurationValue, interfaceNumber } = {}) {
    requireApi("usb");
    const device = await n.usb.requestDevice({ filters });
    await device.open();
    if (configurationValue != null) await device.selectConfiguration(configurationValue);
    if (interfaceNumber != null) await device.claimInterface(interfaceNumber);
    const descriptor = { manufacturer: device.manufacturerName, product: device.productName, serial: device.serialNumber,
      vendor_id: device.vendorId, product_id: device.productId,
      configurations: (device.configurations || []).map((c) => ({ value: c.configurationValue,
        interfaces: c.interfaces.map((i) => ({ number: i.interfaceNumber,
          alternates: i.alternates.map((a) => ({ interface_class: a.interfaceClass,
            endpoints: a.endpoints.map((e) => ({ number: e.endpointNumber, direction: e.direction, type: e.type })) })) })) })) };
    return { device, descriptor, sendSnapshot: () => send("usb", { descriptor }),
      async read(endpoint, length = 64) {
        const r = await device.transferIn(endpoint, Math.min(4096, length));
        return { status: r.status, bytes: r.data ? bytes(r.data, 4096) : [] };
      },
      write: (endpoint, data) => device.transferOut(endpoint, new Uint8Array(data)),
      async stop() { if (interfaceNumber != null) await device.releaseInterface(interfaceNumber).catch(() => {}); await device.close(); } };
  }

  async function nfc({ onTag, sendTags = true } = {}) {
    requireApi("nfc");
    const controller = new AbortController();
    const reader = new NDEFReader();
    let last = "", lastAt = 0;
    reader.addEventListener("reading", (event) => {
      const records = Array.from(event.message.records || []).slice(0, 20).map((record) => ({
        type: record.recordType, media_type: record.mediaType || null,
        text: record.data ? new TextDecoder(record.encoding || "utf-8").decode(record.data).slice(0, 4000) : null,
      }));
      const tag = { serial_number: event.serialNumber || null, records };
      const signature = JSON.stringify(tag), now = Date.now();
      if (signature === last && now - lastAt < 3000) return;
      last = signature; lastAt = now;
      onTag?.(tag); if (sendTags) void send("nfc", tag).catch(console.error);
    });
    await reader.scan({ signal: controller.signal });
    return { stop() { controller.abort(); } };
  }

  async function xr({ mode = "immersive-vr", onAction } = {}) {
    requireApi("xr");
    const session = await n.xr.requestSession(mode);
    const actions = [];
    const record = (type, event) => {
      const action = { type, handedness: event.inputSource?.handedness || "none", target_ray_mode: event.inputSource?.targetRayMode || null, at: Date.now() };
      actions.push(action); if (actions.length > 30) actions.shift(); onAction?.(action);
    };
    const listeners = ["select", "squeeze"].map((type) => {
      const fn = (event) => record(type, event); session.addEventListener(type, fn); return [type, fn];
    });
    return { session, actions, sendSnapshot: () => send("xr", { mode, actions: actions.slice(-20) }),
      async stop() { for (const [type, fn] of listeners) session.removeEventListener(type, fn); await session.end(); } };
  }

  function sensor(kind, { frequency = 5, onReading, onError } = {}) {
    requireApi(kind);
    const names = { ambient_light: "AmbientLightSensor", magnetometer: "Magnetometer", proximity: "ProximitySensor",
      accelerometer: "Accelerometer", gyroscope: "Gyroscope" };
    const sensor = new window[names[kind]]({ frequency: Math.min(20, Math.max(1, frequency)) });
    let latest = null;
    const reading = () => {
      latest = kind === "ambient_light" ? { lux: sensor.illuminance } : kind === "proximity" ? { distance: sensor.distance, max: sensor.max, near: sensor.near } :
        { x: sensor.x, y: sensor.y, z: sensor.z };
      onReading?.(latest);
    };
    sensor.addEventListener("reading", reading); sensor.start();
    if (onError) sensor.addEventListener("error", onError);
    return { sensor, snapshot: () => latest, sendSnapshot: () => send(kind, { reading: latest }),
      stop() { sensor.removeEventListener("reading", reading); if (onError) sensor.removeEventListener("error", onError); sensor.stop(); } };
  }

  ns.connectors = { supported, send, captureScreen, readClipboard, pickContacts, pickDirectory,
    gamepads, midi, hid, usb, nfc, xr, sensor };
})();
