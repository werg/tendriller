/* Tendriller snippet: bluetooth.js — connect to a Bluetooth LE device, read, write and get notified.
 *
 *   <button id="pair">Connect sensor</button>
 *   <script src="_tendril/snippets/bluetooth.js"></script>
 *   <script>
 *     const bt = tendrilSnippets.bluetooth;
 *     if (!bt.supported()) pair.replaceWith(bt.unsupportedReason());
 *     pair.onclick = async () => {                                  // the device picker needs a tap
 *       const dev = await bt.connect({ services: ["heart_rate"] });  // or a 128-bit UUID string
 *       await dev.notify("heart_rate", "heart_rate_measurement", (dv) => {
 *         const bpm = dv.getUint8(1);
 *         rate.textContent = bpm;
 *         if (bpm > 170) tendril.send({ type: "heart_rate_high", bpm });
 *       });
 *       const level = (await dev.read("battery_service", "battery_level")).getUint8(0);
 *       // dev.write(service, characteristic, "text" | Uint8Array);  dev.disconnect()
 *     };
 *   </script>
 *
 * connect({services, namePrefix, name, optionalServices, onDisconnect}) → dev:
 *   {device, name, read(svc, chr) → DataView, readText(svc, chr), write(svc, chr, data, {withResponse=true}),
 *    notify(svc, chr, fn(DataView)) → Promise<stop()>, disconnect()}
 * Service/characteristic names are the standard GATT names or UUIDs. Every service you want to use
 * must be in `services` or `optionalServices`.
 * Web Bluetooth exists only in Chromium browsers (Chrome/Edge on desktop and Android) on HTTPS;
 * not on iOS (any browser), Firefox or Safari.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const supported = () => "bluetooth" in navigator;
  const unsupportedReason = () => supported() ? "" :
    !window.isSecureContext ? "Web Bluetooth needs a secure (HTTPS) page." :
    "Web Bluetooth is not available in this browser. Use Chrome or Edge on desktop or Android (not iPhone).";
  async function available() {
    if (!supported()) return false;
    try { return await navigator.bluetooth.getAvailability(); } catch { return true; }
  }

  async function connect({ services = [], namePrefix, name, optionalServices = [], onDisconnect } = {}) {
    if (!supported()) throw new Error(unsupportedReason());
    const filter = {};
    if (services.length) filter.services = services;
    if (namePrefix) filter.namePrefix = namePrefix;
    if (name) filter.name = name;
    let device;
    try {
      device = await navigator.bluetooth.requestDevice(Object.keys(filter).length
        ? { filters: [filter], optionalServices }
        : { acceptAllDevices: true, optionalServices });
    } catch (e) {
      throw new Error(e.name === "NotFoundError" ? "No device was chosen." : e.name === "SecurityError" ? "Opening the device picker needs a tap." : e.message);
    }
    const server = await device.gatt.connect();
    device.addEventListener("gattserverdisconnected", () => onDisconnect && onDisconnect());
    const chars = new Map();
    const chr = async (svc, c) => {
      const key = svc + "/" + c;
      if (!chars.has(key)) chars.set(key, (await server.getPrimaryService(svc)).getCharacteristic(c));
      return chars.get(key);
    };
    return {
      device, server, name: device.name,
      read: async (svc, c) => (await chr(svc, c)).readValue(),
      readText: async (svc, c) => new TextDecoder().decode(await (await chr(svc, c)).readValue()),
      async write(svc, c, data, { withResponse = true } = {}) {
        const ch = await chr(svc, c);
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        return withResponse ? ch.writeValueWithResponse(bytes) : ch.writeValueWithoutResponse(bytes);
      },
      async notify(svc, c, fn) {
        const ch = await chr(svc, c);
        const h = (e) => fn(e.target.value);
        ch.addEventListener("characteristicvaluechanged", h);
        await ch.startNotifications();
        return () => { ch.removeEventListener("characteristicvaluechanged", h); ch.stopNotifications().catch(() => {}); };
      },
      disconnect: () => device.gatt.connected && device.gatt.disconnect(),
    };
  }

  ns.bluetooth = { supported, unsupportedReason, available, connect };
})();
